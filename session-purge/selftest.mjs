/**
 * Session Purge — offline self-test.
 *
 *   node selftest.mjs [--app /path/to/app/dsh/node_modules/@deepseek-ai]
 *
 * Part A builds a synthetic dsh store (session logs as real multi-frame
 * Zstandard files, a projection checkpoint, a spill directory, attachment
 * objects) and drives `engine.js` against it: plan, purge, and assert that what
 * was referenced only by the deleted sessions is gone while everything a
 * surviving session references stays.
 *
 * Part B runs when a dsh installation is reachable: it validates the hand-written
 * Host manifest with the installation's own `validateTypertManifest`, then boots
 * the real Cordis context + Typert registry + API gateway around the Host half and
 * invokes `sessionPurge.inspect` and `sessionPurge.purge` through the gateway —
 * the same path the browser takes — including the live-session refusal.
 *
 * Part B2 checks the premises DESIGN.md v8 stands on (§14, I4) against dsh's own
 * persistence, session, agent and storage services — no stubs except the empty
 * llm/tools/system-prompt hubs, which a resume never calls before a turn. It
 * exercises nothing in this plugin; it answers "does dsh behave the way the
 * design assumes", so a dsh upgrade that breaks an assumption fails here first.
 *
 * Nothing outside the temporary directory is read or written, except reading the
 * installation's packages.
 *
 * @module @jedeiah/session-purge/selftest
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, open as openFile, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP = '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai';

/** @returns the app package directory from argv or the default location. */
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

/** One Zstandard log frame, exactly as the JSONL backend writes them. */
function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

