/**
 * Chime (turn-notifier) — offline self-test.
 *
 *   node selftest.mjs [--app /path/to/app/dsh/node_modules/@deepseek-ai]
 *
 * The Host half imports `@deepseek-ai/dsh-typert-protocol`, which only resolves
 * inside a dsh installation. Instead of installing anything, this registers a
 * one-line resolver that anchors every `@deepseek-ai/*` specifier at the
 * installation's own package directory (`--app`, or the default location).
 *
 * Part A checks the row configuration the client half reads:
 *
 *  - the schema accepts an empty config, so every field really has a default
 *    (the client half renders switches without a round-trip, and a field that
 *    defaulted to `undefined` would flip the switch to the opposite of what the
 *    Host holds);
 *  - every field is `.volatile()`, because the Host half reads all of them while
 *    handling events rather than once at mount;
 *  - the documented defaults and the numeric bounds hold — `repeatCount` is
 *    clamped to 1..10, and `finishedPattern` / `interactionPattern` stay plain
 *    strings the client half parses itself.
 *
 * Part B validates the hand-written Host manifest with the installation's own
 * `validateTypertManifest`.
 *
 * Part C needs no installation: it materialises the Client half in a `vm`
 * sandbox the way a page does (register, build the module, call `apply`), then
 * renders the registered chime entry with a minimal hook runtime, fake timers,
 * fake activity listeners and a fake `AudioContext` that records every chime.
 * It pins the fix for "only the session on screen rings": the entry lives in the
 * root `shell.overlay` slot and a session other than the one on screen rings
 * too, while subagent turns stay silent and near-simultaneous triggers fold into
 * one alert instead of stacking chimes.
 *
 * Nothing outside a temporary directory is written, and nothing in the bundle is
 * touched.
 *
 * @module @jedeiah/turn-notifier/selftest
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = '@jedeiah/turn-notifier';
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

/**
 * A React stand-in just large enough for this bundle's hooks: state, refs, memo
 * and effects with dependency arrays, committed synchronously after each render.
 * @returns `{ React, mount }`; `mount(component, props)` renders once and returns
 *   `{ render(props), unmount() }`.
 */
function createHookRuntime() {
  let frame = null;
  const slotOf = (create) => {
    const index = frame.cursor;
    frame.cursor += 1;
    if (!(index in frame.slots)) frame.slots[index] = create();
    return frame.slots[index];
  };
  const changed = (previous, next) => previous === undefined || next === undefined
    || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const owner = frame;
      const slot = slotOf(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        owner.dirty = true;
      }];
    },
    useRef: (initial) => slotOf(() => ({ current: initial })),
    useMemo(factory, deps) {
      const slot = slotOf(() => ({ deps: undefined, value: undefined }));
      if (changed(slot.deps, deps)) {
        slot.value = factory();
        slot.deps = deps;
      }
      return slot.value;
    },
    useCallback: (callback, deps) => React.useMemo(() => callback, deps),
    useEffect(effect, deps) {
      const slot = slotOf(() => ({ deps: undefined, cleanup: undefined, effect: true }));
      if (changed(slot.deps, deps)) frame.effects.push({ slot, effect, deps });
    },
  };
  function mount(component, initialProps) {
    const instance = { slots: [], cursor: 0, effects: [], dirty: false, props: initialProps };
    const render = (props = instance.props) => {
      instance.props = props;
      do {
        instance.dirty = false;
        instance.cursor = 0;
        instance.effects = [];
        frame = instance;
        try {
          component(props);
        } finally {
          frame = null;
        }
        for (const { slot, effect, deps } of instance.effects) {
          if (typeof slot.cleanup === 'function') slot.cleanup();
          slot.cleanup = effect();
          slot.deps = deps;
        }
      } while (instance.dirty);
    };
    const unmount = () => {
      for (const slot of instance.slots) if (slot?.effect === true && typeof slot.cleanup === 'function') slot.cleanup();
    };
    render();
    return { render, unmount };
  }
  return { React, mount };
}

/**
 * Load `client.js` into a fresh sandbox and activate it against a stub runtime.
 *
 * Every call is a new page: module-level state (the once-only console reports,
 * the audio context) starts clean.
 * @returns the materialised module, its slot entries and gates, the fake
 *   browser's controls, and the record of every chime that played.
 */
