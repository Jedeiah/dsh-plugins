/**
 * Reverse Engineering — offline self-test.
 *
 *   node selftest.mjs [--app /path/to/app/dsh/node_modules/@deepseek-ai]
 *
 * The Host half imports `@deepseek-ai/dsh-typert-protocol`, which only resolves
 * inside a dsh installation. Instead of installing anything, this registers a
 * one-line resolver that anchors every `@deepseek-ai/*` specifier at the
 * installation's own package directory (`--app`, or the default location).
 *
 * Part A drives what the `skills` toggle is built from:
 *
 *  - `CONFIG_DEFAULTS` is read out of the schema, so it cannot drift away from
 *    the `Config` it claims to mirror (the reason `schemaDefaults` exists);
 *  - the schema's own default agrees with it — here `true`, matching upstream,
 *    which installs REA's matching skill alongside the MCP registration;
 *  - `.volatile()` really does arrive as a live handle, which is why
 *    `readConfigValue` unwraps one instead of reading the field directly;
 *  - `syncLiveSkills` links on, empties-but-keeps-the-directory off, and is
 *    idempotent — driven against a temporary directory pair, never the bundle's
 *    real `skills-live/`.
 *
 * Part B validates the hand-written Host manifest with the installation's own
 * `validateTypertManifest`.
 *
 * Part C covers the registry reader with a tarball built in memory, so the risky
 * code (PAX paths, path traversal, link entries) is exercised without a network
 * and without trusting whatever the registry happens to publish today.
 *
 * Part D pins the release wiring: one spec source, one reader, and a launch plan
 * whose `command` and `args` cannot come from two different rungs.
 *
 * Nothing outside a temporary directory is written, and nothing in the bundle is
 * touched. No network access is used.
 *
 * @module @jedeiah/rea-dsh/selftest
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = '@jedeiah/rea-dsh';
const DEFAULT_APP = '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai';

/** @returns the directory holding the installation's `@deepseek-ai/*` packages. */
function appDirectory() {
  const index = process.argv.indexOf('--app');
  return index === -1 ? DEFAULT_APP : process.argv[index + 1];
}

let failures = 0;
/**
 * Assert one condition.
 * @param label - what is being checked.
 * @param condition - the result.
 * @param detail - optional detail for the failure line.
 */
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

const app = appDirectory();
if (!existsSync(app)) {
  console.log(`\nskip — no dsh installation at ${app} (pass --app <path>)`);
  process.exit(0);
}

