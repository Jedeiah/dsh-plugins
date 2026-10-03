/**
 * Client half of the Chime bundle.
 *
 * Two contributions live on the row whose specifier is this package name:
 *
 *  - An invisible entry in `conversation.composer.dock` (id
 *    `turn-notifier-alert`) that rings when the viewed session finished a turn
 *    or is waiting for the user.
 *  - The row's settings page in `plugins.row.config`, registered inside a gate
 *    that depends on this bundle's own Host service (`remote.turnNotifier`).
 *    The gate is what makes the page survive an off→on toggle of this row: dsh
 *    does not always re-run a client half's `apply` (deepseek-harness#8452), but
 *    `ctx.inject` does re-run its callback once the dependency reappears.
 *
 * Tunables come from the Host row's `Config` (see ../index.js) through
 * `ctx.configForms`. They are read in the browser, so changing them takes effect
 * without reloading the module. Status signals come from the slot's
 * `useSessionStatus` standard prop, whose entries are
 * `{ running, pendingInteraction, completionUnread }`.
 */

// These client.js files are loaded as plain scripts into one shared scope, so a
// top-level `const` collides with any other bundle declaring the same name
// (BUNDLE_NAME / SLOT_NAME / DEFAULTS / WAVEFORMS / PATTERNS / DEFAULT_TONE_MS).
// Everything below lives inside this IIFE; the only global effect is the
// __ModuleLoader__.load() call at the end.
(() => {

/** This bundle's package name: the browser module id. */
const BUNDLE_NAME = '@jedeiah/turn-notifier';
/** Profile row id; also the Host settings namespace the settings bundle edits. */
const ENTRY_ID = 'turn-notifier';

/** Slot this plugin's notification entry occupies. */
const SLOT_NAME = 'conversation.composer.dock';

/** Fallbacks, mirroring the Host schema defaults. */
const DEFAULTS = Object.freeze({
  muted: false,
  notifyOnTurnEnd: true,
  notifyOnWaiting: true,
  repeatCount: 3,
  intervalMs: 5000,
  volume: 1,
  waveform: 'sine',
  finishedPattern: '880:170, 1318.5:300',
  interactionPattern: '1046.5:140, 1318.5:140, 1046.5:200',
});

/** Oscillator waveforms the Host schema accepts. */
const WAVEFORMS = Object.freeze(['sine', 'square', 'triangle']);

/** Duration assumed for a tone written without one. */
const DEFAULT_TONE_MS = 200;

/** Events that unlock the audio context after the first user gesture. */
const UNLOCK_EVENTS = Object.freeze(['pointerdown', 'keydown']);

/**
 * Events that count as "the user is back" and cancel the repeats.
 *
 * Pointer Events already cover mouse, touch and pen, so `mousemove`/`touchstart`
 * would only duplicate `pointermove`/`pointerdown` on the same gesture.
 */
const ACTIVITY_EVENTS = Object.freeze(['pointerdown', 'pointermove', 'keydown', 'wheel']);

/** Built-in chimes, used when the configured pattern is missing or unparsable. */
const PATTERNS = Object.freeze({
  finished: Object.freeze([
    Object.freeze({ offsetMs: 0, frequency: 880, durationMs: 170 }),
    Object.freeze({ offsetMs: 170, frequency: 1318.5, durationMs: 300 }),
  ]),
  interaction: Object.freeze([
    Object.freeze({ offsetMs: 0, frequency: 1046.5, durationMs: 140 }),
    Object.freeze({ offsetMs: 150, frequency: 1318.5, durationMs: 140 }),
    Object.freeze({ offsetMs: 300, frequency: 1046.5, durationMs: 200 }),
  ]),
});

window.__ModuleLoader__.load({
  id: BUNDLE_NAME,
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // Official primitives are a platform seed shared by every client bundle, so
    // the page gets the shell's control styling instead of hand-rolled buttons.
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** Clamp a value into an integer range, falling back when unusable. */
    function clampInteger(value, min, max, fallback) {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, Math.round(number)));
    }

    /**
     * Parse `frequencyHz:durationMs` pairs into tones played back to back.
     * @param text - the configured pattern.
     * @param fallback - returned when the text is unusable; pass null to validate only.
     * @returns the tone list, or the fallback.
     */
    function parsePattern(text, fallback) {
      const tones = [];
      let offsetMs = 0;
      for (const part of String(text ?? '').split(',')) {
        const piece = part.trim();
        if (piece === '') continue;
        const [frequencyText, durationText] = piece.split(':');
        const frequency = Number(frequencyText);
        const durationMs = durationText === undefined || durationText.trim() === ''
          ? DEFAULT_TONE_MS
          : Number(durationText);
        if (!Number.isFinite(frequency) || frequency < 20 || frequency > 20000) return fallback;
        if (!Number.isFinite(durationMs) || durationMs < 10 || durationMs > 5000) return fallback;
        tones.push({ offsetMs, frequency, durationMs });
        offsetMs += durationMs;
      }
      return tones.length === 0 ? fallback : tones;
    }

    /** Project a raw form snapshot into the shape both halves consume. */
    function project(raw) {
      const value = raw?.value ?? {};
      const user = raw?.user ?? {};
      const finishedPattern = typeof value.finishedPattern === 'string' ? value.finishedPattern : DEFAULTS.finishedPattern;
      const interactionPattern = typeof value.interactionPattern === 'string' ? value.interactionPattern : DEFAULTS.interactionPattern;
      return {
        status: raw?.status ?? 'loading',
        writable: raw?.writable === true,
        muted: value.muted === true,
        notifyOnTurnEnd: value.notifyOnTurnEnd !== false,
        notifyOnWaiting: value.notifyOnWaiting !== false,
        repeatCount: clampInteger(value.repeatCount, 1, 10, DEFAULTS.repeatCount),
        intervalMs: clampInteger(value.intervalMs, 1000, 60000, DEFAULTS.intervalMs),
        volume: Math.min(2, Math.max(0, Number.isFinite(value.volume) ? value.volume : DEFAULTS.volume)),
        waveform: WAVEFORMS.includes(value.waveform) ? value.waveform : DEFAULTS.waveform,
        finishedPattern,
        interactionPattern,
        tones: {
          finished: parsePattern(finishedPattern, PATTERNS.finished),
          interaction: parsePattern(interactionPattern, PATTERNS.interaction),
        },
        overridden: {
          muted: user?.muted !== undefined,
          notifyOnTurnEnd: user?.notifyOnTurnEnd !== undefined,
          notifyOnWaiting: user?.notifyOnWaiting !== undefined,
          repeatCount: user?.repeatCount !== undefined,
          intervalMs: user?.intervalMs !== undefined,
          volume: user?.volume !== undefined,
          waveform: user?.waveform !== undefined,
          finishedPattern: user?.finishedPattern !== undefined,
          interactionPattern: user?.interactionPattern !== undefined,
        },
      };
    }

    /**
     * Mirror one settings form into a tiny observable both components bind.
     * @param form - the form returned by `ctx.configForms.get`.
     * @returns `{ getSnapshot, subscribe, dispose }`.
     */
    function createSettingsStore(form) {
      let snapshot = project(form.getSnapshot());
      const listeners = new Set();
      const unsubscribe = form.subscribe(() => {
        snapshot = project(form.getSnapshot());
        for (const listener of [...listeners]) listener();
      });
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        /** Write one field through the settings service; resolves `false` when rejected. */
        write: (field, value) => Promise.resolve(form.set(field, value)).then((accepted) => accepted !== false),
        /** Drop one user override, returning the field to its schema default. */
        reset: (field) => Promise.resolve(form.unset(field)).then((accepted) => accepted !== false),
        dispose: () => {
          unsubscribe();
          listeners.clear();
        },
      };
    }

    /** Subscribe a component to a store. */
    function useStoreValue(store) {
      const [snapshot, setSnapshot] = React.useState(() => store.getSnapshot());
      React.useEffect(() => {
        setSnapshot(store.getSnapshot());
        return store.subscribe(() => setSnapshot(store.getSnapshot()));
      }, [store]);
      return snapshot;
    }

    /**
     * Lazily owns one AudioContext for chimes.
     * @returns `{ ensure, ring }`.
     */
    function createAudio() {
      let context = null;
      let limiter = null;

      function ensure() {
        try {
          if (context === null) {
            const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
            if (AudioContextCtor === undefined) return null;
            context = new AudioContextCtor();
          }
          if (context.state === 'suspended') {
            // Autoplay policy rejects this before a user gesture; not an error.
            void Promise.resolve(context.resume()).catch(() => {});
          }
          // One compressor for every tone, built once and reused. Volume goes up to
          // 2 so a quiet laptop speaker can still be pushed; past 1.0 the summed
          // samples would clip against the output range, so the chain ends here
          // instead of at `destination` and the peaks get caught rather than
          // squared off. Settings chosen to be inert below the threshold.
          if (limiter === null) {
            limiter = context.createDynamicsCompressor();
            limiter.threshold.value = -3;
            limiter.knee.value = 4;
            limiter.ratio.value = 12;
            limiter.attack.value = 0.003;
            limiter.release.value = 0.12;
            limiter.connect(context.destination);
          }
          return context;
        } catch {
          return null;
        }
      }

      function ring(reason, settings) {
        const audio = ensure();
        if (audio === null) return;
        const tones = settings.tones?.[reason] ?? PATTERNS[reason] ?? PATTERNS.finished;
        const volume = settings.volume;
        const waveform = WAVEFORMS.includes(settings.waveform) ? settings.waveform : DEFAULTS.waveform;
        const base = audio.currentTime + 0.01;
        for (const tone of tones) {
          const startsAt = base + tone.offsetMs / 1000;
          const endsAt = startsAt + tone.durationMs / 1000;
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = waveform;
          oscillator.frequency.setValueAtTime(tone.frequency, startsAt);
          gain.gain.setValueAtTime(0, startsAt);
          gain.gain.linearRampToValueAtTime(volume, startsAt + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
          oscillator.connect(gain);
          gain.connect(limiter ?? audio.destination);
          oscillator.start(startsAt);
          oscillator.stop(endsAt + 0.02);
        }
      }

      return { ensure, ring };
    }

    /** Cancel a running alert and detach its activity listeners. */
    function stopAlert(alertRef) {
      const current = alertRef.current;
      if (current === null) return;
      alertRef.current = null;
      for (const timer of current.timers) window.clearTimeout(timer);
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, current.onActivity);
    }

    /** Ring once now, then repeat until the count is used up or the user returns. */
    function startAlert(alertRef, audio, settings, reason) {
      stopAlert(alertRef);
      audio.ring(reason, settings);
      const timers = [];
      for (let index = 1; index < settings.repeatCount; index += 1) {
        timers.push(window.setTimeout(() => audio.ring(reason, settings), settings.intervalMs * index));
      }
      const onActivity = () => stopAlert(alertRef);
      for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, { passive: true });
      alertRef.current = { timers, onActivity };
    }

    /** Stand-in status map for slots that expose no `useSessionStatus` prop. */
    const EMPTY_STATUS = new Map();

    /** Selector over an empty status map, used when the slot provides no hook. */
    function readEmptyStatus(selector) {
      return selector(EMPTY_STATUS);
    }

    /** The invisible entry that owns the notification behavior. */

    /** Browser-side mirror of `typert.js`; the Gateway reads these descriptors. */
    const TYPERT_REMOTE = {
      package: BUNDLE_NAME,
      descriptors: [
        {
          id: `${BUNDLE_NAME}#turnNotifier/introspect`,
          service: 'turnNotifier',
          namespace: 'turnNotifier',
          method: 'introspect',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'strict', typeSymbol: `${BUNDLE_NAME}#TurnNotifierConfig`, create: () => ({ parse: (value) => value }) },
        },
      ],
    };

    function createNotifier(audio, store) {
      return function TurnNotifier(props) {
        const { sessionId, useSessionStatus } = props;
        const settings = useStoreValue(store);
        // A slot may not supply the hook; fall back instead of throwing, which
        // would blank the whole slot entry ("slot entry crashed in ...").
        const useStatus = typeof useSessionStatus === 'function' ? useSessionStatus : readEmptyStatus;
        const selectRunning = React.useCallback(
          (snapshot) => (sessionId === undefined ? undefined : snapshot.get(sessionId)?.running),
          [sessionId],
        );
        const selectPending = React.useCallback(
          (snapshot) => (sessionId === undefined ? undefined : snapshot.get(sessionId)?.pendingInteraction),
          [sessionId],
        );
        const selectKnown = React.useCallback(
          (snapshot) => (sessionId === undefined ? undefined : snapshot.has(sessionId)),
          [sessionId],
        );
        const running = useStatus(selectRunning);
        const pending = useStatus(selectPending);
        const known = useStatus(selectKnown);

        const previous = React.useRef({ sessionId: undefined, running: undefined, pending: undefined, known: undefined });
        const alertRef = React.useRef(null);

        React.useEffect(() => {
          const before = previous.current;
          previous.current = { sessionId, running, pending, known };

          // First render, or a switch to another session: record the baseline
          // without chiming, so a session that is already idle or already
          // waiting does not ring merely because it became visible.
          if (before.sessionId !== sessionId) {
            stopAlert(alertRef);
            return;
          }

          // A session that leaves the status map (reconnect, list refresh) is not
          // a finished turn: both sides of a transition must be observed.
          const watched = before.known === true && known === true;
          const finishedTurn = watched && before.running === true && running !== true;
          const needsUser = watched && pending !== undefined && before.pending === undefined;
          if (settings.muted === true) stopAlert(alertRef);
          else if (needsUser && settings.notifyOnWaiting !== false) startAlert(alertRef, audio, settings, 'interaction');
          else if (finishedTurn && settings.notifyOnTurnEnd !== false) startAlert(alertRef, audio, settings, 'finished');
          // The reason to chime is gone — a new turn started, or the pending
          // interaction was answered — so stop the remaining repeats at once.
          else if (running === true || before.pending !== undefined) stopAlert(alertRef);
        }, [sessionId, running, pending, known, settings]);

        React.useEffect(() => () => stopAlert(alertRef), []);

        return null;
      };
    }

    /** Snapshot shown when the slot injects no settings store. */
    const FALLBACK_SNAPSHOT = Object.freeze({
          writable: false,
      muted: DEFAULTS.muted,
      notifyOnTurnEnd: DEFAULTS.notifyOnTurnEnd,
      notifyOnWaiting: DEFAULTS.notifyOnWaiting,
      repeatCount: DEFAULTS.repeatCount,
      intervalMs: DEFAULTS.intervalMs,
      volume: DEFAULTS.volume,
      waveform: DEFAULTS.waveform,
      finishedPattern: DEFAULTS.finishedPattern,
      interactionPattern: DEFAULTS.interactionPattern,
      overridden: Object.freeze({
        muted: false,
        notifyOnTurnEnd: false,
        notifyOnWaiting: false,
        repeatCount: false,
        intervalMs: false,
        volume: false,
        waveform: false,
        finishedPattern: false,
        interactionPattern: false,
      }),
    });

    /**
     * Stable stand-in store. A slot entry that throws blanks the whole slot, so a
     * missing `inject` face must degrade to a message, never to a crash.
     */
    const FALLBACK_STORE = Object.freeze({
      getSnapshot: () => FALLBACK_SNAPSHOT,
      subscribe: () => () => {},
      // Writes cannot land without a form; say so instead of throwing, so a
      // composition without the settings surface stays read-only rather than broken.
      write: () => Promise.resolve(false),
      writeAll: () => Promise.resolve(false),
      reset: () => Promise.resolve(false),
    });


    // ───────────────────────────────────────────────────────────────────
    // Settings page (this bundle's own, registered on this row's
    // `plugins.row.config` key from inside `apply`).
    // ───────────────────────────────────────────────────────────────────

    /** Dictionary namespace for the row settings page. */
    const SETTINGS_LOCALE_NS = 'plugin.turnNotifierSettings';