async function bootClient() {
  const source = readFileSync(join(here, 'client.js'), 'utf8');
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const listeners = new Map();
  /** One record per chime: when it started and the frequencies of its tones. */
  const rings = [];
  let reverbs = 0;
  const errors = [];
  const registered = [];

  class FakeAudioContext {
    state = 'running';
    destination = {};
    /** Read exactly once per chime (its start time), so it marks where one begins. */
    get currentTime() {
      rings.push({ at: now, frequencies: [] });
      return now / 1000;
    }
    resume() { return Promise.resolve(); }
    sampleRate = 48000;
    createBuffer(channels, length) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { getChannelData: (channel) => data[channel] };
    }
    createConvolver() {
      reverbs += 1;
      return { buffer: null, connect() {} };
    }
    createDynamicsCompressor() {
      const param = () => ({ value: 0 });
      return { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect() {} };
    }
    createOscillator() {
      return {
        type: '',
        frequency: { setValueAtTime: (hz) => { rings.at(-1)?.frequencies.push(hz); } },
        connect() {},
        start() {},
        stop() {},
      };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
  }

  const window = {
    AudioContext: FakeAudioContext,
    setTimeout: (callback, ms) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener: (type, listener) => { listeners.get(type)?.delete(listener); },
    __ModuleLoader__: { load: (spec) => registered.push(spec) },
  };
  const sandbox = {
    window,
    console: { log() {}, warn() {}, error: (...parts) => errors.push(parts.join(' ')) },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });

  const { React, mount } = createHookRuntime();
  const required = [];
  const primitives = new Proxy({}, { get: (_target, key) => (props) => ({ type: String(key), props }) });
  const plugin = registered[0]?.factory((specifier) => {
    required.push(specifier);
    if (specifier === 'react') return React;
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`client half required an unexpected specifier: ${specifier}`);
  });

  let formValue = {};
  const formListeners = new Set();
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: formValue, user: {} }),
    subscribe: (listener) => {
      formListeners.add(listener);
      return () => formListeners.delete(listener);
    },
    set: () => true,
    unset: () => true,
  };
  const entries = [];
  const injected = [];
  const gates = [];
  const ctx = {
    get: (name) => (name === 'configForms'
      ? { get: (id) => (id === 'turn-notifier' ? form : undefined), whileServed: (_ids, callback) => callback() }
      : undefined),
    effect: (body) => {
      const dispose = body();
      return () => dispose?.();
    },
    slots: {
      inject: (name, callback) => {
        injected.push(name);
        return callback();
      },
      register: (options, component) => {
        entries.push({ options, component });
        return () => undefined;
      },
    },
    locale: { register: () => () => undefined },
    remote: { $mount: async () => async () => undefined },
    inject: (deps, callback) => {
      gates.push({ deps, callback });
      return Object.assign(Promise.resolve(), { dispose: async () => undefined });
    },
  };
  await plugin?.apply(ctx);

  return {
    registered,
    plugin,
    required,
    entries,
    injected,
    gates,
    ctx,
    rings,
    errors,
    mount,
    /** How many room-tail convolvers the audio half built (a function: the story spreads this object). */
    reverbs: () => reverbs,
    /** Run every timer due within the next `ms` milliseconds, in order. */
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let due;
        for (const [id, timer] of timers) {
          if (timer.at <= until && (due === undefined || timer.at < due.timer.at)) due = { id, timer };
        }
        if (due === undefined) break;
        timers.delete(due.id);
        now = due.timer.at;
        due.timer.callback();
      }
      now = until;
    },
    /** Dispatch one window event, as user activity would. */
    fire(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type });
    },
    /** Replace the row's settings and notify the form's subscribers. */
    setForm(value) {
      formValue = value;
      for (const listener of [...formListeners]) listener();
    },
  };
}

/** A session's status entry, shaped like `useSessionStatus` publishes it. */
const idle = () => ({ running: false, pendingInteraction: undefined, completionUnread: false });
const busy = () => ({ running: true, pendingInteraction: undefined, completionUnread: false });
const asking = (interaction = { kind: 'approval' }) => ({ running: true, pendingInteraction: interaction, completionUnread: false });

/** Session rows as `useSessions` publishes them; `S` is a subagent run of `A`. */
const SESSION_LIST = Object.freeze({
  ids: ['A', 'B', 'C', 'D'],
  byId: {
    A: { id: 'A' },
    B: { id: 'B' },
    C: { id: 'C' },
    D: { id: 'D' },
    S: { id: 'S', origin: 'subagent', parentId: 'A' },
  },
  phase: 'ready',
});

/** Frequencies that open each built-in chime, to tell which one played. */
const FINISHED_HZ = 880;
const WAITING_HZ = 1046.5;

/**
 * Boot the Client half, mount its chime entry and return a driver for it.
 *
 * Props carry `sessionId: 'A'` on purpose: that is what the old composer slot
 * handed the entry, so a component that still filtered by it would stay deaf to
 * every other session and fail the checks below.
 * @param initial - session id → status for the first render.
 * @param options - `hooks: false` drops `useSessionStatus`, `sessions: false` drops `useSessions`.
 * @returns the booted client plus `publish(statuses)` and `unmount()`.
 */
