'use strict';

/**
 * Resolve how REA should be launched, synchronously.
 *
 * CommonJS on purpose: `cordis.patch.yml` evaluates `!!js` expressions
 * synchronously while the profile composes, so the bridge row asks this module for
 * `command`/`args` before any plugin `apply` runs. The Host half requires the same
 * module for diagnostics, so there is exactly one implementation of "how does REA
 * get started here".
 *
 * Why any of this exists: `command: npx` only works when `npx` happens to be on the
 * PATH the host passes down. That PATH is inherited from whatever launched the
 * harness, and on macOS a GUI launch does not necessarily carry the shell's node
 * manager (fnm/nvm/volta) directories. This module walks a fixed ladder instead,
 * and every rung is probeable and reportable rather than assumed:
 *
 *   1. global   a `rea` install on PATH, run through an absolute node
 *   2. npx      `npx`'s JS entry point, run through an absolute node
 *   3. bundled  the harness's own node + pnpm (`pnpm dlx`), needing no host node
 *   4. bare     literal `npx` — the pre-existing behaviour, kept as the last rung
 *
 * Rungs 1–3 need an absolute node, which the harness ships on desktop builds; rung
 * 4 is the only one that still depends on PATH, and the Host half reports it.
 *
 * @module @jedeiah/rea-dsh/launcher
 */

const { execFileSync } = require('node:child_process');
const { existsSync, realpathSync, statSync } = require('node:fs');
const { delimiter, dirname, join } = require('node:path');

/** This package's own directory — the anchor for the version file and the shim. */
const PACKAGE_DIR = __dirname;

/** The transparent launcher the bridge actually spawns. */
const SHIM = join(PACKAGE_DIR, 'launcher.mjs');

/** Platform switch, kept as a constant so the logic below reads the same on both. */
const WINDOWS = process.platform === 'win32';

/** @returns every directory on the current PATH, in order, without empties. */
function pathEntries() {
  return String(process.env.PATH ?? '').split(delimiter).filter((entry) => entry !== '');
}

/** @returns the current user's home directory, or an empty string. */
function homeDirectory() {
  return process.env.HOME || process.env.USERPROFILE || '';
}

/** @returns whether a path is an existing regular file. */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a symlink to its target, falling back to the original path.
 * @param path - the candidate path.
 * @returns the real path when it can be resolved, else the input.
 */
function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether a spec names one release rather than a moving tag.
 * @param spec - a version or dist-tag.
 * @returns whether it looks like a concrete version.
 */
function isConcreteSpec(spec) {
  return typeof spec === 'string' && /^\d+\.\d+\.\d+/.test(spec);
}

/**
 * Ask a global REA install which release it is.
 *
 * Bounded and best-effort: a CLI that hangs or answers something unexpected yields null,
 * which the caller reads as "cannot confirm this rung serves the request".
 * @param node - the node executable to run it with.
 * @param entry - the install's `scripts/rea.mjs`.
 * @returns the version string, or null.
 */
