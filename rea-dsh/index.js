import z from '@deepseek-ai/schemastery';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_NAME, ensureSkillInCache, resolveRelease } from './skill-source.js';
import {
  SPEC_PATTERN,
  findBlocks,
  profilePatchPath,
  readPinnedSpec,
  renderOverrideBlock,
  writeOverrideBlock,
} from './profile-override.js';

/*
 * Imported through `import()` rather than a static import: measured on dsh
 * 0.2.0-rc.2, a static import of a dsh package inside a profile-linked bundle can
 * fail to resolve, and the loader then reports only "failed to import".
 */
let TypertRemoteService;
try {
  ({ TypertRemoteService } = await import('@deepseek-ai/dsh-typert-protocol'));
} catch (error) {
  throw new Error('rea-dsh: could not import @deepseek-ai/dsh-typert-protocol', { cause: error });
}

/** Plugin name used by loader diagnostics. */
export const name = 'rea-dsh';

/** Prototype key the Typert Remote markers live under. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * Host half of the rea-dsh bundle.
 *
 * It owns one tunable — whether REA's bundled skill is exposed to the agent — so
 * it can be set in `cordis.patch.yml` or on the bundle's page, instead of being
 * edited here. Only `.volatile()` fields are projected to the browser; the
 * settings service turns them into the form the Client half reads through
 * `ctx.configForms`.
 *
 * It also publishes the `reaAgents` Remote service (see {@link ReaAgentsRuntime}),
 * which is what makes this bundle survive a row switch: the Client half gates its
 * settings entry on that service, so the entry re-attaches by itself when the
 * Host half is rebuilt. A Client half's own `apply` is not re-run after
 * 停用→启用 (deepseek-harness#8452), so a gate is the only shape that works.
 *
 * One release fact this half keeps straight: **the skill has no version of its own.**
 * It follows the spec the launcher recorded when it started the bridge, so it can
 * never name a different release than the server that is running. The spec itself
 * comes from the bridge row's configuration — `REA_SPEC` in its `env`, or a
 * `--spec=` in its `args`, both ordinary Cordis configuration — and reaches the
 * launcher at spawn time.
 *
 * The consequence worth knowing: pinning a version changes the **bridge** only when
 * its process restarts (restarting the harness, or toggling that row off and on),
 * while the skill follows the record within a poll. `describe()` reports exactly
 * that state instead of letting a stale pairing look healthy.
 *
 * `import z from '@deepseek-ai/schemastery'` is the documented way to describe a
 * Config. Because this bundle is linked in from outside the dsh installation,
 * the package must also be named in `peerDependencies` so the resolver routes
 * the bare specifier to the installation's copy.
 */
export const Config = z.object({
  /**
   * Expose REA's bundled skill to the agent.
   *
   * On by default, matching upstream: REA's guided setup installs the matching
   * skill alongside the MCP registration unless asked not to.
   */
  skills: z.boolean().default(true).volatile(),
});

/**
 * Defaults read from the schema itself, so there is one source of truth.
 *
 * `toJSON()` renders every node as `{ type, meta: { default } }` keyed by uid,
 * with `dict` mapping field names to those uids — the same serialization the
 * settings service round-trips when it projects a row's form. Reading defaults
 * from there keeps this table from drifting away from the schema, which a
 * hand-written copy silently would.
 *
 * A `.volatile()` field cannot be defaulted by validating `{}`: that yields the
 * live handle rather than the value, so the `meta.default` path is the only way.
 * @param schema - the exported Config schema.
 * @returns a frozen field-to-default table (empty if the shape is ever different).
 */
function schemaDefaults(schema) {
  const out = {};
  try {
    const json = schema.toJSON();
    // schemastery puts the field→uid map on the root *node* (`refs[uid].dict`),
    // not at the top level; falling back to `json` itself covers a shape where it
    // is hoisted instead.
    const root = json?.refs?.[json?.uid] ?? json;
    for (const [field, uid] of Object.entries(root?.dict ?? {})) {
      const node = json?.refs?.[uid];
      if (node?.meta !== undefined && 'default' in node.meta) out[field] = node.meta.default;
    }
    // Import-time only, before any logger exists, so console is the honest channel.
    if (Object.keys(out).length === 0) {
      console.warn('rea-dsh: Config exposes no readable defaults; unread fields will not fall back');
    }
  } catch (error) {
    console.warn(`rea-dsh: Config defaults could not be read: ${error?.message ?? error}`);
  }
  return out;
}

/** Schema defaults, used when a field cannot be read. */
const CONFIG_DEFAULTS = Object.freeze(schemaDefaults(Config));

/**
 * Read one configured value.
 *
 * A field marked `.volatile()` arrives as a live reference — a frozen handle
 * with `get()` whose value the settings service rewrites without remounting the
 * row — so reading `config.skills` directly would yield the handle object
 * (always truthy) instead of the configured value. Plain fields pass through
 * unchanged.
 * @param value - the configured value or volatile reference.
 * @param fallback - used when the field is absent or unreadable.
 * @param onError - called with the thrown value when a volatile handle refuses to
 *   read; without it a failed read would silently look like the default.
 * @returns the current plain value.
 */
function readConfigValue(value, fallback, onError) {
  if (value === undefined) return fallback;
  if (typeof value?.get === 'function') {
    try {
      const current = value.get();
      return current === undefined ? fallback : current;
    } catch (error) {
      onError?.(error);
      return fallback;
    }
  }
  return value;
}

/**
 * Snapshot every known field, so a Remote read never returns holes.
 * @param config - the row configuration.
 * @param onError - forwarded to {@link readConfigValue} for unreadable fields.
 * @returns a plain field-to-value object.
 */
