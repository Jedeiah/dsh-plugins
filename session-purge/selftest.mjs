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
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
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
  await cp(join(here, 'typert.js'), join(bundle, 'typert.js'));
  // Windows cannot create directory symlinks without Developer Mode or elevation,
  // so the shim uses a junction there; every other platform takes a plain symlink.
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const name of ['schemastery', 'dsh-typert-protocol', 'dsh-home-paths']) {
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
  });
  if (config.issues !== undefined) {
    check('row configuration validates', false, JSON.stringify(config.issues));
    return true;
  }
  const plain = (value) => (typeof value?.get === 'function' ? value.get() : value);
  check('row configuration validates and fills defaults', plain(config.value.includeDescendants) === true && plain(config.value.purgeAttachments) === false, JSON.stringify([plain(config.value.includeDescendants), plain(config.value.purgeAttachments)]));
  check('volatile fields arrive as live references', typeof config.value.includeDescendants?.get === 'function');

  const boot = (settings) => {
    const ctx = new Context();
    new TypertRegistry(ctx);
    ctx.typert.register(manifest.TYPERT);
    const gateway = new TypertGatewayService(ctx, {});
    host.apply(ctx, settings);
    return { ctx, gateway, peer: new Peer(ctx, { principal: { kind: 'owner' } }) };
  };
  const { gateway, peer } = boot(config.value);

  const inspect = await gateway.invoke({ namespace: 'sessionPurge', method: 'inspect', args: { sessionId: store.parentId }, signal: new AbortController().signal, peer });
  check('inspect returns every lineage target with titles', inspect.targets.length === 3 && inspect.targets[0].title === 'Synthetic parent' && inspect.targets.some((target) => target.sessionId === store.grandId && target.title === 'Synthetic grandchild'), JSON.stringify(inspect.targets.map((target) => [target.sessionId, target.title])));
  check('inspect reports the fork that will be kept', (inspect.forkIds ?? []).includes(store.forkId), JSON.stringify(inspect.forkIds));
  check('inspect reports no blocking liveness', inspect.blocked === null);
  check('inspect counts the spilled directory', inspect.spillDirectoryCount === 1, String(inspect.spillDirectoryCount));
  check('inspect totals the disk size', inspect.sizeBytes > 0, String(inspect.sizeBytes));

  const report = await gateway.invoke({ namespace: 'sessionPurge', method: 'purge', args: { sessionId: store.parentId }, signal: new AbortController().signal, peer });
  check('purge deletes the session, its child and its grandchild', report.targets.length === 3 && report.removedIds.length === 3, report.targets.join(','));
  check('purge reports every removed artifact', report.removed.sessionDirectories === 3 && report.removed.projectionRecords === 5 && report.removed.spillDirectories === 1, JSON.stringify(report.removed));
  check('purge leaves the survivor readable', await exists(join(store.survivorProject, store.keptId, 'session.v4.jsonl.zstd')));
  check('purge leaves the fork untouched', await exists(join(store.project, store.forkId)));
  check('purge keeps unreferenced attachments (default off)', await exists(join(store.attachmentsRoot, 'v1', 'objects', store.doomedDigest.slice(0, 2), store.doomedDigest)));

  const second = await buildStore(join(workroot, 'gateway-store-live'));
  const liveHost = boot({ ...config.value, sessionsRoot: second.sessionsRoot, storagesRoot: second.storagesRoot, attachmentsRoot: second.attachmentsRoot, spillRoots: [second.spillRoot], purgeAttachments: true });
  // One service instance per context: flip the stub's answer instead of replacing it.
  const live = { sessionId: second.parentId };
  liveHost.ctx.provide('agents', { get: (id) => (live.sessionId === id ? { id } : undefined) });
  let refusal;
  try {
    await liveHost.gateway.invoke({ namespace: 'sessionPurge', method: 'purge', args: { sessionId: second.parentId }, signal: new AbortController().signal, peer: liveHost.peer });
  } catch (error) {
    refusal = error;
  }
  check('a live target is refused with a stable code', refusal?.code === 'session-purge/session-live', String(refusal?.code));
  check('the refusal names the live session', Array.isArray(refusal?.details?.sessionIds) && refusal.details.sessionIds.includes(second.parentId), JSON.stringify(refusal?.details));
  check('the live session survives the refusal', await exists(join(second.project, second.parentId)));
  live.sessionId = null;
  const retry = await liveHost.gateway.invoke({ namespace: 'sessionPurge', method: 'purge', args: { sessionId: second.parentId }, signal: new AbortController().signal, peer: liveHost.peer });
  check('once cold, the same purge succeeds and clears the unreferenced attachment', retry.removed.attachmentObjects === 1, JSON.stringify(retry.removed));

  // ── Live guard, error codes, and the Host-side reference bookkeeping ──────
  {
    const third = await buildStore(join(workroot, 'gateway-store-bookkeeping'));
    const host3 = boot({ ...config.value, sessionsRoot: third.sessionsRoot, storagesRoot: third.storagesRoot, attachmentsRoot: third.attachmentsRoot, spillRoots: [third.spillRoot] });
    const calls = [];
    const live = { sessionId: third.childId };
    host3.ctx.provide('agents', { get: (id) => (live.sessionId === id ? { id } : undefined) });
    host3.ctx.effect(() => host3.ctx.on('api-session/removed', (id) => calls.push(`removed:${id}`)), 'selftest: announce listener');
    host3.ctx.provide('workspaceRegistry', {
      list: () => [{
        id: 'ws-1',
        sessionIds: [third.parentId],
        detachSession: (id) => {
          // Ordering: the accounting slot must be dropped while the log is still
          // there, or the registry's filtered view skips it and the slot strands.
          calls.push(`detach:${id}:log-${existsSync(join(third.project, id)) ? 'present' : 'gone'}`);
          return Promise.resolve();
        },
      }],
      unarchiveSession: (id) => calls.push(`unarchive:${id}`),
      unpinSession: (id) => calls.push(`unpin:${id}`),
    });
    host3.ctx.provide('schedule', {
      catalog: async () => [{ id: 'task-1', sessionId: third.parentId }, { id: 'task-2', sessionId: 'unrelated' }],
      delete: async ({ id, sessionId }) => { calls.push(`schedule:${sessionId}/${id}`); return { deleted: true }; },
    });

    const blockedInspection = await host3.gateway.invoke({ namespace: 'sessionPurge', method: 'inspect', args: { sessionId: third.parentId }, signal: new AbortController().signal, peer: host3.peer });
    check('a live *child* is reported as blocking the preview', blockedInspection.blocked?.sessionIds?.includes(third.childId) === true, JSON.stringify(blockedInspection.blocked));
    let childRefusal;
    try {
      await host3.gateway.invoke({ namespace: 'sessionPurge', method: 'purge', args: { sessionId: third.parentId }, signal: new AbortController().signal, peer: host3.peer });
    } catch (error) {
      childRefusal = error;
    }
    check('a live child refuses the purge with the stable code', childRefusal?.code === 'session-purge/session-live', String(childRefusal?.code));

    live.sessionId = null;
    const bookkeeping = await host3.gateway.invoke({ namespace: 'sessionPurge', method: 'purge', args: { sessionId: third.parentId }, signal: new AbortController().signal, peer: host3.peer });
    check('the purge drops the Workspace slot before the log disappears', calls.includes(`detach:${third.parentId}:log-present`), calls.join(' | '));
    check('archive and pin entries are cleared through the registry', calls.includes(`unarchive:${third.parentId}`) && calls.includes(`unpin:${third.parentId}`), calls.join(' | '));
    check('only reminders bound to the targets are deleted', calls.includes(`schedule:${third.parentId}/task-1`) && !calls.some((entry) => entry.includes('task-2')), calls.join(' | '));
    check('the report counts the schedule and workspace work', bookkeeping.removed.schedules === 1 && bookkeeping.removed.workspaceSlots === 1, JSON.stringify(bookkeeping.removed));
    check('every removed session is announced once', bookkeeping.removedIds.every((id) => calls.includes(`removed:${id}`)) && calls.filter((entry) => entry.startsWith('removed:')).length === bookkeeping.removedIds.length, calls.join(' | '));

    let unknownRefusal;
    try {
      await host3.gateway.invoke({ namespace: 'sessionPurge', method: 'inspect', args: { sessionId: 'session-does-not-exist' }, signal: new AbortController().signal, peer: host3.peer });
    } catch (error) {
      unknownRefusal = error;
    }
    check('an unknown session is refused with its own code', unknownRefusal?.code === 'session-purge/session-unknown', String(unknownRefusal?.code));
    let invalidRefusal;
    try {
      await host3.gateway.invoke({ namespace: 'sessionPurge', method: 'inspect', args: { sessionId: '../evil' }, signal: new AbortController().signal, peer: host3.peer });
    } catch (error) {
      invalidRefusal = error;
    }
    // Either layer may answer first: the manifest codec rejects at the wire
    // boundary (`gateway/input-invalid`) and the service re-checks with its own
    // stable code. Both mean "refused before any path use".
    check('a traversal-shaped id is refused before any path use', invalidRefusal !== undefined && (invalidRefusal.code === 'session-purge/invalid-session-id' || invalidRefusal.code === 'gateway/input-invalid' || String(invalidRefusal.message).includes('path-safe')), `${String(invalidRefusal?.code)} ${String(invalidRefusal?.message)}`);

    // A target set that grew between preview and confirmation must be refused,
    // not silently deleted.
    const fourth = await buildStore(join(workroot, 'gateway-store-drift'));
    const host4 = boot({ ...config.value, sessionsRoot: fourth.sessionsRoot, storagesRoot: fourth.storagesRoot, attachmentsRoot: fourth.attachmentsRoot, spillRoots: [fourth.spillRoot] });
    await host4.gateway.invoke({ namespace: 'sessionPurge', method: 'inspect', args: { sessionId: fourth.parentId }, signal: new AbortController().signal, peer: host4.peer });
    await mkdir(join(fourth.project, '99999999-8888-7777-6666-555555555555'), { recursive: true });
    await writeFile(join(fourth.project, '99999999-8888-7777-6666-555555555555', 'session.v4.jsonl.zstd'), storedLog(
      { type: 'session', version: 4, id: '99999999-8888-7777-6666-555555555555', createdAt: 9, cwd: '/Users/example/projects/demo', parentSession: fourth.parentId, isSeeded: false, origin: 'subagent', delegationDepth: 1 },
      [{ type: 'session/title', seq: 1, time: 9, data: { title: 'Late child' } }],
    ));
    let driftRefusal;
    try {
      await host4.gateway.invoke({ namespace: 'sessionPurge', method: 'purge', args: { sessionId: fourth.parentId }, signal: new AbortController().signal, peer: host4.peer });
    } catch (error) {
      driftRefusal = error;
    }
    check('a target set that grew since the preview is refused', driftRefusal?.code === 'session-purge/target-set-changed', String(driftRefusal?.code));
    check('the late child survives the refusal', existsSync(join(fourth.project, '99999999-8888-7777-6666-555555555555')));
    // A failed log removal must leave the session whole. Its Workspace slot, its
    // projection record and its reminders are what keep it reachable and
    // configurable; clearing them around a surviving log turns a failed delete
    // into an invisible orphan that no dialog can ever reach again.
    const fifth = await buildStore(join(workroot, 'gateway-store-fail'));
    const host5 = boot({ ...config.value, sessionsRoot: fifth.sessionsRoot, storagesRoot: fifth.storagesRoot, attachmentsRoot: fifth.attachmentsRoot, spillRoots: [fifth.spillRoot] });
    const detachedAgain = [];
    const reattached = [];
    host5.ctx.provide('workspaceRegistry', {
      list: () => [{
        id: 'ws-fail',
        sessionIds: [fifth.parentId],
        detachSession: (id) => { detachedAgain.push(id); return Promise.resolve(); },
        attachSession: (id) => { reattached.push(id); return Promise.resolve(); },
      }],
      unarchiveSession: () => undefined,
      unpinSession: () => undefined,
    });
    // A session directory without write permission cannot have its entries
    // unlinked, so `rm -r` fails before touching a single byte: the log survives
    // intact. (A half-deleted directory is a different, unrecoverable story.)
    const sessionDirectory = join(fifth.project, fifth.parentId);
    const sessionMode = (await stat(sessionDirectory)).mode;
    await chmod(sessionDirectory, 0o500);
    let failureReport;
    try {
      failureReport = await host5.gateway.invoke({ namespace: 'sessionPurge', method: 'purge', args: { sessionId: fifth.parentId }, signal: new AbortController().signal, peer: host5.peer });
    } finally {
      await chmod(sessionDirectory, sessionMode);
    }
    check('the failed directory still holds its log', existsSync(join(sessionDirectory, 'session.v4.jsonl.zstd')));
    check('a directory that cannot be removed is reported as failed',
      failureReport?.failedIds?.includes(fifth.parentId) === true, JSON.stringify(failureReport?.failedIds));
    check('the failed session is not announced as removed',
      failureReport?.removedIds?.includes(fifth.parentId) !== true, JSON.stringify(failureReport?.removedIds));
    check('its projection record survives the failed purge',
      existsSync(join(fifth.storagesRoot, 'session_projcache', 'sessions', `${fifth.parentId}.json`)));
    check('its Workspace slot is put back after the failure',
      detachedAgain.includes(fifth.parentId) && reattached.includes(fifth.parentId),
      `detached=[${detachedAgain.join(',')}] reattached=[${reattached.join(',')}]`);
    check('the failure names the session in a warning',
      Array.isArray(failureReport?.warnings) && failureReport.warnings.some((line) => line.includes(fifth.parentId)),
      JSON.stringify(failureReport?.warnings));

    // Cancellation inside the sweep is the same hazard as a filesystem failure:
    // the slots are dropped before the logs, so a cancel must put back the ones
    // whose directory never came off the disk.
    const sixth = await buildStore(join(workroot, 'gateway-store-cancel'));
    const host6 = boot({ ...config.value, sessionsRoot: sixth.sessionsRoot, storagesRoot: sixth.storagesRoot, attachmentsRoot: sixth.attachmentsRoot, spillRoots: [sixth.spillRoot] });
    const restoredOnCancel = [];
    host6.ctx.provide('workspaceRegistry', {
      list: () => [{
        id: 'ws-cancel',
        sessionIds: [sixth.parentId, sixth.childId, sixth.grandId],
        detachSession: () => Promise.resolve(),
        attachSession: (id) => { restoredOnCancel.push(id); return Promise.resolve(); },
      }],
      unarchiveSession: () => undefined,
      unpinSession: () => undefined,
    });
    // Abort on the fourth `aborted` read: the plan checks once, the step boundary
    // before the sweep checks again, and each removal step checks once more. That
    // leaves the first target deleted and the rest untouched — exactly the
    // half-finished state a cancel produces.
    const abortReason = new Error('selftest: cancelled mid-sweep');
    let reads = 0;
    const cancelling = {
      get aborted() { reads += 1; return reads >= 4; },
      get reason() { return abortReason; },
    };
    let cancelError;
    try {
      await host6.gateway.invoke({ namespace: 'sessionPurge', method: 'purge', args: { sessionId: sixth.parentId }, signal: cancelling, peer: host6.peer });
    } catch (error) {
      cancelError = error;
    }
    check('a cancelled sweep reports the cancellation', cancelError !== undefined && /abort/i.test(String(cancelError.message ?? cancelError)), String(cancelError?.message ?? cancelError));
    check('the target removed before the cancel stays deleted', !existsSync(join(sixth.project, sixth.parentId)));
    check('the targets left on disk are still there',
      existsSync(join(sixth.project, sixth.childId)) && existsSync(join(sixth.nestedProject, sixth.grandId)));
    check('the cancel puts the surviving slots back',
      restoredOnCancel.includes(sixth.childId) && restoredOnCancel.includes(sixth.grandId) && !restoredOnCancel.includes(sixth.parentId),
      JSON.stringify(restoredOnCancel));

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

    const { scanResidue } = await import(join(here, 'engine.js'));
    const unfiltered = await scanResidue({ root: seventh.sessionsRoot });
    check('the residue scan finds every headerless session directory',
      unfiltered.directories.length === 4, JSON.stringify(unfiltered.directories.map((entry) => entry.directory.split('/').pop())));
    check('a folder that is neither a session id nor a stored log is never reported',
      !unfiltered.directories.some((entry) => entry.directory === foreignDirectory),
      JSON.stringify(unfiltered.directories.map((entry) => entry.directory.split('/').pop())));
    const aged = await scanResidue({ root: seventh.sessionsRoot, minimumAgeMs: 60_000 });
    check('the age guard spares a directory that was just created',
      aged.directories.length === 3 && !aged.directories.some((entry) => entry.directory === freshDirectory),
      JSON.stringify(aged.directories.map((entry) => entry.directory.split('/').pop())));
    check('the scan reports the bytes it would reclaim', aged.bytes === 16, String(aged.bytes));

    const host7 = boot({ ...config.value, sessionsRoot: seventh.sessionsRoot, storagesRoot: seventh.storagesRoot, attachmentsRoot: seventh.attachmentsRoot, spillRoots: [seventh.spillRoot] });
    const preview = await host7.gateway.invoke({ namespace: 'sessionPurge', method: 'sweepResidue', args: { apply: false }, signal: new AbortController().signal, peer: host7.peer });
    check('the preview lists the leftovers and removes nothing',
      preview.directories.length === 3 && preview.removed === 0 && preview.bytes === 16, JSON.stringify([preview.directories.length, preview.removed]));
    check('the preview really does not touch the disk',
      existsSync(brokenDirectory) && existsSync(emptyDirectory) && existsSync(renamedDirectory));

    let rejectedFlag;
    try {
      await host7.gateway.invoke({ namespace: 'sessionPurge', method: 'sweepResidue', args: { apply: 'yes' }, signal: new AbortController().signal, peer: host7.peer });
    } catch (error) {
      rejectedFlag = error;
    }
    check('a non-boolean apply is refused before any path use',
      rejectedFlag !== undefined && (rejectedFlag.code === 'gateway/input-invalid' || String(rejectedFlag.message).includes('boolean')),
      `${String(rejectedFlag?.code)} ${String(rejectedFlag?.message)}`);

    const swept = await host7.gateway.invoke({ namespace: 'sessionPurge', method: 'sweepResidue', args: { apply: true }, signal: new AbortController().signal, peer: host7.peer });
    check('the sweep removes exactly what the preview listed',
      swept.removed === 3 && !existsSync(brokenDirectory) && !existsSync(emptyDirectory) && !existsSync(renamedDirectory), JSON.stringify(swept.removed));
    check('the fresh directory survives the sweep', existsSync(freshDirectory));
    check('the foreign folder survives the sweep', existsSync(join(foreignDirectory, 'todo.md')));
    check('healthy sessions are untouched by the sweep', existsSync(join(seventh.project, seventh.parentId)));

  }
  await testDesignPremises(app, join(workroot, 'premises'));
  return true;
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
  await testClientHalf(appDirectory());
  await testGateway(appDirectory(), root);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nall checks passed' : `\n${String(failures)} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