// Anchor this bundle's bare `@deepseek-ai/*` imports at the installation: a clone
// has no node_modules of its own (the profile links to the directory instead), and
// installing one just to run a self-test would be absurd.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return next(specifier, { ...context, parentURL: ${JSON.stringify(`file://${app}/`)} });
  }
  return next(specifier, context);
}
`), import.meta.url);

const host = await import(join(here, 'index.js'));
const { TYPERT } = await import(join(here, 'typert.js'));
const override = await import(join(here, 'profile-override.js'));
const source = await import(join(here, 'skill-source.js'));
const launcher = await import(join(here, 'launcher.cjs'));

/** Unwrap a volatile handle, exactly as the Host half must. */
const plain = (value) => (typeof value?.get === 'function' ? value.get() : value);

console.log("\nPart A — the toggle's building blocks");
{
  check('CONFIG_DEFAULTS was read from the schema, not hand-copied',
    Object.keys(host.CONFIG_DEFAULTS).join(',') === 'skills' && host.CONFIG_DEFAULTS.skills === true,
    JSON.stringify(host.CONFIG_DEFAULTS));

  const validated = host.Config['~standard'].validate({});
  check('the row configuration validates',
    validated.issues === undefined, JSON.stringify(validated.issues));
  check("the schema's own default agrees with CONFIG_DEFAULTS",
    validated.issues === undefined && plain(validated.value.skills) === host.CONFIG_DEFAULTS.skills,
    JSON.stringify(plain(validated.value.skills)));
  check('.volatile() arrives as a live handle (why readConfigValue exists)',
    typeof validated.value?.skills?.get === 'function');

  const root = mkdtempSync(join(tmpdir(), 'rea-dsh-selftest-'));
  const liveDir = join(root, 'live');
  const sourceDir = join(root, 'source');
  try {
    mkdirSync(join(sourceDir, 'reverse-engineer-anything'), { recursive: true });
    mkdirSync(join(sourceDir, 'second-skill'), { recursive: true });
    writeFileSync(join(sourceDir, 'reverse-engineer-anything', 'SKILL.md'), '# rea\n');

    check('off: reports no failures', host.syncLiveSkills(false, { liveDir, sourceDir }).length === 0);
    // The provider only watches roots that exist when it first looks, so the
    // directory has to be there even with nothing in it.
    check('off: the directory still exists', existsSync(liveDir));
    check('off: and holds nothing', readdirSync(liveDir).length === 0);

    check('on: reports no failures', host.syncLiveSkills(true, { liveDir, sourceDir }).length === 0);
    check('on: every source skill is exposed',
      readdirSync(liveDir).sort().join(',') === 'reverse-engineer-anything,second-skill',
      readdirSync(liveDir).join(','));
    check('on: entries are symlinks, not copies',
      lstatSync(join(liveDir, 'reverse-engineer-anything')).isSymbolicLink());

    check('repeating the same state changes nothing',
      host.syncLiveSkills(true, { liveDir, sourceDir }).length === 0
      && readdirSync(liveDir).sort().join(',') === 'reverse-engineer-anything,second-skill');

    host.syncLiveSkills(false, { liveDir, sourceDir });
    check('off again: the directory remains, emptied',
      existsSync(liveDir) && readdirSync(liveDir).length === 0);

    host.syncLiveSkills(true, { liveDir, sourceDir });
    check('a missing source directory is not an error',
      host.syncLiveSkills(true, { liveDir, sourceDir: join(root, 'absent') }).length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('\nPart A2 — the poll does not churn the watched directory');
{
  // The instance-level guard is what keeps a 1 Hz poll from rewriting the directory the
  // skill provider watches on every tick. The free `syncLiveSkills` rewrites by design,
  // so the runtime is constructed here over temporary directories, with the disposers
  // collected so the poll interval does not outlive the block.
  const root = mkdtempSync(join(tmpdir(), 'rea-dsh-poll-'));
  const source = join(root, 'source');
  const live = join(root, 'live');
  const disposers = [];
  mkdirSync(join(source, 'reverse-engineer-anything'), { recursive: true });
  writeFileSync(join(source, 'reverse-engineer-anything', 'SKILL.md'), '# from the temp source\n');
  writeFileSync(join(source, 'reverse-engineer-anything', 'provenance.txt'), 'temp\n');

  const ctx = {
    baseUrl: `file://${root}/`,
    logger: { warn: () => {}, info: () => {} },
    reflect: { provide: () => {} },
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    get: () => undefined,
    on: () => {},
  };
  try {
    const record = join(root, 'status.json');
    writeFileSync(record, `${JSON.stringify({ writtenAt: 't1', spec: 'latest', mode: 'npx' })}\n`);
    const runtime = new host.ReaAgentsRuntime(ctx, { skills: { get: () => true } }, {
      liveDir: live,
      launchStatePath: record,
      autoRefresh: false,
    });
    // The policy above is only useful if the poll actually consults it — and the refresh
    // itself would reach the network, so it is replaced by a counter here.
    const refreshes = [];
    runtime.refreshSkill = async () => { refreshes.push('refresh'); };
    // With the automatic refresh off, the startup attempt never happened — this is the
    // state right after it, so the assertions below are about the poll and nothing else.
    runtime.lastAttemptedSpec = 'latest';
    // Point the runtime at the temporary source so the assertions prove *this* source was
    // linked, rather than passing on the bundle's own copy.
    runtime.skill.sourceDirectory = source;
    runtime.sync();
    check('the runtime links the resolved source into the live directory',
      existsSync(join(live, 'reverse-engineer-anything', 'provenance.txt')));
    const before = statSync(live).mtimeMs;
    runtime.sync();
    runtime.sync();
    check('repeating a sync with unchanged inputs rewrites nothing',
      statSync(live).mtimeMs === before, `${String(before)} → ${String(statSync(live).mtimeMs)}`);
    runtime.skill.sourceDirectory = join(root, 'vanished');
    runtime.sync();
    check('a source that vanished falls back to the bundled copy instead of emptying the directory',
      existsSync(join(live, 'reverse-engineer-anything', 'SKILL.md'))
      && !existsSync(join(live, 'reverse-engineer-anything', 'provenance.txt')));
    // The pin line is what the page shows for "is a version pinned?". Its first version
    // reported the *normal* state — nothing pinned — as an anomaly, because it treated
    // `readPinnedSpec`'s null as "a block without a spec" when it also means "no block".
    const patch = join(root, 'cordis.patch.yml');
    const pinCheck = () => runtime.diagnose().checks.find((entry) => entry.id === 'pin');
    check('no patch file reads as following latest', pinCheck().level === 'ok' && pinCheck().title.includes('跟随最新'),
      JSON.stringify(pinCheck()));
    writeFileSync(patch, "- insert:\n    - id: keep-me\n      name: '@x/y'\n");
    check('a patch file without our block still reads as following latest',
      pinCheck().level === 'ok' && pinCheck().title.includes('跟随最新'), JSON.stringify(pinCheck()));
    writeFileSync(patch, `${readFileSync(patch, 'utf8')}\n${override.renderOverrideBlock({ spec: '6.4.0', plan: { command: '/abs/node', args: ['/abs/launcher.mjs', 'mcp'] } })}\n`);
    check('a block with a spec reads as pinned', pinCheck().title.includes('6.4.0'), JSON.stringify(pinCheck()));
    writeFileSync(patch, "- insert:\n    - id: keep-me\n\n# @jedeiah/rea-dsh: pinned bridge version (managed) — begin\n- id: rea-bridge\n  config:\n    serverName: rea\n");
    check('an unterminated block is reported as such rather than as a pin',
      pinCheck().level === 'warn' && pinCheck().title.includes('不成对'), JSON.stringify(pinCheck()));

    runtime.poll();
    check('a poll with nothing new does not refresh', refreshes.length === 0, String(refreshes.length));
    writeFileSync(record, `${JSON.stringify({ writtenAt: 't2', spec: 'latest', mode: 'npx' })}\n`);
    runtime.poll();
    check('a bridge respawn on a floating tag drives one refresh',
      refreshes.length === 1, String(refreshes.length));
    runtime.poll();
    check('and it does not repeat for the same spawn', refreshes.length === 1, String(refreshes.length));

    // The refresh policy, tested purely: no registry, no timer, and the reason is a value
    // rather than something implied by control flow.
    const policy = (over) => host.refreshReason({
      spec: 'latest', lastSpec: 'latest', spawn: 't2', lastSpawn: 't1', error: null, retryAfter: 0, now: 1, refreshing: false, ...over,
    });
    check('a changed spec refreshes', policy({ spec: '6.5.0' }) === 'spec-changed');
    check('a floating tag refreshes when the bridge respawned', policy({}) === 'tag-respawned');
    check('a concrete version does not refresh on a respawn',
      policy({ spec: '6.4.0', lastSpec: '6.4.0' }) === null);
    check('the same spawn does not refresh twice', policy({ lastSpawn: 't2' }) === null);
    // Isolated from the respawn rule, so the assertion is about the retry floor itself.
    const retryOnly = (over) => policy({ spawn: 't1', lastSpawn: 't1', error: 'boom', ...over });
    check('a failure retries once the floor has passed',
      retryOnly({ retryAfter: 0 }) === 'retry' && retryOnly({ retryAfter: 10, now: 5 }) === null);
    check('an in-flight refresh is never doubled', policy({ refreshing: true }) === null);

    check('the runtime reports the invalidation contract it found',
      ['ok', 'missing', 'unavailable', 'failed', 'unknown', 'refused'].includes(runtime.invalidation), runtime.invalidation);
  } catch (error) {
    check('the runtime can be constructed over temporary directories', false, String(error?.message ?? error));
  } finally {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* one failed teardown must not strand the rest */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('\nPart B — the hand-written Host manifest');
try {
  const { validateTypertManifest } = await import(join(app, 'dsh-typert-loader', 'lib', 'index.js'));
  validateTypertManifest(PACKAGE, TYPERT);
  check('TYPERT passes the installation validator', true);
} catch (error) {
  check('TYPERT passes the installation validator', false, String(error?.message ?? error));
}

/**
 * Build one ustar header.
 * @param options - `{ name, size, type, prefix }`.
 * @returns the 512-byte header block.
 */
function tarHeader({ name, size, type = '0', prefix = '' }) {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'binary');
  block.write('0000000\0', 108, 8, 'binary');
  block.write('0000000\0', 116, 8, 'binary');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'binary');
  block.write('00000000000\0', 136, 12, 'binary');
  block.write('        ', 148, 8, 'binary');
  block.write(type, 156, 1, 'binary');
  block.write('ustar\0', 257, 6, 'binary');
  block.write('00', 263, 2, 'binary');
  if (prefix !== '') block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'binary');
  return block;
}