async function chimeStory(initial, options = {}) {
  const client = await bootClient();
  const chime = client.entries.find((entry) => entry.options.id === 'turn-notifier-alert');
  let status = new Map(Object.entries(initial));
  const props = () => ({
    sessionId: 'A',
    ...(options.hooks === false ? {} : { useSessionStatus: (selector) => selector(status) }),
    ...(options.sessions === false ? {} : { useSessions: (selector) => selector(SESSION_LIST) }),
  });
  const view = client.mount(chime.component, props());
  return {
    ...client,
    /** Publish a new status map (a new identity, as ui-session does) and re-render. */
    publish(next) {
      status = new Map(Object.entries(next));
      view.render(props());
    },
    rerender: () => view.render(props()),
    unmount: () => view.unmount(),
  };
}

console.log('\nPart C — the client half watches every session');
{
  const client = await bootClient();
  check('the module registers itself once', client.registered.length === 1, String(client.registered.length));
  check('the module id is the package name', client.registered[0]?.id === PACKAGE, String(client.registered[0]?.id));
  check('the factory exports { inject, apply }',
    Array.isArray(client.plugin?.inject) && typeof client.plugin?.apply === 'function');
  check('it requires only platform seeds',
    client.required.every((specifier) => specifier === 'react' || specifier === '@deepseek-ai/dsh-client-ui-primitives'),
    client.required.join(', '));

  const chime = client.entries.find((entry) => entry.options.id === 'turn-notifier-alert');
  check('the chime registers in shell.overlay, the root slot the app frame always renders',
    chime?.options.name === 'shell.overlay', String(chime?.options.name));
  check('nothing registers in the per-conversation composer dock any more',
    client.entries.every((entry) => entry.options.name !== 'conversation.composer.dock')
      && !client.injected.includes('conversation.composer.dock'),
    client.injected.join(','));

  // The settings page still hangs off the gate on this bundle's own service.
  check('the settings page is gated on remote.turnNotifier', client.gates[0]?.deps?.[0] === 'remote.turnNotifier',
    JSON.stringify(client.gates.map((gate) => gate.deps)));
  client.gates[0]?.callback(client.ctx);
  const page = client.entries.find((entry) => entry.options.name === 'plugins.row.config');
  check('the gate registers the row page keyed <package>#<row id>',
    page?.options.key === `${PACKAGE}#turn-notifier`, String(page?.options.key));
  check('no fallback was reported on a complete composition', client.errors.length === 0, client.errors.join(' | '));
}
{
  const story = await chimeStory({ A: idle(), B: asking() });
  check('a session already idle or already waiting at mount does not ring', story.rings.length === 0, String(story.rings.length));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.publish({ A: idle(), B: busy() });
  check('the session on screen finishing a turn still rings the finished chime',
    story.rings.length === 1 && story.rings[0].frequencies[0] === FINISHED_HZ, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.publish({ A: busy(), B: idle() });
  check('a session other than the one on screen finishing a turn rings the finished chime',
    story.rings.length === 1 && story.rings[0].frequencies[0] === FINISHED_HZ, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), C: busy() });
  story.publish({ A: busy(), C: asking() });
  check('a session other than the one on screen waiting for the user rings the waiting chime',
    story.rings.length === 1 && story.rings[0].frequencies[0] === WAITING_HZ, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), S: busy() });
  story.publish({ A: busy(), S: idle() });
  check('a subagent finishing its turn stays silent (it is a step of its parent\'s turn)',
    story.rings.length === 0, JSON.stringify(story.rings));
  story.publish({ A: busy(), S: asking() });
  check('a subagent waiting for the user still rings',
    story.rings.length === 1 && story.rings[0].frequencies[0] === WAITING_HZ, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.publish({ B: busy() });
  check('a running session leaving the map is not a finished turn', story.rings.length === 0, JSON.stringify(story.rings));
  story.publish({ A: idle(), B: busy() });
  check('…and one re-entering it idle has no "before" to compare', story.rings.length === 0, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), B: busy(), D: busy() });
  story.publish({ A: busy(), B: idle(), D: idle() });
  check('two sessions finishing in the same update ring once', story.rings.length === 1, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), B: busy(), D: busy() });
  story.publish({ A: busy(), B: idle(), D: busy() });
  story.advance(500);
  story.publish({ A: busy(), B: idle(), D: idle() });
  check('a second session finishing moments later folds into the alert instead of stacking a chime',
    story.rings.length === 1, JSON.stringify(story.rings));
  story.advance(20000);
  check('…and the alert still plays its configured repeats (3 by default, 5 s apart)',
    story.rings.length === 3 && story.rings[1].at === 5000 && story.rings[2].at === 10000,
    JSON.stringify(story.rings.map((ring) => ring.at)));
}
{
  const story = await chimeStory({ A: busy(), B: busy(), D: busy() });
  story.publish({ A: busy(), B: idle(), D: busy() });
  story.advance(13000);
  story.publish({ A: busy(), B: idle(), D: idle() });
  check('once an alert has used up its rings, another session finishing rings again',
    story.rings.length === 4 && story.rings[3].at === 13000, JSON.stringify(story.rings.map((ring) => ring.at)));
}
{
  const story = await chimeStory({ A: busy(), B: busy(), C: busy() });
  story.publish({ A: busy(), B: idle(), C: busy() });
  story.advance(300);
  story.publish({ A: busy(), B: idle(), C: asking() });
  check('a waiting session takes over a finished alert with its own chime at once',
    story.rings.length === 2 && story.rings[1].frequencies[0] === WAITING_HZ, JSON.stringify(story.rings));
  story.advance(20000);
  check('…and the waiting chime is what repeats',
    story.rings.length === 4 && story.rings.slice(1).every((ring) => ring.frequencies[0] === WAITING_HZ),
    JSON.stringify(story.rings.map((ring) => ring.frequencies[0])));
}
{
  const story = await chimeStory({ A: busy(), B: busy(), C: busy() });
  story.publish({ A: busy(), B: busy(), C: asking() });
  story.advance(300);
  story.publish({ A: busy(), B: idle(), C: asking() });
  check('a finished session during a waiting alert folds in (the urgent chime keeps playing)',
    story.rings.length === 1 && story.rings[0].frequencies[0] === WAITING_HZ, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.publish({ A: busy(), B: idle() });
  story.advance(5000);
  story.fire('pointermove');
  story.advance(20000);
  check('pointer or key activity cancels the remaining repeats', story.rings.length === 2, JSON.stringify(story.rings.map((ring) => ring.at)));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.publish({ A: busy(), B: idle() });
  story.publish({ A: busy(), B: busy() });
  story.advance(20000);
  check('the repeats stop once the session that rang starts a new turn', story.rings.length === 1, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: idle(), B: busy() });
  story.publish({ A: idle(), B: idle() });
  story.publish({ A: busy(), B: idle() });
  story.advance(20000);
  check('another session starting a turn does not cancel the alert', story.rings.length === 3, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), C: asking() });
  story.publish({ A: busy(), C: busy() });
  story.publish({ A: busy(), C: asking() });
  story.publish({ A: busy(), C: busy() });
  story.advance(20000);
  check('an answered question stops its repeats', story.rings.length === 1, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.setForm({ muted: true });
  story.rerender();
  story.publish({ A: busy(), B: idle() });
  check('muted: nothing rings', story.rings.length === 0, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.publish({ A: busy(), B: idle() });
  story.setForm({ muted: true });
  story.rerender();
  story.advance(20000);
  check('muting stops an alert in progress', story.rings.length === 1, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), B: busy(), C: busy() });
  story.setForm({ notifyOnTurnEnd: false });
  story.rerender();
  story.publish({ A: busy(), B: idle(), C: busy() });
  story.publish({ A: busy(), B: idle(), C: asking() });
  check('notifyOnTurnEnd off silences finished turns but not waiting',
    story.rings.length === 1 && story.rings[0].frequencies[0] === WAITING_HZ, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.setForm({ repeatCount: 2, intervalMs: 3000 });
  story.rerender();
  story.publish({ A: busy(), B: idle() });
  story.advance(20000);
  check('repeat count and interval come from the settings',
    story.rings.length === 2 && story.rings[1].at === 3000, JSON.stringify(story.rings.map((ring) => ring.at)));
}
{
  // An instrument voice strikes every partial of every note, so one note shows up
  // as several frequencies — a bell's hum an octave down, its minor third and
  // fifth — and all of them start with the chime, not one per note slot.
  const story = await chimeStory({ A: busy(), B: busy() });
  story.setForm({ voice: 'bell', finishedPattern: '783.99:480, 523.25:900' });
  story.rerender();
  story.publish({ A: busy(), B: idle() });
  const heard = story.rings[0]?.frequencies ?? [];
  const near = (hz) => heard.some((value) => Math.abs(value - hz) < 0.01);
  check('the bell voice sounds the strike tone with its hum, minor third and fifth',
    story.rings.length === 1 && near(783.99) && near(783.99 * 0.5) && near(783.99 * 1.19) && near(783.99 * 1.5) && near(523.25),
    JSON.stringify(heard.map((value) => Math.round(value))));
  check('an instrument voice plays through the room tail, built once', story.reverbs() === 1, String(story.reverbs()));
  check('the instrument voice raised no error', story.errors.length === 0, story.errors.join(' | '));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.setForm({ voice: 'electricPiano', finishedPattern: '523.25:600' });
  story.rerender();
  story.publish({ A: busy(), B: idle() });
  const heard = story.rings[0]?.frequencies ?? [];
  check('the electric piano adds its FM modulator to the note',
    heard.filter((value) => Math.abs(value - 523.25) < 0.01).length === 2, JSON.stringify(heard));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.setForm({ voice: 'classic' });
  story.rerender();
  story.publish({ A: busy(), B: idle() });
  check('the classic voice still plays one oscillator per note, dry',
    JSON.stringify(story.rings[0]?.frequencies) === JSON.stringify([880, 1318.5]) && story.reverbs() === 0,
    JSON.stringify([story.rings[0]?.frequencies, story.reverbs()]));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.setForm({ voice: 'theremin' });
  story.rerender();
  story.publish({ A: busy(), B: idle() });
  check('an unknown voice falls back to classic',
    JSON.stringify(story.rings[0]?.frequencies) === JSON.stringify([880, 1318.5]), JSON.stringify(story.rings[0]?.frequencies));
}
{
  // Every preset melody must parse with the client's own rules, and name a voice
  // the client knows; a typo would fall back to the default without a word.
  const source = readFileSync(join(here, 'client.js'), 'utf8');
  const presets = [...source.matchAll(/\{ key: '(\w+)', voice: '(\w+)', finished: '([^']+)', interaction: '([^']+)' \}/g)];
  const voices = new Set([...source.slice(source.indexOf('const VOICES = Object.freeze({'), source.indexOf('/** Voice names')).matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]));
  const pairOk = (text) => text.split(',').every((part) => {
    const [hz, ms] = part.trim().split(':').map(Number);
    return hz >= 20 && hz <= 20000 && ms >= 10 && ms <= 5000;
  });
  const bad = presets.filter(([, , voice, finished, interaction]) => !voices.has(voice) || !pairOk(finished) || !pairOk(interaction)).map((match) => match[1]);
  check('every chime set names a known voice and two valid melodies', presets.length === 10 && bad.length === 0, `${String(presets.length)} sets; bad: ${bad.join(',')}`);
  const keys = new Set(presets.map((match) => match[1]));
  check('every chime set and voice has a name in both languages',
    [...keys].every((key) => source.split(`tone_${key}:`).length === 3) && [...voices].every((voice) => source.split(`voice_${voice}:`).length === 3));
}
{
  const story = await chimeStory({ A: busy(), B: busy() });
  story.publish({ A: busy(), B: idle() });
  story.unmount();
  story.advance(20000);
  check('unmounting the entry stops a playing alert', story.rings.length === 1, JSON.stringify(story.rings));
}
{
  const story = await chimeStory({ A: busy() }, { hooks: false });
  story.publish({ A: idle() });
  story.publish({ A: busy() });
  check('without useSessionStatus the entry renders, stays silent and reports it once',
    story.rings.length === 0 && story.errors.filter((line) => line.includes('useSessionStatus')).length === 1,
    story.errors.join(' | '));
}
{
  const story = await chimeStory({ A: busy(), S: busy() }, { sessions: false });
  story.publish({ A: busy(), S: idle() });
  check('without useSessions subagent turns ring too, and the console says why once',
    story.rings.length === 1 && story.errors.filter((line) => line.includes('useSessions')).length === 1,
    story.errors.join(' | '));
}