function snapshotConfig(config, onError) {
  const out = {};
  for (const [field, fallback] of Object.entries(CONFIG_DEFAULTS)) {
    out[field] = readConfigValue(config?.[field], fallback, onError);
  }
  return out;
}

/** This package's own directory, resolved from this module's URL. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

/** The shipped skill copy, used when nothing newer can be obtained. */
const SKILLS_SOURCE_DIR = join(PACKAGE_DIR, 'skills');

/**
 * Where refreshed skill payloads live.
 *
 * Inside the package on purpose: this bundle's footprint stays one directory, so
 * removing it removes every trace. Nothing here writes to the user's home, to
 * `~/.agents/skills`, or anywhere else a harness would have to clean up later.
 */
const SKILL_CACHE_DIR = join(PACKAGE_DIR, 'cache', 'skill');

/**
 * What the launcher recorded about the spawn that is (or was last) serving this row.
 *
 * `launcher.mjs` writes this once per spawn, so it is the only evidence of which spec
 * the bridge actually runs — as opposed to which spec the version file declares now.
 */
const LAUNCH_STATE_FILE = join(PACKAGE_DIR, 'cache', 'status.json');

/**
 * Where this bundle lives upstream, spelled once.
 *
 * Used only by the update check, which compares this installed copy's version with the
 * one on the default branch. A fetch failure is reported, never retried in a loop.
 */
const PLUGIN_REPOSITORY = 'Jedeiah/dsh-plugins';

/** This installed copy's own version, read once at import. */
const LOCAL_PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();

/**
 * How long to wait before retrying a failed skill refresh.
 *
 * A failure is usually "no network right now", which is not worth a request per
 * poll — and a working bundled copy is already in place, so patience is free.
 */
const SKILL_RETRY_MS = 5 * 60_000;

/**
 * What the skill follows before the bridge has ever spawned.
 *
 * The launcher's own default, spelled here so the two agree: a fresh install with no
 * bridge record still gets a skill, and it is the same release the bridge would pick.
 */
const DEFAULT_SPEC = 'latest';

/**
 * The launcher module, shared with the bridge row's `!!js` expressions.
 *
 * It owns how REA is started and which release that means. This half never asks a
 * file what the version is: it reads the record the launcher writes when it spawns.
 */
const launcher = (() => {
  try {
    return createRequire(import.meta.url)('./launcher.cjs');
  } catch (error) {
    console.warn(`rea-dsh: launcher module unavailable: ${error?.message ?? error}`);
    return null;
  }
})();

/**
 * The spec the launcher last ran the bridge with.
 *
 * This is the single input to the skill's version, and it is a **record**, not a
 * declaration: the launcher writes `cache/status.json` immediately before it starts
 * the server, so the skill can only ever follow what actually runs. Nothing needs to
 * agree with anything else, which is why there is no version file to keep in sync.
 * @returns the recorded spec, or `latest` when the bridge has not spawned yet.
 */
function runningSpec(path = LAUNCH_STATE_FILE) {
  const recorded = readLaunchState(path);
  return typeof recorded?.spec === 'string' && recorded.spec !== '' ? recorded.spec : null;
}

/**
 * Compare what the version file declares with what the bridge actually launched.
 *
 * Kept as a pure function because it is the one place that answers "is the running
 * server on the version I think it is?" — a question whose answer must never be
 * guessed from the declared value alone.
 * @param expected - what the bridge actually ran, from the launcher's record.
 * @param actual - the spec the skill currently in place was fetched for.
 * @returns `{ state, ... }` where state is `aligned`, `stale`, or `unknown`.
 */
function describeVersionDrift(expected, actual, options = {}) {
  const seen = typeof actual === 'string' && actual !== '' ? actual : null;
  if (typeof expected !== 'string' || expected === '') {
    return { state: 'unknown', expected: null, actual: seen, reason: 'no-bridge-record' };
  }
  // A failed refresh leaves the skill on whatever it had — the bundled copy at worst —
  // so the honest answer is "stale", whatever the spec strings say.
  if (options.skillError !== undefined && options.skillError !== null) {
    return { state: 'stale', expected, actual: seen, reason: 'skill-refresh-failed' };
  }
  if (seen === null) return { state: 'stale', expected, actual: null, reason: 'skill-not-fetched' };
  if (seen !== expected) return { state: 'stale', expected, actual: seen, reason: 'spec-mismatch' };
  // Same floating tag on both sides, but the bridge restarted after the skill was
  // fetched: the tag may resolve to a newer release than the skill is pinned to, and
  // nothing offline can tell. Say so instead of claiming alignment.
  if (options.floating === true) return { state: 'unverified', expected, actual: seen, reason: 'floating-tag' };
  return { state: 'aligned', expected, actual: seen };
}

/**
 * Decide whether the skill needs (re)resolving.
 *
 * Pure, so the policy is testable without touching the network, and so the reason is
 * visible in the logs rather than implied by control flow. The case that matters most is
 * the last one: **a floating tag resolves afresh at every bridge start**, so a new spawn
 * is the signal that the skill's release may have moved. Comparing spec strings alone
 * would never fire there — the string stays `latest` — and the skill would silently stay
 * on whatever it first resolved to, which is the exact drift this bundle exists to
 * prevent.
 * @param state - `{ spec, lastSpec, spawn, lastSpawn, error, retryAfter, now, refreshing }`.
 * @returns a short reason, or null when nothing should happen.
 */
