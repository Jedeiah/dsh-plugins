import z from '@deepseek-ai/schemastery';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * The shipped HTTP fetch provider, with one explicit allowance for the fake-ip
 * range a local TUN proxy hands out.
 *
 * `dsh-web-fetch-http` refuses any hostname whose resolution is not globally
 * reachable unicast, which is right for SSRF defense but makes every fetch fail
 * while Clash / Shadowrocket in TUN mode answers lookups from its fake-ip pool
 * (198.18.0.0/15, RFC 2544 benchmarking).
 *
 * The provider takes its address resolver as a constructor argument, so this
 * bundle changes exactly that one collaborator and inherits everything else —
 * URL policy, same-origin redirects, error codes, caps, charset decoding,
 * connection pinning and proxy routing.
 *
 * The replacement resolver keeps upstream authoritative:
 *
 *   1. ask the shipped resolver first;
 *   2. when — and only when — it refuses with `WEB_BLOCKED_URL`, resolve once
 *      more and accept the answer only if every address lies inside a range
 *      configured in `allowRanges`;
 *   3. otherwise rethrow the shipped error untouched.
 *
 * On the rescuing path an IPv4 destination wrapped in IPv6 — the IPv4-mapped
 * `::ffff:a.b.c.d` and the IPv4-translated `::ffff:0:a.b.c.d` a proxy with IPv6
 * DNS answers AAAA with — is handed on as the IPv4 destination itself. The
 * shipped pinning takes the first eligible address, and a `::ffff:0:x` literal
 * is not routeable everywhere the proxy's own fake-ip is. Nothing else about the
 * answer is touched, and the strict path (`allowRanges` empty) returns the
 * shipped verdict verbatim.
 *
 * Nothing about "which addresses are public" is reimplemented here, so an
 * upstream change to that policy keeps applying. The plugin can only ever widen
 * the verdict for addresses inside its own configured ranges, and it fails
 * closed: an unrecognized refusal reason, a changed error code, or a mixed
 * answer set all rethrow the shipped error rather than admitting the request.
 */

/*
 * The provider is loaded with a dynamic import, not a static one. Measured on
 * dsh 0.2.0-rc.2: a static `import ... from '@deepseek-ai/dsh-web-fetch-http'`
 * inside a profile-linked bundle fails to resolve — the loader cannot create the
 * entry at all, and reports only "failed to import" — while the same specifier
 * resolved through `import()` at module scope succeeds. Nothing else about the
 * bundle changes between the two forms.
 */
let HttpFetchProvider;
try {
  ({ HttpFetchProvider } = await import('@deepseek-ai/dsh-web-fetch-http'));
} catch (error) {
  throw new Error('web-fetch-fakeip: could not import @deepseek-ai/dsh-web-fetch-http', { cause: error });
}
if (typeof HttpFetchProvider !== 'function') {
  throw new Error('web-fetch-fakeip: @deepseek-ai/dsh-web-fetch-http no longer exports HttpFetchProvider — this bundle needs an update for the installed dsh version');
}

/** Default `User-Agent`, matching the shipped provider. */
const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)';
/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
const MAX_NODE_TIMER_DELAY_MS = 2147483647;
/** The shipped refusal code that means "an address was not public". */
const BLOCKED_CODE = 'WEB_BLOCKED_URL';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-fakeip';
/** The web seam this provider registers into. */
export const inject = ['web'];

/**
 * No field is `.volatile()`: the limits are captured when the provider is built,
 * so a volatile field would silently ignore later edits. Leaving them plain makes
 * a config change restart the fiber, which rebuilds the provider with the new
 * value — the loud, predictable behaviour. `allowRanges` is validated here for the
 * same reason: a typo must fail the load, not quietly restore the strict policy.
 */
export const Config = z.object({
  /**
   * Address ranges to accept even though the shipped guard refuses them, as
   * comma or space separated IPv4 CIDRs. `198.18.0.0/15` is the Clash /
   * Shadowrocket fake-ip pool. An empty string restores the shipped policy exactly.
   */
  allowRanges: z.string().default('198.18.0.0/15'),
  /** Response body byte ceiling. */
  maxResponseBytes: z.number().default(5e6),
  /** Decoded body character ceiling. */
  maxBodyChars: z.number().default(1e5),
  /** Fetch timeout — a resource backstop, not the model-facing tool budget. */
  timeoutMs: z.number().default(3e4),
  /** Same-origin redirect hop ceiling (0 follows none). */
  maxRedirects: z.number().default(5),
  /** `User-Agent` sent with every request. */
  userAgent: z.string().default(DEFAULT_USER_AGENT),
});