console.log('\nPart D — the settings page: chime picker, custom panel, preview, volume');
/**
 * Render the row's settings page the way the Plugins page does, against a form
 * that records every write and echoes it back as the next revision.
 * @param value - the stored settings.
 * @returns controls to find elements, act on them and read what happened.
 */
async function pageStory(value) {
  const client = await bootClient();
  client.gates[0]?.callback(client.ctx);
  const entry = client.entries.find((candidate) => candidate.options.name === 'plugins.row.config');
  const writes = [];
  let stored = { ...value };
  const form = {
    state: { status: 'ready', writable: true, value: stored, user: {} },
    mutate: (ops) => {
      writes.push(ops);
      for (const op of ops) if (op.op === 'set') stored = { ...stored, [op.path[0]]: op.value };
      form.state = { ...form.state, value: stored };
      return Promise.resolve(true);
    },
  };
  const t = (key, values) => (values === undefined ? key : `${key}${JSON.stringify(values)}`);
  const injected = entry.options.inject?.() ?? {};
  let tree;
  const outer = () => entry.component({ t, view: 'page', form, ...injected });
  const groupsElement = () => walk(outer()).find((node) => typeof node.type === 'function');
  const Groups = groupsElement().type;
  const view = client.mount((props) => { tree = Groups(props); return tree; }, groupsElement().props);
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    view.render(groupsElement().props);
  };
  return {
    client,
    writes,
    stored: () => stored,
    nodes: () => walk(tree),
    /** The ChoiceMenu element whose label is `labelKey`. */
    menu: (labelKey) => walk(tree).find((node) => node.props?.label === labelKey && Array.isArray(node.props?.items)),
    /** The button whose text is one of `texts`. */
    button: (...texts) => walk(tree).find((node) => kindOf(node) === 'Button' && texts.includes(textOf(node))),
    buttons: (text) => walk(tree).filter((node) => kindOf(node) === 'Button' && textOf(node) === text),
    inputs: () => walk(tree).filter((node) => node.type === 'input' && node.props?.type === 'text'),
    slider: () => walk(tree).find((node) => node.type === 'input' && node.props?.type === 'range'),
    rerender: () => view.render(groupsElement().props),
    settle,
    unmount: () => view.unmount(),
  };
}
/** Every element of a rendered tree, depth first. */
function walk(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out; }
  if (node === null || typeof node !== 'object') return out;
  out.push(node);
  walk(node.props?.children, out);
  walk(node.children, out);
  if (node.props?.trailing !== undefined) walk(node.props.trailing, out);
  return out;
}
/**
 * What an element is: a host tag, a named component (`ChoiceMenu`), or — for the
 * stub primitives, which are anonymous — the name the stub stamps on its output.
 */
