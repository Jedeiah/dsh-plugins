import z from '@deepseek-ai/schemastery';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  throw new Error('chrome-devtools-mcp: could not import @deepseek-ai/dsh-typert-protocol', { cause: error });
}

/** Plugin name used by loader diagnostics. */
export const name = 'chrome-devtools-mcp';

/** Prototype key the Typert Remote markers live under. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * Host half of the chrome-devtools-mcp bundle.
 *
 * It owns two tunables — whether chrome-devtools-mcp's bundled skills are exposed
 * to the agent, and which browser the MCP server talks to — so both can be set in
 * `cordis.patch.yml` or on the bundle's page, instead of being edited here. Only
 * `.volatile()` fields are projected to the browser; the settings service turns
 * them into the form the Client half reads through `ctx.configForms`.
 *
 * The `browser` tunable reaches the MCP bridge by rewriting this profile's
 * `cordis.patch.yml`: the bundle ships two mutually exclusive rows
 * (`chrome-devtools-launch` / `chrome-devtools-attach`) and exactly one of them is
 * disabled. That file is watched by dsh's HMR, so the switch takes effect without
 * a restart when HMR is on (the code warns when it is not). The alternative — a
 * single row whose `args` a `!!js` expression derives from a file in this bundle —
 * was rejected because a file inside the bundle is not watched, so nothing would
 * notice the change.
 *
 * It also publishes the `chromeDevtoolsMcp` Remote service (see
 * {@link ChromeDevtoolsMcpRuntime}), which is what makes this bundle survive a
 * row switch: the Client half gates its settings entry on that service, so the
 * entry re-attaches by itself when the Host half is rebuilt. A Client half's own
 * `apply` is not re-run after 停用→启用 (deepseek-harness#8452), so a gate is the
 * only shape that works.
 *
 * `import z from '@deepseek-ai/schemastery'` is the documented way to describe a
 * Config. Because this bundle is linked in from outside the dsh installation,
 * the package must also be named in `peerDependencies` so the resolver routes
 * the bare specifier to the installation's copy.
 */