/** English copy. */
const en = {
  summary: 'Chimes when a turn finishes or the agent waits for you.',
  pageIntro: 'Changes apply immediately.',
  groupWhen: 'When it rings',
  groupHow: 'How it rings',
  groupTones: 'Chimes',
  groupRepeat: 'Repeats',
  tone: 'Chime set',
  toneHint: 'Picking a set plays it right away.',
  tone_bright: 'Bright',
  tone_soft: 'Soft',
  tone_deep: 'Deep',
  tone_single: 'Single',
  tone_custom: 'Custom\u2026',
  turnEndLabel: 'A turn finishes',
  waitingLabel: 'The agent waits for you',
  muteLabel: 'Mute',
  muteHint: 'Silences every chime and leaves the other settings alone.',
  volume: 'Volume',
  volumeHint: '0 is silent, 2 is the top.',
  waveform: 'Waveform',
  waveformHint: 'Timbre shared by every tone.',
  waveform_sine: 'Sine',
  waveform_square: 'Square',
  waveform_triangle: 'Triangle',
  finishedPattern: 'Finished',
  finishedPatternHint: 'frequencyHz:durationMs, comma separated. Example: 880:170, 1318.5:300',
  interactionPattern: 'Waiting',
  interactionPatternHint: 'Same notation. Example: 1046.5:140, 1318.5:200',
  invalidPattern: 'Use frequencyHz:durationMs, separated by commas.',
  preview: 'Preview',
  playing: 'Playing',
  repeatCount: 'Rings',
  repeatCountHint: 'Including the first one. 1–10.',
  intervalSeconds: 'Interval',
  intervalSecondsHint: 'Seconds between chimes. 1–60.',
  seconds: 's',
  stopHint: 'Any pointer or key activity stops the repeats.',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This row is switched off; there is nothing to configure.',
  saving: 'Loading settings…',
  saveFailed: 'The deployment did not accept that value.',
};

