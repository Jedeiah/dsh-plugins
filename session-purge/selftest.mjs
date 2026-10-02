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
 * @module @jedeiah/session-purge/selftest
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  // Windows cannot create directory symlinks without Developer Mode or elevation,
  // so the shim uses a junction there; every other platform takes a plain symlink.
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const name of ['schemastery', 'dsh-typert-protocol', 'dsh-home-paths']) {
    await symlink(join(app, name), join(modules, 'node_modules', '@deepseek-ai', name), linkType);
  }

  const { Context } = await import(join(app, 'cordis', 'lib', 'index.js'));
  const { TypertRegistry } = await import(join(app, 'dsh-typert-registry', 'lib', 'index.js'));
  const { TypertGatewayService } = await import(join(app, 'dsh-api-gateway', 'lib', 'index.js'));
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
  let mounted;
  let dictionaries;
  const ctx = {
    remote: { $mount: async (contribution) => { mounted = contribution; return async () => undefined; } },
    locale: { register: (namespace, dicts) => { dictionaries = { namespace, ...dicts }; return () => undefined; } },
    slots: {
      register: (options, component) => { entries.push({ options, component }); return () => undefined; },
      inject: (_slot, callback) => {
        const produced = callback();
        if (produced !== undefined && produced !== null && typeof produced[Symbol.iterator] === 'function') for (const _entry of produced) { /* register() already recorded it */ }
      },
    },
    effect: (body, label) => { effects.push(label); const dispose = body(); return typeof dispose === 'function' ? dispose : () => undefined; },
    configForms: { whileServed: (_namespaces, register) => register(new Set(['session-purge'])) },
  };

  try {
    await plugin.apply(ctx);
    check('apply() completes against a stub runtime', true);
  } catch (error) {
    check('apply() completes against a stub runtime', false, String(error));
    return;
  }

  const slots = entries.map((entry) => entry.options.name);
  check('contributes a sidebar row action', slots.includes('sidebar.workspaces.session.row.action'));
  check('contributes a sidebar menu row', slots.includes('sidebar.workspaces.session.menu.item'));
  check('contributes two overlay entries (dialog + toast)', slots.filter((slot) => slot === 'shell.overlay').length === 2, slots.join(', '));
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
  check('the settings page renders one checkbox per scope switch', rendered.filter((node) => node.props?.type === 'checkbox').length === 5, String(rendered.filter((node) => node.props?.type === 'checkbox').length));
  checkbox.props.onChange({ target: { checked: true } });
  check('toggling a switch queues one field write with the revision fence', writes.length === 1 && writes[0].ops[0].op === 'set' && writes[0].revision === 3, JSON.stringify(writes));
  check('list entries carry an id, the keyed entry a key, all a locale namespace', entries.every((entry) => (typeof entry.options.id === 'string' || typeof entry.options.key === 'string') && entry.options.locale === 'plugin.sessionPurge'), JSON.stringify(entries.map((entry) => entry.options.id ?? entry.options.key)));
  check('every sidebar and overlay entry injects its behavior', entries.filter((entry) => entry.options.name !== 'plugins.row.config').every((entry) => typeof entry.options.inject === 'function'));
  check('registers dictionaries, the remote mount and the settings page', effects.length === 3 && dictionaries?.namespace === 'plugin.sessionPurge', effects.join(' | '));

  check('mounts the bundle\'s own Remote namespace', mounted?.package === '@jedeiah/session-purge' && mounted.descriptors.length === 2, JSON.stringify(mounted?.descriptors?.map((descriptor) => `${descriptor.namespace}/${descriptor.method}`)));
  // Mirrors the Client API's own admission checks: every declared field must carry
  // `mode: 'strict'`, a type symbol and a `create()` factory, or the namespace
  // mounts nothing and every call fails at runtime.
  const isStrictCodec = (codec) => codec?.mode === 'strict' && typeof codec.typeSymbol === 'string' && codec.typeSymbol.length > 0 && typeof codec.create === 'function';
  const fields = (mounted?.descriptors ?? []).flatMap((descriptor) => [...descriptor.parameters.map((parameter) => parameter.codec), descriptor.result]);
  check('every Client descriptor field carries a strict codec', fields.length > 0 && fields.every(isStrictCodec), fields.map((codec) => `${String(codec?.mode)}/${String(codec?.typeSymbol)}`).join(', '));

  const dictionaryBlock = (name) => {
    const start = source.indexOf(`const ${name} = {`);
    const end = source.indexOf('};', start);
    return new Set([...source.slice(start, end).matchAll(/^ {6}([a-zA-Z][A-Za-z0-9_]*):/gm)].map((match) => match[1]));
  };
  const zh = dictionaryBlock('zh');
  const en = dictionaryBlock('en');
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
    const dispose = ctx.typert.remotes.register(mounted);
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
  await testClientHalf(appDirectory());
  await testGateway(appDirectory(), root);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nall checks passed' : `\n${String(failures)} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
