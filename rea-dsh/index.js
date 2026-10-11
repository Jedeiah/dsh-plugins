import z from '@deepseek-ai/schemastery';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * Snapshot every known field, so `introspect` never returns holes.
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

/** Where the shipped skill copy lives. */
const SKILLS_SOURCE_DIR = join(PACKAGE_DIR, 'skills');

/**
 * The directory the skill provider actually scans.
 *
 * The shipped `@deepseek-ai/dsh-skill-filesystem` provider is reused rather than
 * reimplemented — its discovery, frontmatter parsing and file watcher are
 * internal and would be lost by a reimplementation. To make the `skills` toggle
 * reach it, the toggle is turned into a filesystem event: when on, every skill
 * under {@link SKILLS_SOURCE_DIR} is linked into this directory; when off, the
 * directory is emptied. The provider's watcher (which follows symlinks by
 * default) then sees the skills appear or disappear on its own.
 */
const SKILLS_LIVE_DIR = join(PACKAGE_DIR, 'skills-live');

/**
 * Sync {@link SKILLS_LIVE_DIR} with the shipped skills according to `enabled`.
 *
 * The directory is created even when `enabled` is false. The provider's watcher
 * only watches roots that exist when it first looks, so a directory created
 * later — the first time someone flips the switch on — would never be noticed
 * and its skills would stay invisible until a restart. Creating it up front
 * makes the toggle a plain content change, which the watcher does see.
 *
 * Entries are symlinked rather than copied so the live directory costs nothing
 * and always reflects the shipped copy. Existing entries are cleared first, so a
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
  constructor(ctx, config) {
    super(ctx, 'reaAgents');
    this.ctx = ctx;
    this.config = config ?? {};
    this.applied = undefined;
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
   * Bring the live skill directory in line with the configured toggle.
   *
   * Idempotent: repeating the current state is a no-op, so the watcher can call
   * this cheaply.
   */
  sync() {
    const enabled = readConfigValue(
      this.config.skills,
      CONFIG_DEFAULTS.skills,
      (error) => this.warn('reading the skills toggle', error),
    ) === true;
    if (enabled === this.applied) return;
    const failed = syncLiveSkills(enabled);
    if (failed.length > 0) this.warn(`linking ${failed.join(', ')}`);
    this.applied = enabled;
    // Tell the skill registry its cached catalog is stale, so the agent sees the
    // new catalog on its next step. The provider's own file watcher does not
    // cover this: it only reacts to host mutations made through dsh tools, and it
    // cannot reach an agent that has already received a catalog anyway.
    //
    // KNOWN BOUNDARY: the '/' slash menu in the browser keeps its own per-session
    // cache (dsh-client-ui-skill) and only rebuilds it on `agent-preset/selected`
    // or `connection/reset`. A toggle therefore reaches the model immediately but
    // not that menu until the chat is reopened. See README.
    try { this.ctx?.get?.('skills')?.invalidateCache?.(); }
    catch (error) { this.warn('skills cache invalidation', error); }
  }

  /**
   * Poll the volatile toggle.
   *
   * The settings service rewrites a volatile field's value in place but emits no
   * change event, so the Host has to look. The interval is short enough to feel
   * immediate when someone flips the switch and long enough to cost nothing.
   * @param ctx - owning Cordis context.
   */
  startWatch(ctx) {
    const timer = setInterval(() => {
      try { this.sync(); } catch (error) { this.warn('skills sync', error); }
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
   * The Remote read the Client half falls back to when `configForms` is missing.
   *
   * This deliberately syncs before answering: the toggle's value and the live
   * directory are two halves of one fact, and a caller asking what the Host holds
   * wants the answer the filesystem agrees with, not the value from up to one
   * poll interval ago. The sync is idempotent, so the cost is one comparison.
   * @returns this row's live configuration with schema defaults applied.
   */
  introspect() {
    this.sync();
    return snapshotConfig(this.config, (error) => this.warn('reading the configuration', error));
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

markRemoteMethods(ReaAgentsRuntime.prototype, ['introspect']);

/**
 * Mount the bundle for one profile row.
 * @param ctx - Host plugin context.
 * @param config - the row configuration.
 */
export function apply(ctx, config) {
  // NOTE: no `settings.configure({ auto: false })` here. It would remove this row
  // from `configForms`' namespace list, and the Plugins page hands a row's page
  // its form only when that list contains the row id (`configForm(rowId)`); with
  // `auto: false` the page receives `undefined` and renders nothing. The custom
  // page below is registered on `plugins.row.config`, which is a different slot
  // from the bundle-level auto form, so leaving the schema advertised costs
  // nothing.
  new ReaAgentsRuntime(ctx, config);
}

export { CONFIG_DEFAULTS, ReaAgentsRuntime, SKILLS_LIVE_DIR, SKILLS_SOURCE_DIR, syncLiveSkills };