/** Simplified Chinese copy. */
const zh = {
  summary: '答完一轮、或停下来等你操作时响铃。',
  pageIntro: '改完立即生效。',
  groupWhen: '什么时候响',
  groupHow: '怎么响',
  groupTones: '音调',
  groupRepeat: '重复',
  tone: '提示音',
  toneHint: '换一套会立刻试听。',
  tone_bright: '清脆',
  tone_soft: '柔和',
  tone_deep: '沉稳',
  tone_single: '单音',
  tone_custom: '自定义…',
  turnEndLabel: '答完一轮',
  waitingLabel: '停下来等你操作',
  muteLabel: '静音',
  muteHint: '只让铃不响，其它设置不受影响。',
  volume: '音量',
  volumeHint: '0 是静音，2 是最大。',
  waveform: '波形',
  waveformHint: '所有音共用的波形。',
  waveform_sine: '正弦',
  waveform_square: '方波',
  waveform_triangle: '三角',
  finishedPattern: '答完',
  finishedPatternHint: '格式「频率Hz:时长ms」，逗号分隔。例如 880:170, 1318.5:300',
  interactionPattern: '等待',
  interactionPatternHint: '格式相同。例如 1046.5:140, 1318.5:200',
  invalidPattern: '请按「频率Hz:时长ms」书写，用逗号分隔。',
  preview: '试听',
  playing: '播放中',
  repeatCount: '响几声',
  repeatCountHint: '含第一次。1–10。',
  intervalSeconds: '间隔',
  intervalSecondsHint: '两次之间隔几秒。1–60。',
  seconds: '秒',
  stopHint: '鼠标或键盘一动，重复立即停止。',
  readOnly: '本部署的设置为只读。',
  unavailable: '这一行已停用，暂无可配置的内容。',
  saving: '正在读取设置…',
  saveFailed: '本部署没有接受这个值。',
};