/**
 * Build one tar entry, padded to the archive's block size.
 * @param name - the entry path.
 * @param data - its contents.
 * @param type - the ustar type flag.
 * @returns the entry's bytes.
 */
function tarEntry(name, data, type = '0') {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512, 0);
  return Buffer.concat([tarHeader({ name, size: payload.length, type }), payload, padding]);
}

/**
 * Build one PAX extended-header record, using the length-prefixed form.
 * @param key - the attribute name.
 * @param value - its value.
 * @returns the record text.
 */
function paxRecord(key, value) {
  const rest = ` ${key}=${value}\n`;
  const restBytes = Buffer.byteLength(rest);
  let digits = 1;
  while (String(restBytes + digits).length !== digits) digits += 1;
  return `${restBytes + digits}${rest}`;
}

console.log('\nPart C — the registry reader (built in memory, no network)');
{
  const longName = `package/skills/${'deep/'.repeat(30)}SKILL.md`;
  const archive = gzipSync(Buffer.concat([
    tarEntry('package/skills/reverse-engineer-anything/SKILL.md', '---\nname: x\n---\n'),
    tarEntry('package/skills/reverse-engineer-anything/references/one.md', 'reference body'),
    // A PAX header whose `path` must override the following entry's own name: the
    // short name here is a decoy, and npm tarballs do use this form.
    tarEntry('PaxHeaders/entry', paxRecord('path', longName), 'x'),
    tarEntry('decoy.md', 'the pax path must win'),
    tarEntry('package/index.js', 'not part of the skill payload'),
    tarEntry('package/skills/reverse-engineer-anything/link', '', '2'),
    Buffer.alloc(1024, 0),
  ]));

  const { files, links } = source.readTarGz(archive);
  const paths = files.map((file) => file.path);
  check('every regular file is read', files.length === 4, JSON.stringify(paths));
  check('the PAX path overrides the entry name', paths.includes(longName), JSON.stringify(paths));
  check('the decoy name is not used', !paths.includes('decoy.md'));
  check('link entries are reported, never followed', links.length === 1 && links[0].path.endsWith('/link'),
    JSON.stringify(links));

  check('absolute paths are refused', source.safeRelativePath('/etc/passwd') === null);
  check('traversal is refused', source.safeRelativePath('a/../../b') === null);
  check('empty segments are refused', source.safeRelativePath('a//b') === null);
  check('ordinary paths pass', source.safeRelativePath('a/b.md') === 'a/b.md');

  check('a sha512 SRI match is accepted',
    source.matchesIntegrity(Buffer.from('x'), {
      integrity: `sha512-${(await import('node:crypto')).createHash('sha512').update('x').digest('base64')}`,
    }));
  check('a wrong hash is rejected', source.matchesIntegrity(Buffer.from('x'), { integrity: 'sha512-AAAA' }) === false);
  check('an empty hash set is rejected', source.matchesIntegrity(Buffer.from('x'), {}) === false);
  check('a release with no hash at all is not trusted', source.hasVerifiableHash({}) === false);

  const root = mkdtempSync(join(tmpdir(), 'rea-dsh-tar-'));
  try {
    const written = source.writePayload(
      [{ path: 'reverse-engineer-anything/SKILL.md', data: Buffer.from('body') }],
      join(root, 'out'),
    );
    check('the payload writer writes relative paths', written.join(',') === 'reverse-engineer-anything/SKILL.md');
    check('the written bytes survive the round trip',
      readdirSync(join(root, 'out', 'reverse-engineer-anything')).includes('SKILL.md'));
    let refused = false;
    try {
      source.writePayload([{ path: '../escape.md', data: Buffer.from('x') }], join(root, 'out'));
    } catch {
      refused = true;
    }
    check('the payload writer refuses an escaping path', refused);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('\nPart D — one spec source, one launch plan');
{
  // The spec has exactly one home: the bridge row's own configuration, arriving as an
  // argument or as the environment the MCP client hands the child. No file is read,
  // so there is nothing to fall out of sync with the skill.
  const withoutSpec = (run) => {
    const saved = process.env.REA_SPEC;
    delete process.env.REA_SPEC;
    try {
      return run();
    } finally {
      if (saved !== undefined) process.env.REA_SPEC = saved;
    }
  };
  const withSpec = (spec, run) => {
    const saved = process.env.REA_SPEC;
    process.env.REA_SPEC = spec;
    try {
      return run();
    } finally {
      if (saved === undefined) delete process.env.REA_SPEC;
      else process.env.REA_SPEC = saved;
    }
  };
  check('an explicit spec wins over everything', launcher.resolveSpec('6.4.0') === '6.4.0');
  check('an empty explicit spec is ignored',
    withSpec('6.4.0', () => launcher.resolveSpec('   ')) === '6.4.0');
  check('the environment supplies the spec when no argument does',
    withSpec('6.4.0', () => launcher.resolveSpec()) === '6.4.0');
  check('with nothing declared the default is latest',
    withoutSpec(() => launcher.resolveSpec()) === 'latest');
  check('the environment is read per call, not cached at import', (() => {
    const first = withSpec('1.0.0', () => launcher.resolveSpec());
    const second = withSpec('2.0.0', () => launcher.resolveSpec());
    return first === '1.0.0' && second === '2.0.0';
  })());

  const plan = launcher.resolveLaunchPlan();
  check('the launch plan names a command', typeof plan.command === 'string' && plan.command !== '');
  check('the launch plan names arguments', Array.isArray(plan.args) && plan.args.length > 0);
  check('the launch plan reports its rung', typeof plan.mode === 'string' && plan.mode !== '');
  // Either the shim (which re-resolves at spawn time) or the bare fallback is
  // acceptable; mixing a shim command with bare arguments would not be.
  const consistent = plan.mode === 'shim'
    ? plan.args[0].endsWith('launcher.mjs')
    : plan.args.some((argument) => argument.startsWith('rea-agents@'));
  check('command and args come from the same rung', consistent, JSON.stringify(plan));

  // The bundled rung has to be reachable from the harness's *runtime* node, which is
  // a plain Node build with no `process.resourcesPath`. Derive the root from that
  // interpreter's own path, which is exactly what the launcher shim does at spawn
  // time, instead of trusting this test process's environment.
  // <Resources>/app/dsh/node_modules/@deepseek-ai → <Resources> is four levels up.
  const resources = join(app, '..', '..', '..', '..');
  const bundledNode = join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node');
  if (existsSync(bundledNode)) {
    const derived = launcher.resourcesFromExecutable(bundledNode);
    check('a resources root is derived from the runtime interpreter',
      typeof derived === 'string' && derived.endsWith(join('Contents', 'Resources')), String(derived));
    check('the bundled pnpm is found under the derived root',
      existsSync(join(derived ?? '', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')));
    const withPath = launcher.resolveSpawnPlan({ spec: '6.4.0' });
    const savedPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    let withoutPath;
    try {
      withoutPath = launcher.resolveSpawnPlan({ spec: '6.4.0' });
    } finally {
      process.env.PATH = savedPath;
    }
    check('a host with no package manager on PATH still gets a real command',
      withoutPath.command === bundledNode && withoutPath.args[0].endsWith('pnpm.mjs'),
      JSON.stringify(withoutPath));
    // Both directions, so the rung order is actually pinned: with a package manager on
    // PATH the npx rung wins (it reuses the cache the host already has), and only without
    // one does the bundled rung take over. The earlier form accepted every mode but
    // `bare`, which would have passed even if the order were reversed.
    check('with a package manager on PATH the npx rung is chosen', withPath.mode === 'npx', withPath.mode);
    check('without one the bundled rung is chosen', withoutPath.mode === 'bundled', withoutPath.mode);
    check('the requested spec reaches the child',
      withoutPath.args.some((argument) => argument.includes('rea-agents@6.4.0'))
      || withoutPath.env?.REA_SPEC === '6.4.0',
      JSON.stringify(withoutPath.args));
  } else {
    console.log('  skip no bundled runtime at this installation; bundled-rung checks not run');
  }

  const spawn = launcher.resolveSpawnPlan({ spec: '6.4.0' });
  check('the spawn plan honours an explicit spec',
    spawn.args.some((argument) => argument.includes('rea-agents@6.4.0')), JSON.stringify(spawn.args));
  check('the spawn plan explains its choice', Array.isArray(spawn.notes) && spawn.notes.length > 0);
  check('the spawn plan never returns an empty command', typeof spawn.command === 'string' && spawn.command !== '');
  if (spawn.env !== undefined) {
    check('the widened PATH keeps the inherited entries',
      String(spawn.env.PATH).includes(String(process.env.PATH ?? '').split(':')[0] ?? ''));
  }
}

console.log('\nPart E — release wiring invariants');
{
  check('the bundle carries no version file to keep in sync',
    !existsSync(join(here, 'rea-version.json')));

  const patch = await (await import('node:fs/promises')).readFile(join(here, 'cordis.patch.yml'), 'utf8');
  check('the patch documents the one pinning knob', patch.includes('REA_SPEC'));
  check('the bridge resolves its command through the launcher',
    /command:\s*!!js/.test(patch) && patch.includes('resolveLaunchPlan().command'));
  check('the bridge resolves its args through the launcher',
    /args:\s*!!js/.test(patch) && patch.includes('resolveLaunchPlan().args'));
  check('the bridge no longer hard-codes a package manager',
    !/command:\s*npx\b/.test(patch));
  check('the bridge never hard-codes a version',
    !/rea-agents@\d/.test(patch));

  // `unknown` means "no bridge record to align to" — never "the values matched",
  // which is the distinction that keeps a never-spawned bridge from looking healthy.
  check('no bridge record is reported as unknown, not aligned',
    host.describeVersionDrift(null, 'latest').state === 'unknown');
  check('a skill not yet on the recorded release is reported as stale',
    host.describeVersionDrift('6.4.0', null).state === 'stale');
  check('a matching spec is reported as aligned',
    host.describeVersionDrift('latest', 'latest').state === 'aligned');
  check('a different spec is reported as stale, with both values', (() => {
    const drift = host.describeVersionDrift('6.4.0', 'latest');
    return drift.state === 'stale' && drift.expected === '6.4.0' && drift.actual === 'latest';
  })());

  const index = await (await import('node:fs/promises')).readFile(join(here, 'index.js'), 'utf8');
  check('the host half reports the cache-invalidation contract',
    index.includes('invalidateCache') && index.includes('missing'));
  check('the host half degrades to the bundled copy on a failed refresh',
    index.includes('SKILLS_SOURCE_DIR') && index.includes('ensureSkillInCache'));
  check('the host half answers version drift from the launcher record, not from the declaration',
    index.includes('readLaunchState') && index.includes('describeVersionDrift'));
  check('the host half takes its version from the launcher record',
    index.includes('runningSpec') && !index.includes('rea-version.json'));
}

{
  // Which writer this environment can use is worth seeing: the harness's own lock and
  // atomic write are only reachable where `@deepseek-ai/dsh-atomic-write` resolves (the
  // host process, through peerDependencies), and the fallback is otherwise.
  const harnessWriter = await import('@deepseek-ai/dsh-atomic-write').catch(() => null);
  console.log(`\n  note 写入器：${harnessWriter === null
    ? '回退路径（tmp + rename；本进程解析不到 dsh-atomic-write）'
    : 'dsh 自己的文件锁 + writeFileAtomic'}）`.replace('）', ''));
}

console.log('\nPart F — the profile override block (pure; nothing is written)');
{
  const plan = {
    mode: 'shim',
    command: '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node',
    args: ['/Users/x/dsh-plugins/rea-dsh/launcher.mjs', 'mcp'],
  };
  const block = override.renderOverrideBlock({ spec: '6.4.0', plan });

  // `applyEntryPatches` assigns `config` wholesale, so a partial block would drop
  // serverName/transport and break the very row it configures.
  check('the block carries the complete config',
    ['serverName: rea', 'transport: stdio', 'command:', 'args:', 'REA_SPEC:'].every((needle) => block.includes(needle)));
  check('arguments and the command are both quoted',
    block.includes("'/Applications/DeepSeek Harness.app") && block.includes("'/Users/x/dsh-plugins"));
  check('the ports stay in the args list', block.includes("- 'mcp'"));
  check('a spec that is not version-shaped is refused', (() => {
    try {
      override.renderOverrideBlock({ spec: "6.4.0'\n- id: evil", plan });
      return false;
    } catch {
      return true;
    }
  })());

  const original = "- insert:\n    - id: keep-me\n      name: '@x/y'\n";
  const added = override.applyOverrideBlock(original, block);
  check('appending changes the text', added.changed === true);
  check('the original content is preserved verbatim', added.text.startsWith(original.trimEnd()));
  check('a second identical write changes nothing', override.applyOverrideBlock(added.text, block).changed === false);
  check('the pinned spec reads back', override.readPinnedSpec(added.text) === '6.4.0');
  check('a file without a block reads as following latest', override.readPinnedSpec(original) === null);

  const removed = override.applyOverrideBlock(added.text, null);
  check('removing restores the original text byte for byte', removed.text === original);
  check('removing twice is a no-op', override.applyOverrideBlock(removed.text, null).changed === false);

  // Measured against the harness's own YAML schema: `"\n"` and a comments-only file
  // both fail `Include`'s "top-level array" check, while `[]` passes. A removal that
  // leaves nothing must therefore leave an explicit empty list.
  const onlyBlock = override.applyOverrideBlock(`${override.BLOCK_BEGIN}\n- id: rea-bridge\n${override.BLOCK_END}\n`, null);
  check('removing the only content leaves an explicit empty list, not a bare newline',
    onlyBlock.text === '[]\n', JSON.stringify(onlyBlock.text));
  const commentOnly = override.applyOverrideBlock(`# 用户的注释\n${override.BLOCK_BEGIN}\n- id: rea-bridge\n${override.BLOCK_END}\n`, null);
  check('removing from a comments-only file keeps the comment and adds an empty list',
    commentOnly.text === '# 用户的注释\n[]\n', JSON.stringify(commentOnly.text));
  const blockThenEntry = override.applyOverrideBlock(`${override.BLOCK_BEGIN}\n- id: rea-bridge\n${override.BLOCK_END}\n\n- id: later\n`, null);
  check('removing keeps whatever followed the block',
    blockThenEntry.text === '- id: later\n', JSON.stringify(blockThenEntry.text));

  // W4: the markers are matched as whole lines, so a user's own text that merely
  // *mentions* them is not mistaken for our block. Before this, a comment naming the
  // begin marker made the next removal delete the user's rows with it.
  const mention = `# 说明：${override.BLOCK_BEGIN} 这一段由插件管理\n- id: user-row\n  config:\n    a: 1\n`;
  const mentioned = override.applyOverrideBlock(mention, null);
  check('a comment that mentions the begin marker is not treated as our block',
    mentioned.changed === false && mentioned.text === mention, mentioned.outcome);
  check('that file still holds the user row', mention.includes('- id: user-row'));

  // W3: refusing is not the same answer as "already correct", and the caller has to be
  // able to tell them apart.
  const markerPair = `${override.BLOCK_BEGIN}\n- id: somebody-else\n${override.BLOCK_END}\n`;
  const foreign = override.applyOverrideBlock(`- id: user-row\n\n${markerPair}`, null);
  check('a marker pair without our row is refused, not removed',
    foreign.outcome === 'refused-unrecognised' && foreign.changed === false, foreign.outcome);
  const unterminatedOnly = `- id: user-row\n\n${override.BLOCK_BEGIN}\n`;
  check('a begin marker with no end marker is refused as unterminated',
    override.applyOverrideBlock(unterminatedOnly, null).outcome === 'refused-unterminated');
  check('refusal beats "unchanged" in the reporting',
    override.applyOverrideBlock(original, null).outcome === 'unchanged');

  // W5: two blocks must not survive as two — `applyEntryPatches` applies patches in
  // order, so a stale second block would beat the one just written.
  const doubled = `${original}${block}\n\n${block}\n`;
  const deduplicated = override.applyOverrideBlock(doubled, block);
  check('writing over duplicate blocks leaves exactly one',
    deduplicated.text.split(override.BLOCK_BEGIN).length === 2,
    String(deduplicated.text.split(override.BLOCK_BEGIN).length - 1));
  const cleared = override.applyOverrideBlock(doubled, null);
  check('removing clears every block',
    cleared.changed === true && !cleared.text.includes(override.BLOCK_BEGIN)
    && cleared.text === original, JSON.stringify(cleared.text.slice(0, 40)));

  // The sha1-only form is what older publishes carry; it has to verify too, or a
  // perfectly good release would be refused for lacking the newer field.
  check('a sha1 shasum alone verifies', source.matchesIntegrity(Buffer.from('x'), {
    shasum: createHash('sha1').update('x').digest('hex'),
  }));
  check('a sha1 shasum that does not match is refused',
    source.matchesIntegrity(Buffer.from('x'), { shasum: 'a'.repeat(40) }) === false);
  check('a sha1-only release counts as verifiable', source.hasVerifiableHash({ shasum: 'a'.repeat(40) }) === true);

  // `writeOverrideBlock` is the only function that touches a real user file, so it gets
  // driven for real — into a temporary directory — rather than only through the pure
  // splice: it takes the harness's file lock and writes atomically, and both of those
  // live outside the pure path.
  const disk = mkdtempSync(join(tmpdir(), 'rea-dsh-override-'));
  try {
    const patch = join(disk, 'cordis.patch.yml');
    writeFileSync(patch, "- insert:\n    - id: keep-me\n      name: '@x/y'\n", { mode: 0o600 });
    const first = await override.writeOverrideBlock(patch, block);
    check('writing to disk reports a write', first.changed === true && first.outcome === 'written'
      && first.pinnedSpec === '6.4.0', JSON.stringify(first));
    check('the file now carries the block and still carries the user row',
      readFileSync(patch, 'utf8').includes('- id: keep-me') && readFileSync(patch, 'utf8').includes('REA_SPEC'));
    check('the mode is preserved as 0600', (statSync(patch).mode & 0o777) === 0o600,
      (statSync(patch).mode & 0o777).toString(8));
    const second = await override.writeOverrideBlock(patch, block);
    check('a second identical write does not touch the file',
      second.changed === false && second.outcome === 'unchanged', JSON.stringify(second));
    const removed = await override.writeOverrideBlock(patch, null);
    check('removing from disk restores the original text',
      removed.changed === true
      && readFileSync(patch, 'utf8') === "- insert:\n    - id: keep-me\n      name: '@x/y'\n");
    check('no lock or staging file is left behind',
      !readdirSync(disk).some((entry) => entry.endsWith('.lock') || entry.includes('.tmp')));
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }

  const unterminated = `${original}${override.BLOCK_BEGIN}\n- id: rea-bridge\n`;
  check('a block missing its end marker is left untouched',
    override.applyOverrideBlock(unterminated, null).changed === false
    && override.applyOverrideBlock(unterminated, block).changed === false);

  check('the patch path is derived from the profile base url',
    override.profilePatchPath({ baseUrl: 'file:///Users/x/.dsh/profiles/desktop/' })
      === '/Users/x/.dsh/profiles/desktop/cordis.patch.yml');
  check('an unavailable profile location yields no path',
    override.profilePatchPath({}) === undefined);
}

console.log('\nPart G — the three declaration sites agree');
{
  const read = (await import('node:fs/promises')).readFile;
  const clientSource = await read(join(here, 'client.js'), 'utf8');
  const indexSource = await read(join(here, 'index.js'), 'utf8');

  const manifestMethods = TYPERT.invocations.map((entry) => entry.method);
  check('the manifest declares every method this page calls',
    ['snapshot', 'diagnose', 'checkUpdate', 'setVersion'].every((method) => manifestMethods.includes(method)),
    JSON.stringify(manifestMethods));

  // The runtime marker the gateway actually reads, rather than a string in the source:
  // a method can exist on the class and still be invisible to the Gateway if the
  // prototype marker disagrees.
  const marker = Object.getOwnPropertyDescriptor(
    host.ReaAgentsRuntime.prototype,
    '@deepseek-ai/dsh-typert-protocol/remote-methods',
  );
  const marked = marker?.value?.methods?.map((entry) => entry.method) ?? [];
  check('the prototype marker lists exactly the manifest methods',
    marked.slice().sort().join(',') === manifestMethods.slice().sort().join(','),
    JSON.stringify(marked));
  check('every marked method is a direct invocation',
    (marker?.value?.methods ?? []).every((entry) => entry.invocation?.kind === 'direct'));

  for (const method of manifestMethods) {
    // `client.js` builds these ids from `BUNDLE_NAME`, so the source text contains
    // `#reaAgents/<method>` rather than the expanded package-qualified id.
    check(`client.js mirrors ${method}`, clientSource.includes(`#reaAgents/${method}`));
    check(`the host implements ${method}`, typeof host.ReaAgentsRuntime.prototype[method] === 'function');
  }

  // The reverse direction: a mirror entry with no manifest counterpart is the blank-page
  // trap, and it is invisible in any test that only walks the manifest.
  const mirrored = new Set(
    [...clientSource.matchAll(/#reaAgents\/([A-Za-z]+)/g)].map((match) => match[1]),
  );
  // The gateway resolves with an envelope, not with the method's own return value. Losing
  // this unwrapping is invisible to every offline test and shows up on the page as `?`
  // where a version should be — which is exactly what happened once already.
  check('the client half unwraps the Remote envelope',
    clientSource.includes('answer.ok === true') && /unwrap\(/g.test(clientSource)
    && (clientSource.match(/unwrap\(/g) ?? []).length >= 3,
    String((clientSource.match(/unwrap\(/g) ?? []).length));

  check('client.js declares nothing the manifest does not',
    [...mirrored].every((method) => manifestMethods.includes(method)),
    JSON.stringify([...mirrored]));
}

console.log('\nPart H — the installer, driven by an injected fetch');
{
  const SKILL = source.SKILL_NAME;
  const sri = (buffer) => `sha512-${createHash('sha512').update(buffer).digest('base64')}`;

  /**
   * Build a tarball whose payload is a minimal skill.
   * @param extra - additional entries to append before the end blocks.
   * @returns the gzipped bytes.
   */
  const buildTarball = (extra = []) => gzipSync(Buffer.concat([
    tarEntry(`package/skills/${SKILL}/SKILL.md`, '---\nname: x\n---\nbody\n'),
    tarEntry(`package/skills/${SKILL}/references/a.md`, 'ref\n'),
    ...extra,
    Buffer.alloc(1024, 0),
  ]));

  /**
   * A fetch stand-in serving one version manifest and its tarball.
   * @param bytes - the tarball to serve.
   * @param options - `{ version, integrity }` overrides.
   * @returns a fetch-compatible function.
   */
  const registryFor = (bytes, options = {}) => {
    const version = options.version ?? '9.9.9';
    const urls = new Map([
      [`https://registry.test/rea-agents/${version}`, {
        ok: true,
        status: 200,
        json: async () => ({
          version,
          dist: { tarball: `https://registry.test/pkg/${version}.tgz`, integrity: options.integrity ?? sri(bytes) },
        }),
      }],
      [`https://registry.test/pkg/${version}.tgz`, {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes,
        headers: { get: () => null },
      }],
    ]);
    return async (url) => urls.get(String(url))
      ?? { ok: false, status: 404, json: async () => ({}), headers: { get: () => null } };
  };

  const root = mkdtempSync(join(tmpdir(), 'rea-dsh-install-'));
  const cacheDir = join(root, 'cache');
  try {
    const bytes = buildTarball();
    const installed = await source.ensureSkillInCache({
      spec: '9.9.9', cacheDir, registry: 'https://registry.test', fetchImpl: registryFor(bytes),
    });
    check('a verified tarball installs', installed.version === '9.9.9' && installed.reused === false,
      JSON.stringify(installed.files));
    check('the payload lands under its version directory',
      existsSync(join(cacheDir, '9.9.9', SKILL, 'SKILL.md')) && existsSync(join(cacheDir, '9.9.9', SKILL, 'references', 'a.md')));
    const origin = JSON.parse(readFileSync(join(cacheDir, '9.9.9', '.origin.json'), 'utf8'));
    check('the origin record names the release and hashes every file',
      origin.version === '9.9.9' && origin.integrity === sri(bytes)
      && typeof origin.files[`${SKILL}/SKILL.md`] === 'string',
      JSON.stringify(Object.keys(origin.files)));
    check('no staging directory survives the install',
      !readdirSync(cacheDir).some((entry) => entry.startsWith('.staging-')));

    const again = await source.ensureSkillInCache({
      spec: '9.9.9', cacheDir, registry: 'https://registry.test', fetchImpl: registryFor(bytes),
    });
    check('a second run reuses the cache rather than downloading', again.reused === true);

    let mismatch = null;
    try {
      await source.ensureSkillInCache({
        spec: '9.9.9', cacheDir: join(root, 'bad'), registry: 'https://registry.test',
        fetchImpl: registryFor(bytes, { integrity: `sha512-${'A'.repeat(86)}==` }),
      });
    } catch (error) {
      mismatch = String(error?.message ?? error);
    }
    check('an integrity mismatch is refused', mismatch !== null && /integrity mismatch/.test(mismatch), String(mismatch));
    check('a refused install leaves no cache entry', !existsSync(join(root, 'bad', '9.9.9')));

    let escape = null;
    try {
      await source.ensureSkillInCache({
        spec: '9.9.9', cacheDir: join(root, 'esc'), registry: 'https://registry.test',
        fetchImpl: registryFor(buildTarball([tarEntry(`package/skills/${SKILL}/../../escape.md`, 'x')])),
      });
    } catch (error) {
      escape = String(error?.message ?? error);
    }
    check('a payload that escapes the extraction root is refused',
      escape !== null && /unsafe tar path|escaping/.test(escape), String(escape));

    // The GNU long-name form (`L`) is a different branch from PAX, and npm tarballs carry
    // both; the reader has to honour it or a long path silently becomes its truncated self.
    const longPath = `package/skills/${SKILL}/${'deep/'.repeat(24)}entry.md`;
    const longNameEntry = Buffer.concat([
      tarHeader({ name: '././@LongLink', size: Buffer.byteLength(longPath) + 1, type: 'L' }),
      Buffer.from(`${longPath}\0`, 'utf8'),
      Buffer.alloc((512 - ((Buffer.byteLength(longPath) + 1) % 512)) % 512, 0),
    ]);
    const { files: longFiles } = source.readTarGz(gzipSync(Buffer.concat([
      longNameEntry,
      tarEntry('././@LongLink', 'body'),
      Buffer.alloc(1024, 0),
    ])));
    check('a GNU long name overrides the truncated entry name',
      longFiles.some((file) => file.path === longPath), JSON.stringify(longFiles.map((file) => file.path)));

    let missing = null;
    try {
      await source.ensureSkillInCache({
        spec: '0.0.0-missing', cacheDir: join(root, 'missing'), registry: 'https://registry.test',
        fetchImpl: registryFor(bytes),
      });
    } catch (error) {
      missing = String(error?.message ?? error);
    }
    check('an unknown release is refused', missing !== null && /404/.test(missing), String(missing));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${String(failures)} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