/** A stored session log: a header frame plus one frame of events. */
function storedLog(header, events) {
  return Buffer.concat([frame(`${JSON.stringify(header)}\n`), frame(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`)]);
}

/** The same two lines in the raw-line shape (`compression: 'none'`). */
function storedRaw(header, events) {
  return Buffer.from(`${JSON.stringify(header)}\n${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

/**
 * Build a synthetic dsh home.
 * @param root - the temporary directory to fill.
 * @returns the paths a purge configuration needs.
 */
console.log('\nPart 0 — the package manifest\'s display resources');
{
  const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
  const exported = manifest.exports ?? {};
  // dsh 0.2.1 reads display text from the exported locale JSON and the icon from
  // an exported resource (`<package>/icon`), without activating the plugin. The
  // top-level `icon` field still wins, but it is the legacy spelling.
  check('exports the locale dictionaries', exported['./locale/*.json'] === './locale/*.json');
  check('exports the icon at ./icon', exported['./icon'] === './icon.svg', String(exported['./icon']));

  const icon = readFileSync(join(here, 'icon.svg'));
  check('the icon is an SVG under the 256 KiB display limit',
    icon.byteLength < 256 * 1024 && /^\s*<svg[\s>]/.test(icon.subarray(0, 64).toString('utf8')),
    `${String(icon.byteLength)} bytes`);

  const shipped = manifest.files ?? [];
  check('files ships the icon and the dictionaries',
    shipped.includes('icon.svg') && shipped.includes('locale/*.json'), shipped.join(','));

  const languages = readdirSync(join(here, 'locale'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5));
  check('the locale directory ships en and zh', languages.includes('en') && languages.includes('zh'), languages.join(','));
  for (const language of languages) {
    const dictionary = JSON.parse(readFileSync(join(here, 'locale', `${language}.json`), 'utf8'));
    check(`locale/${language}.json titles the plugin`,
      typeof dictionary?.meta?.title === 'string' && dictionary.meta.title.trim() !== '');
    check(`locale/${language}.json describes the plugin`,
      typeof dictionary?.meta?.description === 'string' && dictionary.meta.description.trim() !== '');
  }
}

async function buildStore(root, options = {}) {
  const raw = options.raw === true;
  const write = raw ? storedRaw : storedLog;
  const file = raw ? 'session.v2.jsonl' : 'session.v4.jsonl.zstd';
  const version = raw ? 2 : 4;
  const sessionsRoot = join(root, 'sessions');
  const storagesRoot = join(root, 'storages');
  const attachmentsRoot = join(root, 'attachments');
  const spillRoot = join(root, 'tmp', 'dsh-spill-abc123');
  const project = join(sessionsRoot, '--Users-me-projects-doomed--');
  const survivorProject = join(sessionsRoot, '--Users-me-projects-kept--');
  const nestedProject = join(sessionsRoot, '--Users-me-projects-nested--');
  const parentId = 'session-parent-0000';
  const childId = '11111111-2222-3333-4444-555555555555';
  const grandId = '22222222-3333-4444-5555-666666666666';
  const forkId = 'session-fork-0000';
  const keptId = 'session-kept-0000';
  const doomedDigest = 'a'.repeat(64);
  const keptDigest = 'b'.repeat(64);
  const sharedDigest = 'c'.repeat(64);

  for (const id of [parentId, childId, forkId]) await mkdir(join(project, id), { recursive: true });
  await mkdir(join(survivorProject, keptId), { recursive: true });
  await mkdir(join(nestedProject, grandId), { recursive: true });
  await mkdir(join(storagesRoot, 'session_projcache', 'sessions'), { recursive: true });
  await mkdir(join(attachmentsRoot, 'v1', 'objects', doomedDigest.slice(0, 2)), { recursive: true });
  await mkdir(join(attachmentsRoot, 'v1', 'objects', keptDigest.slice(0, 2)), { recursive: true });
  await mkdir(join(attachmentsRoot, 'v1', 'objects', sharedDigest.slice(0, 2)), { recursive: true });
  await mkdir(join(attachmentsRoot, 'v1', 'files', doomedDigest.slice(0, 2), doomedDigest), { recursive: true });
  await mkdir(join(spillRoot, `session-${createHash('sha256').update(parentId).digest('hex').slice(0, 12)}`), { recursive: true });

  const cwd = '/Users/example/projects/demo';
  await writeFile(join(project, parentId, file), write(
    { type: 'session', version, id: parentId, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 },
    [
      { type: 'session/title', seq: 1, time: 2, data: { title: 'Synthetic parent' } },
      { type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'image', source: `sha256:${doomedDigest}` }] } },
      { type: 'user/message', seq: 3, time: 4, data: { content: [{ type: 'image', source: `sha256:${sharedDigest}` }] } },
    ],
  ));
  await writeFile(join(project, childId, file), write(
    { type: 'session', version, id: childId, createdAt: 2, cwd, parentSession: parentId, isSeeded: false, origin: 'subagent', delegationDepth: 1 },
    [{ type: 'session/title', seq: 1, time: 3, data: { title: 'Synthetic child' } }],
  ));
  await writeFile(join(survivorProject, keptId, file), write(
    { type: 'session', version, id: keptId, createdAt: 3, cwd, isSeeded: false, delegationDepth: 0 },
    [
      { type: 'session/title', seq: 1, time: 4, data: { title: 'Survivor' } },
      { type: 'user/message', seq: 2, time: 5, data: { content: [{ type: 'image', source: `sha256:${keptDigest}` }] } },
      { type: 'user/message', seq: 3, time: 6, data: { content: [{ type: 'image', source: `sha256:${sharedDigest}` }] } },
    ],
  ));
  await writeFile(join(nestedProject, grandId, file), write(
    { type: 'session', version: 4, id: grandId, createdAt: 3, cwd, parentSession: childId, isSeeded: false, origin: 'subagent', delegationDepth: 2 },
    [{ type: 'session/title', seq: 1, time: 4, data: { title: 'Synthetic grandchild' } }],
  ));
  await writeFile(join(project, forkId, 'session.v4.jsonl.zstd'), storedLog(
    { type: 'session', version: 4, id: forkId, createdAt: 4, cwd, parentSession: parentId, isSeeded: true, delegationDepth: 0 },
    [{ type: 'session/title', seq: 1, time: 5, data: { title: 'Independent fork' } }],
  ));
  const titles = { 'session-parent-0000': 'Synthetic parent', [childId]: 'Synthetic child', [grandId]: 'Synthetic grandchild', [forkId]: 'Independent fork', 'session-kept-0000': 'Survivor' };
  for (const [id, title] of Object.entries(titles)) {
    await writeFile(join(storagesRoot, 'session_projcache', 'sessions', `${id}.json`), JSON.stringify({ version: 7, record: { rows: { title: { ver: 1, seq: 1, val: title } } } }));
  }
  await writeFile(join(attachmentsRoot, 'v1', 'objects', doomedDigest.slice(0, 2), doomedDigest), 'doomed bytes');
  // Projection residue the storage domain can leave behind: an invalid-record
  // backup and an atomic write that never landed.
  await writeFile(join(storagesRoot, 'session_projcache', 'sessions', `${parentId}.json.bak.202610030101`), '{"version":7,"record":{"rows":{}}}');
  await writeFile(join(storagesRoot, 'session_projcache', 'sessions', `${parentId}.json.deadbeef1234.tmp`), '{}');
  await writeFile(join(attachmentsRoot, 'v1', 'objects', keptDigest.slice(0, 2), keptDigest), 'kept bytes');
  await writeFile(join(attachmentsRoot, 'v1', 'objects', sharedDigest.slice(0, 2), sharedDigest), 'shared bytes');
  await writeFile(join(attachmentsRoot, 'v1', 'files', doomedDigest.slice(0, 2), doomedDigest, 'report.png'), 'link');
  await writeFile(join(spillRoot, `session-${createHash('sha256').update(parentId).digest('hex').slice(0, 12)}`, 'tool-output.txt'), 'spilled');

  return { root, sessionsRoot, storagesRoot, attachmentsRoot, spillRoot, project, survivorProject, nestedProject, parentId, childId, grandId, forkId, keptId, doomedDigest, keptDigest, sharedDigest };
}

/** @returns the canonical path (the temp directory is a symlink on macOS). */
async function realpathOf(path) {
  return realpath(path);
}

/** @returns whether a path exists. */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Part A: drive the filesystem engine against the synthetic store.
 * @param store - the synthetic store description.
 */
async function testEngine(store) {
  console.log('\nPart A — engine against a synthetic store');
  const engine = await import(join(here, 'engine.js'));

  const index = await engine.indexStoredSessions(store.sessionsRoot);
  check('indexes every stored session (parent, child, grandchild, fork, survivor)', index.size === 5, `saw ${String(index.size)}`);

  // Generation selection: newest compressed generation wins, and a raw-line store
  // (`compression: 'none'`) is ranked numerically, not lexicographically.
  check('picks the newest compressed generation', engine.selectLogFile(['session.v2.jsonl.zstd', 'session.v10.jsonl.zstd']) === 'session.v10.jsonl.zstd');
  check('falls back to the newest raw-line generation', engine.selectLogFile(['session.v2.jsonl', 'session.v10.jsonl', 'session.v9.jsonl']) === 'session.v10.jsonl');
  check('returns nothing for a directory without a log', engine.selectLogFile(['session.lock']) === undefined);

  const plan = await engine.planPurge({ root: store.sessionsRoot, sessionId: store.parentId, includeDescendants: true, spillRoots: [store.spillRoot] });
  check('plan includes the session, its subagent child and its grandchild', plan.targetIds.length === 3 && plan.targetIds.includes(store.childId) && plan.targetIds.includes(store.grandId), plan.targetIds.join(','));
  check('a fork is NOT lineage and stays out of the target set', !plan.targetIds.includes(store.forkId) && plan.forkIds.includes(store.forkId), `targets=${plan.targetIds.join(',')} forks=${plan.forkIds.join(',')}`);
  check('plan finds the spilled output directory', plan.spillDirectories.length === 1, plan.spillDirectories.join(','));
  check('plan totals logs plus spill', plan.sizeBytes >= plan.logBytes + plan.spillBytes && plan.spillBytes > 0, JSON.stringify({ log: plan.logBytes, spill: plan.spillBytes, total: plan.sizeBytes }));
  const shallow = await engine.planPurge({ root: store.sessionsRoot, sessionId: store.parentId, includeDescendants: false });
  check('includeDescendants: false plans only the selected session', shallow.targetIds.length === 1 && shallow.targetIds[0] === store.parentId);

  const warnings = [];
  const digests = await engine.unreferencedDigests({
    doomed: plan.targets.map((target) => target.directory),
    survivors: [join(store.survivorProject, store.keptId)],
  });
  check('only the doomed digest is unreferenced (a shared one is kept)', digests.size === 1 && digests.has(store.doomedDigest) && !digests.has(store.sharedDigest), [...digests].join(','));
  const directories = await engine.removeSessionDirectories({ plan, removeEmptyProjectDirectory: true, warnings });
  check('removes every target directory', directories.sessionDirectories === 3 && directories.removedIds.length === 3 && directories.failedIds.length === 0, JSON.stringify(directories));
  check('drops only the emptied project directory', directories.projectDirectories === 1, JSON.stringify(directories));
  check('parent log is gone', !(await exists(join(store.project, store.parentId))));
  check('subagent log is gone', !(await exists(join(store.project, store.childId))));
  check('the grandchild in another project directory is gone', !(await exists(join(store.nestedProject, store.grandId))));
  check('the fork still exists and keeps its project directory', await exists(join(store.project, store.forkId)) && await exists(store.project));
  check('survivor log is untouched', await exists(join(store.survivorProject, store.keptId)));

  const records = await engine.removeProjectionRecords({ storagesRoot: store.storagesRoot, ids: plan.targetIds, warnings });
  check('removes every projection document of the targets, including .bak and .tmp residue', records === 5, `${String(records)} of [${(await readdir(join(store.storagesRoot, 'session_projcache', 'sessions'))).join(', ')}]`);
  check('the fork\'s and survivor\'s projection records stay', await exists(join(store.storagesRoot, 'session_projcache', 'sessions', `${store.forkId}.json`)) && await exists(join(store.storagesRoot, 'session_projcache', 'sessions', 'session-kept-0000.json')));
  check('survivor projection record stays', await exists(join(store.storagesRoot, 'session_projcache', 'sessions', 'session-kept-0000.json')));

  const spill = await engine.removeSpillDirectories({ ids: plan.targetIds, roots: [store.spillRoot], warnings });
  check('removes the spill directory', spill === 1, String(spill));
  check('prunes the emptied spill root', !(await exists(store.spillRoot)));

  const attachments = await engine.removeAttachments({ root: store.attachmentsRoot, digests, warnings });
  check('removes the doomed object and its reference link', attachments.objects === 1 && attachments.links === 1, JSON.stringify(attachments));
  check('keeps the survivor object', await exists(join(store.attachmentsRoot, 'v1', 'objects', store.keptDigest.slice(0, 2), store.keptDigest)));
  check('keeps the object two sessions shared', await exists(join(store.attachmentsRoot, 'v1', 'objects', store.sharedDigest.slice(0, 2), store.sharedDigest)));
  check('no warnings were raised', warnings.length === 0, warnings.join(' | '));

  // The same flow over a raw-line store (`compression: 'none'`): the generation
  // selector ranks `.jsonl` generations numerically and the digest scanner reads
  // plain lines instead of Zstandard frames.
  const raw = await buildStore(join(store.root, 'raw-store'), { raw: true });
  const rawIndex = await engine.indexStoredSessions(raw.sessionsRoot);
  check('indexes a raw-line store', rawIndex.size === 5, `saw ${String(rawIndex.size)}`);
  check('reads the raw store\'s header and title', rawIndex.get(raw.parentId)?.header?.id === raw.parentId && (await engine.readStoredTitle(rawIndex.get(raw.parentId).directory)) === 'Synthetic parent');
  const rawPlan = await engine.planPurge({ root: raw.sessionsRoot, sessionId: raw.parentId, includeDescendants: true });
  const rawWarnings = [];
  const rawDigests = await engine.unreferencedDigests({
    doomed: rawPlan.targets.map((target) => target.directory),
    survivors: [join(raw.survivorProject, raw.keptId)],
  });
  check('finds the unreferenced digest in raw lines', rawDigests.size === 1 && rawDigests.has(raw.doomedDigest), [...rawDigests].join(','));
  const rawRemoved = await engine.removeSessionDirectories({ plan: rawPlan, removeEmptyProjectDirectory: true, warnings: rawWarnings });
  check('deletes a raw-line session, its child and its grandchild', rawRemoved.sessionDirectories === 3 && !(await exists(join(raw.project, raw.parentId))), JSON.stringify(rawRemoved));
  check('the raw-line survivor stays readable', await exists(join(raw.survivorProject, raw.keptId, 'session.v2.jsonl')));
}

/**
 * Part A3: the transaction store on its own — no dsh installation needed.
 * @param root - a scratch directory.
 */
async function testTransactionStore(root) {
  console.log('\nPart A3 — transaction store (txn.js)');
  const txn = await import(join(here, 'txn.js'));
  const engine = await import(join(here, 'engine.js'));

  check('session artifacts are recognised', ['session.lock', 'session.jsonl', 'session.v4.jsonl.zstd', 'session.migration.ab12.jsonl.zstd.tmp'].every((name) => txn.isSessionArtifact(name)));
  check('anything else is not a session artifact', !['notes.txt', 'session.md', 'sessions.json', 'report.png'].some((name) => txn.isSessionArtifact(name)));

  check('a checkpoint of the deleted log matches its tombstone', txn.checkpointIdentityMatches({ createdAt: 5, cwd: '/a' }, { createdAt: 5, cwd: '/a', formatVersion: 4 }));
  check('a new session under the same id does not', !txn.checkpointIdentityMatches({ createdAt: 5, cwd: '/a' }, { createdAt: 6, cwd: '/a' }));
  check('another cwd does not', !txn.checkpointIdentityMatches({ createdAt: 5, cwd: '/a' }, { createdAt: 5, cwd: '/b' }));
  check('a record without an identity does not', !txn.checkpointIdentityMatches({ createdAt: 5 }, undefined));

  const sessions = join(root, 'sessions');
  await mkdir(sessions, { recursive: true });
  const staging = await txn.stagingRootFor(sessions);
  check('the staging root is a sibling of the session root', staging === join(await realpathOf(root), txn.STAGING_DIRECTORY), staging);
  await txn.ensureStagingRoot(staging);

  const manifest = { version: txn.MANIFEST_VERSION, runId: txn.newRunId(), path: 'immediate', targets: [], entries: [], outcome: null };
  await txn.writeManifest(staging, manifest);
  const runs = await txn.listRuns(staging);
  check('a manifest round-trips', runs.length === 1 && runs[0].manifest?.runId === manifest.runId);
  check('no temporary file is left next to it', (await readdir(runs[0].directory)).every((name) => !name.endsWith('.tmp')));
  await mkdir(join(staging, 'runs', 'zz-garbage'), { recursive: true });
  await writeFile(join(staging, 'runs', 'zz-garbage', 'manifest.json'), '{"version":1,"runId":"zz-garbage","targets":[]}');
  const withGarbage = await txn.listRuns(staging);
  check('a manifest of another version is unknown residue, never acted on', withGarbage.length === 2 && withGarbage.find((run) => run.runId === 'zz-garbage')?.manifest === undefined);

  // Commit and identity: a rename keeps the inode, so identity follows the move.
  const project = join(sessions, '--project--');
  const source = join(project, 'session-x');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'session.jsonl'), '{}\n');
  const before = await txn.entryIdentity(source);
  const staged = txn.stagedPathFor(staging, manifest.runId, source);
  await txn.commitEntry(source, staged);
  check('the commit moves the entry out of the tree', !existsSync(source) && existsSync(join(staged, 'session.jsonl')));
  check('identity follows the moved entry', before !== undefined && (await txn.entryIdentity(staged)) === before);
  await txn.cleanupEntry({ stagedPath: staged, linked: false }, []);
  check('a committed directory is removed whole', !existsSync(staged));

  // A linked entry whose target was swapped after the commit is left alone.
  if (process.platform !== 'win32') {
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'session.jsonl'), '{}\n');
    const link = join(project, 'session-linked');
    await symlink(outside, link, 'dir');
    const recorded = await txn.targetIdentity(link);
    const linkStaged = txn.stagedPathFor(staging, manifest.runId, link);
    await txn.commitEntry(link, linkStaged);
    await rm(outside, { recursive: true, force: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'session.jsonl'), 'someone else\'s\n');
    const warnings = [];
    await txn.cleanupEntry({ stagedPath: linkStaged, linked: true, realTarget: outside, realTargetIdentity: recorded }, warnings);
    check('a linked target swapped since the commit is not touched', existsSync(join(outside, 'session.jsonl')) && warnings.some((line) => line.includes('identity-drift')), JSON.stringify(warnings));
    check('the moved link itself is removed', !existsSync(linkStaged));
  }

  // The engine indexes a linked session directory and marks it.
  if (process.platform !== 'win32') {
    const store = join(root, 'linked-store');
    const real = join(root, 'linked-real', 'session-l');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'session.jsonl'), `${JSON.stringify({ type: 'session', version: 2, id: 'session-l', createdAt: 1 })}\n`);
    await mkdir(join(store, '--p--'), { recursive: true });
    await symlink(real, join(store, '--p--', 'session-l'), 'dir');
    const index = await engine.indexStoredSessions(store);
    check('a linked session directory is indexed and marked linked', index.get('session-l')?.linked === true, JSON.stringify([...index.keys()]));
  }

  // In-process serialization holds without flock (Windows' situation).
  const order = [];
  const slow = txn.withGlobalLock(staging, undefined, async () => { order.push('a-start'); await new Promise((resolve) => setTimeout(resolve, 30)); order.push('a-end'); });
  const fast = txn.withGlobalLock(staging, undefined, async () => { order.push('b'); });
  await Promise.all([slow, fast]);
  check('two operations on one staging root never overlap', order.join(',') === 'a-start,a-end,b', order.join(','));

  // The audit rotates instead of growing without bound.
  await writeFile(join(staging, 'audit.jsonl'), Buffer.alloc(8 * 1024 * 1024, 0x20));
  await txn.appendAudit(staging, { runId: 'r', outcome: 'verified' });
  check('a full audit file is rotated', existsSync(join(staging, 'audit.1.jsonl')) && (await readFile(join(staging, 'audit.jsonl'), 'utf8')).trim().split('\n').length === 1);
}

/**
 * Spill-root discovery must accept only the backend's own root shape and must
 * never treat a look-alike directory as its own.
 */