function kindOf(node) {
  if (typeof node?.type === 'string') return node.type;
  if (typeof node?.type !== 'function') return undefined;
  if (node.type.name !== '') return node.type.name;
  try {
    return node.type(node.props)?.type;
  } catch {
    return undefined;
  }
}
/** The text inside an element. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children) + textOf(node.children);
}
const DOORBELL = { voice: 'bell', waveform: 'square', volume: 2, finishedPattern: '783.99:480, 523.25:900', interactionPattern: '659.25:320, 783.99:320, 880:900' };
{
  const page = await pageStory(DOORBELL);
  const picker = page.menu('tone');
  check('a stored preset shows its name, with the custom panel closed',
    picker?.props.current === 'tone_doorbell' && page.menu('voice') === undefined, String(picker?.props.current));
  check('the waveform of a non-classic preset does not make it "custom"', picker?.props.selectedId === 'doorbell');

  picker.props.onSelect('custom');
  page.rerender();
  check('choosing Custom opens the panel without writing anything',
    page.menu('voice') !== undefined && page.menu('tone')?.props.current === 'tone_custom' && page.writes.length === 0,
    JSON.stringify(page.writes));
  const waveform = page.nodes().find((node) => kindOf(node) === 'SegmentedControl');
  check('the waveform control stays in place, disabled for a non-classic voice', waveform?.props.disabled === true);

  const ringsBefore = page.client.rings.length;
  page.menu('voice').props.onSelect('marimba');
  await page.settle();
  check('changing the voice writes only the voice and previews it',
    JSON.stringify(page.writes.at(-1)) === JSON.stringify([{ op: 'set', path: ['voice'], value: 'marimba' }]) && page.client.rings.length === ringsBefore + 1,
    JSON.stringify(page.writes));
  check('after a voice change the panel stays open and the picker says Custom — nothing jumps',
    page.menu('voice')?.props.current === 'voice_marimba' && page.menu('tone')?.props.current === 'tone_custom');

  page.menu('tone').props.onSelect('bright');
  await page.settle();
  const fields = Object.fromEntries(page.writes.at(-1).map((op) => [op.path[0], op.value]));
  check('picking a classic preset writes voice, waveform and both melodies in one batch',
    fields.voice === 'classic' && fields.waveform === 'sine' && fields.finishedPattern === '880:170, 1318.5:300' && Object.keys(fields).length === 4,
    JSON.stringify(fields));
  check('picking a preset closes the panel and names the preset',
    page.menu('voice') === undefined && page.menu('tone')?.props.current === 'tone_bright');
}
{
  // Reset to default, one melody at a time.
  const page = await pageStory(DOORBELL);
  page.menu('tone').props.onSelect('custom');
  page.rerender();
  const [resetFinished, resetWaiting] = page.buttons('resetDefault');
  check('each melody row has its own Reset button, live while it differs from the default',
    resetFinished?.props.disabled === false && resetWaiting?.props.disabled === false);
  const start = page.client.rings.length;
  resetFinished.props.onClick();
  await page.settle();
  check('Reset on "done" writes only that melody, back to the default, and plays it',
    JSON.stringify(page.writes.at(-1)) === JSON.stringify([{ op: 'set', path: ['finishedPattern'], value: '880:170, 1318.5:300' }])
      && page.stored().interactionPattern === DOORBELL.interactionPattern && page.client.rings.length === start + 1,
    JSON.stringify(page.writes));
  check('after the reset that row\'s button is disabled, the other stays live',
    page.buttons('resetDefault')[0]?.props.disabled === true && page.buttons('resetDefault')[1]?.props.disabled === false);
  check('resetting a melody keeps the panel open', page.menu('voice') !== undefined && page.menu('tone')?.props.current === 'tone_custom');

  // An invalid draft is thrown away by Reset, not left behind.
  page.inputs()[1].props.onChange({ target: { value: 'not a melody' } });
  page.rerender();
  check('an invalid draft disables Preview for that row', page.buttons('preview').at(-1)?.props.disabled === true);
  page.buttons('resetDefault')[1].props.onClick();
  await page.settle();
  check('Reset clears an invalid draft and writes the default',
    page.inputs()[1]?.props.value === '1046.5:140, 1318.5:140, 1046.5:200' && page.stored().interactionPattern === '1046.5:140, 1318.5:140, 1046.5:200',
    String(page.inputs()[1]?.props.value));
  const writesSoFar = page.writes.length;
  page.inputs()[0].props.onChange({ target: { value: 'oops' } });
  page.rerender();
  page.buttons('resetDefault')[0].props.onClick();
  await page.settle();
  check('Reset on a row already at the default only drops the draft, writing nothing',
    page.writes.length === writesSoFar && page.inputs()[0]?.props.value === '880:170, 1318.5:300');
}
{
  // A classic set played with another waveform is not that set any more.
  const page = await pageStory({ voice: 'classic', waveform: 'square', finishedPattern: '880:170, 1318.5:300', interactionPattern: '1046.5:140, 1318.5:140, 1046.5:200' });
  check('a classic set with a non-sine waveform shows as Custom with the panel open',
    page.menu('tone')?.props.current === 'tone_custom' && page.menu('voice') !== undefined);
  check('the waveform control is live for the classic voice',
    page.nodes().find((node) => kindOf(node) === 'SegmentedControl')?.props.disabled === false);
}
{
  // Preview both: the waiting chime starts after the finished one has rung out,
  // not at a fixed half second, and the button reads Stop for the whole time.
  const page = await pageStory({ voice: 'bowl', finishedPattern: '440:1600', interactionPattern: '587.33:700, 587.33:1400' });
  const start = page.client.rings.length;
  page.button('preview').props.onClick();
  page.rerender();
  check('Preview plays the finished chime at once and turns into Stop',
    page.client.rings.length === start + 1 && page.button('stopPreview') !== undefined);
  page.client.advance(1500);
  page.rerender();
  check('the waiting chime does not start while the first still rings', page.client.rings.length === start + 1, String(page.client.rings.length - start));
  page.client.advance(6000);
  page.rerender();
  check('the waiting chime follows once the first has rung out', page.client.rings.length === start + 2, String(page.client.rings.length - start));
  page.client.advance(10000);
  page.rerender();
  check('the button reads Preview again once the sound has ended', page.button('preview') !== undefined && page.button('stopPreview') === undefined);

  page.button('preview').props.onClick();
  page.rerender();
  page.button('stopPreview').props.onClick();
  page.rerender();
  page.client.advance(20000);
  check('Stop cancels the waiting chime still to come', page.client.rings.length === start + 3, String(page.client.rings.length - start));

  page.button('preview').props.onClick();
  page.unmount();
  page.client.advance(20000);
  check('leaving the page cancels a preview in progress', page.client.rings.length === start + 4, String(page.client.rings.length - start));
}
{
  const page = await pageStory({ volume: 1 });
  const start = page.client.rings.length;
  for (const step of [1.1, 1.2, 1.3, 1.4]) {
    page.slider().props.onChange({ target: { value: String(step) } });
    page.rerender();
  }
  check('dragging the volume slider writes nothing and plays nothing yet',
    page.writes.length === 0 && page.client.rings.length === start && page.slider().props.value === 1.4);
  page.slider().props.onPointerUp();
  await page.settle();
  check('letting go writes the volume once and previews it',
    JSON.stringify(page.writes) === JSON.stringify([[{ op: 'set', path: ['volume'], value: 1.4 }]]) && page.client.rings.length === start + 1,
    JSON.stringify(page.writes));
  page.slider().props.onBlur();
  await page.settle();
  check('a release without a change writes nothing more', page.writes.length === 1);
}

const app = appDirectory();
if (!existsSync(app)) {
  console.log(`\nskip — no dsh installation at ${app} (pass --app <path>)`);
  // Parts 0 and C need no installation; their failures must not be skipped away.
  process.exit(failures === 0 ? 0 : 1);
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

/** Unwrap a volatile handle, exactly as the Host half must. */
const plain = (value) => (typeof value?.get === 'function' ? value.get() : value);