export function refreshReason(state) {
  if (state.refreshing === true) return null;
  if (state.spec !== state.lastSpec) return 'spec-changed';
  if (!isConcreteVersion(state.spec) && state.spawn !== null && state.spawn !== state.lastSpawn) {
    return 'tag-respawned';
  }
  if (state.error !== null && state.now >= state.retryAfter) return 'retry';
  return null;
}

/**
 * Whether a spec names one release rather than a moving tag.
 * @param spec - a version or dist-tag.
 * @returns whether it looks like a concrete version.
 */
function isConcreteVersion(spec) {
  return typeof spec === 'string' && /^\d+\.\d+\.\d+/.test(spec);
}

/** @returns a promise that settles after `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Total bytes under one directory, bounded.
 *
 * The cache is worth reporting because it is the only thing this bundle leaves on disk
 * besides its own source, and "how big is it" is a fair question for a settings page to
 * answer without making the user go look.
 * @param directory - the directory to measure.
 * @param budget - how many entries to visit before giving up.
 * @returns `{ bytes, entries, complete }`.
 */
function directorySize(directory, budget = 5000) {
  let bytes = 0;
  let entries = 0;
  let complete = true;
  const walk = (current) => {
    if (!complete) return;
    let listing;
    try {
      listing = readdirSync(current, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    for (const entry of listing) {
      if (entries >= budget) { complete = false; return; }
      entries += 1;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try { bytes += statSync(full).size; } catch { /* raced away; not worth reporting */ }
      }
    }
  };
  walk(directory);
  return { bytes, entries, complete };
}

/**
 * Read the launcher's record of the last spawn.
 * @returns the decoded record, or null when there is none yet.
 */
function readLaunchState(path = LAUNCH_STATE_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    // No spawn recorded yet, or the file is mid-write: both are ordinary.
    return null;
  }
}

/**
 * The directory the skill provider actually scans.
 *
 * The shipped `@deepseek-ai/dsh-skill-filesystem` provider is reused rather than
 * reimplemented — its discovery, frontmatter parsing and file watcher are
 * internal and would be lost by a reimplementation. To make the `skills` toggle
 * reach it, the toggle is turned into a filesystem event: when on, every skill
 * under the resolved source directory is linked into this directory; when off, the
 * directory is emptied. The provider's watcher (which follows symlinks by default)
 * then sees the skills appear or disappear on its own.
 */
const SKILLS_LIVE_DIR = join(PACKAGE_DIR, 'skills-live');

/**
 * Sync {@link SKILLS_LIVE_DIR} with the resolved skills according to `enabled`.
 *
 * The directory is created even when `enabled` is false. The provider's watcher
 * only watches roots that exist when it first looks, so a directory created
 * later — the first time someone flips the switch on — would never be noticed
 * and its skills would stay invisible until a restart. Creating it up front
 * makes the toggle a plain content change, which the watcher does see.
 *
 * Entries are symlinked rather than copied so the live directory costs nothing
 * and always reflects the resolved copy. Existing entries are cleared first, so a
 * skill removed upstream also disappears here.
 * @param enabled - whether the skills should be exposed.
 * @param opts - directory overrides, so a test can drive this without touching the bundle.
 * @returns the names of skills that could not be exposed.
 */
function syncLiveSkills(enabled, { liveDir = SKILLS_LIVE_DIR, sourceDir = SKILLS_SOURCE_DIR } = {}) {
  rmSync(liveDir, { recursive: true, force: true });
  mkdirSync(liveDir, { recursive: true });
  if (!enabled) return [];
  if (!existsSync(sourceDir)) return [];
  const failed = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = join(sourceDir, entry.name);
    const to = join(liveDir, entry.name);
    try {
      // 'junction' is what Windows needs to link a directory without elevation.
      // POSIX ignores the type, so this one call covers both platforms.
      symlinkSync(from, to, 'junction');
    } catch {
      // Filesystems without symlink support fall back to a copy.
      try { cpSync(from, to, { recursive: true }); } catch { failed.push(entry.name); }
    }
  }
  return failed;
}

/**
 * The Remote service: the Host's authoritative view of this row's configuration.
 *
 * The Client half reads it when `configForms` is unavailable — a composition
 * without the settings UI — so the toggle still reflects what the Host holds
 * rather than a hard-coded snapshot. It doubles as the reactive dependency the
 * Client half's `ctx.inject` gate waits on.
 */