export const Config = z.object({
  /**
   * Expose chrome-devtools-mcp's bundled skills to the agent.
   *
   * Off by default, matching upstream: chrome-devtools-mcp ships as an MCP
   * server, and its README never mentions the skills directory. The skills are
   * an extra the repo publishes for agents that have a skill mechanism.
   */
  skills: z.boolean().default(false).volatile(),
  /**
   * Which browser the MCP server drives.
   *
   * - `launch` — the server starts its own Chrome, using
   *   `~/.cache/chrome-devtools-mcp/chrome-profile`. Nothing to set up; but it is a
   *   separate browser, so it has none of your tabs, cookies or logins.
   * - `attach` — the server drives the Chrome you are already using, so the agent
   *   sees your real session. Needs Chrome 144+ with Remote Debugging enabled at
   *   `chrome://inspect/#remote-debugging`, and Chrome asks for confirmation once
   *   per connection.
   *
   * Switching rewrites this profile's `cordis.patch.yml` to disable one of the two
   * mutually exclusive bridge rows; see the module doc above for why.
   */
  browser: z.union(['launch', 'attach']).default('launch').volatile(),
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
      console.warn('chrome-devtools-mcp: Config exposes no readable defaults; unread fields will not fall back');
    }
  } catch (error) {
    console.warn(`chrome-devtools-mcp: Config defaults could not be read: ${error?.message ?? error}`);
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

/** Where the shipped skill copies live. */
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
 * Absolute path of this profile's patch file.
 *
 * `ctx.baseUrl` is the *profile* directory, not the bundle directory — the same
 * trap the patch's `!!js` works around. Here it is exactly the right anchor: the
 * only file that can disable a bridge row is the profile's own `cordis.patch.yml`.
 * @param ctx - owning Cordis context.
 * @returns the patch path, or undefined when the profile location is unavailable.
 */
function profilePatchPath(ctx) {
  const base = String(ctx?.baseUrl ?? '');
  if (base === '') return undefined;
  try {
    return join(fileURLToPath(base), 'cordis.patch.yml');
  } catch {
    return undefined;
  }
}

/** Delimiters of the block this bundle owns inside the profile patch. */
const BROWSER_BLOCK_BEGIN = '# @jedeiah/chrome-devtools-mcp: browser mode (managed) — begin';
const BROWSER_BLOCK_END = '# @jedeiah/chrome-devtools-mcp: browser mode (managed) — end';

/** The two mutually exclusive bridge rows this bundle ships. */
const LAUNCH_ROW = 'chrome-devtools-launch';
const ATTACH_ROW = 'chrome-devtools-attach';

/**
 * Force exactly one of the two mutually exclusive bridge rows to be enabled.
 *
 * Both rows are written in one pass, so there is never a moment where both are
 * live — they share a `serverName`, and two at once is exactly what makes
 * `mcp-client` throw "serverName is already in use".
 *
 * Rewrites one delimited block instead of parsing and re-serializing the file: a
 * YAML round-trip would drop the user's comments and formatting, and this file is
 * theirs. The block is replaced in place when the markers are present, appended
 * otherwise.
 *
 * `disabled` is a plain field, not an expression — that is what makes the switch
 * apply without a restart. dsh's HMR watches this file, and the loader compares
 * entries by `id`, re-mounting only the rows that changed.
 *
 * Compare-before-write, so the 1s poll cannot keep rewriting the file and keep
 * re-mounting the rows.
 * @param patchPath - absolute path of the profile patch file.
 * @param mode - `launch` (this bundle's own Chrome) or `attach` (the user's).
 * @returns whether the file content actually changed.
 */
function writeBrowserMode(patchPath, mode) {
  const block = [
    BROWSER_BLOCK_BEGIN,
    `- id: ${LAUNCH_ROW}`,
    `  disabled: ${mode === 'launch' ? 'false' : 'true'}`,
    `- id: ${ATTACH_ROW}`,
    `  disabled: ${mode === 'attach' ? 'false' : 'true'}`,
    BROWSER_BLOCK_END,
  ].join('\n');
  const previous = readFileSync(patchPath, 'utf8');
  const start = previous.indexOf(BROWSER_BLOCK_BEGIN);
  let next;
  if (start === -1) {
    next = `${previous.replace(/\s*$/, '')}\n\n${block}\n`;
  } else {
    // `tail` keeps whatever followed the block, leading newline included, so an
    // unchanged mode round-trips to byte-identical text and the caller can tell
    // "wrote something" from "nothing to do".
    const end = previous.indexOf(BROWSER_BLOCK_END, start);
    const tail = end === -1 ? '' : previous.slice(end + BROWSER_BLOCK_END.length);
    next = `${previous.slice(0, start)}${block}${tail}`;
  }
  if (next === previous) return false;
  writeFileSync(patchPath, next);
  return true;
}

/**
 * The Remote service: the Host's authoritative view of this row's configuration.
 *
 * The Client half reads it when `configForms` is unavailable — a composition
 * without the settings UI — so the toggle still reflects what the Host holds
 * rather than a hard-coded snapshot. It doubles as the reactive dependency the
 * Client half's `ctx.inject` gate waits on.
 */
class ChromeDevtoolsMcpRuntime extends TypertRemoteService {
  /**
   * @param ctx - owning Cordis context.
   * @param config - the row configuration as Cordis delivers it (volatile fields
   *   are live references; see {@link readConfigValue}).
   */
  constructor(ctx, config) {
    super(ctx, 'chromeDevtoolsMcp');
    this.ctx = ctx;
    this.config = config ?? {};
    this.appliedSkills = undefined;
    this.appliedBrowser = undefined;
    // The first syncs touch the filesystem (they create or clear `skills-live/`)
    // and this profile's patch file. Neither may take the row down: this row also
    // carries the MCP bridge, which has nothing to do with either tunable, and a
    // load failure would read to the user as "the plugin is broken". Failures
    // degrade to "not applied yet" and the poll retries.
    try {
      this.syncSkills();
    } catch (error) {
      this.warn('initial skills sync', error);
    }
    try {
      this.syncBrowser();
    } catch (error) {
      this.warn('initial browser sync', error);
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
      this.ctx?.logger?.warn?.(`chrome-devtools-mcp: ${what} failed${detail}`);
    } catch { /* a logger that throws must not become the failure */ }
  }

  /**
   * Report an informational event — something that worked, but that the operator
   * should know about, such as "written, but a restart is needed to apply it".
   * @param message - what happened.
   */
  notify(message) {
    try {
      this.ctx?.logger?.info?.(`chrome-devtools-mcp: ${message}`);
    } catch { /* a logger that throws must not become the failure */ }
  }

  /**
   * Bring the live skill directory in line with the `skills` tunable.
   *
   * Idempotent: repeating the current state is a no-op, so the watcher can call
   * this cheaply.
   */
  syncSkills() {
    const enabled = readConfigValue(
      this.config.skills,
      CONFIG_DEFAULTS.skills,
      (error) => this.warn('reading the skills toggle', error),
    ) === true;
    if (enabled === this.appliedSkills) return;
    const failed = syncLiveSkills(enabled);
    if (failed.length > 0) this.warn(`linking ${failed.join(', ')}`);
    this.appliedSkills = enabled;
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
   * Bring this profile's patch file in line with the `browser` tunable.
   *
   * The two bridge rows share a `serverName`, so exactly one may be enabled; this
   * writes the override that disables the other. Idempotent and compare-before-
   * write: a steady state costs one config read and never touches the file, so
   * dsh's HMR is not re-triggered on every poll.
   */
  syncBrowser() {
    const mode = readConfigValue(
      this.config.browser,
      CONFIG_DEFAULTS.browser,
      (error) => this.warn('reading the browser tunable', error),
    ) === 'attach' ? 'attach' : 'launch';
    if (mode === this.appliedBrowser) return;
    const patchPath = profilePatchPath(this.ctx);
    if (patchPath === undefined) {
      this.warn('locating the profile patch file');
      return;
    }
    let changed;
    try {
      changed = writeBrowserMode(patchPath, mode);
    } catch (error) {
      this.warn(`writing the browser mode to ${patchPath}`, error);
      return;
    }
    this.appliedBrowser = mode;
    // dsh's HMR watches this file, and the loader compares entries by `id`, so the
    // row this disables and the row it enables are re-mounted on their own — no
    // restart, no `plugin_manager` call, no other row touched.
    //
    // It must *not* be two `setPluginEnabled` calls: the first returns before the
    // row it disabled has unloaded, so the second trips `mcp-client`'s "serverName
    // is already in use". Writing both rows in one pass has no such window.
    if (changed && this.ctx?.get?.('hmr') === undefined) {
      this.notify(`switched to "${mode}" — restart dsh to apply (HMR is not running)`);
    }
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
      try { this.syncSkills(); } catch (error) { this.warn('skills sync', error); }
      try { this.syncBrowser(); } catch (error) { this.warn('browser sync', error); }
    }, 1000);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      ctx.effect(() => () => clearInterval(timer), 'chrome-devtools-mcp: skills toggle poll');
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
    this.syncSkills();
    this.syncBrowser();
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

markRemoteMethods(ChromeDevtoolsMcpRuntime.prototype, ['introspect']);

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
  new ChromeDevtoolsMcpRuntime(ctx, config);
}

export { CONFIG_DEFAULTS, ChromeDevtoolsMcpRuntime, SKILLS_LIVE_DIR, SKILLS_SOURCE_DIR, syncLiveSkills, writeBrowserMode };