/** @returns the validation result for one raw config. */
const validate = (raw) => host.Config['~standard'].validate(raw);

console.log('\nPart A — the row configuration the client half reads');
{
  const empty = validate({});
  check('an empty config validates (every field has a default)',
    empty.issues === undefined, JSON.stringify(empty.issues));

  const value = empty.issues === undefined ? empty.value : {};

  check('muted defaults to false', plain(value.muted) === false, String(plain(value.muted)));
  check('notifyOnTurnEnd defaults to true', plain(value.notifyOnTurnEnd) === true);
  check('notifyOnWaiting defaults to true', plain(value.notifyOnWaiting) === true);
  check('repeatCount defaults to 3', plain(value.repeatCount) === 3, String(plain(value.repeatCount)));
  check('intervalMs defaults to 5000', plain(value.intervalMs) === 5000, String(plain(value.intervalMs)));
  check('volume defaults to 1', plain(value.volume) === 1, String(plain(value.volume)));
  check('waveform defaults to sine', plain(value.waveform) === 'sine', String(plain(value.waveform)));
  check('voice defaults to classic, so an upgrade sounds the same', plain(value.voice) === 'classic', String(plain(value.voice)));
  check('finishedPattern keeps its documented default',
    plain(value.finishedPattern) === '880:170, 1318.5:300', String(plain(value.finishedPattern)));
  check('interactionPattern keeps its documented default',
    plain(value.interactionPattern) === '1046.5:140, 1318.5:140, 1046.5:200',
    String(plain(value.interactionPattern)));

  const volatileFields = ['muted', 'notifyOnTurnEnd', 'notifyOnWaiting', 'repeatCount',
    'intervalMs', 'volume', 'waveform', 'voice', 'finishedPattern', 'interactionPattern'];
  const notVolatile = volatileFields.filter((name) => typeof value[name]?.get !== 'function');
  check('every field is .volatile() (the Host reads them per event, not once at mount)',
    notVolatile.length === 0, notVolatile.join(','));
}