/** WHATWG URL retains brackets around IPv6 hostnames. */
function stripIpv6Brackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Parse `a.b.c.d/len` (a bare address means /32) into a masked IPv4 range.
 * @param text - the CIDR text.
 * @returns `{ base, mask }`, or undefined when unparsable.
 */
function parseRange(text) {
  const [address, lengthText] = String(text).split('/');
  const octets = address.trim().split('.');
  if (octets.length !== 4) return undefined;
  let base = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet) || Number(octet) > 255) return undefined;
    base = base * 256 + Number(octet);
  }
  const length = lengthText === undefined ? 32 : Number(lengthText.trim());
  if (!Number.isInteger(length) || length < 0 || length > 32) return undefined;
  const mask = length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

/**
 * Parse the configured allowance, refusing anything that is not an IPv4 CIDR.
 *
 * An unparsable entry is a configuration error, not a reason to fall back: the
 * shipped guard would simply resume refusing every proxied fetch and the mistake
 * would look like the original bug.
 *
 * @param text - comma or space separated CIDRs.
 * @returns the parsed ranges.
 * @throws when a non-empty entry is not an IPv4 CIDR.
 */
function parseAllowance(text) {
  const pieces = String(text ?? '').split(/[\s,]+/).filter((piece) => piece !== '');
  const ranges = [];
  const invalid = [];
  for (const piece of pieces) {
    const range = parseRange(piece);
    if (range === undefined) invalid.push(piece);
    else ranges.push(range);
  }
  if (invalid.length > 0) {
    throw new Error(`web-fetch-fakeip: allowRanges entries must be IPv4 CIDRs; got ${invalid.map((piece) => `"${piece}"`).join(', ')}`);
  }
  return ranges;
}

/**
 * Read an address as an unsigned 32-bit IPv4 destination when the resolver handed
 * back an IPv4 one wrapped in IPv6: the IPv4-mapped form (`::ffff:a.b.c.d`) and
 * the IPv4-translated form (`::ffff:0:a.b.c.d`) a TUN proxy with IPv6 DNS answers
 * AAAA with for the very same fake-ip it hands out as A.
 *
 * The textual IPv6 forms are not matched one by one — compressed or not, case,
 * leading zeros and an embedded dotted quad all spell the same destination. The
 * address is normalized through the WHATWG URL parser first, whose IPv6
 * serialization is specified, then expanded into its eight groups, where the
 * 96-bit prefix decides.
 *
 * @param address - the address text.
 * @returns the address as an integer, or undefined when it is not an IPv4 destination.
 */
function ipv4ValueOf(address) {
  const text = stripIpv6Brackets(String(address));
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted !== null) {
    const octets = dotted.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return undefined;
    return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
  }
  let normalized;
  try {
    normalized = new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    // Not a spelling the URL parser accepts as an IPv6 literal: fail closed.
    return undefined;
  }
  const [head, tail] = normalized.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = [
    ...headGroups,
    ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"),
    ...tailGroups
  ];
  if (groups.length !== 8) return undefined;
  const values = groups.map((group) => parseInt(group, 16));
  if (values.some((value) => !Number.isInteger(value))) return undefined;
  const prefix = values.slice(0, 6).join(",");
  const mapped = prefix === "0,0,0,0,0,65535";
  const translated = prefix === "0,0,0,0,65535,0";
  if (!mapped && !translated) return undefined;
  return (((values[6] << 16) | values[7]) >>> 0);
}

/**
 * Whether an address text is an IPv4 destination inside one of the allowances.
 * Only a real IPv4 destination can match, so the allowance can never widen an
 * IPv6 verdict.
 *
 * @param address - textual address.
 * @param ranges - the parsed allowance.
 * @returns true when the address is covered.
 */
function isInsideAllowance(address, ranges) {
  const value = ipv4ValueOf(address);
  if (value === undefined) return false;
  return ranges.some((range) => ((value & range.mask) >>> 0) === range.base);
}

/** Race a wait for system resolution without letting it delay tool cancellation. */
function raceWithSignal(promise, signal) {
  if (signal === undefined) return promise;
  const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal.reason });
  if (signal.aborted === true) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