class ReaAgentsRuntime extends TypertRemoteService {
  /**
   * @param ctx - owning Cordis context.
   * @param config - the row configuration as Cordis delivers it (volatile fields
   *   are live references; see {@link readConfigValue}).
   */
  /**
   * @param ctx - owning Cordis context.
   * @param config - the row configuration (volatile fields are live references).
   * @param options - `{ liveDir, launchStatePath, autoRefresh }`: test seams for the
   *   watched directory, the launcher's record, and the initial network refresh.
   */
  constructor(ctx, config, options = {}) {
    super(ctx, 'reaAgents');
    this.ctx = ctx;
    this.config = config ?? {};
    this.liveDir = options.liveDir ?? SKILLS_LIVE_DIR;
    this.launchStatePath = options.launchStatePath ?? LAUNCH_STATE_FILE;

    /** The `enabled|sourceDir` pair the live directory currently reflects. */
    this.applied = undefined;

    /**
     * What the live directory was linked from, and how that went.
     *
     * `requestedSpec` is the last attempt; `appliedSpec` is the last **successful**
     * fetch. Keeping them apart is what stops a failed refresh from reporting the
     * requested release as if it were in place.
     */
    this.skill = {
      requestedSpec: null,
      appliedSpec: null,
      version: null,
      fetchedAt: null,
      sourceDirectory: SKILLS_SOURCE_DIR,
      origin: 'bundled',
      error: null,
    };

    /** Whether the registry accepted an explicit cache invalidation. */
    this.invalidation = 'unknown';

    /** Refresh bookkeeping: at most one request in flight, and a retry floor. */
    this.refreshing = false;
    this.lastAttemptedSpec = null;
    this.retryAfter = 0;

    /**
     * The bridge spawn this half has already accounted for.
     *
     * Seeded from the record that exists at construction, so the startup refresh is not
     * repeated by the first tick — only a *new* spawn re-resolves a floating tag.
     */
    this.lastSeenSpawn = (() => {
      const recorded = readLaunchState(this.launchStatePath);
      return typeof recorded?.writtenAt === 'string' ? recorded.writtenAt : null;
    })();

    // The first sync touches the filesystem (it creates or clears `skills-live/`).
    // A failure there must not take the row down: this row also carries the MCP
    // bridge, which has nothing to do with the skills toggle, and a load failure
    // would read to the user as "the plugin is broken". Failures degrade to
    // "toggle not applied yet" and the poll retries.
    try {
      this.sync();
    } catch (error) {
      this.warn('initial skills sync', error);
    }
    this.startWatch(ctx);
    // A composition that drives refreshes itself (a test, or a host that manages timing)
    // turns the automatic one off instead of reaching for the network at construction.
    if (options.autoRefresh !== false) void this.refreshSkill();
  }

  /**
   * Report a non-fatal failure.
   *
   * These paths are all "the optional skills toggle did not work", never "the row
   * is broken", so they are logged rather than thrown: a silent failure here would
   * leave someone flipping a switch that never does anything.
   * @param what - the operation that failed.
   * @param error - the thrown value.
   */
  warn(what, error) {
    const detail = error === undefined ? '' : `: ${error?.message ?? error}`;
    try {
      this.ctx?.logger?.warn?.(`rea-dsh: ${what} failed${detail}`);
    } catch { /* a logger that throws must not become the failure */ }
  }

  /**
   * Report a normal transition.
   * @param message - the line to log.
   */
  note(message) {
    try {
      this.ctx?.logger?.info?.(`rea-dsh: ${message}`);
    } catch { /* as above: logging must never be the failure */ }
  }

  /**
   * Bring the live skill directory in line with the toggle and the resolved source.
   *
   * Idempotent by comparison rather than by inspection: the pair
   * `(enabled, sourceDirectory)` is remembered, and an unchanged pair returns
   * before anything is written. That matters because this runs once a second — a
   * write per poll would churn the provider's watcher and, worse, the harness's
   * own patch files if it ever touched them.
   */
  sync() {
    const enabled = readConfigValue(
      this.config.skills,
      CONFIG_DEFAULTS.skills,
      (error) => this.warn('reading the skills toggle', error),
    ) === true;
    // A resolved source can vanish under us — `git clean -xdf` removes `cache/`, which
    // the README presents as safe. Linking nothing would empty the live directory and the
    // refresh that could restore it only runs when the spec string changes, so fall back
    // to the bundled copy for this pass and say so once.
    const resolved = this.skill.sourceDirectory;
    const usable = existsSync(join(resolved, SKILL_NAME, 'SKILL.md'));
    const sourceDirectory = usable || resolved === SKILLS_SOURCE_DIR ? resolved : SKILLS_SOURCE_DIR;
    if (!usable && resolved !== SKILLS_SOURCE_DIR && this.warnedMissingSource !== resolved) {
      this.warnedMissingSource = resolved;
      this.warn(`skill source ${resolved} is missing; linking the bundled copy instead`);
    }
    const key = `${String(enabled)}|${sourceDirectory}`;
    if (key === this.applied) return;

    const failed = syncLiveSkills(enabled, { liveDir: this.liveDir, sourceDir: sourceDirectory });
    if (failed.length > 0) this.warn(`linking ${failed.join(', ')}`);
    this.applied = key;
    this.invalidateCatalog();
  }

  /**
   * Tell the skill registry its cached catalog is stale.
   *
   * `invalidateCache()` is load-bearing, not an optimization: the provider's own
   * watcher is not enough for a session that already received a catalog, which is
   * why this bundle writes through it (see the crate note in `AGENTS.md`). It is
   * also not part of upstream's published provider contract — the registry README
   * documents a registration-scoped `invalidate()` held by the provider — so its
   * absence after a harness upgrade is recorded rather than swallowed: the toggle
   * would then reach the model one stability window later instead of at once.
   */
  invalidateCatalog() {
    let registry;
    try {
      registry = this.ctx?.get?.('skills');
    } catch (error) {
      this.invalidation = 'unavailable';
      this.warn('reaching the skill registry', error);
      return;
    }
    if (registry === undefined || registry === null) {
      this.invalidation = 'unavailable';
      this.warn('skill registry is not mounted; the toggle still applies on the next catalog read');
      return;
    }
    if (typeof registry.invalidateCache !== 'function') {
      this.invalidation = 'missing';
      this.warn('skill registry exposes no invalidateCache(); skill changes now need a reopened chat');
      return;
    }
    try {
      registry.invalidateCache();
      this.invalidation = 'ok';
    } catch (error) {
      this.invalidation = 'failed';
      this.warn('skills cache invalidation', error);
    }
  }