async function testSpillDiscovery() {
  console.log('\nPart A2 — spill-root discovery');
  const { discoverSpillRoots, SPILL_ROOT_PATTERN } = await import(join(here, 'engine.js'));
  const base = tmpdir();
  const valid = await mkdtemp(join(base, 'dsh-spill-'));
  const validName = valid.slice(base.length + 1);
  const foreign = join(base, 'dsh-spill-test-abc');
  await mkdir(foreign, { recursive: true });
  try {
    check('the backend root shape is accepted', SPILL_ROOT_PATTERN.test(validName), validName);
    check('a look-alike root is rejected', !SPILL_ROOT_PATTERN.test('dsh-spill-test-abc') && !SPILL_ROOT_PATTERN.test('dsh-spill-toolong1'));
    const roots = await discoverSpillRoots();
    check('discovery finds the real root and skips the look-alike', roots.includes(valid) && !roots.includes(foreign), roots.join(', '));
  } finally {
    await rm(valid, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }
}

/**
 * Part B: run the Host half through the installation's own Cordis + gateway.
 * @param app - the installation's package directory.
 * @param workroot - a scratch directory for the module-resolution shim.
 * @returns whether the part ran.
 */
async function testGateway(app, workroot) {
  if (!(await exists(join(app, 'cordis', 'lib', 'index.js')))) {
    console.log('\nPart B — skipped (no dsh installation at the default path; pass --app)');
    return false;
  }
  console.log('\nPart B — Host half through the real Cordis context and API gateway');

  // Bare specifiers inside the bundle resolve through the installation's copies,
  // exactly as the app's resolver routes them for a `link:` bundle. A scratch
  // package tree with the same two names reproduces that without touching the
  // plugin directory or the profile.
  const modules = join(workroot, 'modules');
  const bundle = join(modules, 'session-purge');
  await mkdir(join(modules, 'node_modules', '@deepseek-ai'), { recursive: true });
  await cp(join(here, 'index.js'), join(bundle, 'index.js'));
  await cp(join(here, 'engine.js'), join(bundle, 'engine.js'));
  await cp(join(here, 'txn.js'), join(bundle, 'txn.js'));
  await cp(join(here, 'typert.js'), join(bundle, 'typert.js'));
  // Windows cannot create directory symlinks without Developer Mode or elevation,
  // so the shim uses a junction there; every other platform takes a plain symlink.
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const name of ['schemastery', 'dsh-typert-protocol', 'dsh-home-paths', 'node-addon-system']) {
    await symlink(join(app, name), join(modules, 'node_modules', '@deepseek-ai', name), linkType);
  }

  const { Context } = await import(join(app, 'cordis', 'lib', 'index.js'));
  const { TypertRegistry } = await import(join(app, 'dsh-typert-registry', 'lib', 'index.js'));
  const { TypertGatewayService } = await import(join(app, 'dsh-api-gateway', 'lib', 'index.js'));
  // 0.2.1 made every Remote call name its Peer: `prepareInvocation` reads
  // `request.peer.signal` and `.principal`, and the Gateway no longer falls back
  // to an operator peer (0.2.0 called `request.peer ?? this.operatorPeer()`).
  const { Peer } = await import(join(app, 'dsh-client-connection', 'lib', 'index.js'));
  const { validateTypertManifest } = await import(join(app, 'dsh-typert-loader', 'lib', 'index.js'));
  const host = await import(join(bundle, 'index.js'));
  const manifest = await import(join(bundle, 'typert.js'));

  try {
    validateTypertManifest('@jedeiah/session-purge', manifest.TYPERT);
    check('hand-written TYPERT manifest passes the installation validator', true);
  } catch (error) {
    check('hand-written TYPERT manifest passes the installation validator', false, String(error));
  }

  const store = await buildStore(join(workroot, 'gateway-store'));
  const config = host.Config['~standard'].validate({
    sessionsRoot: store.sessionsRoot,
    storagesRoot: store.storagesRoot,
    attachmentsRoot: store.attachmentsRoot,
    spillRoots: [store.spillRoot],
    // Recovery is driven by hand below; a timer would race the tests.
    recoveryDelayMs: -1,
  });
  if (config.issues !== undefined) {
    check('row configuration validates', false, JSON.stringify(config.issues));
    return true;
  }
  const plain = (value) => (typeof value?.get === 'function' ? value.get() : value);
  check('row configuration validates and fills defaults', plain(config.value.includeDescendants) === true && plain(config.value.purgeAttachments) === false, JSON.stringify([plain(config.value.includeDescendants), plain(config.value.purgeAttachments)]));
  check('volatile fields arrive as live references', typeof config.value.includeDescendants?.get === 'function');

  const { tryLockExclusive } = await import(join(app, 'node-addon-system', 'lib', 'flock.js'));
  const engine = await import(join(here, 'engine.js'));
  const txn = await import(join(here, 'txn.js'));
  const named = (name, message) => Object.assign(new Error(message), { name });
  const leases = process.platform !== 'win32';

  /**
   * The persistence seam the fence talks to, backed by a synthetic store: a write
   * open is refused for an owned id and otherwise takes the same kernel lease the
   * JSONL backend takes on `session.lock`. Part B2 shows dsh's real seam behaves
   * this way; here it lets Part B drive the plugin's own logic over synthetic logs
   * (the real backend insists on its own cwd-derived layout).
   * @param root - the synthetic session root.
   * @param options - `reportedRoot` to lie about the root, `lease: false` to skip the lock.
   * @returns the stub.
   */
  const stubPersistence = (root, options = {}) => ({
    root: options.reportedRoot ?? root,
    owned: new Set(),
    async open(id, access) {
      if (access === 'write' && this.owned.has(id)) throw named('SessionAlreadyOwnedError', `session "${id}" is already owned by an active write handle`);
      const record = (await engine.indexStoredSessions(root)).get(id);
      if (record === undefined) throw named('SessionPersistenceNotFoundError', `session "${id}" not found`);
      if (access !== 'write') return { header: record.header, close: async () => undefined };
      let lease;
      if (options.lease !== false && leases) {
        lease = await openFile(join(record.directory, 'session.lock'), 'w');
        await tryLockExclusive(lease.fd);
      }
      return { header: record.header, inheritedEventCount: 0, close: async () => { await lease?.close(); } };
    },
  });

  const boot = (settings, persistence) => {
    const ctx = new Context();
    new TypertRegistry(ctx);
    ctx.typert.register(manifest.TYPERT);
    const gateway = new TypertGatewayService(ctx, {});
    const seam = persistence ?? stubPersistence(settings.sessionsRoot);
    ctx.provide('sessionPersistence', seam);
    host.apply(ctx, settings);
    const peer = new Peer(ctx, { principal: { kind: 'owner' } });
    const invoke = (method, args, signal = new AbortController().signal) => gateway.invoke({ namespace: 'sessionPurge', method, args, signal, peer });
    const attempt = async (method, args, signal) => {
      try {
        return { value: await invoke(method, args, signal) };
      } catch (error) {
        return { error };
      }
    };
    return { ctx, gateway, peer, seam, invoke, attempt, service: () => ctx.get('sessionPurge') };
  };
  const rooted = (target) => ({ ...config.value, sessionsRoot: target.sessionsRoot, storagesRoot: target.storagesRoot, attachmentsRoot: target.attachmentsRoot, spillRoots: [target.spillRoot] });
  const runsOf = async (target) => txn.listRuns(await txn.stagingRootFor(target.sessionsRoot));
  const allThere = (target) => existsSync(join(target.project, target.parentId)) && existsSync(join(target.project, target.childId)) && existsSync(join(target.nestedProject, target.grandId));

  // ── The immediate path, end to end ─────────────────────────────────────────
  const main = boot(config.value);
  check('the Remote service is reachable for recovery', typeof main.service()?.recover === 'function');
  const inspect = await main.invoke('inspect', { sessionId: store.parentId });
  check('inspect returns every lineage target with titles', inspect.targets.length === 3 && inspect.targets[0].title === 'Synthetic parent' && inspect.targets.some((target) => target.sessionId === store.grandId && target.title === 'Synthetic grandchild'), JSON.stringify(inspect.targets.map((target) => [target.sessionId, target.title])));
  check('inspect reports the fork that will be kept', (inspect.forkIds ?? []).includes(store.forkId), JSON.stringify(inspect.forkIds));
  check('inspect reports no blocking liveness', inspect.blocked === null);
  check('inspect counts the spilled directory', inspect.spillDirectoryCount === 1, String(inspect.spillDirectoryCount));
  check('inspect totals the disk size', inspect.sizeBytes > 0, String(inspect.sizeBytes));

  const report = await main.invoke('purge', { sessionId: store.parentId });
  check('purge removes the session, its child and its grandchild', report.removedIds.length === 3 && report.failedIds.length === 0, JSON.stringify([report.removedIds, report.failedIds]));
  check('purge reports every removed artifact', report.removed.sessionDirectories === 3 && report.removed.projectionRecords === 5 && report.removed.spillDirectories === 1, JSON.stringify(report.removed));
  check('the logs left the session tree', !allThere(store) && !existsSync(join(store.project, store.parentId)) && !existsSync(join(store.nestedProject, store.grandId)));
  check('purge leaves the survivor readable', await exists(join(store.survivorProject, store.keptId, 'session.v4.jsonl.zstd')));
  check('purge leaves the fork untouched', await exists(join(store.project, store.forkId)));
  check('purge keeps unreferenced attachments (default off)', await exists(join(store.attachmentsRoot, 'v1', 'objects', store.doomedDigest.slice(0, 2), store.doomedDigest)));
  check('the report names its run and an honest outcome', typeof report.runId === 'string' && report.outcome === 'verified-with-gaps' && ['checkpoint-memory', 'workspace', 'schedule'].every((gap) => report.unverified.includes(gap)), JSON.stringify([report.outcome, report.unverified]));
  {
    const staging = await txn.stagingRootFor(store.sessionsRoot);
    const runs = await txn.listRuns(staging);
    const run = runs.find((entry) => entry.runId === report.runId);
    check('the finished run keeps its manifest (for the tombstones) and nothing else', runs.length === 1 && run?.manifest?.outcome === report.outcome && !existsSync(join(run.directory, 'entries')), JSON.stringify(runs.map((entry) => entry.runId)));
    check('the manifest records no titles', run !== undefined && !(await readFile(join(run.directory, 'manifest.json'), 'utf8')).includes('Synthetic'));
    const audit = await readFile(join(staging, 'audit.jsonl'), 'utf8');
    check('one audit record names the run, without titles', audit.trim().split('\n').length === 1 && audit.includes(report.runId) && !audit.includes('Synthetic'), audit);
    check('the staging area is outside the session tree', !staging.startsWith(`${await realpathOf(store.sessionsRoot)}/`), staging);
  }

  // ── Liveness: by registry, and by another owner of the write handle ─────────
  {
    const second = await buildStore(join(workroot, 'gateway-store-live'));
    const seam = stubPersistence(second.sessionsRoot);
    const liveHost = boot({ ...rooted(second), purgeAttachments: true }, seam);
    const live = { sessionId: second.parentId };
    liveHost.ctx.provide('agents', { get: (id) => (live.sessionId === id ? { id } : undefined) });
    const refused = await liveHost.attempt('purge', { sessionId: second.parentId });
    check('a live target is refused with a stable code', refused.error?.code === 'session-purge/session-live', String(refused.error?.code));
    check('the refusal names the live session', refused.error?.details?.sessionIds?.includes(second.parentId) === true, JSON.stringify(refused.error?.details));
    check('the live session survives the refusal', allThere(second));

    // The registry says cold, but someone else holds the write handle: the fence
    // is what decides, and it refuses before anything is written.
    live.sessionId = null;
    seam.owned.add(second.childId);
    const fenced = await liveHost.attempt('purge', { sessionId: second.parentId });
    check('a target owned by another writer is refused by the fence', fenced.error?.code === 'session-purge/session-live' && fenced.error?.details?.sessionIds?.includes(second.childId) === true, `${String(fenced.error?.code)} ${JSON.stringify(fenced.error?.details)}`);
    check('a refused fence changes nothing and leaves no run behind', allThere(second) && (await runsOf(second)).length === 0);
    if (leases) {
      // Every lease the fence took was released: taking them again works.
      const probe = await openFile(join(second.project, second.parentId, 'session.lock'), 'r+');
      let free = true;
      try {
        await tryLockExclusive(probe.fd);
      } catch {
        free = false;
      } finally {
        await probe.close();
      }
      check('a refused fence releases the leases it had taken', free);
    }
    seam.owned.clear();
    const retry = await liveHost.invoke('purge', { sessionId: second.parentId });
    check('once nobody owns it, the same purge succeeds and clears the unreferenced attachment', retry.removedIds.length === 3 && retry.removed.attachmentObjects === 1, JSON.stringify(retry.removed));
  }

  // ── Bookkeeping through the owners' services ───────────────────────────────
  {
    const third = await buildStore(join(workroot, 'gateway-store-bookkeeping'));
    const host3 = boot(rooted(third));
    const calls = [];
    const live = { sessionId: third.childId };
    host3.ctx.provide('agents', { get: (id) => (live.sessionId === id ? { id } : undefined) });
    host3.ctx.effect(() => host3.ctx.on('api-session/removed', (id) => calls.push(`removed:${id}`)), 'selftest: announce listener');
    // The raw record still accounts the parent while the filtered view already
    // hides it — the state dsh is in once its header index forgets a deleted log.
    const accounts = { 'ws-1': [third.parentId, third.forkId], 'ws-2': [third.keptId] };
    const archived = [third.childId];
    const pinned = [third.parentId];
    host3.ctx.provide('workspaceRegistry', {
      list: () => Object.entries(accounts).map(([id, ids]) => ({
        id,
        record: { sessionIds: ids },
        get sessionIds() { return ids.filter((entry) => entry !== third.parentId); },
        detachSession: (sessionId) => {
          calls.push(`detach:${id}:${sessionId}:log-${existsSync(join(third.project, sessionId)) ? 'present' : 'gone'}`);
          accounts[id] = accounts[id].filter((entry) => entry !== sessionId);
          return Promise.resolve();
        },
      })),
      get archivedSessionIds() { return [...archived]; },
      get pinnedSessionIds() { return [...pinned]; },
      unarchiveSession: (id) => { calls.push(`unarchive:${id}`); archived.splice(0, archived.length, ...archived.filter((entry) => entry !== id)); },
      unpinSession: (id) => { calls.push(`unpin:${id}`); pinned.splice(0, pinned.length, ...pinned.filter((entry) => entry !== id)); },
    });
    const rows = [
      { id: 'task-1', sessionId: third.parentId, status: 'active' },
      { id: 'task-2', sessionId: 'unrelated', status: 'active' },
      { id: 'task-3', sessionId: third.childId, status: 'inactive' },
    ];
    host3.ctx.provide('schedule', {
      catalog: async () => rows.map((row) => ({ ...row })),
      delete: async ({ id, sessionId }) => {
        calls.push(`schedule:${sessionId}/${id}`);
        const at = rows.findIndex((row) => row.id === id && row.sessionId === sessionId);
        if (at === -1) return { id, deleted: false };
        rows.splice(at, 1);
        return { id, deleted: true };
      },
    });

    const blockedInspection = await host3.invoke('inspect', { sessionId: third.parentId });
    check('a live *child* is reported as blocking the preview', blockedInspection.blocked?.sessionIds?.includes(third.childId) === true, JSON.stringify(blockedInspection.blocked));
    const childRefusal = await host3.attempt('purge', { sessionId: third.parentId });
    check('a live child refuses the purge with the stable code', childRefusal.error?.code === 'session-purge/session-live', String(childRefusal.error?.code));

    live.sessionId = null;
    const bookkeeping = await host3.invoke('purge', { sessionId: third.parentId });
    check('the Workspace slot is dropped after the log left the tree', calls.includes(`detach:ws-1:${third.parentId}:log-gone`), calls.join(' | '));
    check('a workspace is selected by its raw record, not the filtered view', calls.some((entry) => entry.startsWith(`detach:ws-1:${third.parentId}`)));
    check('a workspace that does not account the target is never mutated', !calls.some((entry) => entry.startsWith('detach:ws-2')), calls.join(' | '));
    check('archive and pin entries are cleared through the registry', calls.includes(`unarchive:${third.childId}`) && calls.includes(`unpin:${third.parentId}`), calls.join(' | '));
    check('reminders of every status bound to the targets are deleted, and only those', calls.includes(`schedule:${third.parentId}/task-1`) && calls.includes(`schedule:${third.childId}/task-3`) && !calls.some((entry) => entry.includes('task-2')), calls.join(' | '));
    check('the report counts the schedule and workspace work', bookkeeping.removed.schedules === 2 && bookkeeping.removed.workspaceSlots === 1, JSON.stringify(bookkeeping.removed));
    check('every removed session is announced once', bookkeeping.removedIds.every((id) => calls.includes(`removed:${id}`)) && calls.filter((entry) => entry.startsWith('removed:')).length === bookkeeping.removedIds.length, calls.join(' | '));
    check('with Workspace and Schedule readable, only the checkpoint memory stays unverified', bookkeeping.outcome === 'verified-with-gaps' && bookkeeping.unverified.length === 1 && bookkeeping.unverified[0] === 'checkpoint-memory', JSON.stringify([bookkeeping.outcome, bookkeeping.unverified]));

    const unknownRefusal = await host3.attempt('inspect', { sessionId: 'session-does-not-exist' });
    check('an unknown session is refused with its own code', unknownRefusal.error?.code === 'session-purge/session-unknown', String(unknownRefusal.error?.code));
    const invalidRefusal = await host3.attempt('inspect', { sessionId: '../evil' });
    // Either layer may answer first: the manifest codec rejects at the wire
    // boundary (`gateway/input-invalid`) and the service re-checks with its own
    // stable code. Both mean "refused before any path use".
    check('a traversal-shaped id is refused before any path use', invalidRefusal.error !== undefined && (invalidRefusal.error.code === 'session-purge/invalid-session-id' || invalidRefusal.error.code === 'gateway/input-invalid' || String(invalidRefusal.error.message).includes('path-safe')), `${String(invalidRefusal.error?.code)} ${String(invalidRefusal.error?.message)}`);
  }

  // ── The preview is the contract ─────────────────────────────────────────────
  {
    const fourth = await buildStore(join(workroot, 'gateway-store-drift'));
    const host4 = boot(rooted(fourth));
    await host4.invoke('inspect', { sessionId: fourth.parentId });
    const lateId = '99999999-8888-7777-6666-555555555555';
    await mkdir(join(fourth.project, lateId), { recursive: true });
    await writeFile(join(fourth.project, lateId, 'session.v4.jsonl.zstd'), storedLog(
      { type: 'session', version: 4, id: lateId, createdAt: 9, cwd: '/Users/example/projects/demo', parentSession: fourth.parentId, isSeeded: false, origin: 'subagent', delegationDepth: 1 },
      [{ type: 'session/title', seq: 1, time: 9, data: { title: 'Late child' } }],
    ));
    const drift = await host4.attempt('purge', { sessionId: fourth.parentId });
    check('a target set that grew since the preview is refused', drift.error?.code === 'session-purge/target-set-changed', String(drift.error?.code));
    check('the late child survives the refusal', existsSync(join(fourth.project, lateId)));
  }

  // ── A commit that fails leaves its target whole ─────────────────────────────
  {
    // Without write permission on the project directory the rename out of it
    // fails, so the parent and its child stay; the grandchild lives in another
    // project directory and is removed. The failed ones keep everything.
    const fifth = await buildStore(join(workroot, 'gateway-store-fail'));
    const host5 = boot(rooted(fifth));
    const detached = [];
    host5.ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'ws-fail', record: { sessionIds: [fifth.parentId, fifth.childId, fifth.grandId] }, sessionIds: [fifth.parentId, fifth.childId, fifth.grandId], detachSession: (id) => { detached.push(id); return Promise.resolve(); } }],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      unarchiveSession: () => undefined,
      unpinSession: () => undefined,
    });
    const projectMode = (await stat(fifth.project)).mode;
    await chmod(fifth.project, 0o500);
    let failure;
    try {
      failure = await host5.attempt('purge', { sessionId: fifth.parentId });
    } finally {
      await chmod(fifth.project, projectMode);
    }
    const value = failure.value;
    check('a target whose directory cannot be moved is reported as failed', value?.failedIds?.includes(fifth.parentId) === true && value.failedIds.includes(fifth.childId) && value.removedIds.includes(fifth.grandId), JSON.stringify([value?.removedIds, value?.failedIds, String(failure.error)]));
    check('the outcome says the purge was partial', value?.outcome === 'failed-partial', String(value?.outcome));
    check('the failed directory still holds its log', existsSync(join(fifth.project, fifth.parentId, 'session.v4.jsonl.zstd')));
    check('the failed session keeps its projection record', existsSync(join(fifth.storagesRoot, 'session_projcache', 'sessions', `${fifth.parentId}.json`)));
    check('the failed session keeps its Workspace slot', !detached.includes(fifth.parentId) && !detached.includes(fifth.childId) && detached.includes(fifth.grandId), JSON.stringify(detached));
    check('the failure names the session in a warning', Array.isArray(value?.warnings) && value.warnings.some((line) => line.includes(fifth.parentId)), JSON.stringify(value?.warnings));
    // A surviving session must not keep a tombstone, or the watcher would delete
    // its own checkpoint the next time it is written.
    const tombstones = host5.service().tombstones;
    check('a failed target is not left with a tombstone; a removed one is', !tombstones.has(fifth.parentId) && !tombstones.has(fifth.childId) && tombstones.has(fifth.grandId), JSON.stringify([...tombstones.keys()]));
  }

  // ── Cancellation is all or nothing: never half a purge ──────────────────────
  {
    // Abort at the n-th look at the signal, for every n. Each run must end in one
    // of two states: refused with every target on disk and no run left behind,
    // or finished with every target gone. Nothing in between.
    let aborted = 0;
    let finished = 0;
    let halfway = 0;
    for (let n = 1; n <= 6; n += 1) {
      const target = await buildStore(join(workroot, `gateway-store-cancel-${String(n)}`));
      const cancelHost = boot(rooted(target));
      let reads = 0;
      const reason = new Error('selftest: cancelled');
      const signal = { get aborted() { reads += 1; return reads >= n; }, get reason() { return reason; } };
      const outcome = await cancelHost.attempt('purge', { sessionId: target.parentId }, signal);
      const gone = !existsSync(join(target.project, target.parentId)) && !existsSync(join(target.project, target.childId)) && !existsSync(join(target.nestedProject, target.grandId));
      const runs = await runsOf(target);
      if (outcome.error !== undefined && allThere(target) && runs.length === 0) aborted += 1;
      else if (outcome.value !== undefined && gone && outcome.value.removedIds.length === 3) finished += 1;
      else halfway += 1;
    }
    check('a cancel either changes nothing or lets the purge finish — never half', halfway === 0 && aborted > 0 && finished > 0, JSON.stringify({ aborted, finished, halfway }));
  }

  // ── Two windows deleting the same session at once ───────────────────────────
  {
    const twice = await buildStore(join(workroot, 'gateway-store-twice'));
    const twiceHost = boot(rooted(twice));
    const [first, second] = await Promise.all([
      twiceHost.attempt('purge', { sessionId: twice.parentId }),
      twiceHost.attempt('purge', { sessionId: twice.parentId }),
    ]);
    const outcomes = [first, second];
    const succeeded = outcomes.filter((entry) => entry.value?.removedIds?.length === 3).length;
    const unknown = outcomes.filter((entry) => entry.error?.code === 'session-purge/session-unknown').length;
    check('two concurrent purges of one session: one deletes it, the other is told it is gone', succeeded === 1 && unknown === 1, JSON.stringify(outcomes.map((entry) => entry.error?.code ?? entry.value?.removedIds?.length)));
  }

  // ── The fence proves it guards these directories ────────────────────────────
  {
    const mismatch = await buildStore(join(workroot, 'gateway-store-mismatch'));
    const wrongRoot = boot(rooted(mismatch), stubPersistence(mismatch.sessionsRoot, { reportedRoot: join(workroot, 'elsewhere') }));
    const refused = await wrongRoot.attempt('purge', { sessionId: mismatch.parentId });
    check('a backend rooted elsewhere is refused before anything moves', refused.error?.code === 'session-purge/fence-mismatch' && allThere(mismatch), String(refused.error?.code));
    if (leases) {
      const lockless = boot(rooted(mismatch), stubPersistence(mismatch.sessionsRoot, { lease: false }));
      const unguarded = await lockless.attempt('purge', { sessionId: mismatch.parentId });
      check('a write handle that does not hold this directory\'s lease is refused', unguarded.error?.code === 'session-purge/fence-mismatch' && allThere(mismatch), String(unguarded.error?.code));
    }
  }

  // ── Another process running a purge on the same root ────────────────────────
  if (leases) {
    const busy = await buildStore(join(workroot, 'gateway-store-busy'));
    const staging = await txn.stagingRootFor(busy.sessionsRoot);
    await txn.ensureStagingRoot(staging);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { open } from 'node:fs/promises';
      const { tryLockExclusive } = await import(${JSON.stringify(join(app, 'node-addon-system', 'lib', 'flock.js'))});
      const handle = await open(${JSON.stringify(join(staging, '.lock'))}, 'a');
      await tryLockExclusive(handle.fd);
      process.stdout.write('locked\\n');
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const locked = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      child.stdout.on('data', (chunk) => {
        if (!String(chunk).includes('locked')) return;
        clearTimeout(timer);
        resolve(true);
      });
      void exited.then(() => { clearTimeout(timer); resolve(false); });
    });
    const busyHost = boot(rooted(busy));
    const refused = await busyHost.attempt('purge', { sessionId: busy.parentId });
    check('a purge already running in another process is reported as busy', locked && refused.error?.code === 'session-purge/busy' && allThere(busy), `${String(locked)} ${String(refused.error?.code)}`);
    child.stdin.end();
    await exited;
    const afterwards = await busyHost.attempt('purge', { sessionId: busy.parentId });
    check('once that process is gone the purge runs', afterwards.value?.removedIds?.length === 3, String(afterwards.error));
  }

  // ── Linked session directories: the link goes, other people's files stay ────
  if (leases) {
    const linked = await buildStore(join(workroot, 'gateway-store-linked'));
    const external = join(linked.root, 'external');
    // The child's folder lives elsewhere and also holds a file that is not ours;
    // the grandchild's folder holds only session artifacts.
    for (const [id, project, extra] of [[linked.childId, linked.project, true], [linked.grandId, linked.nestedProject, false]]) {
      const outside = join(external, id);
      await mkdir(dirname(outside), { recursive: true });
      await rename(join(project, id), outside);
      if (extra) await writeFile(join(outside, 'notes.txt'), 'mine, not the session\'s\n');
      await symlink(outside, join(project, id), 'dir');
    }
    const linkHost = boot(rooted(linked));
    const linkedReport = await linkHost.invoke('purge', { sessionId: linked.parentId });
    check('linked targets are indexed and removed', linkedReport.removedIds.length === 3, JSON.stringify(linkedReport.removedIds));
    check('the links are gone from the session tree', !existsSync(join(linked.project, linked.childId)) && !existsSync(join(linked.nestedProject, linked.grandId)));
    check('a linked folder that held only session artifacts is removed', !existsSync(join(external, linked.grandId)));
    check('a linked folder keeps a file that is not the session\'s', existsSync(join(external, linked.childId, 'notes.txt')) && !existsSync(join(external, linked.childId, 'session.v4.jsonl.zstd')));
    check('the kept file is reported as leftover', linkedReport.warnings.some((line) => line.includes('leftover')), JSON.stringify(linkedReport.warnings));
  }

  // ── Recovery from a crash, forward only ─────────────────────────────────────
  {
    /**
     * Write the manifest a run would have written, optionally move some entries
     * as its commit would have, and leave the rest of the run "crashed".
     */
    const craft = async (target, { commit = [], commitDone = false, claimCommitted = [] } = {}) => {
      const staging = await txn.stagingRootFor(target.sessionsRoot);
      await txn.ensureStagingRoot(staging);
      const index = await engine.indexStoredSessions(target.sessionsRoot);
      const ids = [target.parentId, target.childId];
      const runId = txn.newRunId();
      const entries = [];
      for (const id of ids) {
        const record = index.get(id);
        entries.push({ id, primary: true, source: record.directory, projectDirectory: record.projectDirectory, staged: txn.stagedPathFor(staging, runId, record.directory), identity: await txn.entryIdentity(record.directory), linked: false, realTarget: null, realTargetIdentity: null, state: claimCommitted.includes(id) ? 'COMMITTED' : 'PLANNED' });
      }
      const manifest = {
        version: txn.MANIFEST_VERSION, runId, path: 'immediate', state: 'FENCED', createdAt: new Date().toISOString(), completedAt: null, attempts: 0, lastError: null,
        settings: { removeEmptyProjectDirectory: true, purgeSchedules: true, purgeSpill: true, spillRoots: [target.spillRoot] },
        targets: ids.map((id) => ({ id, state: 'FENCED', sizeBytes: index.get(id).sizeBytes, checkpoint: { createdAt: index.get(id).header.createdAt, cwd: index.get(id).header.cwd } })),
        entries,
        steps: { fence: 'done', commit: commitDone ? 'done' : 'pending', workspace: 'pending', cache: 'pending', schedules: 'pending', spill: 'pending', cleanup: 'pending', verify: 'pending' },
        outcome: null, unverified: [],
      };
      await txn.writeManifest(staging, manifest);
      for (const entry of entries) if (commit.includes(entry.id)) await txn.commitEntry(entry.source, entry.staged);
      return { staging, runId };
    };

    const abandoned = await buildStore(join(workroot, 'gateway-store-recover-abandoned'));
    const abandonedRun = await craft(abandoned);
    const report1 = await boot(rooted(abandoned)).service().recover();
    check('recovery abandons a run that never moved anything', report1.abandoned.includes(abandonedRun.runId) && !existsSync(txn.runDirectory(abandonedRun.staging, abandonedRun.runId)) && allThere(abandoned), JSON.stringify(report1));

    const midway = await buildStore(join(workroot, 'gateway-store-recover-midway'));
    const midwayRun = await craft(midway, { commit: [midway.parentId] });
    const report2 = await boot(rooted(midway)).service().recover();
    const midwayManifest = await txn.readManifest(txn.runDirectory(midwayRun.staging, midwayRun.runId));
    check('recovery finishes a commit that a crash cut short — forward, not back', report2.resumed.includes(midwayRun.runId) && !existsSync(join(midway.project, midway.parentId)) && midwayManifest?.outcome === 'failed-partial', JSON.stringify([report2, midwayManifest?.outcome]));
    check('the part the crash never reached stays whole', existsSync(join(midway.project, midway.childId)) && existsSync(join(midway.storagesRoot, 'session_projcache', 'sessions', `${midway.childId}.json`)));
    check('the moved part is purged after recovery', !existsSync(join(midway.storagesRoot, 'session_projcache', 'sessions', `${midway.parentId}.json`)) && !existsSync(join(txn.runDirectory(midwayRun.staging, midwayRun.runId), 'entries')));

    const lost = await buildStore(join(workroot, 'gateway-store-recover-lost'));
    const lostRun = await craft(lost, { commitDone: true, claimCommitted: [lost.parentId, lost.childId] });
    const report3 = await boot(rooted(lost)).service().recover();
    const lostManifest = await txn.readManifest(txn.runDirectory(lostRun.staging, lostRun.runId));
    check('a commit whose rename did not survive is redone under a new fence', report3.resumed.includes(lostRun.runId) && !existsSync(join(lost.project, lost.parentId)) && !existsSync(join(lost.project, lost.childId)) && lostManifest?.targets?.every((target) => target.state === 'COMMITTED'), JSON.stringify([report3, lostManifest?.targets]));

    const drifted = await buildStore(join(workroot, 'gateway-store-recover-drift'));
    const driftRun = await craft(drifted, { commitDone: true, claimCommitted: [drifted.parentId] });
    // The directory was replaced by a different one under the same name (a
    // restore from backup, say): same path, other inode. It must not be touched.
    const replacement = join(drifted.project, drifted.parentId);
    await rename(replacement, `${replacement}.old`);
    await cp(`${replacement}.old`, replacement, { recursive: true });
    await rm(`${replacement}.old`, { recursive: true, force: true });
    await boot(rooted(drifted)).service().recover();
    check('a directory that is not the one the run recorded is left alone', existsSync(join(replacement, 'session.v4.jsonl.zstd')));

    // A finished run: its tombstones are re-armed until it expires, then it goes.
    const finishedRun = await txn.listRuns(await txn.stagingRootFor(store.sessionsRoot));
    const reborn = boot(config.value);
    await reborn.service().recover();
    check('a recent finished run re-arms its tombstones after a restart', reborn.service().tombstones.has(store.parentId) && finishedRun.length === 1);
    const expired = finishedRun[0].manifest;
    expired.completedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await txn.writeManifest(await txn.stagingRootFor(store.sessionsRoot), expired);
    const report4 = await boot(config.value).service().recover();
    check('a finished run past its retention is removed', report4.expired.includes(expired.runId) && (await txn.listRuns(await txn.stagingRootFor(store.sessionsRoot))).length === 0, JSON.stringify(report4));
  }

  // ── The residue sweep ───────────────────────────────────────────────────────
  {
    // A session whose header cannot be read is omitted by dsh's own backend —
    // "Unreadable or unsupported headers … are omitted from discovery and list()"
    // — so it can never be selected in the interface and its bytes stay forever.
    // The residue sweep is the only way back, so it is tested end to end.
    const seventh = await buildStore(join(workroot, 'gateway-store-residue'));
    const brokenDirectory = join(seventh.project, 'session-b1b1b1b1-0000-4000-8000-000000000001');
    await mkdir(brokenDirectory, { recursive: true });
    // A truncated Zstandard frame: the magic is there, the frame is not.
    await writeFile(join(brokenDirectory, 'session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00, 0x00]));
    const emptyDirectory = join(seventh.project, 'session-e1e1e1e1-0000-4000-8000-000000000002');
    await mkdir(emptyDirectory, { recursive: true });
    // A directory whose name says nothing, but which still holds a stored log: a
    // damaged session renamed by hand is still a session.
    const renamedDirectory = join(seventh.project, 'moved-here');
    await mkdir(renamedDirectory, { recursive: true });
    await writeFile(join(renamedDirectory, 'session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00, 0x00]));
    const freshDirectory = join(seventh.project, 'session-f1f1f1f1-0000-4000-8000-000000000003');
    await mkdir(freshDirectory, { recursive: true });
    // Neither a session id nor a stored log: someone's own folder under a project
    // directory. Unreadable, but never this sweep's business.
    const foreignDirectory = join(seventh.project, 'notes');
    await mkdir(foreignDirectory, { recursive: true });
    await writeFile(join(foreignDirectory, 'todo.md'), 'not a session\n');
    // Backdate the real leftovers: a directory younger than the age guard is
    // treated as a session being created and must be left alone.
    const old = new Date(Date.now() - 3_600_000);
    for (const directory of [brokenDirectory, emptyDirectory, renamedDirectory, foreignDirectory]) await utimes(directory, old, old);

    const unfiltered = await engine.scanResidue({ root: seventh.sessionsRoot });
    check('the residue scan finds every headerless session directory',
      unfiltered.directories.length === 4, JSON.stringify(unfiltered.directories.map((entry) => entry.directory.split('/').pop())));
    check('a folder that is neither a session id nor a stored log is never reported',
      !unfiltered.directories.some((entry) => entry.directory === foreignDirectory),
      JSON.stringify(unfiltered.directories.map((entry) => entry.directory.split('/').pop())));
    const aged = await engine.scanResidue({ root: seventh.sessionsRoot, minimumAgeMs: 60_000 });
    check('the age guard spares a directory that was just created',
      aged.directories.length === 3 && !aged.directories.some((entry) => entry.directory === freshDirectory),
      JSON.stringify(aged.directories.map((entry) => entry.directory.split('/').pop())));
    check('the scan reports the bytes it would reclaim', aged.bytes === 16, String(aged.bytes));

    const host7 = boot(rooted(seventh));
    const preview = await host7.invoke('sweepResidue', { apply: false });
    check('the preview lists the leftovers and removes nothing',
      preview.directories.length === 3 && preview.removed === 0 && preview.bytes === 16, JSON.stringify([preview.directories.length, preview.removed]));
    check('the preview really does not touch the disk',
      existsSync(brokenDirectory) && existsSync(emptyDirectory) && existsSync(renamedDirectory));
    const rejectedFlag = await host7.attempt('sweepResidue', { apply: 'yes' });
    check('a non-boolean apply is refused before any path use',
      rejectedFlag.error !== undefined && (rejectedFlag.error.code === 'gateway/input-invalid' || String(rejectedFlag.error.message).includes('boolean')),
      `${String(rejectedFlag.error?.code)} ${String(rejectedFlag.error?.message)}`);
    const swept = await host7.invoke('sweepResidue', { apply: true });
    check('the sweep removes exactly what the preview listed',
      swept.removed === 3 && !existsSync(brokenDirectory) && !existsSync(emptyDirectory) && !existsSync(renamedDirectory), JSON.stringify(swept.removed));
    check('the fresh directory survives the sweep', existsSync(freshDirectory));
    check('the foreign folder survives the sweep', existsSync(join(foreignDirectory, 'todo.md')));
    check('healthy sessions are untouched by the sweep', existsSync(join(seventh.project, seventh.parentId)));
  }
  await testDesignPremises(app, join(workroot, 'premises'));
  await testRealTree(app, join(workroot, 'real-tree'), { host, manifest: manifest.TYPERT, Context, TypertRegistry, TypertGatewayService, Peer });
  return true;
}

/**
 * Part B3: the plugin itself, end to end, on dsh's real services.
 *
 * Part B drives the plugin over synthetic logs through a stub seam; Part B2 shows
 * the real seam behaves like that stub. This part closes the loop: real sessions
 * (created and persisted by dsh's own agent loop), the real JSONL backend as the
 * fence, the real projection cache table as the checkpoint store — and the
 * plugin's own tombstone watcher against a real late write-back.
 * @param app - the installation's package directory.
 * @param workroot - an empty scratch directory for this part.
 * @param parts - the modules Part B already loaded.
 */
async function testRealTree(app, workroot, { host, manifest, Context, TypertRegistry, TypertGatewayService, Peer }) {
  console.log('\nPart B3 — the plugin end to end on dsh\'s real services');
  const sessionsRoot = join(workroot, 'sessions');
  const storagesRoot = join(workroot, 'storages');
  await mkdir(workroot, { recursive: true });
  const imported = (name) => import(join(app, name, 'lib', 'index.js'));
  const ctx = new Context();
  const fibers = [];
  const mount = async (name, config) => {
    const module = await imported(name);
    const fiber = ctx.plugin(module.default ?? module, config);
    fibers.push(fiber);
    await fiber;
  };
  await mount('dsh-storage');
  await mount('dsh-storage-json', { root: storagesRoot });
  await mount('dsh-storage-domain', { backend: 'json', routes: {} });
  await mount('dsh-session-projection');
  await mount('dsh-session');
  await mount('dsh-session-persistence-jsonl', { root: sessionsRoot, compression: 'zstd', listConcurrency: 4 });
  await mount('dsh-session-projection-cache', { writeEveryEvents: 200, writeIntervalMs: 5000 });
  for (const name of ['dsh-llm', 'dsh-tools', 'dsh-system-prompt', 'dsh-agent']) await mount(name);
  await mount('dsh-agent-loop', { maxParallelToolCalls: 10, agents: [] });
  new TypertRegistry(ctx);
  ctx.typert.register(manifest);
  const gateway = new TypertGatewayService(ctx, {});
  const config = host.Config['~standard'].validate({ sessionsRoot, storagesRoot, attachmentsRoot: join(workroot, 'attachments'), spillRoots: [], recoveryDelayMs: -1 });
  host.apply(ctx, config.value);
  const peer = new Peer(ctx, { principal: { kind: 'owner' } });
  const attempt = async (method, args) => {
    try {
      return { value: await gateway.invoke({ namespace: 'sessionPurge', method, args, signal: new AbortController().signal, peer }) };
    } catch (error) {
      return { error };
    }
  };
  const nextChange = (key, operation) => new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(false); }, 5_000);
    const off = ctx.on('domain/changed', (change) => {
      if (change.domain !== 'session_projcache' || change.key !== key || change.operation !== operation) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
  // The detach checkpoint reaches memory only after it reached the disk
  // ("durability first, then memory", `dsh-session-projection-cache`), so a
  // session counts as cold once its checkpoint is readable.
  const cold = async (id, meta = {}) => {
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: workroot, ...meta } });
    await ctx.sessions.flush(handle.agent.session);
    await handle.dispose();
    const table = ctx.storageDomain.get('session_projcache').table('sessions');
    for (let waited = 0; table.get(id) === undefined && waited < 2_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  try {
    const parent = 'session-aaaaaaaa-1111-4222-8333-444444444444';
    const child = 'bbbbbbbb-1111-4222-8333-444444444444';
    const resident = 'session-cccccccc-1111-4222-8333-444444444444';
    await cold(parent);
    await cold(child, { parentSession: parent, origin: 'subagent', delegationDepth: 1 });
    const table = ctx.storageDomain.get('session_projcache').table('sessions');
    const recordFile = (id) => join(storagesRoot, 'session_projcache', 'sessions', `${id}.json`);
    check('setup: two real cold sessions with their checkpoints', table.get(parent) !== undefined && table.get(child) !== undefined && existsSync(recordFile(parent)), JSON.stringify([table.get(parent) !== undefined, table.get(child) !== undefined, existsSync(recordFile(parent)), existsSync(join(storagesRoot, 'session_projcache')) ? readdirSync(join(storagesRoot, 'session_projcache'), { recursive: true }) : 'no domain dir']));

    // A resident session is refused, by the fence as well as the registry.
    const live = await ctx.agents.resume({ resumeSessionId: (await cold(resident), resident) });
    const refused = await attempt('purge', { sessionId: resident });
    check('a resident real session is refused', refused.error?.code === 'session-purge/session-live', String(refused.error?.code));
    await live.dispose();

    const inspection = await attempt('inspect', { sessionId: parent });
    check('the preview finds the real subagent child', inspection.value?.targets?.length === 2 && inspection.value.targets.some((target) => target.sessionId === child), JSON.stringify(inspection.value?.targets?.map((target) => target.sessionId) ?? String(inspection.error)));

    // Read the log the way a cold reader would, before the commit.
    const reader = await ctx.sessionPersistence.open(parent, 'read');
    const { header, inheritedEventCount } = reader;
    const { events } = await reader.read();
    await reader.close();

    const purged = await attempt('purge', { sessionId: parent });
    const report = purged.value;
    check('the real purge removes both sessions', report?.removedIds?.length === 2 && report.failedIds.length === 0, JSON.stringify(report ?? String(purged.error)));
    check('the backend no longer lists them', !(await ctx.sessionPersistence.list()).some((snapshot) => snapshot.header.id === parent || snapshot.header.id === child));
    check('their checkpoints are gone from the table and the disk', table.get(parent) === undefined && table.get(child) === undefined && !existsSync(recordFile(parent)) && !existsSync(recordFile(child)));
    check('with the real table only Workspace and Schedule stay unverified', report?.outcome === 'verified-with-gaps' && JSON.stringify([...report.unverified].sort()) === JSON.stringify(['schedule', 'workspace']), JSON.stringify([report?.outcome, report?.unverified]));

    // The late cold read lands after the purge; the plugin's watcher removes it.
    const deleted = nextChange(parent, 'deleted');
    ctx.sessionProjectionCache.coldSnapshot(header, inheritedEventCount, events);
    check('the plugin\'s watcher deletes a real late write-back', (await deleted) && table.get(parent) === undefined && !existsSync(recordFile(parent)));

    // The same id, created anew, keeps its checkpoint.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cold(parent);
    await new Promise((resolve) => setTimeout(resolve, 200)); // room for a (wrong) watcher reaction
    check('a new session under a deleted id keeps its checkpoint', table.get(parent) !== undefined && existsSync(recordFile(parent)));
  } catch (error) {
    check('Part B3 ran to completion', false, error?.stack ?? String(error));
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
}

/**
 * Part B2: the I4 premises of DESIGN.md v8, against dsh's real services.
 *
 * Four claims the design cannot hold without, each with a control that would
 * fail if the test were vacuous:
 *   P1  a resident session holds its write handle, so `open(id, 'write')` is
 *       refused — in-process (P1) and across processes (P1b);
 *   P2  while we hold that handle `agents.resume` is refused, and closing it
 *       after the directory moved out of the tree writes nothing;
 *   P3  a late cold-read write-back really resurrects the checkpoint (control),
 *       and a `domain/changed` watcher deletes it again, after it, on the chain;
 *   P4  a new session created under the same id is not taken for a resurrection.
 * The watcher here is the test's own — the plugin does not have one yet.
 * @param app - the installation's package directory.
 * @param workroot - an empty scratch directory for this part.
 */
async function testDesignPremises(app, workroot) {
  console.log('\nPart B2 — DESIGN v8 premises (§14, I4) against dsh\'s real services');
  const sessionsRoot = join(workroot, 'sessions');
  const storagesRoot = join(workroot, 'storages');
  await mkdir(workroot, { recursive: true });

  const imported = (name) => import(join(app, name, 'lib', 'index.js'));
  const { Context } = await imported('cordis');
  const ctx = new Context();
  const fibers = [];
  const mount = async (name, config) => {
    const module = await imported(name);
    const fiber = ctx.plugin(module.default ?? module, config);
    fibers.push(fiber);
    await fiber;
  };
  // The same plugins and configs dsh-base composes (`dsh-base/cordis.patch.yml`),
  // rooted in the scratch directory.
  await mount('dsh-storage');
  await mount('dsh-storage-json', { root: storagesRoot });
  await mount('dsh-storage-domain', { backend: 'json', routes: {} });
  await mount('dsh-session-projection');
  await mount('dsh-session');
  await mount('dsh-session-persistence-jsonl', { root: sessionsRoot, compression: 'zstd', listConcurrency: 4 });
  await mount('dsh-session-projection-cache', { writeEveryEvents: 200, writeIntervalMs: 5000 });
  for (const name of ['dsh-llm', 'dsh-tools', 'dsh-system-prompt', 'dsh-agent']) await mount(name);
  await mount('dsh-agent-loop', { maxParallelToolCalls: 10, agents: [] });

  const persistence = ctx.sessionPersistence;
  const isOwned = (error) => error?.name === 'SessionAlreadyOwnedError';
  const attempt = async (operation) => {
    try {
      return { value: await operation() };
    } catch (error) {
      return { error };
    }
  };
  /** Every entry of a directory with its size and mtime: "did anything write here". */
  const fingerprint = async (directory) => {
    const entries = [];
    for (const name of (await readdir(directory)).sort()) {
      const info = await stat(join(directory, name));
      entries.push(`${name}:${String(info.size)}:${String(info.mtimeMs)}`);
    }
    return entries.join('|');
  };
  /** The checkpoint identity a stored header witnesses (`dsh-session-projection-cache:365-379`). */
  const identityOf = (header, inheritedEventCount) => ({
    formatVersion: header.version,
    createdAt: header.createdAt,
    isSeeded: header.isSeeded,
    inheritedEventCount,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  });
  const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))));
  /** Resolve on the first `domain/changed` for `key` with `operation`, or false after five seconds. */
  const nextChange = (key, operation) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, 5_000);
    const off = ctx.on('domain/changed', (change) => {
      if (change.domain !== 'session_projcache' || change.key !== key || change.operation !== operation) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });

  try {
    const id = 'session-11111111-2222-4333-8444-555555555555';
    const created = await ctx.agents.create({ sessionId: id, meta: { cwd: workroot } });
    await ctx.sessions.flush(created.agent.session);
    await created.dispose();
    const project = (await readdir(sessionsRoot)).find((name) => existsSync(join(sessionsRoot, name, id)));
    const directory = project === undefined ? undefined : join(sessionsRoot, project, id);
    check('setup: a real session is materialized, then cold', directory !== undefined && ctx.sessions.get(id) === undefined && ctx.agents.get(id) === undefined);
    if (directory === undefined) return;

    // P1 — the fence refuses a resident session.
    const resident = await ctx.agents.resume({ resumeSessionId: id });
    check('P1 resume makes the session resident', ctx.sessions.get(id) !== undefined && ctx.agents.get(id) !== undefined);
    const blocked = await attempt(() => persistence.open(id, 'write'));
    check('P1 open(id, "write") on a resident session is refused with SessionAlreadyOwnedError', isOwned(blocked.error), String(blocked.error ?? 'it succeeded'));
    await blocked.value?.close();
    await resident.dispose();
    const released = await attempt(() => persistence.open(id, 'write'));
    check('P1 once the owner disposes, the same open succeeds', released.value !== undefined, String(released.error));
    await released.value?.close();

    // P1b — and across processes: the lease is the kernel's, not this process's.
    if (process.platform === 'win32') {
      console.log('  skip P1b (Windows holds a named semaphore, not session.lock)');
    } else {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { open } from 'node:fs/promises';
        const { tryLockExclusive } = await import(${JSON.stringify(join(app, 'node-addon-system', 'lib', 'flock.js'))});
        const handle = await open(${JSON.stringify(join(directory, 'session.lock'))}, 'r+');
        await tryLockExclusive(handle.fd);
        process.stdout.write('locked\\n');
        process.stdin.resume();
        process.stdin.on('end', () => process.exit(0));
      `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
      const exited = new Promise((resolve) => child.on('exit', resolve));
      const locked = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 10_000);
        child.stdout.on('data', (chunk) => {
          if (!String(chunk).includes('locked')) return;
          clearTimeout(timer);
          resolve(true);
        });
        void exited.then(() => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      check('P1b a child process takes the session lease', locked);
      const foreign = await attempt(() => persistence.open(id, 'write'));
      check('P1b open(id, "write") is refused while another process holds the lease', isOwned(foreign.error), String(foreign.error ?? 'it succeeded'));
      await foreign.value?.close();
      child.stdin.end();
      await exited;
      const reclaimed = await attempt(() => persistence.open(id, 'write'));
      check('P1b the kernel releases the lease when that process exits', reclaimed.value !== undefined, String(reclaimed.error));
      await reclaimed.value?.close();
    }

    // P2 — holding the handle: resume is refused, and close writes nothing.
    const reader = await persistence.open(id, 'read');
    const { header, inheritedEventCount } = reader;
    const { events } = await reader.read();
    await reader.close();
    const ours = await persistence.open(id, 'write');
    const before = await fingerprint(directory);
    const resume = await attempt(() => ctx.agents.resume({ resumeSessionId: id }));
    check('P2 agents.resume is refused with SessionAlreadyOwnedError while we hold the handle', isOwned(resume.error), String(resume.error ?? 'it succeeded'));
    await resume.value?.dispose();
    check('P2 the refused resume leaves no half-entered session', ctx.sessions.get(id) === undefined && ctx.agents.get(id) === undefined);
    check('P2 the refused resume wrote nothing into the session directory', (await fingerprint(directory)) === before);
    const staged = join(workroot, 'staged');
    await rename(directory, staged);
    await ours.close();
    check('P2 closing the handle after the directory moved out does not recreate it', !existsSync(directory));
    const after = await fingerprint(staged);
    check('P2 closing the handle writes nothing into the moved directory', after === before, `${before} -> ${after}`);
    const listed = (await persistence.list()).map((snapshot) => snapshot.header.id);
    check('P2 the moved session is no longer listed', !listed.includes(id), JSON.stringify(listed));
    const reopened = await attempt(() => persistence.open(id, 'write'));
    check('P2 nobody can open it for write once it is out of the tree', reopened.error?.name === 'SessionPersistenceNotFoundError', String(reopened.error?.name ?? 'it succeeded'));

    // P3 — a late cold-read write-back, and the watcher that deletes it again.
    const table = ctx.storageDomain.get('session_projcache')?.table('sessions');
    const recordFile = join(storagesRoot, 'session_projcache', 'sessions', `${id}.json`);
    const tombstone = identityOf(header, inheritedEventCount);
    check('P3 the documented diagnostic lookup reaches the table the cache writes', table !== undefined && table === ctx.sessionProjectionCache.table);
    if (table === undefined) return;
    check('P3 the detach wrote a checkpoint bound to the log identity', canonical(table.get(id)?.identity) === canonical(tombstone) && existsSync(recordFile), `${canonical(table.get(id)?.identity)} vs ${canonical(tombstone)}`);
    // Control: with no watcher, the late write-back does resurrect the record —
    // otherwise the watcher check below would prove nothing.
    await table.delete(id);
    const resurrected = nextChange(id, 'put');
    ctx.sessionProjectionCache.coldSnapshot(header, inheritedEventCount, events);
    check('P3 control: with no watcher, a late cold-read write-back resurrects the checkpoint', (await resurrected) && table.get(id) !== undefined && existsSync(recordFile));

    const changes = [];
    ctx.on('domain/changed', (change) => {
      if (change.domain !== 'session_projcache') return;
      changes.push({ operation: change.operation, key: change.key, identity: change.value?.identity });
      if (change.operation === 'put' && change.key === id && canonical(change.value?.identity) === canonical(tombstone)) void table.delete(change.key);
    });
    await table.delete(id);
    check('P3 purging through the table clears memory and disk', table.get(id) === undefined && !existsSync(recordFile));
    const deletedAgain = nextChange(id, 'deleted');
    // The real late source (`dsh-session-projection-cache:284-289`): a reader that
    // loaded the log before the commit and folds it after the delete.
    ctx.sessionProjectionCache.coldSnapshot(header, inheritedEventCount, events);
    check('P3 the watcher deletes the late write-back', await deletedAgain);
    const putAt = changes.findIndex((change) => change.operation === 'put' && change.key === id);
    const deletedAt = changes.findIndex((change, index) => index > putAt && change.operation === 'deleted' && change.key === id);
    check('P3 the put event carries the record and its identity', putAt !== -1 && canonical(changes[putAt].identity) === canonical(tombstone), JSON.stringify(changes[putAt]));
    check('P3 the delete lands after the put on the write chain', putAt !== -1 && deletedAt > putAt, JSON.stringify(changes.map((change) => change.operation)));
    check('P3 memory and disk both end empty', table.get(id) === undefined && !existsSync(recordFile));

    // P4 — the same id, created anew, is a new session, not a resurrection.
    await new Promise((resolve) => setTimeout(resolve, 5)); // a distinct createdAt
    const reborn = await ctx.agents.create({ sessionId: id, meta: { cwd: workroot } });
    await ctx.sessions.flush(reborn.agent.session);
    await reborn.dispose();
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the detach write-back and any watcher reaction land
    const record = table.get(id);
    check('P4 the new session has a checkpoint after its own detach', record !== undefined);
    check('P4 its identity differs from the tombstone', record !== undefined && canonical(record.identity) !== canonical(tombstone), `${canonical(record?.identity)} vs ${canonical(tombstone)}`);
    check('P4 the watcher saw that put (it was armed, not absent)', changes.some((change) => change.operation === 'put' && change.key === id && canonical(change.identity) !== canonical(tombstone)), JSON.stringify(changes.slice(-3)));
    check('P4 the watcher left it alone (memory and disk)', record !== undefined && existsSync(recordFile));
  } catch (error) {
    check('Part B2 ran to completion', false, error?.stack ?? String(error));
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
}

/**
 * Part C: materialise the browser half in a stub module table and activate it
 * against a stub client runtime.
 *
 * The Client half is a classic script that hands its factory to
 * `window.__ModuleLoader__.load`; nothing about it is type-checked or executed
 * until a page loads, so a mistake there costs a boot failure that the Host half
 * cannot see. This part runs the same sequence the page does — register, build
 * the module, call `apply` — and asserts the contributions, the Remote manifest
 * and the dictionaries, which is exactly the class of defect (a const referenced
 * from its own temporal dead zone) that shipped the first time.
 */
async function testClientHalf(app) {
  console.log('\nPart C — client half materialisation and registration');
  const source = await readFile(join(here, 'client.js'), 'utf8');

  const registered = [];
  const sandbox = { console, window: { __ModuleLoader__: { load: (spec) => registered.push(spec) } } };
  vm.createContext(sandbox);
  try {
    vm.runInContext(source, sandbox, { filename: 'client.js' });
    check('module body evaluates and registers itself', registered.length === 1, `${String(registered.length)} registration(s)`);
  } catch (error) {
    check('module body evaluates and registers itself', false, String(error));
    return;
  }
  const module = registered[0];
  check('module id is the package name', module.id === '@jedeiah/session-purge', String(module.id));
  check('it exposes a factory', typeof module.factory === 'function');

  // The two specifiers a page resolves for this bundle: React and the primitives
  // package, both platform seeds. Anything else would fail at runtime.
  const required = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => undefined],
    useEffect: () => undefined,
    Fragment: Symbol('Fragment'),
    useSyncExternalStore: (_subscribe, read) => read(),
  };
  const primitives = new Proxy({}, { get: (_target, key) => (props) => ({ type: String(key), props }) });
  const require = (spec) => {
    required.push(spec);
    if (spec === 'react') return react;
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`client half required an unexpected specifier: ${spec}`);
  };

  let plugin;
  try {
    plugin = module.factory(require);
    check('factory body runs (no temporal-dead-zone reference)', true);
  } catch (error) {
    check('factory body runs (no temporal-dead-zone reference)', false, String(error));
    return;
  }
  check('exports { inject, apply }', typeof plugin.apply === 'function' && Array.isArray(plugin.inject), JSON.stringify(plugin.inject));
  check('requires only platform seeds', required.every((spec) => spec === 'react' || spec === '@deepseek-ai/dsh-client-ui-primitives'), required.join(', '));

  const entries = [];
  const effects = [];
  const writes = [];
  const mounted = [];
  let namespaceReads = 0;
  let dictionaries;

  // The fake namespace service `$mount` publishes, plus a context stub that
  // enforces cordis's own rule: `remote.<namespace>` is readable only on a
  // context that declared it in `inject`. A client half that reads it from its
  // own context therefore fails here exactly as it fails in the browser
  // ("cannot get property \"remote.sessionPurge\" without inject").
  const namespace = {
    inspect: async () => ({ sessionId: 'x', targets: [], sizeBytes: 0, scheduleCount: 0, spillDirectoryCount: 0, includeDescendants: true, purgeAttachments: false, live: false, blocked: null, forkIds: [], logBytes: 0, spillBytes: 0 }),
    purge: async () => ({ sessionId: 'x', targets: [], removedIds: [], failedIds: [], forkIds: [], removed: { bytesFreed: 0 }, warnings: [] }),
  };
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: {} }),
    subscribe: () => () => undefined,
    mutate: (ops, revision) => { writes.push({ ops, revision }); return Promise.resolve(true); },
    set: () => undefined,
    unset: () => undefined,
  };
  const makeRemote = (injected) => {
    const remote = {
      $mount: async (contribution) => {
        mounted.push(contribution);
        await Promise.resolve();
        return async () => undefined;
      },
    };
    if (injected) {
      Object.defineProperty(remote, 'sessionPurge', {
        get: () => { namespaceReads += 1; return namespace; },
      });
    } else {
      Object.defineProperty(remote, 'sessionPurge', {
        get: () => { throw new Error('cannot get property "remote.sessionPurge" without inject'); },
      });
    }
    return remote;
  };
  const makeCtx = (injected = new Set()) => {
    const ctx = {
      remote: makeRemote(injected.has('remote.sessionPurge')),
      slots: {
        register: (options, component) => { entries.push({ options, component }); return () => undefined; },
        inject: (_slot, callback) => {
          const produced = callback();
          if (produced !== undefined && produced !== null && typeof produced[Symbol.iterator] === 'function') for (const _entry of produced) { /* register() recorded it */ }
        },
      },
      locale: { register: (namespace, dicts) => { dictionaries = { namespace, ...dicts }; return () => undefined; } },
      configForms: { whileServed: (_namespaces, register) => register(new Set(['session-purge'])) },
      effect: (body, label) => { effects.push(label); const dispose = body(); return typeof dispose === 'function' ? dispose : () => undefined; },
      get: (name) => (name === 'configForms' ? ctx.configForms : undefined),
      inject: (names, callback) => {
        injectedNames.push(...names);
        const child = makeCtx(new Set(names));
        const cleanup = callback(child);
        return {
          then: (resolve, reject) => Promise.resolve(cleanup).then(resolve, reject),
          catch: (reject) => Promise.resolve(cleanup).catch(reject),
          dispose: async () => { if (typeof cleanup === 'function') await cleanup(); },
        };
      },
    };
    return ctx;
  };
  const injectedNames = [];
  const ctx = makeCtx();

  let disposer;
  try {
    disposer = await plugin.apply(ctx);
    check('apply() completes against a stub runtime', true);
  } catch (error) {
    check('apply() completes against a stub runtime', false, String(error));
    return;
  }
  check('apply returns a disposer', typeof disposer === 'function');
  check('the Remote namespace is read through an injected child context', injectedNames.includes('remote.sessionPurge'), injectedNames.join(', '));
  check('the bundle mounts exactly one Remote contribution', mounted.length === 1 && mounted[0].package === '@jedeiah/session-purge');

  const slots = entries.map((entry) => entry.options.name);
  check('contributes a sidebar row action', slots.includes('sidebar.workspaces.session.row.action'));
  check('contributes a sidebar menu row', slots.includes('sidebar.workspaces.session.menu.item'));
  check('contributes two overlay entries (dialog + toast)', slots.filter((slot) => slot === 'shell.overlay').length === 2, slots.join(', '));

  // The dialog's geometry, both halves of it. Neither failure is visible in a
  // page: drop the hooks and the card sizes to its content again (an 80-target
  // preview measured 3657px tall on an 828px viewport, footer buttons off-screen);
  // drop the stylesheet and the same thing happens with the classes in place.
  const confirmEntry = entries.find((entry) => entry.options.id === 'session-purge-confirm');
  const confirm = confirmEntry?.options.inject();
  confirm?.purge.open('session-hooks', 'Hooks');
  const dialogTree = confirmEntry?.component({ purge: confirm?.purge, t: (key) => key });
  check(
    'the confirmation dialog hands both geometry hooks to the Modal primitive',
    dialogTree?.props?.className === 'sessionPurge-dialog' && dialogTree?.props?.contentClassName === 'sessionPurge-dialog-content',
    JSON.stringify([dialogTree?.props?.className, dialogTree?.props?.contentClassName]),
  );
  confirm?.purge.dismiss();

  // A second materialisation, this time with a document: the only DOM write the
  // module makes is that one stylesheet, and it must be tagged so a page inspector
  // can find it next to the ones dsh's own plugins leave.
  {
    const created = [];
    let domSpec;
    const dom = {
      console,
      window: { __ModuleLoader__: { load: (contribution) => { domSpec = contribution; } } },
      document: {
        head: { appendChild: (tag) => created.push(tag) },
        querySelector: () => null,
        createElement: (name) => ({ name, dataset: {}, textContent: '' }),
      },
    };
    vm.createContext(dom);
    try {
      vm.runInContext(source, dom, { filename: 'client.js' });
      domSpec.factory(require);
      const style = created[0];
      check(
        'the module injects its dialog stylesheet once, tagged for inspection',
        created.length === 1 && style?.dataset?.plugin === '@jedeiah/session-purge' && style?.dataset?.pluginCss === '@jedeiah/session-purge/client.css',
        JSON.stringify(created.map((tag) => tag.dataset)),
      );
      check(
        'the stylesheet caps the card and scrolls the content region',
        /\.sessionPurge-dialog \{[^}]*max-height: min\(800px, 100%\)/.test(style?.textContent ?? '') && /\.sessionPurge-dialog-content \{[^}]*overflow-y: auto/.test(style?.textContent ?? ''),
        JSON.stringify(style?.textContent ?? null),
      );
    } catch (error) {
      check('the module injects its dialog stylesheet once, tagged for inspection', false, String(error));
    }
  }
  const settingsEntry = entries.find((entry) => entry.options.name === 'plugins.row.config');
  check('contributes the row configuration page keyed <package>#<row id>', settingsEntry?.options.key === '@jedeiah/session-purge#session-purge', JSON.stringify(settingsEntry?.options));
  const card = settingsEntry?.component({ t: (key) => key, view: 'summary', form: undefined });
  check('the settings page renders a one-liner for the summary view', typeof card === 'string');
  const page = settingsEntry?.component({
    t: (key) => key,
    view: 'page',
    form: {
      state: { status: 'ready', writable: true, revision: 3, value: { purgeAttachments: true, purgeSpill: false } },
      mutate: (ops, revision) => { writes.push({ ops, revision }); return Promise.resolve(true); },
    },
  });
  const flat = JSON.stringify(page, (key, value) => (typeof value === 'function' ? '[fn]' : value));
  check('the settings page renders every switch with the stored values', flat.includes('optPurgeAttachments') && flat.includes('"checked":true') && flat.includes('"checked":false'), flat.slice(0, 160));
  const rendered = (() => {
    const nodes = [];
    const walk = (node) => {
      if (Array.isArray(node)) { for (const child of node) walk(child); return; }
      if (node === null || node === undefined || typeof node !== 'object') return;
      nodes.push(node);
      walk(node.children);
    };
    walk(page);
    return nodes;
  })();
  const checkbox = rendered.find((node) => node.props?.type === 'checkbox');
  const boxes = rendered.filter((node) => node.props?.type === 'checkbox').length;
  const textFields = rendered.filter((node) => node.props?.type === 'text').length;
  check('the settings page renders one checkbox per scope switch plus the spill-root field', boxes === 5 && textFields === 1, `checkboxes=${String(boxes)} text=${String(textFields)}`);
  checkbox.props.onChange({ target: { checked: true } });
  check('toggling a switch queues one field write with the revision fence', writes.length === 1 && writes[0].ops[0].op === 'set' && writes[0].revision === 3, JSON.stringify(writes));
  check('list entries carry an id, the keyed entry a key, all a locale namespace', entries.every((entry) => (typeof entry.options.id === 'string' || typeof entry.options.key === 'string') && entry.options.locale === 'plugin.sessionPurge'), JSON.stringify(entries.map((entry) => entry.options.id ?? entry.options.key)));
  check('every sidebar and overlay entry injects its behavior', entries.filter((entry) => entry.options.name !== 'plugins.row.config').every((entry) => typeof entry.options.inject === 'function'));
  check('registers the dictionaries and the settings page as effects', effects.length === 2 && dictionaries?.namespace === 'plugin.sessionPurge', effects.join(' | '));

  const hostManifest = await import(join(here, 'typert.js'));
  const shape = (descriptor) => `${descriptor.namespace}/${descriptor.method}:${descriptor.parameters.map((parameter) => `${parameter.wire}=${parameter.source}`).join(',')}`;
  const hostShape = hostManifest.TYPERT.invocations.map(shape).sort();
  const clientShape = (mounted[0]?.descriptors ?? []).map(shape).sort();
  check('the inline Client manifest matches the Host manifest field for field', JSON.stringify(hostShape) === JSON.stringify(clientShape), `${hostShape.join(' | ')} vs ${clientShape.join(' | ')}`);

  check('both manifests are owned by this package', hostManifest.TYPERT.package === '@jedeiah/session-purge' && mounted[0].package === '@jedeiah/session-purge');

  check('the mounted contribution carries every method',
    mounted[0].descriptors.length === 3
    && ['inspect', 'purge', 'sweepResidue'].every((method) => mounted[0].descriptors.some((descriptor) => descriptor.method === method)),
    JSON.stringify(mounted[0].descriptors.map((descriptor) => `${descriptor.namespace}/${descriptor.method}`)));
  // The namespace answers `{ ok, value }`. Reading the report off the raw answer
  // is the classic silent break — the page would show `undefined` and look empty —
  // so the residue call must go through the same helper every other call uses.
  check('the residue call routes through the envelope-unwrapping helper',
    /residue\(apply\) \{\s*return call\('sweepResidue', apply === true\);/.test(source));

  // Mirrors the Client API's own admission checks: every declared field must carry
  // `mode: 'strict'`, a type symbol and a `create()` factory, or the namespace
  // mounts nothing and every call fails at runtime.
  const isStrictCodec = (codec) => codec?.mode === 'strict' && typeof codec.typeSymbol === 'string' && codec.typeSymbol.length > 0 && typeof codec.create === 'function';
  const fields = (mounted[0]?.descriptors ?? []).flatMap((descriptor) => [...descriptor.parameters.map((parameter) => parameter.codec), descriptor.result]);
  check('every Client descriptor field carries a strict codec', fields.length > 0 && fields.every(isStrictCodec), fields.map((codec) => `${String(codec?.mode)}/${String(codec?.typeSymbol)}`).join(', '));

  const dictionaryBlock = (name) => {
    const start = source.indexOf(`const ${name} = {`);
    const end = source.indexOf('};', start);
    return new Set([...source.slice(start, end).matchAll(/^ {6}([a-zA-Z][A-Za-z0-9_]*):/gm)].map((match) => match[1]));
  };
  const zh = dictionaryBlock('zh');
  const en = dictionaryBlock('en');
  // Reading the namespace from the plugin's own context must still throw (that is
  // the browser failure this wiring exists to avoid), while the child context is
  // allowed to read it.
  let outerThrew = false;
  try { void ctx.remote.sessionPurge; } catch { outerThrew = true; }
  check('the outer context still guards the dotted service (regression shape)', outerThrew);

  const usedKeys = new Set([...source.matchAll(/\bt\('[A-Za-z][A-Za-z0-9_]*'/g)].map((match) => match[0].slice(3, -1)));
  // The scope switches are worded from a table, so their keys appear only as
  // `t(\`opt${field}\`)` templates: every opt*/hint* entry is live when the source
  // renders those two templates.
  if (source.includes('t(`opt${') && source.includes('t(`hint${')) {
    for (const key of [...zh, ...en]) if (/^(opt|hint)[A-Z]/.test(key)) usedKeys.add(key);
  }
  check('every t() key exists in both dictionaries', [...usedKeys].every((key) => zh.has(key) && en.has(key)), [...usedKeys].filter((key) => !zh.has(key) || !en.has(key)).join(', '));
  check('no dictionary key is dead', [...zh].every((key) => usedKeys.has(key)), [...zh].filter((key) => !usedKeys.has(key)).join(', '));

  // The strongest available admission check: hand the Client manifest to the
  // installation's own Typert registry, the same one the browser mounts it into.
  if (!(await exists(join(app, 'dsh-typert-registry', 'lib', 'index.js')))) {
    console.log('  skip real-registry admission (no dsh installation; pass --app)');
    return;
  }
  try {
    const { Context } = await import(join(app, 'cordis', 'lib', 'index.js'));
    const { TypertRegistry } = await import(join(app, 'dsh-typert-registry', 'lib', 'index.js'));
    const ctx = new Context();
    new TypertRegistry(ctx);
    const dispose = ctx.typert.remotes.register(mounted[0]);
    await dispose();
    check('the installation\'s Typert registry admits the Client manifest', true);
  } catch (error) {
    check('the installation\'s Typert registry admits the Client manifest', false, String(error));
  }
}

const root = await mkdtemp(join(tmpdir(), 'session-purge-selftest-'));
try {
  const store = await buildStore(join(root, 'store'));
  await testEngine(store);
  await testSpillDiscovery();
  await testTransactionStore(join(root, 'txn'));
  await testClientHalf(appDirectory());
  await testGateway(appDirectory(), root);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nall checks passed' : `\n${String(failures)} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