/**
 * Resolve a hostname and accept the answer only when every address sits inside
 * the configured allowance.
 *
 * @param hostname - URL hostname, bracketed or not.
 * @param signal - aborts the wait for resolution.
 * @param allowance - the parsed allowance.
 * @returns the accepted address set, or undefined when the answer does not
 *   qualify (a mixed set, an IPv6 answer, or an address outside the allowance).
 *   Wrapped IPv4 destinations are handed over as the IPv4 address itself.
 */
async function addressesInsideAllowance(hostname, signal, allowance) {
  if (allowance.length === 0) return undefined;
  const unbracketed = stripIpv6Brackets(hostname);
  let resolved;
  if (isIP(unbracketed) !== 0) {
    // An IP literal needs no lookup; the shipped resolver treats it the same way.
    resolved = [{ address: unbracketed, family: isIP(unbracketed) }];
  } else {
    try {
      resolved = await raceWithSignal(lookup(unbracketed, { all: true, order: 'verbatim' }), signal);
    } catch {
      // Resolution trouble keeps the shipped verdict authoritative.
      return undefined;
    }
  }
  if (resolved.length === 0) return undefined;
  const addresses = [];
  const seen = new Set();
  for (const entry of resolved) {
    if (!isInsideAllowance(entry.address, allowance)) return undefined;
    // Hand the connector the IPv4 destination an IPv6 wrapper stands for: the
    // pinned lookup takes the first eligible address, and a `::ffff:0:x` literal
    // is not routeable everywhere the proxy's own fake-ip is.
    const value = ipv4ValueOf(entry.address);
    const address = value === undefined ? entry.address : `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
    const family = value === undefined ? entry.family : 4;
    const key = `${address}/${family}`;
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push({ address, family });
  }
  return addresses;
}

/**
 * Build the resolver injected into the shipped provider.
 *
 * @param official - the shipped resolver, authoritative for every verdict.
 * @param allowance - the parsed allowance.
 * @returns a resolver with the shipped signature.
 */
function createResolver(official, allowance) {
  return async function resolveWithAllowance(hostname, signal) {
    try {
      return await official(hostname, signal);
    } catch (error) {
      // The refusal is recognized by its documented code, so no error class is imported.
      if (error === null || typeof error !== 'object' || error.code !== BLOCKED_CODE) throw error;
      const rescued = await addressesInsideAllowance(hostname, signal, allowance);
      if (rescued === undefined) throw error;
      return rescued;
    }
  };
}

/** A resource limit (byte/char/length cap) must be a positive finite number. */
function assertPositiveFinite(label, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`web-fetch-fakeip: ${label} must be a positive finite number`);
}

/** The redirect hop cap must be a non-negative integer. */
function assertNonNegativeInteger(label, value) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`web-fetch-fakeip: ${label} must be a non-negative integer`);
}

/**
 * Register the fake-ip-aware provider on the web seam.
 * @param ctx - Host plugin context; `web` is guaranteed by `inject`.
 * @param config - resolved plugin config.
 */
export function apply(ctx, config) {
  const resolved = config ?? {};
  const limits = {
    maxResponseBytes: resolved.maxResponseBytes ?? 5e6,
    maxBodyChars: resolved.maxBodyChars ?? 1e5,
    timeoutMs: resolved.timeoutMs ?? 3e4,
    maxRedirects: resolved.maxRedirects ?? 5,
    userAgent: resolved.userAgent ?? DEFAULT_USER_AGENT,
  };
  assertPositiveFinite('maxResponseBytes', limits.maxResponseBytes);
  assertPositiveFinite('maxBodyChars', limits.maxBodyChars);
  assertPositiveFinite('timeoutMs', limits.timeoutMs);
  if (limits.timeoutMs > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-fakeip: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`);
  }
  assertNonNegativeInteger('maxRedirects', limits.maxRedirects);
  const allowance = parseAllowance(resolved.allowRanges);

  // The shipped resolver, taken from the default the shipped constructor installs.
  const official = new HttpFetchProvider(limits).resolveAddresses;
  const resolver = createResolver(official, allowance);
  const provider = new HttpFetchProvider(limits, resolver);

  // Fail loudly instead of silently running the shipped guard alone: if an
  // upstream change drops or renames this constructor parameter, the injected
  // resolver would be ignored and every proxied fetch would be refused again
  // with no hint that this bundle needs updating.
  if (provider.resolveAddresses !== resolver) {
    throw new Error('web-fetch-fakeip: HttpFetchProvider no longer accepts an injected resolver — this bundle needs an update for the installed dsh version');
  }

  ctx.effect(() => ctx.web.registerFetchProvider(provider), 'web-fetch-fakeip: fetch provider');
}