function globalReaVersion(node, entry) {
  try {
    const output = execFileSync(node, [entry, '--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const found = /(\d+\.\d+\.\d+[0-9A-Za-z.\-+]*)/.exec(String(output));
    return found === null ? null : found[1];
  } catch {
    return null;
  }
}

/**
 * Resolve which REA release to run, without consulting this package's own files.
 *
 * The spec has exactly one home: the bridge row's configuration in
 * `cordis.patch.yml`, which reaches this code as an argument (argv) or as the
 * environment the MCP client passes to the child it spawns. That is the harness's
 * own split — the settings README says volatile fields are what forms edit, and
 * "ordinary configuration remains editable through Cordis configuration files" —
 * and it keeps a value that a subprocess needs out of a bespoke side file.
 *
 * There is deliberately no fallback file: the skill the Host half exposes follows
 * the spec this launcher *records*, so a missing declaration degrades to `latest`
 * on both sides at once instead of letting two sources drift apart.
 * @param explicit - an explicit spec from the caller, which wins over everything.
 * @returns the spec string, never empty.
 */
function resolveSpec(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  const fromEnvironment = process.env.REA_SPEC;
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') return fromEnvironment.trim();
  return 'latest';
}

/**
 * Candidate harness resources roots (`…/Contents/Resources` on macOS).
 *
 * `process.resourcesPath` only exists inside Electron's own process. The launcher
 * shim, however, is started by the harness's *runtime* node — a plain Node build,
 * where that property is absent — so relying on it alone would make the bundled
 * rung unreachable in exactly the situation it exists for. The second source below
 * derives the same root from the interpreter that is running this code, which is
 * that node.
 * @returns candidate resources roots, best first.
 */
function resourcesFromExecutable(executable) {
  if (typeof executable !== 'string' || executable === '') return null;
  let directory = executable;
  for (let depth = 0; depth < 8; depth += 1) {
    directory = dirname(directory);
    if (directory === '' || directory === '.' || directory === '/') return null;
    if (isFile(join(directory, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'))) return directory;
  }
  return null;
}

/**
 * Candidate harness resources roots, best first.
 * @returns roots from Electron's own property and from the running interpreter.
 */
function resourcesRoots() {
  const roots = [];
  const declared = process.resourcesPath;
  if (typeof declared === 'string' && declared !== '') roots.push(declared);

  // Only a real Node build: under Electron, `execPath` is the application binary,
  // and spawning it would start a second app instead of running a script.
  if (process.versions?.electron === undefined) {
    const derived = resourcesFromExecutable(process.execPath);
    if (derived !== null) roots.push(derived);
  }
  return roots;
}

/**
 * Locate the harness's bundled pnpm, which is half of the self-sufficient rung.
 * @returns the absolute path to `pnpm.mjs`, or null.
 */
function findBundledPnpm() {
  for (const root of resourcesRoots()) {
    const candidate = join(root, 'runtime', 'pnpm', 'bin', 'pnpm.mjs');
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Candidate absolute `node` executables, best first.
 *
 * A node already running this code comes first: it is present and working by
 * definition. Then the harness's runtime, which needs no PATH at all. PATH entries
 * are last because they are exactly what may be missing under a GUI launch.
 * @returns absolute candidate paths, in preference order.
 */
function nodeCandidates() {
  const candidates = [];

  const executable = process.execPath;
  if (typeof executable === 'string' && process.versions?.electron === undefined) candidates.push(executable);

  // `DSH_DESKTOP_NODE_EXECUTABLE` is deliberately not a candidate: when the harness sets
  // it, it names the Electron application binary, not a node — spawning it would start a
  // second GUI instance. The harness's own runtime node is found through
  // {@link resourcesRoots}, which derives it from the interpreter already running.
  for (const root of resourcesRoots()) {
    candidates.push(join(root, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', WINDOWS ? 'node.exe' : 'node'));
    candidates.push(join(root, 'runtime', 'bin', WINDOWS ? 'node.cmd' : 'node'));
  }

  for (const entry of pathEntries()) candidates.push(join(entry, WINDOWS ? 'node.exe' : 'node'));
  return candidates;
}

/**
 * Locate an absolute node executable.
 * @returns the resolved path, or null when nothing usable is found.
 */
function findNode() {
  for (const candidate of nodeCandidates()) {
    if (isFile(candidate)) return realOrSelf(candidate);
  }
  return null;
}

/**
 * Locate an executable by name on PATH, then in the install roots a GUI launch
 * tends to omit.
 *
 * The extra roots matter more than they look: a harness started from the Dock gets
 * whatever PATH the app reconstructed, and Homebrew or a user-local prefix may be
 * absent from it even though the binary is installed.
 * @param name - the executable name without extension.
 * @returns the resolved path, or null.
 */
function findExecutable(name) {
  const file = WINDOWS ? `${name}.cmd` : name;
  const roots = [
    ...pathEntries(),
    join(homeDirectory(), '.local', 'bin'),
    join(homeDirectory(), '.bun', 'bin'),
    join(homeDirectory(), '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const root of roots) {
    if (root === '') continue;
    const candidate = join(root, file);
    if (existsSync(candidate)) return realOrSelf(candidate);
  }
  return null;
}

/**
 * Spell one REA package spec.
 *
 * Kept as a function so the shape is stated once: everything else in this module
 * composes it rather than concatenating strings inline.
 * @param spec - a version or dist-tag.
 * @returns the pnpm/npm spec string.
 */
function packageSpec(spec) {
  return `rea-agents@${spec}`;
}

/**
 * Resolve one launch plan.
 *
 * The returned `command`/`args` are what the bridge row should use verbatim; when a
 * node executable exists we route through {@link SHIM}, which re-resolves at spawn
 * time and owns process teardown. Only the no-node case falls back to spawning
 * `npx` directly.
 * @param options - `{ spec }` to override the declared spec (used by diagnostics).
 * @returns `{ mode, command, args, node, notes }`.
 */
function resolveLaunchPlan(options = {}) {
  const spec = resolveSpec(options.spec);
  const forward = Array.isArray(options.forward) ? options.forward : ['mcp'];
  const notes = [];
  const node = findNode();

  if (node === null) {
    notes.push('no absolute node executable found; falling back to PATH-resolved npx');
    return { mode: 'bare', command: 'npx', args: ['-y', packageSpec(spec), ...forward], node: null, notes };
  }

  notes.push(`node: ${node}`);
  // The shim owns rung selection, so a plan that has a node is always the shim.
  return { mode: 'shim', command: node, args: [SHIM, ...forward], node, notes, spec };
}

/**
 * The ladder the shim walks at spawn time, cheapest first: reuse what the host
 * already has (a global install, then its npm cache), and fall back to the
 * harness's own runtime, which needs nothing from the host.
 *
 * Split out from {@link resolveLaunchPlan} because the shim runs later than profile
 * composition: a `rea` the user installed in between should be picked up on the next
 * spawn without a restart.
 * @param options - `{ spec, forward }`; `forward` defaults to the `mcp` subcommand.
 * @returns `{ mode, command, args, env, notes }` — a complete argv for the child.
 */
function resolveSpawnPlan(options = {}) {
  const spec = resolveSpec(options.spec);
  const forward = Array.isArray(options.forward) ? options.forward : ['mcp'];
  const requested = packageSpec(spec);
  const node = findNode();
  const notes = [];

  // Rung 1: a global REA install. Its bin is a symlink to `scripts/rea.mjs`, so
  // realpath gives the entry point without asking npm where its global root is.
  const reaBin = WINDOWS ? null : findExecutable('rea');
  if (reaBin !== null && node !== null) {
    const entry = realOrSelf(reaBin);
    const wanted = isConcreteSpec(spec) ? spec : null;
    const installed = globalReaVersion(node, entry);
    // A global install runs *its own* release and takes no spec argument, so honouring a
    // pin means checking first: if it is not the requested version, this rung cannot
    // serve the request and the ladder continues to one that can.
    if (wanted === null || installed === wanted) {
      notes.push(`global rea: ${entry}${installed === null ? ' (版本无法确认)' : ` (${installed})`}`);
      return { mode: 'global', spec, command: node, args: [entry, ...forward], env: childEnvironment(node), notes };
    }
    notes.push(`global rea ${installed ?? '未知'} is not the requested ${wanted}; falling through`);
  } else if (reaBin !== null) {
    notes.push('global rea found but no node to run it with');
  }

  // Rung 2: npx's JS entry point, run by an absolute node. Resolving the symlink
  // avoids npm's shebang, which would need `node` on PATH again. This comes before
  // the bundled rung on purpose: it reuses the npm cache the user already has
  // instead of materialising a second copy of REA's dependency tree in pnpm's store.
  if (node !== null) {
    const npx = findExecutable('npx');
    const entry = npx === null ? null : realOrSelf(npx);
    if (entry !== null && /\.(c|m)?js$/.test(entry)) {
      notes.push(`npx entry: ${entry}`);
      return { mode: 'npx', spec, command: node, args: [entry, '-y', requested, ...forward], env: childEnvironment(node), notes };
    }
  }

  // Rung 3: the harness's own node plus its own pnpm. This is the self-sufficient
  // rung — the one that works on a machine with no user-level node at all, and the
  // one that still works when a GUI launch never carried the shell's PATH.
  if (node !== null) {
    const pnpm = findBundledPnpm();
    if (pnpm !== null) {
      notes.push(`bundled pnpm: ${pnpm}`);
      return {
        mode: 'bundled',
        spec,
        command: node,
        args: [pnpm, 'dlx', requested, ...forward],
        env: childEnvironment(node),
        notes,
      };
    }
  }

  // Rung 4: no node anywhere. Keep the historical shape so the failure is a
  // recognisable "npx is not on PATH" instead of a novel one.
  notes.push('no usable node; relying on a PATH-resolved npx');
  return { mode: 'bare', spec, command: WINDOWS ? 'npx.cmd' : 'npx', args: ['-y', requested, ...forward], env: undefined, notes };
}

/**
 * Build the child environment for rungs 1–3.
 *
 * PATH is widened rather than replaced: the probed directories go first so the
 * child's own `node`/`npx` lookups resolve, and the inherited PATH stays behind
 * them so nothing that used to work stops working.
 * @param node - the resolved node executable.
 * @returns an environment object for the child.
 */
function childEnvironment(node) {
  const extra = [];
  const nodeDir = node.slice(0, node.lastIndexOf(WINDOWS ? '\\' : '/'));
  if (nodeDir !== '') extra.push(nodeDir);
  const npx = WINDOWS ? null : findExecutable('npx');
  if (npx !== null) {
    const npxDir = npx.slice(0, npx.lastIndexOf('/'));
    if (npxDir !== '' && !extra.includes(npxDir)) extra.push(npxDir);
  }
  return { ...process.env, PATH: [...extra, String(process.env.PATH ?? '')].filter(Boolean).join(delimiter) };
}

module.exports = {
  PACKAGE_DIR,
  SHIM,
  WINDOWS,
  resolveSpec,
  findNode,
  findExecutable,
  resolveLaunchPlan,
  resolveSpawnPlan,
  resourcesRoots,
  resourcesFromExecutable,
  findBundledPnpm,
  childEnvironment,
};
