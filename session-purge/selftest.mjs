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
 * Nothing outside the temporary directory is read or written, except reading the
 * installation's packages.
 *
 * @module @local/session-purge/selftest
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * Build a synthetic dsh home.
 * @param root - the temporary directory to fill.
 * @returns the paths a purge configuration needs.
 */
async function buildStore(root) {
  const sessionsRoot = join(root, 'sessions');
  const storagesRoot = join(root, 'storages');
  const attachmentsRoot = join(root, 'attachments');
  const spillRoot = join(root, 'tmp', 'dsh-spill-abc123');
  const project = join(sessionsRoot, '--Users-me-projects-doomed--');
  const survivorProject = join(sessionsRoot, '--Users-me-projects-kept--');
  const parentId = 'session-parent-0000';
  const childId = '11111111-2222-3333-4444-555555555555';
  const keptId = 'session-kept-0000';
  const doomedDigest = 'a'.repeat(64);
  const keptDigest = 'b'.repeat(64);

  for (const id of [parentId, childId]) await mkdir(join(project, id), { recursive: true });
  await mkdir(join(survivorProject, keptId), { recursive: true });
  await mkdir(join(storagesRoot, 'session_projcache', 'sessions'), { recursive: true });
  await mkdir(join(attachmentsRoot, 'v1', 'objects', doomedDigest.slice(0, 2)), { recursive: true });
  await mkdir(join(attachmentsRoot, 'v1', 'objects', keptDigest.slice(0, 2)), { recursive: true });
  await mkdir(join(attachmentsRoot, 'v1', 'files', doomedDigest.slice(0, 2), doomedDigest), { recursive: true });
  await mkdir(join(spillRoot, `session-${createHash('sha256').update(parentId).digest('hex').slice(0, 12)}`), { recursive: true });

  const cwd = '/Users/example/projects/demo';
  await writeFile(join(project, parentId, 'session.v4.jsonl.zstd'), storedLog(
    { type: 'session', version: 4, id: parentId, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 },
    [
      { type: 'session/title', seq: 1, time: 2, data: { title: 'Synthetic parent' } },
      { type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'image', source: `sha256:${doomedDigest}` }] } },
    ],
  ));
  await writeFile(join(project, childId, 'session.v4.jsonl.zstd'), storedLog(
    { type: 'session', version: 4, id: childId, createdAt: 2, cwd, parentSession: parentId, isSeeded: false, origin: 'subagent', delegationDepth: 1 },
    [{ type: 'session/title', seq: 1, time: 3, data: { title: 'Synthetic child' } }],
  ));
  await writeFile(join(survivorProject, keptId, 'session.v4.jsonl.zstd'), storedLog(
    { type: 'session', version: 4, id: keptId, createdAt: 3, cwd, isSeeded: false, delegationDepth: 0 },
    [
      { type: 'session/title', seq: 1, time: 4, data: { title: 'Survivor' } },
      { type: 'user/message', seq: 2, time: 5, data: { content: [{ type: 'image', source: `sha256:${keptDigest}` }] } },
    ],
  ));
  const titles = { 'session-parent-0000': 'Synthetic parent', [childId]: 'Synthetic child', 'session-kept-0000': 'Survivor' };
  for (const [id, title] of Object.entries(titles)) {
    await writeFile(join(storagesRoot, 'session_projcache', 'sessions', `${id}.json`), JSON.stringify({ version: 7, record: { rows: { title: { ver: 1, seq: 1, val: title } } } }));
  }
  await writeFile(join(attachmentsRoot, 'v1', 'objects', doomedDigest.slice(0, 2), doomedDigest), 'doomed bytes');
  await writeFile(join(attachmentsRoot, 'v1', 'objects', keptDigest.slice(0, 2), keptDigest), 'kept bytes');
  await writeFile(join(attachmentsRoot, 'v1', 'files', doomedDigest.slice(0, 2), doomedDigest, 'report.png'), 'link');
  await writeFile(join(spillRoot, `session-${createHash('sha256').update(parentId).digest('hex').slice(0, 12)}`, 'tool-output.txt'), 'spilled');

  return { root, sessionsRoot, storagesRoot, attachmentsRoot, spillRoot, project, survivorProject, parentId, childId, keptId, doomedDigest, keptDigest };
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
  check('indexes three stored sessions', index.size === 3, `saw ${String(index.size)}`);

  const plan = await engine.planPurge({ root: store.sessionsRoot, sessionId: store.parentId, includeDescendants: true, spillRoots: [store.spillRoot] });
  check('plan includes the session and its subagent child', plan.targetIds.length === 2 && plan.targetIds.includes(store.childId), plan.targetIds.join(','));
  check('plan finds the spilled output directory', plan.spillDirectories.length === 1, plan.spillDirectories.join(','));
  check('plan totals the on-disk size of both logs', plan.sizeBytes > 0, String(plan.sizeBytes));

  const warnings = [];
  const digests = await engine.unreferencedDigests({
    doomed: plan.targets.map((target) => target.directory),
    survivors: [join(store.survivorProject, store.keptId)],
  });
  check('only the doomed digest is unreferenced', digests.size === 1 && digests.has(store.doomedDigest), [...digests].join(','));
  const directories = await engine.removeSessionDirectories({ plan, removeEmptyProjectDirectory: true, warnings });
  check('removes both session directories', directories.sessionDirectories === 2, JSON.stringify(directories));
  check('drops the emptied project directory', directories.projectDirectories === 1, JSON.stringify(directories));
  check('parent log is gone', !(await exists(join(store.project, store.parentId))));
  check('subagent log is gone', !(await exists(join(store.project, store.childId))));
  check('survivor log is untouched', await exists(join(store.survivorProject, store.keptId)));

  const records = await engine.removeProjectionRecords({ storagesRoot: store.storagesRoot, ids: plan.targetIds, warnings });
  check('removes both projection records and keeps the survivor', records === 2, String(records));
  check('survivor projection record stays', await exists(join(store.storagesRoot, 'session_projcache', 'sessions', 'session-kept-0000.json')));

  const spill = await engine.removeSpillDirectories({ ids: plan.targetIds, roots: [store.spillRoot], warnings });
  check('removes the spill directory', spill === 1, String(spill));
  check('prunes the emptied spill root', !(await exists(store.spillRoot)));

  const attachments = await engine.removeAttachments({ root: store.attachmentsRoot, digests, warnings });
  check('removes the doomed object and its reference link', attachments.objects === 1 && attachments.links === 1, JSON.stringify(attachments));
  check('keeps the survivor object', await exists(join(store.attachmentsRoot, 'v1', 'objects', store.keptDigest.slice(0, 2), store.keptDigest)));
  check('no warnings were raised', warnings.length === 0, warnings.join(' | '));
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
  for (const name of ['schemastery', 'dsh-typert-protocol', 'dsh-home-paths']) {
    await symlink(join(app, name), join(modules, 'node_modules', '@deepseek-ai', name), 'dir');
  }

  const { Context } = await import(join(app, 'cordis', 'lib', 'index.js'));
  const { TypertRegistry } = await import(join(app, 'dsh-typert-registry', 'lib', 'index.js'));
  const { TypertGatewayService } = await import(join(app, 'dsh-api-gateway', 'lib', 'index.js'));
  const { validateTypertManifest } = await import(join(app, 'dsh-typert-loader', 'lib', 'index.js'));
  const host = await import(join(bundle, 'index.js'));
  const manifest = await import(join(bundle, 'typert.js'));

  try {
    validateTypertManifest('@local/session-purge', manifest.TYPERT);
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
    return { ctx, gateway };
  };
  const { gateway } = boot(config.value);

  const inspect = await gateway.invoke({ namespace: 'sessionPurge', method: 'inspect', args: { sessionId: store.parentId }, signal: new AbortController().signal });
  check('inspect returns both targets with titles', inspect.targets.length === 2 && inspect.targets[0].title === 'Synthetic parent', JSON.stringify(inspect.targets.map((target) => [target.sessionId, target.title])));
  check('inspect reports no blocking liveness', inspect.blocked === null);
  check('inspect counts the spilled directory', inspect.spillDirectoryCount === 1, String(inspect.spillDirectoryCount));
  check('inspect totals the disk size', inspect.sizeBytes > 0, String(inspect.sizeBytes));

  const report = await gateway.invoke({ namespace: 'sessionPurge', method: 'purge', args: { sessionId: store.parentId }, signal: new AbortController().signal });
  check('purge deletes the session and its child', report.targets.length === 2, report.targets.join(','));
  check('purge reports every removed artifact', report.removed.sessionDirectories === 2 && report.removed.projectionRecords === 2 && report.removed.spillDirectories === 1, JSON.stringify(report.removed));
  check('purge leaves the survivor readable', await exists(join(store.survivorProject, store.keptId, 'session.v4.jsonl.zstd')));
  check('purge keeps unreferenced attachments (default off)', await exists(join(store.attachmentsRoot, 'v1', 'objects', store.doomedDigest.slice(0, 2), store.doomedDigest)));

  const second = await buildStore(join(workroot, 'gateway-store-live'));
  const liveHost = boot({ ...config.value, sessionsRoot: second.sessionsRoot, storagesRoot: second.storagesRoot, attachmentsRoot: second.attachmentsRoot, spillRoots: [second.spillRoot], purgeAttachments: true });
  // One service instance per context: flip the stub's answer instead of replacing it.
  const live = { sessionId: second.parentId };
  liveHost.ctx.provide('agents', { get: (id) => (live.sessionId === id ? { id } : undefined) });
  let refusal;
  try {
    await liveHost.gateway.invoke({ namespace: 'sessionPurge', method: 'purge', args: { sessionId: second.parentId }, signal: new AbortController().signal });
  } catch (error) {
    refusal = error;
  }
  check('a live target is refused with a stable code', refusal?.code === 'session-purge/session-live', String(refusal?.code));
  check('the refusal names the live session', Array.isArray(refusal?.details?.sessionIds) && refusal.details.sessionIds.includes(second.parentId), JSON.stringify(refusal?.details));
  check('the live session survives the refusal', await exists(join(second.project, second.parentId)));
  live.sessionId = null;
  const retry = await liveHost.gateway.invoke({ namespace: 'sessionPurge', method: 'purge', args: { sessionId: second.parentId }, signal: new AbortController().signal });
  check('once cold, the same purge succeeds and clears the unreferenced attachment', retry.removed.attachmentObjects === 1, JSON.stringify(retry.removed));
  return true;
}

const root = await mkdtemp(join(tmpdir(), 'session-purge-selftest-'));
try {
  const store = await buildStore(join(root, 'store'));
  await testEngine(store);
  await testGateway(appDirectory(), root);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nall checks passed' : `\n${String(failures)} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