/** Token-only styling, so light and dark follow the host theme automatically. */
const STYLE = Object.freeze({
  /** Inline notice/error lines shared by the settings surfaces. */
  notice: { opacity: 0.7, fontSize: 12, lineHeight: 1.6 },
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: 1.5 },
});

    /** The row page's current owner form; see {@link TurnNotifierRowConfig}. */
    const rowBridge = { current: undefined };

    /**
     * Send one batch of edits to the row's form. The revision is deliberately left
     * to the form: a revision read at render time goes stale the moment the first
     * write lands, so a second write in the same tick (a slider drag, a chime set
     * that writes two fields) would be rejected and the page would report a failure
     * that never happened. The form's own pending-revision chain follows its own
     * writes, which is what makes those batches land.
     * @param ops - the form operations to apply atomically.
     * @returns whether the Host accepted them.
     */
    function rowMutate(ops) {
      const form = rowBridge.current;
      if (form === undefined) return Promise.resolve(false);
      return Promise.resolve(form.mutate(ops)).then((accepted) => accepted !== false);
    }

    /** Stable store identity for the row page, delegating to {@link rowBridge}. */
    const ROW_STORE = Object.freeze({
      getSnapshot: () => project(rowBridge.current?.state),
      subscribe: () => () => undefined,
      write: (field, value) => rowMutate([{ op: 'set', path: [field], value }]),
      /** Writes several fields as one atomic batch: one user action, one revision bump. */
      writeAll: (entries) => rowMutate(Object.entries(entries).map(([field, value]) => ({ op: 'set', path: [field], value }))),
      reset: (field) => rowMutate([{ op: 'unset', path: [field] }]),
    });

    /** One uppercase group heading with its rows. */
    // ───────────────────────────────────────────────────────────────────
    // Layout
    // ───────────────────────────────────────────────────────────────────

    /**
     * Spacing and colour of the row page. Colours come from the shell's alias
     * tokens so the page follows the active theme instead of hard-coding a
     * palette, and every size is a multiple of four to sit on the same grid as
     * the surrounding pages.
     */
    const LAYOUT = Object.freeze({
      page: { display: 'flex', flexDirection: 'column', gap: 20 },
      section: { display: 'flex', flexDirection: 'column', gap: 10 },
      sectionTitle: {
        margin: 0,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      /** Two columns while there is room, one when the panel narrows. */
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 },
      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', gap: 8, alignItems: 'center' },
      switchRow: { display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'space-between' },
      switchText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      text: {
        flex: 1,
        minWidth: 0,
        padding: '5px 8px',
        background: 'transparent',
        color: 'inherit',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        fontFamily: 'inherit',
        fontSize: 13,
      },
      number: {
        width: 72,
        padding: '5px 8px',
        background: 'transparent',
        color: 'inherit',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        fontFamily: 'inherit',
        fontSize: 13,
      },
      value: { fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)', minWidth: 34, textAlign: 'right' },
    });

    /**
     * The chime sets offered by name. Each one writes *both* patterns: a set is
     * something a person picks as a whole ("make it softer"), so editing one
     * chime at a time stays the job of the Custom escape hatch.
     */
    const TONE_SETS = Object.freeze([
      { key: 'bright', finished: '880:170, 1318.5:300', interaction: '1046.5:140, 1318.5:140, 1046.5:200' },
      { key: 'soft', finished: '660:190, 880:320', interaction: '784:150, 988:150, 784:210' },
      { key: 'deep', finished: '523:200, 392:340', interaction: '587:160, 523:160, 587:220' },
      { key: 'single', finished: '880:220', interaction: '1046.5:220' },
    ]);

    /**
     * Which set the current pair of patterns amounts to.
     * @param settings - the projected settings.
     * @returns a `TONE_SETS` key, or `'custom'` when no set matches.
     */
    function toneSetOf(settings) {
      const found = TONE_SETS.find((set) => set.finished === settings.finishedPattern && set.interaction === settings.interactionPattern);
      return found === undefined ? 'custom' : found.key;
    }

    // ───────────────────────────────────────────────────────────────────
    // Field helpers
    // ───────────────────────────────────────────────────────────────────

    /**
     * One titled group of fields.
     * @param key - React key.
     * @param title - localized heading.
     * @param children - the group's fields.
     * @returns the section element.
     */
    function section(key, title, children) {
      return h('section', { key, style: LAYOUT.section }, [
        h('h4', { key: 'title', style: LAYOUT.sectionTitle }, title),
        h('div', { key: 'body', style: LAYOUT.section }, children),
      ]);
    }

    /**
     * A labelled switch row on the shell's own `Switch`, which carries the
     * accessible name, the focus ring and the theme-aware track for free.
     * @param key - React key.
     * @param label - localized row label; also the switch's accessible name.
     * @param checked - current state.
     * @param disabled - whether the deployment is read-only.
     * @param onChange - receives the next state.
     * @param hint - optional second line.
     * @returns the row element.
     */
    function switchRow(key, label, checked, disabled, onChange, hint) {
      return h('div', { key, style: LAYOUT.switchRow }, [
        h('div', { key: 'text', style: LAYOUT.switchText }, [
          h('span', { key: 'label', style: LAYOUT.label }, label),
          hint === undefined ? null : h('span', { key: 'hint', style: LAYOUT.hint }, hint),
        ]),
        h(primitives.Switch, { key: 'switch', checked, disabled, label, onChange }),
      ]);
    }

    /**
     * A tone-pattern field: the notation, its hint, and the control that plays
     * it. The text is committed on blur or Enter so a half-typed pattern is
     * never written to the Host.
     * @param props - key, t, label, hint, value, disabled, invalid, playing, and
     * the edit/commit/preview callbacks.
     * @returns the field element.
     */
    function patternRow(props) {
      const { key, t, label, hint, value, disabled, invalid, playing, onEdit, onCommit, onPreview } = props;
      return h('div', { key, style: LAYOUT.field }, [
        h('label', { key: 'label', style: LAYOUT.label }, label),
        h('div', { key: 'row', style: LAYOUT.row }, [
          h('input', {
            key: 'input',
            type: 'text',
            value,
            disabled,
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => onEdit(event.target.value),
            onBlur: () => onCommit(),
            onKeyDown: (event) => {
              if (event.key === 'Enter') onCommit();
            },
            style: {
              ...LAYOUT.text,
              borderColor: invalid ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l1)',
            },
          }),
          h(primitives.Button, {
            key: 'preview',
            variant: 'outline',
            disabled: disabled || invalid,
            onClick: onPreview,
          }, playing ? t('playing') : t('preview')),
        ]),
        h('span', { key: 'hint', style: invalid ? { ...LAYOUT.hint, color: 'var(--dsw-alias-state-error-primary)' } : LAYOUT.hint },
          invalid ? t('invalidPattern') : hint),
      ]);
    }

    /**
     * A numeric field with a unit beside it and its hint underneath. Like the
     * pattern fields, the text is committed on blur or Enter: writing on every
     * keystroke would clamp an emptied box straight back to its default while the
     * person is still typing.
     * @param props - key, label, hint, unit, value, min, max, disabled, onEdit, onCommit.
     * @returns the field element.
     */
    function numberRow(props) {
      const { key, label, hint, unit, value, min, max, disabled, onEdit, onCommit } = props;
      return h('div', { key, style: LAYOUT.field }, [
        h('label', { key: 'label', style: LAYOUT.label }, label),
        h('div', { key: 'row', style: LAYOUT.row }, [
          h('input', {
            key: 'input',
            type: 'number',
            min,
            max,
            value,
            disabled,
            onChange: (event) => onEdit(event.target.value),
            onBlur: () => onCommit(),
            onKeyDown: (event) => {
              if (event.key === 'Enter') onCommit();
            },
            style: LAYOUT.number,
          }),
          unit === undefined ? null : h('span', { key: 'unit', style: LAYOUT.hint }, unit),
        ]),
        h('span', { key: 'hint', style: LAYOUT.hint }, hint),
      ]);
    }

    /**
     * The chime-set picker: one menu that names the current set, plus the button
     * that plays it. Choosing a set writes both patterns and previews the result,
     * so the effect of a choice is audible before the menu is reopened.
     * @param props - t, the current set key, disabled, and the pick/preview callbacks.
     * @returns the field element.
     */
    function tonePicker(props) {
      const { t, active, disabled, onPick, onPreview, playing } = props;
      const [open, setOpen] = React.useState(false);
      const labelKey = active === 'custom' ? 'tone_custom' : `tone_${active}`;
      return h('div', { style: LAYOUT.field }, [
        h('label', { key: 'label', style: LAYOUT.label }, t('tone')),
        h('div', { key: 'row', style: LAYOUT.row }, [
          h(primitives.Menu, {
            key: 'menu',
            open,
            // The trigger rides in as the anchor: that is what Menu positions the
            // list against and where it returns focus after a choice or Escape.
            anchor: h(primitives.Button, {
              variant: 'outline',
              disabled,
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              onClick: () => setOpen(true),
            }, h('span', {
              key: 'face',
              style: { display: 'inline-flex', alignItems: 'center', gap: 6 },
            }, [t(labelKey), h(primitives.IconChevronDownOutlineRegular, { key: 'chevron' })])),
            onClose: () => setOpen(false),
            items: TONE_SETS.map((set) => ({ id: set.key, label: t(`tone_${set.key}`) })).concat([{ id: 'custom', label: t('tone_custom') }]),
            selectedId: active,
            selection: 'check',
            onSelect: (id) => {
              setOpen(false);
              onPick(id);
            },
          }),
          h(primitives.Button, {
            key: 'preview',
            variant: 'ghost',
            disabled,
            onClick: onPreview,
          }, playing ? t('playing') : t('preview')),
        ]),
        h('span', { key: 'hint', style: LAYOUT.hint }, t('toneHint')),
      ]);
    }

    // ───────────────────────────────────────────────────────────────────
    // The row page
    // ───────────────────────────────────────────────────────────────────

    /**
     * The row page body: every setting, grouped, each writing the moment it
     * changes. Values come from the row's own `ctx.configForms.get('turn-notifier')`
     * so the page and the chime can never disagree.
     * @param props - the row's form bridge plus this bundle's locale and audio.
     * @returns the page.
     */
    function TurnNotifierGroups(props) {
      const { t, store, snapshot, audio } = props;
      // Hooks must run unconditionally: subscribe to the live store when one is
      // given, otherwise to a frozen stand-in, and let an explicit snapshot win.
      const live = useStoreValue(store ?? FALLBACK_STORE);
      const settings = snapshot ?? live;
      const [drafts, setDrafts] = React.useState({});
      const [failed, setFailed] = React.useState(false);
      const [playing, setPlaying] = React.useState(null);
      const playingTimer = React.useRef(null);
      const playTimer = React.useRef(null);
      const [customOpen, setCustomOpen] = React.useState(false);
      // A pending timer would otherwise fire into an unmounted tree — and the
      // "preview both" one would ring a second chime after the page is gone.
      React.useEffect(() => () => {
        if (playingTimer.current !== null) window.clearTimeout(playingTimer.current);
        if (playTimer.current !== null) window.clearTimeout(playTimer.current);
      }, []);

      const write = (field, value) => {
        store.write(field, value).then((ok) => setFailed(ok === false));
      };
      const draftOf = (field, current) => (drafts[field] !== undefined ? drafts[field] : current);
      const edit = (field, text) => setDrafts((current) => ({ ...current, [field]: text }));
      const drop = (field) => setDrafts((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
      const commit = (field) => {
        const text = drafts[field];
        if (text === undefined) return;
        // An unusable pattern keeps its draft: dropping it would throw away what the
        // person typed and clear the error state in the same breath.
        if (parsePattern(text, null) === null) return;
        write(field, text);
        drop(field);
      };
      /** Commit a numeric draft, clamped and scaled (interval is shown in seconds). */
      const commitNumber = (field, min, max, fallback, scale) => {
        const text = drafts[field];
        if (text === undefined) return;
        write(field, clampInteger(text, min, max, fallback) * scale);
        drop(field);
      };
      const play = (reason, text, overrides) => {
        const tones = parsePattern(text, PATTERNS[reason]);
        // `overrides` lets a control preview its own pending value: the snapshot in
        // `settings` still carries the old one until the Host writes back.
        audio.ring(reason, { ...settings, ...overrides, tones: { ...settings.tones, [reason]: tones } });
        setPlaying(reason);
        if (playingTimer.current !== null) window.clearTimeout(playingTimer.current);
        playingTimer.current = window.setTimeout(() => setPlaying(null), 700);
      };
      const disabled = settings.writable !== true;
      const finished = draftOf('finishedPattern', settings.finishedPattern);
      const interaction = draftOf('interactionPattern', settings.interactionPattern);
      const finishedOk = parsePattern(finished, null) !== null;
      const interactionOk = parsePattern(interaction, null) !== null;
      const toneSet = toneSetOf(settings);
      // A pair that matches no set is by definition custom, so the editor stays
      // open until the person picks a set again.
      const editingTones = toneSet === 'custom' || customOpen;
      const pickToneSet = (key) => {
        const set = TONE_SETS.find((candidate) => candidate.key === key);
        if (set === undefined) {
          setCustomOpen(true);
          return;
        }
        setCustomOpen(false);
        // One batch, not two writes: the pair is a single choice, and two calls in
        // one tick would race each other's revision.
        store.writeAll({ finishedPattern: set.finished, interactionPattern: set.interaction });
        play('finished', set.finished, { finishedPattern: set.finished, interactionPattern: set.interaction });
      };

      return h('div', { style: LAYOUT.page }, [
        section('when', t('groupWhen'), [
          switchRow('turnEnd', t('turnEndLabel'), settings.notifyOnTurnEnd, disabled, (next) => write('notifyOnTurnEnd', next)),
          switchRow('waiting', t('waitingLabel'), settings.notifyOnWaiting, disabled, (next) => write('notifyOnWaiting', next)),
          switchRow('mute', t('muteLabel'), settings.muted, disabled, (next) => write('muted', next), t('muteHint')),
        ]),
        section('how', t('groupHow'), [h('div', { key: 'grid', style: LAYOUT.grid }, [
          h('div', { key: 'volume', style: LAYOUT.field }, [
            h('div', { key: 'head', style: LAYOUT.row }, [
              h('label', { key: 'label', style: { ...LAYOUT.label, flex: 1 } }, t('volume')),
              h('span', { key: 'value', style: LAYOUT.value }, settings.volume.toFixed(2)),
            ]),
            h('input', {
              key: 'slider',
              type: 'range',
              min: 0,
              max: 2,
              step: 0.05,
              value: settings.volume,
              disabled,
              onChange: (event) => write('volume', Number(event.target.value)),
              style: { width: '100%' },
            }),
            h('span', { key: 'hint', style: LAYOUT.hint }, t('volumeHint')),
          ]),
          h('div', { key: 'waveform', style: LAYOUT.field }, [
            h('label', { key: 'label', style: LAYOUT.label }, t('waveform')),
            h(primitives.SegmentedControl, {
              key: 'control',
              id: `${BUNDLE_NAME}-waveform`,
              label: t('waveform'),
              value: settings.waveform,
              disabled,
              options: WAVEFORMS.map((name) => ({ value: name, label: t(`waveform_${name}`) })),
              onChange: (next) => {
                write('waveform', next);
                play('finished', finished, { waveform: next });
              },
            }),
            h('span', { key: 'hint', style: LAYOUT.hint }, t('waveformHint')),
          ]),
        ])]),
        section('tones', t('groupTones'), [
          tonePicker({
            key: 'picker',
            t,
            active: toneSet,
            disabled,
            playing: playing !== null,
            onPick: pickToneSet,
            onPreview: () => {
              if (finishedOk) play('finished', finished);
              if (playTimer.current !== null) window.clearTimeout(playTimer.current);
              if (interactionOk) playTimer.current = window.setTimeout(() => play('interaction', interaction), 520);
            },
          }),
          editingTones ? h('div', { key: 'grid', style: LAYOUT.grid }, [
            patternRow({
              key: 'finished',
              t,
              label: t('finishedPattern'),
              hint: t('finishedPatternHint'),
              value: finished,
              disabled,
              invalid: !finishedOk,
              playing: playing === 'finished',
              onEdit: (text) => edit('finishedPattern', text),
              onCommit: () => commit('finishedPattern'),
              onPreview: () => play('finished', finished),
            }),
            patternRow({
              key: 'interaction',
              t,
              label: t('interactionPattern'),
              hint: t('interactionPatternHint'),
              value: interaction,
              disabled,
              invalid: !interactionOk,
              playing: playing === 'interaction',
              onEdit: (text) => edit('interactionPattern', text),
              onCommit: () => commit('interactionPattern'),
              onPreview: () => play('interaction', interaction),
            }),
          ]) : null,
        ]),
        section('repeat', t('groupRepeat'), [
          h('div', { key: 'grid', style: LAYOUT.grid }, [
            numberRow({
              key: 'count',
              label: t('repeatCount'),
              hint: t('repeatCountHint'),
              value: draftOf('repeatCount', settings.repeatCount),
              min: 1,
              max: 10,
              disabled,
              onEdit: (text) => edit('repeatCount', text),
              onCommit: () => commitNumber('repeatCount', 1, 10, DEFAULTS.repeatCount, 1),
            }),
            numberRow({
              key: 'interval',
              label: t('intervalSeconds'),
              hint: t('intervalSecondsHint'),
              unit: t('seconds'),
              value: draftOf('intervalMs', Math.round(settings.intervalMs / 1000)),
              min: 1,
              max: 60,
              disabled,
              onEdit: (text) => edit('intervalMs', text),
              onCommit: () => commitNumber('intervalMs', 1, 60, DEFAULTS.intervalMs / 1000, 1000),
            }),
          ]),
          h('span', { key: 'stop', style: LAYOUT.hint }, t('stopHint')),
        ]),
        failed ? h('div', { key: 'failed', role: 'alert', style: STYLE.error }, t('saveFailed')) : null,
      ]);
    }


    function TurnNotifierRowConfig(props) {
      const { t, view, form, audio } = props;
      if (view === 'summary') return t('summary');
      if (form?.state === undefined) return null;
      if (form.state.status === 'loading') return h('div', { role: 'status' }, t('saving'));
      if (form.state.status !== 'ready') return h('div', { style: STYLE.notice }, t('unavailable'));
      // One stable bridge for the whole page: the owner hands a fresh `{state,
      // mutate}` object every render, so an adapter created per render would give
      // `useStoreValue` a new dependency each time and spin in a setState loop.
      // The bridge's identity never changes; the page's explicit `snapshot` is
      // what makes a new revision visible, and the owner re-renders on changes.
      rowBridge.current = form;
      return h('div', { key: 'page', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
        form.state.writable === true ? null : h('div', { key: 'readonly', style: STYLE.notice }, t('readOnly')),
        h('p', { key: 'intro', style: { margin: 0, ...LAYOUT.hint, fontSize: 13 } }, t('pageIntro')),
        h(TurnNotifierGroups, {
          key: 'groups',
          t,
          store: ROW_STORE,
          snapshot: project(form.state),
          audio,
        }),
      ]);
    }
    return {
      inject: ['remote', 'slots', 'locale'],
      async apply(ctx) {
        // `configForms` is optional: a composition without the settings UI must
        // still get the chime (with schema defaults, read-only). It is read
        // here, outside the gate below, because the chime must start whether or
        // not the settings surface exists.
        const forms = ctx.get('configForms');
        const form = forms?.get?.(ENTRY_ID);
        const store = form === undefined ? FALLBACK_STORE : createSettingsStore(form);
        if (form !== undefined) ctx.effect(() => () => store.dispose(), 'turn-notifier: settings subscription');

        const audio = createAudio();

        // Unlock the audio context on the first user gesture, as autoplay policy requires.
        ctx.effect(() => {
          const unlock = () => audio.ensure();
          for (const type of UNLOCK_EVENTS) window.addEventListener(type, unlock, { passive: true });
          return () => {
            for (const type of UNLOCK_EVENTS) window.removeEventListener(type, unlock);
          };
        }, 'turn-notifier: audio unlock');

        // The ringing contribution, an invisible entry: it needs the session
        // status hook only, and must keep observing whether or not a settings
        // surface is open. The settings page registers on this same row from the
        // gate below.
        ctx.slots.inject(SLOT_NAME, () =>
          ctx.slots.register({ name: SLOT_NAME, id: `${ENTRY_ID}-alert`, order: 91 }, createNotifier(audio, store)),
        );

        // Mount this bundle's Remote service, then gate the settings entry on it.
        //
        // The gate is the whole point. This half's `apply` is NOT re-run after a
        // 停用→启用 cycle (deepseek-harness#8452), so anything registered directly
        // here is lost for good. `ctx.inject` re-runs its callback whenever its
        // dependencies become available again, and `remote.turnNotifier` — this
        // bundle's own Host service — is precisely the dependency that disappears
        // and returns with the row.
        const mounted = ctx.remote.$mount(TYPERT_REMOTE);
        const ui = ctx.inject(['remote.turnNotifier', 'slots', 'locale'], (child) => {
          const prune = [];
          prune.push(child.effect(() => child.locale.register(SETTINGS_LOCALE_NS, { zh, en }), 'turn-notifier: settings dictionaries'));
          const childForms = child.get('configForms');
          if (childForms?.whileServed !== undefined) {
            prune.push(child.effect(() => childForms.whileServed([ENTRY_ID], () => child.slots.inject('plugins.row.config', () => child.slots.register({
              name: 'plugins.row.config',
              key: `${BUNDLE_NAME}#${ENTRY_ID}`,
              locale: SETTINGS_LOCALE_NS,
              inject: () => ({ audio }),
            }, TurnNotifierRowConfig))), 'turn-notifier: row configuration page'));
          }
          return () => {
            for (const dispose of prune.reverse()) {
              try { void dispose?.(); } catch { /* one failed teardown must not strand the rest */ }
            }
          };
        });
        try {
          await ui;
        } catch (error) {
          void mounted.then((dispose) => dispose(), () => undefined);
          throw error;
        }
        return async () => {
          await ui.dispose();
          void mounted.then((dispose) => dispose(), () => undefined);
        };
      },
    };
  },
});

})();