  /**
   * Obtain the skill for the declared release, or keep the bundled copy.
   *
   * Never awaited by the row: the bundled copy is already linked, so a slow or
   * unreachable registry only delays the upgrade, never the plugin. On success the
   * live directory is re-pointed by the ordinary `sync()` comparison.
   */
  async refreshSkill() {
    if (this.refreshing) return;
    const spec = runningSpec() ?? DEFAULT_SPEC;
    if (spec === this.lastAttemptedSpec && this.skill.error !== null && Date.now() < this.retryAfter) return;
    this.refreshing = true;
    this.lastAttemptedSpec = spec;
    try {
      const installed = await ensureSkillInCache({
        spec,
        cacheDir: SKILL_CACHE_DIR,
        onEvent: (event) => {
          if (event.kind === 'install') this.note(`skill ${event.version} installed from npm (${event.files} files)`);
        },
      });
      this.skill = {
        requestedSpec: spec,
        appliedSpec: spec,
        version: installed.version,
        fetchedAt: new Date().toISOString(),
        sourceDirectory: installed.directory,
        origin: 'npm',
        error: null,
      };
      this.note(`skill source: REA ${installed.version} (${installed.reused ? 'cache hit' : 'fetched'})`);
      this.sync();
    } catch (error) {
      const firstFailure = this.skill.error === null;
      // Only the request is new; `appliedSpec`, `version` and `sourceDirectory` keep
      // describing what is actually in place, which is what the drift answer reads.
      this.skill = { ...this.skill, requestedSpec: spec, error: String(error?.message ?? error) };
      this.retryAfter = Date.now() + SKILL_RETRY_MS;
      // Report once per outage: a warn every five minutes is honest, one every
      // second is noise nobody reads.
      if (firstFailure) {
        this.warn(`skill refresh (${spec}); keeping the bundled copy`, error);
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Poll the volatile toggle and the declared version.
   *
   * The settings service rewrites a volatile field's value in place but emits no
   * change event, so the Host has to look. The interval is short enough to feel
   * immediate when someone flips the switch and long enough to cost nothing.
   *
   * The version check is what makes a pin take effect without a restart *for the
   * skill*; the bridge's own copy of the spec is fixed at activation, which is why
   * {@link ReaAgentsRuntime.describe} reports the distinction.
   * @param ctx - owning Cordis context.
   */
  startWatch(ctx) {
    const timer = setInterval(() => {
      try {
        this.poll();
      } catch (error) { this.warn('skills sync', error); }
    }, 1000);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      ctx.effect(() => () => clearInterval(timer), 'rea-dsh: skills toggle poll');
    } catch (error) {
      // No effect channel: `unref` above still keeps the timer from holding the
      // process open, but it will outlive this row. Report rather than hide it.
      this.warn('timer cleanup registration', error);
    }
  }

  /**
   * One poll tick.
   *
   * Split out of the interval so it can be driven directly — a test should not have to
   * wait a second, and the decision it makes is worth reading in one place.
   */
  poll() {
    this.sync();
    const record = readLaunchState(this.launchStatePath);
    const spawn = typeof record?.writtenAt === 'string' ? record.writtenAt : null;
    const spec = typeof record?.spec === 'string' && record.spec !== '' ? record.spec : DEFAULT_SPEC;
    const reason = refreshReason({
      spec,
      lastSpec: this.lastAttemptedSpec,
      spawn,
      lastSpawn: this.lastSeenSpawn,
      error: this.skill.error,
      retryAfter: this.retryAfter,
      now: Date.now(),
      refreshing: this.refreshing,
    });
    if (reason === null) return;
    this.lastSeenSpawn = spawn;
    this.note(`skill refresh: ${reason}`);
    void this.refreshSkill();
  }

  /**
   * Describe where the two release inputs currently stand.
   *
   * Reported rather than hidden because the two sides move at different times: the
   * bridge's spec is fixed when its process starts, while the skill follows the
   * record within a poll. After a pin change and a bridge restart, the skill is
   * briefly behind — and if its fetch failed, it stays behind. `drift` is that
   * state, and it is answered entirely from recorded facts.
   * @returns a plain description for `diagnose`/`snapshot` and the logs.
   */
  describe() {
    const recorded = readLaunchState();
    const expected = typeof recorded?.spec === 'string' && recorded.spec !== '' ? recorded.spec : null;
    let resolution = null;
    try {
      const plan = launcher?.resolveLaunchPlan?.({ spec: expected ?? undefined });
      if (plan !== undefined && plan !== null) {
        resolution = { mode: plan.mode, command: plan.command, args: plan.args, notes: plan.notes };
      }
    } catch (error) {
      this.warn('resolving the launcher plan', error);
    }
    const floating = typeof expected === 'string' && !isConcreteVersion(expected)
      && typeof this.skill.fetchedAt === 'string'
      && typeof recorded?.writtenAt === 'string'
      && this.skill.fetchedAt < recorded.writtenAt;
    return {
      // `expected` is the bridge's own record; `actual` is the release the skill last
      // *succeeded* on. Nothing here is compared against a declaration, because the
      // skill has no declaration of its own to drift from.
      drift: describeVersionDrift(expected, this.skill.appliedSpec, {
        skillError: this.skill.error,
        floating,
      }),
      bridge: {
        mode: recorded?.mode ?? resolution?.mode ?? null,
        spec: expected,
        launchedAt: typeof recorded?.writtenAt === 'string' ? recorded.writtenAt : null,
      },
      skill: {
        version: this.skill.version,
        appliedSpec: this.skill.appliedSpec,
        requestedSpec: this.skill.requestedSpec,
        fetchedAt: this.skill.fetchedAt,
        origin: this.skill.origin,
        sourceDirectory: this.skill.sourceDirectory,
        error: this.skill.error,
      },
      catalogInvalidation: this.invalidation,
      resolution,
    };
  }

  /**
   * Answer "is this thing healthy, and where is it looking?" in one call.
   *
   * Every field is an observation the Host already holds — no probing of the network
   * and no starting of anything. The page renders it, and the same call is what its
   * self-check button runs, so an installed user can ask without a terminal.
   * @returns `{ ok, checks, facts }`.
   */
  diagnose() {
    const facts = this.describe();
    const checks = [];

    const record = readLaunchState();
    checks.push(record === null
      ? { id: 'bridge-record', level: 'warn', title: '桥还没有启动记录',
          detail: 'MCP 服务器尚未拉起过（插件刚装好，或桥那一行被停用了）。记录会写在 cache/status.json。' }
      : { id: 'bridge-record', level: 'ok', title: `桥已拉起（${record.mode ?? '未知方式'}）`,
          detail: `启动于 ${record.writtenAt ?? '未知时间'}，spec=${record.spec ?? '未知'}` });

    const mode = facts.resolution?.mode ?? null;
    // `resolution.mode` is how the *bridge row* starts things (`shim` = through
    // `launcher.mjs`); the rung the shim actually picked is in the launch record. Showing
    // the internal word "shim" on its own told the reader nothing.
    const rung = typeof record?.mode === 'string' ? record.mode : null;
    checks.push(mode === 'bare'
      ? { id: 'launcher', level: 'warn', title: '没找到绝对 node，回落到了 PATH 上的 npx',
          detail: '这在 GUI 启动且 PATH 不含 node 管理器时会失败。装一个全局 rea，或让 dsh 自带运行时可用。' }
      : { id: 'launcher', level: 'ok',
          title: `启动方式：${rung ?? '未知'}${mode === 'shim' ? '（由启动器按阶梯选出）' : ''}`,
          detail: (facts.resolution?.notes ?? []).join('；') || '无补充说明' });

    const driftReason = {
      'skill-refresh-failed': `技能拉取失败：${facts.skill.error ?? '未知原因'}（正在用包内兜底副本，稍后自动重试）`,
      'skill-not-fetched': '技能还没成功拉取过，当前用的是包内兜底副本。',
      'spec-mismatch': `桥在 ${facts.drift.expected ?? '未知'}，技能在 ${facts.drift.actual ?? '未知'}；技能会在下一次轮询跟上。`,
      'floating-tag': '桥用的是浮动 tag 且在本技能抓取之后重启过 —— 它可能已解析到更新的发布版，点「检查更新」确认。',
      'no-bridge-record': '没有桥的启动记录可比对。',
    }[facts.drift.reason] ?? '';
    checks.push(facts.drift.state === 'aligned'
      ? { id: 'version', level: 'ok', title: `技能与桥同版本（${facts.skill.appliedSpec}）`,
          detail: facts.skill.version === null ? '技能的构件版本尚未解析' : `解析到 ${facts.skill.version}` }
      : { id: 'version', level: 'warn',
          title: facts.drift.state === 'unverified' ? '版本可能不一致（浮动 tag，无法离线判定）'
            : facts.drift.state === 'stale' ? '技能与桥的版本不一致'
              : '还不能判断版本是否对齐',
          detail: driftReason });

    checks.push(this.skill.error === null
      ? { id: 'skill', level: 'ok', title: `技能来源：${this.skill.origin === 'npm' ? 'npm 官方原件' : '包内兜底副本'}`,
          detail: this.skill.sourceDirectory }
      : { id: 'skill', level: 'fail', title: '技能刷新失败，正在用包内兜底副本',
          detail: this.skill.error });

    // Reported in terms of what the reader controls — the skill switch — rather than the
    // registry method this half happens to call: the method name is an implementation
    // detail, and it is not even part of upstream's published provider contract.
    checks.push(this.invalidation === 'ok'
      ? { id: 'catalog', level: 'ok', title: '技能开关即时生效',
          detail: '拨动开关后，模型下一步就能看到技能目录的变化（约 1 秒）。' }
      : this.invalidation === 'unknown'
        // Before the first sync settles there is nothing to report; calling that
        // "unavailable" would warn about a state nobody has observed.
        ? { id: 'catalog', level: 'ok', title: '技能开关的生效方式尚未判定',
            detail: '第一次同步完成后会有结论。' }
        : { id: 'catalog', level: 'warn', title: `技能开关可能延迟生效（${this.invalidation}）`,
            detail: '多半是 dsh 升级改了内部方法。开关仍然可用，只是要等 provider 自己的稳定窗口才生效。' });

    let profile = null;
    try {
      const patchPath = profilePatchPath(this.ctx);
      if (patchPath !== undefined && existsSync(patchPath)) {
        const text = readFileSync(patchPath, 'utf8');
        const found = findBlocks(text);
        // "No block" and "a block whose spec cannot be read" are different states, and
        // `readPinnedSpec` answers `null` for both. Asking `findBlocks` separately is what
        // keeps the normal case — nothing pinned — from being reported as an anomaly.
        profile = { path: patchPath, hasBlock: found.blocks.length > 0, stray: found.stray, pinned: readPinnedSpec(text) };
      }
    } catch (error) {
      this.warn('reading the profile patch', error);
    }
    const bridgeSpec = typeof facts.bridge?.spec === 'string' ? facts.bridge.spec : null;
    checks.push(profile === null
      ? { id: 'pin', level: 'ok', title: '跟随最新（自动更新）',
          detail: '本部署没有 profile patch 文件；桥按插件自带的配置启动。' }
      : profile.stray !== null
        ? { id: 'pin', level: 'warn', title: `profile patch 里的管理块标记不成对（${profile.stray}）`,
            detail: `${profile.path} —— 为避免误删你的内容，「应用 / 跟随最新」不会写这个文件；请手工检查那几行。` }
        : profile.hasBlock !== true
          ? { id: 'pin', level: 'ok', title: '跟随最新（自动更新）',
              detail: 'profile patch 里没有本插件的版本覆盖块；每次桥启动都取当时的最新发布版。' }
          : profile.pinned === null
            ? { id: 'pin', level: 'warn', title: '覆盖块里没有 REA_SPEC',
                detail: `${profile.path} —— 可能是手工编辑过，建议在页面上点一次「跟随最新」把它清掉。` }
            : { id: 'pin',
                // A `$DSH_HOME`-level patch outranks this profile's, so the block can exist
                // while the bridge runs something else. The launcher's own record is the
                // tie-breaker; the file alone is not evidence of what runs.
                level: bridgeSpec !== null && bridgeSpec !== profile.pinned ? 'warn' : 'ok',
                title: `已钉到 ${profile.pinned}`,
                detail: bridgeSpec !== null && bridgeSpec !== profile.pinned
                  ? `但启动器记录的是 ${bridgeSpec} —— 可能被 $DSH_HOME 层的 patch 覆盖，或桥还没重启。`
                  : '由 profile patch 的覆盖块提供；点「跟随最新」即回到自动更新。' });

    let cache = null;
    try {
      cache = directorySize(join(PACKAGE_DIR, 'cache'));
    } catch { /* measured for information only */ }
    checks.push(cache === null
      ? { id: 'cache', level: 'warn', title: '缓存目录无法统计', detail: join(PACKAGE_DIR, 'cache') }
      : { id: 'cache', level: 'ok', title: `缓存 ${Math.round(cache.bytes / 1024)} KB`,
          detail: `${join(PACKAGE_DIR, 'cache')}（${cache.complete ? '已完整统计' : '统计未完成'}）` });

    return {
      ok: checks.every((check) => check.level === 'ok'),
      checks,
      facts: { ...facts, cache, profile, plugin: { version: LOCAL_PLUGIN_VERSION } },
    };
  }

  /**
   * Compare what runs here with what is published.
   *
   * Two independent questions, reported separately so one failing fetch cannot hide the
   * other's answer: is a newer REA release available, and is a newer version of this
   * bundle published. Neither result changes anything by itself — `setVersion` is what
   * acts, and it only ever acts when a person asks.
   * @returns `{ running, newest, newer, plugin, errors }`.
   */
  async checkUpdate() {
    const errors = [];
    const spec = runningSpec();
    const running = { spec, version: this.skill.version };

    // Two questions, not one: what the running spec resolves to *now* (a floating tag can
    // have moved since the skill was fetched), and what `latest` is. A pinned user must
    // still be able to learn that something newer exists, or the page reports "up to
    // date" forever. When the running spec *is* `latest` these are the same question and
    // it is asked once.
    const runningSpecUsed = spec ?? DEFAULT_SPEC;
    let resolved = null;
    let newest = null;
    try {
      const release = await resolveRelease(runningSpecUsed, {});
      resolved = release.version;
      newest = { version: release.version };
    } catch (error) {
      errors.push(`REA(${runningSpecUsed}): ${error?.message ?? error}`);
    }
    if (runningSpecUsed !== DEFAULT_SPEC) {
      try {
        const release = await resolveRelease(DEFAULT_SPEC, {});
        newest = { version: release.version };
      } catch (error) {
        errors.push(`REA(${DEFAULT_SPEC}): ${error?.message ?? error}`);
      }
    }

    let plugin = { local: LOCAL_PLUGIN_VERSION, remote: null, newer: null };
    try {
      const response = await fetch(
        `https://raw.githubusercontent.com/${PLUGIN_REPOSITORY}/main/rea-dsh/package.json`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const published = await response.json();
      plugin = {
        local: LOCAL_PLUGIN_VERSION,
        remote: typeof published?.version === 'string' ? published.version : null,
        newer: typeof published?.version === 'string' && published.version !== LOCAL_PLUGIN_VERSION
          ? published.version
          : null,
      };
    } catch (error) {
      errors.push(`插件: ${error?.message ?? error}`);
    }

    return {
      running: { ...running, resolved },
      newest,
      newer: newest !== null && this.skill.version !== null && newest.version !== this.skill.version,
      plugin,
      errors,
    };
  }

  /**
   * Pin the bridge to one spec, or drop the pin and follow `latest` again.
   *
   * The write goes into the profile patch — the one file dsh's HMR watches — as a
   * complete `config` override for the bridge row, because `applyEntryPatches` replaces
   * that object wholesale. `spec: ''` removes the block instead, which is the documented
   * way back to upstream's default.
   *
   * This method then **verifies its own effect**: it watches the launcher's record for a
   * new spawn, so the page can say whether the bridge actually picked the change up
   * rather than claiming success and leaving the user to find out.
   * @param spec - a version or dist-tag, or an empty string to follow `latest`.
   * @returns `{ ok, pinned, changed, reloaded, detail }`.
   */
  async setVersion(spec) {
    const normalized = typeof spec === 'string' ? spec.trim() : '';
    const patchPath = profilePatchPath(this.ctx);
    // Every exit reports the *actual* pin, including the failures: a rejected change
    // must not make the page claim the bridge follows latest when it is still pinned.
    const currentPin = () => {
      try {
        return patchPath === undefined ? null : readPinnedSpec(readFileSync(patchPath, 'utf8'));
      } catch {
        return null;
      }
    };

    if (normalized !== '' && !SPEC_PATTERN.test(normalized)) {
      return { ok: false, pinned: currentPin(), changed: false, reloaded: false,
        detail: `版本号只允许字母、数字、点、下划线与连字符：${JSON.stringify(normalized)}` };
    }

    if (patchPath === undefined || !existsSync(patchPath)) {
      return { ok: false, pinned: null, changed: false, reloaded: false,
        detail: '找不到本 profile 的 cordis.patch.yml，无法写入版本覆盖。' };
    }

    const before = readLaunchState();
    const previousLaunch = typeof before?.writtenAt === 'string' ? before.writtenAt : null;
    let block = null;
    let changed = false;
    let outcome = 'unchanged';
    try {
      if (normalized !== '') {
        const plan = launcher?.resolveLaunchPlan?.({ spec: normalized });
        if (plan === undefined || plan === null || typeof plan.command !== 'string') {
          return { ok: false, pinned: currentPin(), changed: false,
            reloaded: false, detail: '启动器没能给出可写入的启动方案。' };
        }
        block = renderOverrideBlock({ spec: normalized, plan });
      }
      const result = await writeOverrideBlock(patchPath, block);
      changed = result.changed;
      outcome = result.outcome;
    } catch (error) {
      return { ok: false, pinned: currentPin(), changed: false,
        reloaded: false, detail: `写入 profile patch 失败：${error?.message ?? error}` };
    }

    let reloaded = false;
    if (changed) {
      // A respawn alone is not proof — the bridge could have crashed and come back on
      // the old settings. The record has to name a *different* spec than it did before.
      const previousSpec = typeof before?.spec === 'string' ? before.spec : null;
      // A config override for that row makes the loader update it, and
      // dsh-mcp-client reloads the server connection for an edited entry
      // ("editing the configuration entry reloads the server connection in place").
      //
      // Measured on this harness: adding the block reloaded within ~10 s, removing it
      // took ~31 s, so the window is generous rather than tight. Waiting longer than
      // the common case still beats telling someone to restart a harness that was
      // about to reload on its own.
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        await sleep(500);
        const now = readLaunchState();
        if (typeof now?.writtenAt === 'string' && now.writtenAt !== previousLaunch
          && typeof now.spec === 'string' && now.spec !== previousSpec) {
          reloaded = true;
          break;
        }
      }
    }

    const pinned = currentPin();
    // Refusing and "nothing to do" are different answers, and only one of them means the
    // request was honoured. Reporting a refusal as "content already matched" would tell
    // someone their pin was applied while the bridge keeps running the old release.
    const refused = typeof outcome === 'string' && outcome.startsWith('refused-');
    return {
      ok: !refused,
      pinned,
      changed,
      reloaded,
      outcome,
      detail: refused
        ? outcome === 'refused-unterminated'
          ? 'profile patch 里的管理块只有开始标记、没有结束标记 —— 为避免误删你的内容，文件没有改动。请手工检查那一块。'
          : 'profile patch 里出现了形似管理块、但不含本插件那一行的标记 —— 为避免误删你的内容，文件没有改动。'
        : changed
          ? reloaded
            ? '已写入，桥已按新版本重新拉起。'
            : '已写入，但 45 秒内没看到桥重载（实测通常 10–30 秒）。重启 dsh，或在 Plugins 页把这一行停用再启用。'
          : '内容与现状一致，没有改动文件。',
    };
  }

  /**
   * Describe this row as the Client half's own read.
   *
   * Deliberately the same payload the page shows: there is no separate "config view"
   * any more. The method that used to serve one (`introspect`) was declared in three
   * places and called by nothing — the deployment it was written for renders this page
   * only when the settings mirror serves the row, and in every other composition the
   * page short-circuits before reaching a form. Removing it removed a promise the code
   * did not keep.
   * @returns this row's live configuration, schema defaults applied, plus status.
   */
  snapshot() {
    this.sync();
    return {
      ...snapshotConfig(this.config, (error) => this.warn('reading the configuration', error)),
      status: this.describe(),
    };
  }
}

/**
 * Mark Remote methods the way the TypeScript decorator transpiles to: one
 * versioned descriptor on the class prototype. Writing it here keeps this bundle
 * decorator-free and buildless while the Gateway still resolves the endpoint
 * through `remoteMethods()`.
 * @param prototype - the service class prototype.
 * @param methods - exported method names.
 */
function markRemoteMethods(prototype, methods) {
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map((method) => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  });
}

markRemoteMethods(ReaAgentsRuntime.prototype, ['snapshot', 'diagnose', 'checkUpdate', 'setVersion']);

/**
 * Mount the bundle for one profile row.
 * @param ctx - Host plugin context.
 * @param config - the row configuration.
 */
export function apply(ctx, config) {
  // NOTE: no `settings.configure({ auto: false })` here. The policy only controls
  // `autoGenerate` for clients that build pages from the schema, and this bundle ships
  // its own page; declaring it would add a second, unused owner for the same row. The
  // page is registered on `plugins.row.config`, which is a different slot from the
  // bundle-level auto form, so leaving the schema advertised costs nothing.
  new ReaAgentsRuntime(ctx, config);
}

export {
  CONFIG_DEFAULTS,
  readLaunchState,
  ReaAgentsRuntime,
  SKILLS_LIVE_DIR,
  SKILLS_SOURCE_DIR,
  SKILL_NAME,
  describeVersionDrift,
  syncLiveSkills,
};