console.log('\nPart A2 — the schema rejects values outside its bounds');
{
  check('repeatCount above 10 is rejected', validate({ repeatCount: 11 }).issues !== undefined);
  check('repeatCount below 1 is rejected', validate({ repeatCount: 0 }).issues !== undefined);
  check('intervalMs below 1000 is rejected', validate({ intervalMs: 500 }).issues !== undefined);
  check('volume above 2 is rejected', validate({ volume: 3 }).issues !== undefined);
  check('an unknown waveform is rejected', validate({ waveform: 'sawtooth' }).issues !== undefined);
  check('an unknown voice is rejected', validate({ voice: 'theremin' }).issues !== undefined);
  const clientSource = readFileSync(join(here, 'client.js'), 'utf8');
  const clientVoices = [...clientSource.slice(clientSource.indexOf('const VOICES = Object.freeze({'), clientSource.indexOf('/** Voice names')).matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);
  check('the schema accepts every voice the client plays', clientVoices.length === 7 && clientVoices.every((voice) => validate({ voice }).issues === undefined), clientVoices.join(','));
  check('a valid in-range config is accepted',
    validate({ repeatCount: 5, intervalMs: 2000, volume: 0.5, waveform: 'square' }).issues === undefined);
}

console.log('\nPart A3 — what the Host half exports');
{
  check('the runtime class is exported for the selftest-facing contract',
    typeof host.TurnNotifierRuntime === 'function');
  check('apply is exported', typeof host.apply === 'function');
  check('name is the bundle name', host.name === 'turn-notifier', String(host.name));
}

console.log('\nPart B — the hand-written Host manifest');
try {
  const { validateTypertManifest } = await import(join(app, 'dsh-typert-loader', 'lib', 'index.js'));
  validateTypertManifest(PACKAGE, TYPERT);
  check('TYPERT passes the installation validator', true);
} catch (error) {
  check('TYPERT passes the installation validator', false, String(error?.message ?? error));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${String(failures)} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
