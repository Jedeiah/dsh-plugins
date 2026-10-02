/**
 * Client half of the Turn Notifier bundle.
 *
 * Two contributions, both mounted on this bundle's single row:
 *   1. an invisible entry in `conversation.composer.dock` that rings when the
 *      viewed session finished a turn or is waiting for the user;
 *   2. the bundle's configuration page in `plugins.bundle.config`, keyed by this
 *      bundle's package name.
 *
 * Sharing one row is deliberate: a browser half is mounted on the row whose
 * specifier is exactly this package name, so both live and die with the row.
 * Switching the row off turns the whole plugin off; switching it on must bring
 * both back — which is why `dsh.client` must NOT set `immediately`, because
 * removing or replacing a bootstrap entry requires a full page refresh.
 *
 * Tunables come from the Host row's `Config` (see ../index.js) through
 * `ctx.configForms`. They are read in the browser, so changing them takes effect
 * without reloading the module. Status signals come from the slot's
 * `useSessionStatus` standard prop, whose entries are
 * `{ running, pendingInteraction, completionUnread }`.
 */

/** This bundle's package name: the browser module id. */
const BUNDLE_NAME = '@jedeiah/turn-notifier';
/** Profile row id; also the Host settings namespace. */
const ENTRY_ID = 'turn-notifier';
/** Dictionary namespace owned by this plugin. */
const LOCALE_NS = 'plugin.turnNotifier';

/** Slot this plugin's notification entry occupies. */
const SLOT_NAME = 'conversation.composer.dock';

/** Fallbacks, mirroring the Host schema defaults. */
const DEFAULTS = Object.freeze({
  muted: false,
  notifyOnTurnEnd: true,
  notifyOnWaiting: true,
  repeatCount: 3,
  intervalMs: 5000,
  volume: 0.35,
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

/** English copy. */
const en = {
  summary: 'Ring count, interval, volume, waveform and chimes.',
  repeatCount: 'Rings per alert',
  repeatCountHint: 'Including the first chime. 1–10.',
  intervalSeconds: 'Repeat interval',
  intervalSecondsHint: 'Seconds between chimes, after the first. 1–60.',
  volume: 'Volume',
  volumeHint: 'From 0 (silent) to 1 (full).',
  waveform: 'Waveform',
  waveformHint: 'Timbre of every tone.',
  waveform_sine: 'Sine (soft)',
  waveform_square: 'Square (bright)',
  waveform_triangle: 'Triangle (mellow)',
  finishedPattern: 'Finished chime',
  finishedPatternHint: 'Tones as frequencyHz:durationMs, comma separated, played in order. Example: 880:170, 1318.5:300',
  interactionPattern: 'Waiting chime',
  interactionPatternHint: 'Same notation. Example: 1046.5:140, 1318.5:140, 1046.5:200',
  invalidPattern: 'Write tones as frequencyHz:durationMs, separated by commas.',
  seconds: 's',
  reset: 'Reset to default',
  overridden: 'Overridden',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'The notifier row is switched off, so there is nothing to configure right now.',
  saveFailed: 'The deployment did not accept that value; it was left for you to correct.',
  openSettings: 'Turn notifier settings',
  dialogTitle: 'Turn notifier',
  close: 'Close',
  groupWhen: 'When it rings',
  groupHow: 'How it rings',
  groupRepeat: 'Repeats and stopping',
  muteLabel: 'Mute',
  muteHint: 'Use this switch to go quiet. Do not switch the plugin row off instead: after off→on the browser half is not remounted (known dsh issue deepseek-harness#8452), so this page stays away until the page is reloaded.',
  turnEndLabel: 'A turn finishes',
  waitingLabel: 'It stops to wait for you (approval or question)',
  preview: 'Preview',
  stopHint: 'Any pointer or key activity stops the repeats immediately.',
  done: 'Done',
  restoreAll: 'Restore all defaults',
  statusPrefix: 'Now: ',
  statusIdle: 'idle',
  statusRunning: 'running',
  statusWaiting: 'waiting for you',
  statusMuted: 'muted',
  unavailable: 'The notifier row is switched off, so there is nothing to configure right now.',
};

/** Simplified Chinese copy. */
const zh = {
  summary: '响铃次数、间隔、音量、波形与音调。',
  repeatCount: '每次提醒响几声',
  repeatCountHint: '含第一次。取值 1–10。',
  intervalSeconds: '重复间隔',
  intervalSecondsHint: '第一次之后每次间隔几秒。取值 1–60。',
  volume: '音量',
  volumeHint: '0（静音）到 1（最大）。',
  waveform: '波形',
  waveformHint: '所有音使用的波形。',
  waveform_sine: '正弦（柔和）',
  waveform_square: '方波（明亮）',
  waveform_triangle: '三角（圆润）',
  finishedPattern: '答完的音调',
  finishedPatternHint: '格式「频率Hz:时长ms」，逗号分隔，按顺序播放。例如 880:170, 1318.5:300',
  interactionPattern: '等待的音调',
  interactionPatternHint: '格式相同。例如 1046.5:140, 1318.5:140, 1046.5:200',
  invalidPattern: '请按「频率Hz:时长ms」书写，用逗号分隔。',
  seconds: '秒',
  reset: '恢复默认',
  overridden: '已覆盖',
  readOnly: '本部署的设置为只读。',
  unavailable: '回合提醒那一行处于停用状态，现在没有可配置的内容。',
  saveFailed: '本部署没有接受这个值，已保留供你修改。',
  openSettings: '回合提醒设置',
  dialogTitle: '回合提醒',
  close: '关闭',
  groupWhen: '什么时候响',
  groupHow: '怎么响',
  groupRepeat: '重复与停止',
  muteLabel: '静音',
  muteHint: '临时安静用这个开关。不要用停用插件行来代替——停用再启用后浏览器半边不会重新挂载（dsh 的已知问题 deepseek-harness#8452），设置页会一直缺席到重载界面为止。',
  turnEndLabel: '智能体答完一轮',
  waitingLabel: '停下来等你操作（审批 / 提问）',
  preview: '试听',
  stopHint: '鼠标或键盘一动，正在重复的提醒立即停止。',
  done: '完成',
  restoreAll: '全部恢复默认',
  statusPrefix: '当前：',
  statusIdle: '空闲',
  statusRunning: '正在跑',
  statusWaiting: '等待你操作',
  statusMuted: '已静音',
  unavailable: '回合提醒那一行处于停用状态，现在没有可配置的内容。',
};

/** Shared control surface, so every input, select and reset link matches. */
const CONTROL = Object.freeze({
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: '6px',
  padding: '5px 8px',
  fontSize: '13px',
  fontFamily: 'inherit',
});

/** Token-only styling, so light and dark follow the host theme automatically. */
const STYLE = Object.freeze({
  form: { display: 'grid', gap: '14px', maxWidth: '520px' },
  field: { display: 'grid', gap: '4px' },
  label: {
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '13px',
    fontWeight: 500,
    lineHeight: 1.4,
  },
  hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5 },
  row: { display: 'flex', alignItems: 'center', gap: '8px' },
  input: Object.freeze({ ...CONTROL, width: '88px' }),
  select: Object.freeze({ ...CONTROL, width: '160px' }),
  textInput: Object.freeze({ ...CONTROL, width: '280px' }),
  unit: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
  reset: {
    background: 'transparent',
    color: 'var(--dsw-alias-brand-primary)',
    border: 'none',
    padding: '0',
    fontSize: '12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  badge: {
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '11px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '4px',
    padding: '0 5px',
  },
  notice: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: '12px', lineHeight: 1.5 },
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', lineHeight: 1.5 },
});

window.__ModuleLoader__.load({
  id: BUNDLE_NAME,
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // Official primitives are a platform seed shared by every client bundle, so
    // the dialog gets the shell's portal, focus handling and control styling
    // instead of a hand-rolled overlay.
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
        volume: Math.min(1, Math.max(0, Number.isFinite(value.volume) ? value.volume : DEFAULTS.volume)),
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
          gain.connect(audio.destination);
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
      status: 'unavailable',
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
    });


    /** One uppercase group heading with its rows. */
    function dialogGroup(key, title, rows) {
      return h('section', { key, style: { marginBottom: 16 } }, [
        h('h4', { key: 'title', style: { margin: '0 0 8px', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.55 } }, title),
        ...rows,
      ]);
    }

    /** A checkbox row: the switch and its label on one line, hint underneath. */
    function toggleRow(key, label, checked, disabled, onToggle, hint) {
      return h('div', { key, style: { marginBottom: 10 } }, [
        h('label', { key: 'row', style: { display: 'flex', gap: 8, alignItems: 'center', cursor: disabled ? 'default' : 'pointer' } }, [
          h('input', {
            key: 'box',
            type: 'checkbox',
            checked,
            disabled,
            onChange: (event) => onToggle(event.target.checked),
          }),
          h('span', { key: 'text', style: { fontWeight: 600 } }, label),
        ]),
        hint === undefined ? null : h('div', { key: 'hint', style: { opacity: 0.66, fontSize: 12, lineHeight: 1.5, marginLeft: 24 } }, hint),
      ]);
    }

    /** A tone-pattern row: text field, live validation and a preview button. */
    function patternRow(props) {
      const { key, t, label, hint, value, disabled, onEdit, onCommit, onPreview } = props;
      const tones = parsePattern(value, null);
      return h('div', { key, style: { marginBottom: 12 } }, [
        h('div', { key: 'label', style: { fontWeight: 600, marginBottom: 4 } }, label),
        h('div', { key: 'line', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
          h('input', {
            key: 'input',
            type: 'text',
            value,
            disabled,
            onChange: (event) => onEdit(event.target.value),
            onBlur: onCommit,
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            },
            style: {
              flex: 1,
              minWidth: 0,
              padding: '5px 7px',
              background: 'transparent',
              color: 'inherit',
              border: `1px solid ${tones === null ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l1)'}`,
              borderRadius: 4,
            },
          }),
          h(primitives.Button, {
            key: 'preview',
            variant: 'outline',
            disabled: disabled || tones === null,
            onClick: () => onPreview(value),
            children: t('preview'),
          }),
        ]),
        h('div', { key: 'hint', style: { opacity: 0.66, fontSize: 12, lineHeight: 1.5, marginTop: 4 } }, tones === null ? t('invalidPattern') : hint),
      ]);
    }

    /**
     * The Settings dialog opened from the dock bell.
     *
     * It edits exactly the same form the Plugins-page card edits
     * (`ctx.configForms.get(ENTRY_ID)`), so the two surfaces can never disagree;
     * the redesign is layout and affordances, not a second source of truth.
     */
    function TurnNotifierDialog(props) {
      const { t, store, audio, running, pending, open, onClose } = props;
      const settings = useStoreValue(store);
      const [drafts, setDrafts] = React.useState({});
      const [failed, setFailed] = React.useState(false);

      const write = (field, value) => {
        store.write(field, value).then((ok) => setFailed(ok === false));
      };
      const draftOf = (field, current) => (drafts[field] !== undefined ? drafts[field] : current);
      const edit = (field, text) => setDrafts((current) => ({ ...current, [field]: text }));
      const commit = (field) => {
        const text = drafts[field];
        if (text === undefined) return;
        setDrafts((current) => {
          const next = { ...current };
          delete next[field];
          return next;
        });
        write(field, text.trim() === '' ? DEFAULTS[field] : text.trim());
      };
      const preview = (reason, text) => {
        const tones = parsePattern(text, PATTERNS[reason]);
        audio.ring(reason, { ...settings, tones: { ...settings.tones, [reason]: tones } });
      };

      if (open !== true) return null;
      const disabled = settings.writable !== true;
      const status = settings.muted
        ? t('statusMuted')
        : pending === true ? t('statusWaiting') : running === true ? t('statusRunning') : t('statusIdle');

      return h(primitives.Modal, {
        open: true,
        onClose,
        closeLabel: t('close'),
        title: t('dialogTitle'),
        description: `${t('statusPrefix')}${status}`,
        footer: h(React.Fragment, null, [
          h(primitives.Button, {
            key: 'restore',
            variant: 'outline',
            disabled,
            onClick: () => {
              for (const field of ['repeatCount', 'intervalMs', 'volume', 'waveform', 'finishedPattern', 'interactionPattern']) store.reset(field);
            },
            children: t('restoreAll'),
          }),
          h(primitives.Button, { key: 'done', variant: 'primary', onClick: onClose, children: t('done') }),
        ]),
        children: [
          dialogGroup('when', t('groupWhen'), [
            toggleRow('turnEnd', t('turnEndLabel'), settings.notifyOnTurnEnd, disabled, (next) => write('notifyOnTurnEnd', next)),
            toggleRow('waiting', t('waitingLabel'), settings.notifyOnWaiting, disabled, (next) => write('notifyOnWaiting', next)),
            toggleRow('mute', t('muteLabel'), settings.muted, disabled, (next) => write('muted', next), t('muteHint')),
          ]),
          dialogGroup('how', t('groupHow'), [
            h('div', { key: 'volume', style: { marginBottom: 10 } }, [
              h('div', { key: 'label', style: { fontWeight: 600, marginBottom: 4 } }, `${t('volume')} · ${settings.volume.toFixed(2)}`),
              h('input', {
                key: 'slider',
                type: 'range',
                min: 0,
                max: 1,
                step: 0.05,
                value: settings.volume,
                disabled,
                onChange: (event) => write('volume', Number(event.target.value)),
                style: { width: '100%' },
              }),
              h('div', { key: 'hint', style: { opacity: 0.66, fontSize: 12 } }, t('volumeHint')),
            ]),
            h('div', { key: 'waveform', style: { marginBottom: 12 } }, [
              h('div', { key: 'label', style: { fontWeight: 600, marginBottom: 4 } }, t('waveform')),
              h('select', {
                key: 'select',
                value: settings.waveform,
                disabled,
                onChange: (event) => write('waveform', event.target.value),
                style: { padding: '4px 6px', background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 4 },
              }, WAVEFORMS.map((name) => h('option', { key: name, value: name }, t(`waveform_${name}`)))),
              h('div', { key: 'hint', style: { opacity: 0.66, fontSize: 12 } }, t('waveformHint')),
            ]),
            patternRow({
              key: 'finished',
              t,
              label: t('finishedPattern'),
              hint: t('finishedPatternHint'),
              value: draftOf('finishedPattern', settings.finishedPattern),
              disabled,
              onEdit: (text) => edit('finishedPattern', text),
              onCommit: () => commit('finishedPattern'),
              onPreview: () => preview('finished', draftOf('finishedPattern', settings.finishedPattern)),
            }),
            patternRow({
              key: 'interaction',
              t,
              label: t('interactionPattern'),
              hint: t('interactionPatternHint'),
              value: draftOf('interactionPattern', settings.interactionPattern),
              disabled,
              onEdit: (text) => edit('interactionPattern', text),
              onCommit: () => commit('interactionPattern'),
              onPreview: () => preview('interaction', draftOf('interactionPattern', settings.interactionPattern)),
            }),
          ]),
          dialogGroup('repeat', t('groupRepeat'), [
            h('div', { key: 'repeatCount', style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 } }, [
              h('span', { key: 'label', style: { fontWeight: 600, flex: 1 } }, t('repeatCount')),
              h('input', {
                key: 'input',
                type: 'number',
                min: 1,
                max: 10,
                value: settings.repeatCount,
                disabled,
                onChange: (event) => write('repeatCount', clampInteger(event.target.value, 1, 10, DEFAULTS.repeatCount)),
                style: { width: 64, padding: '4px 6px', background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 4 },
              }),
            ]),
            h('div', { key: 'interval', style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 } }, [
              h('span', { key: 'label', style: { fontWeight: 600, flex: 1 } }, `${t('intervalSeconds')}（${t('seconds')}）`),
              h('input', {
                key: 'input',
                type: 'number',
                min: 1,
                max: 60,
                value: Math.round(settings.intervalMs / 1000),
                disabled,
                onChange: (event) => write('intervalMs', clampInteger(event.target.value, 1, 60, DEFAULTS.intervalMs / 1000) * 1000),
                style: { width: 64, padding: '4px 6px', background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 4 },
              }),
            ]),
            h('div', { key: 'stop', style: { opacity: 0.66, fontSize: 12, lineHeight: 1.5 } }, t('stopHint')),
          ]),
          failed ? h('div', { key: 'failed', role: 'alert', style: STYLE.error }, t('saveFailed')) : null,
        ],
      });
    }

    /** The dock bell: opens the settings dialog and reflects muted state. */
    function createDockEntry(store, audio) {
      return function TurnNotifierDock(props) {
        const { t, sessionId, useSessionStatus } = props;
        const settings = useStoreValue(store);
        const [open, setOpen] = React.useState(false);
        const useStatus = typeof useSessionStatus === 'function' ? useSessionStatus : readEmptyStatus;
        const selectRunning = React.useCallback((snapshot) => (sessionId === undefined ? undefined : snapshot.get(sessionId)?.running), [sessionId]);
        const selectPending = React.useCallback((snapshot) => (sessionId === undefined ? undefined : snapshot.get(sessionId)?.pendingInteraction), [sessionId]);
        const running = useStatus(selectRunning);
        const pending = useStatus(selectPending);

        return h(React.Fragment, null, [
          h(primitives.Tooltip, {
            key: 'bell',
            label: t('openSettings'),
            side: 'top',
            align: 'center',
            delayMs: 400,
          }, h('button', {
            key: 'button',
            type: 'button',
            'aria-label': t('openSettings'),
            onClick: () => setOpen(true),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--dsw-alias-label-tertiary)',
              opacity: settings.muted ? 0.35 : 0.75,
            },
          }, h(primitives.IconAlarmClockOutlineRegular, { size: 16 }))),
          h(TurnNotifierDialog, {
            key: 'dialog',
            t,
            store,
            audio,
            running,
            pending,
            open,
            onClose: () => setOpen(false),
          }),
        ]);
      };
    }

    /** Badge style, computed once instead of per render. */
    const BADGE_STYLE = Object.freeze(Object.assign({ marginLeft: '6px' }, STYLE.badge));

    /** One labelled control with its hint, override badge and reset link. */
    function field(props) {
      const { key, t, id, label, hint, value, overridden, kind, choices, unit, step, min, max, onEdit, onCommit, onPick, onReset } = props;
      const control = kind === 'select'
        ? h('select', {
          key: 'input',
          id,
          value,
          style: STYLE.select,
          onChange: (event) => onPick(event.target.value),
        }, choices.map((choice) => h('option', { key: choice.value, value: choice.value }, choice.label)))
        : h('input', {
          key: 'input',
          id,
          type: kind === 'text' ? 'text' : 'number',
          step,
          min,
          max,
          value,
          spellCheck: false,
          style: kind === 'text' ? STYLE.textInput : STYLE.input,
          onChange: (event) => onEdit(event.target.value),
          onBlur: onCommit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') onCommit();
          },
        });
      return h('div', { key, style: STYLE.field }, [
        h('label', { key: 'label', htmlFor: id, style: STYLE.label }, [
          label,
          overridden === true
            ? h('span', { key: 'badge', style: BADGE_STYLE }, t('overridden'))
            : null,
        ]),
        h('div', { key: 'row', style: STYLE.row }, [
          control,
          unit === undefined ? null : h('span', { key: 'unit', style: STYLE.unit }, unit),
          overridden === true
            ? h('button', { key: 'reset', type: 'button', style: STYLE.reset, onClick: onReset }, t('reset'))
            : null,
        ]),
        h('div', { key: 'hint', style: STYLE.hint }, hint),
      ]);
    }

    /**
     * The notifier's configuration page on the Plugins page.
     *
     * Edits are staged locally and written on blur or Enter, so typing a number
     * neither fires one Host write per keystroke nor gets re-clamped out from
     * under the caret.
     *
     * @param props - the asked view, the locale reader and the injected form face.
     */
    function TurnNotifierSettings(props) {
      const { t, view } = props;
      const state = useStoreValue(props.settingsStore ?? FALLBACK_STORE);
      const [drafts, setDrafts] = React.useState({});
      const [failed, setFailed] = React.useState(false);
      const [invalid, setInvalid] = React.useState(false);

      if (view === 'summary') return t('summary');

      if (state.status === 'unavailable' || state.writable !== true) {
        return h('div', { style: STYLE.notice }, state.status === 'unavailable' ? t('unavailable') : t('readOnly'));
      }

      const clearDraft = (name) => setDrafts((current) => {
        if (current[name] === undefined) return current;
        const { [name]: _dropped, ...rest } = current;
        return rest;
      });
      const shown = (name, committed) => (drafts[name] !== undefined ? drafts[name] : String(committed));
      const edit = (name, text) => setDrafts((current) => ({ ...current, [name]: text }));
      const write = (name, value) => {
        setFailed(false);
        // The slot normally injects this; degrade to the error line rather than
        // throwing inside an event handler if it ever does not.
        if (typeof props.writeSetting !== 'function') {
          setFailed(true);
          return;
        }
        void Promise.resolve(props.writeSetting(name, value)).catch(() => setFailed(true));
      };
      const commit = (name, parse) => {
        const text = drafts[name];
        clearDraft(name);
        if (text === undefined || text.trim() === '') return;
        const value = parse(text);
        if (value === undefined) return;
        setInvalid(false);
        write(name, value);
      };
      /** Refuse a pattern the browser cannot play, so a typo never reaches the Host. */
      const commitPattern = (name) => () => commit(name, (text) => {
        if (parsePattern(text, null) === null) {
          setInvalid(true);
          return undefined;
        }
        return text;
      });
      const reset = (name) => {
        clearDraft(name);
        setInvalid(false);
        setFailed(false);
        if (typeof props.resetSetting !== 'function') {
          setFailed(true);
          return;
        }
        void Promise.resolve(props.resetSetting(name)).catch(() => setFailed(true));
      };

      return h('div', { style: STYLE.form }, [
        field({
          key: 'repeatCount',
          t,
          id: 'turn-notifier-repeat-count',
          label: t('repeatCount'),
          hint: t('repeatCountHint'),
          value: shown('repeatCount', state.repeatCount),
          step: 1,
          min: 1,
          max: 10,
          overridden: state.overridden.repeatCount,
          onEdit: (text) => edit('repeatCount', text),
          onCommit: () => commit('repeatCount', (text) => clampInteger(text, 1, 10, state.repeatCount)),
          onReset: () => reset('repeatCount'),
        }),
        field({
          key: 'intervalSeconds',
          t,
          id: 'turn-notifier-interval',
          label: t('intervalSeconds'),
          hint: t('intervalSecondsHint'),
          value: shown('intervalSeconds', state.intervalMs / 1000),
          unit: t('seconds'),
          step: 0.5,
          min: 1,
          max: 60,
          overridden: state.overridden.intervalMs,
          onEdit: (text) => edit('intervalSeconds', text),
          onCommit: () => commit('intervalSeconds', (text) => {
            const seconds = Number(text);
            if (!Number.isFinite(seconds)) return undefined;
            return clampInteger(seconds * 1000, 1000, 60000, state.intervalMs);
          }),
          onReset: () => reset('intervalMs'),
        }),
        field({
          key: 'volume',
          t,
          id: 'turn-notifier-volume',
          label: t('volume'),
          hint: t('volumeHint'),
          value: shown('volume', state.volume),
          step: 0.05,
          min: 0,
          max: 1,
          overridden: state.overridden.volume,
          onEdit: (text) => edit('volume', text),
          onCommit: () => commit('volume', (text) => {
            const number = Number(text);
            if (!Number.isFinite(number)) return undefined;
            return Math.min(1, Math.max(0, number));
          }),
          onReset: () => reset('volume'),
        }),
        field({
          key: 'waveform',
          t,
          id: 'turn-notifier-waveform',
          label: t('waveform'),
          hint: t('waveformHint'),
          kind: 'select',
          choices: WAVEFORMS.map((name) => ({ value: name, label: t(`waveform_${name}`) })),
          value: state.waveform,
          overridden: state.overridden.waveform,
          onPick: (value) => write('waveform', value),
          onReset: () => reset('waveform'),
        }),
        field({
          key: 'finishedPattern',
          t,
          id: 'turn-notifier-finished-pattern',
          label: t('finishedPattern'),
          hint: t('finishedPatternHint'),
          kind: 'text',
          value: shown('finishedPattern', state.finishedPattern),
          overridden: state.overridden.finishedPattern,
          onEdit: (text) => edit('finishedPattern', text),
          onCommit: commitPattern('finishedPattern'),
          onReset: () => reset('finishedPattern'),
        }),
        field({
          key: 'interactionPattern',
          t,
          id: 'turn-notifier-interaction-pattern',
          label: t('interactionPattern'),
          hint: t('interactionPatternHint'),
          kind: 'text',
          value: shown('interactionPattern', state.interactionPattern),
          overridden: state.overridden.interactionPattern,
          onEdit: (text) => edit('interactionPattern', text),
          onCommit: commitPattern('interactionPattern'),
          onReset: () => reset('interactionPattern'),
        }),
        invalid ? h('div', { key: 'invalid', style: STYLE.error }, t('invalidPattern')) : null,
        failed ? h('div', { key: 'error', style: STYLE.error }, t('saveFailed')) : null,
      ]);
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'turn-notifier: dictionaries');

        const form = ctx.configForms.get(ENTRY_ID);
        const store = createSettingsStore(form);
        ctx.effect(() => () => store.dispose(), 'turn-notifier: settings subscription');

        const audio = createAudio();

        // Unlock the audio context on the first user gesture, as autoplay policy requires.
        ctx.effect(() => {
          const unlock = () => audio.ensure();
          for (const type of UNLOCK_EVENTS) window.addEventListener(type, unlock, { passive: true });
          return () => {
            for (const type of UNLOCK_EVENTS) window.removeEventListener(type, unlock);
          };
        }, 'turn-notifier: audio unlock');

        ctx.slots.inject(SLOT_NAME, () =>
          ctx.slots.register({ name: SLOT_NAME, id: ENTRY_ID, order: 90 }, createDockEntry(store, audio)),
        );

        // The chime behavior stays its own invisible entry: it needs the session
        // status hook only and must keep observing while the dialog is closed.
        ctx.slots.inject(SLOT_NAME, () =>
          ctx.slots.register({ name: SLOT_NAME, id: `${ENTRY_ID}-alert`, order: 91 }, createNotifier(audio, store)),
        );

        // The bundle's own configuration page, sharing this row's lifecycle:
        // off means nothing is mounted, on means everything comes back.
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: BUNDLE_NAME,
          locale: LOCALE_NS,
          inject: () => ({
            settingsStore: store,
            writeSetting: (name, value) => form.set(name, value),
            resetSetting: (name) => form.unset(name),
          }),
        }, TurnNotifierSettings)), 'turn-notifier: settings page');

      },
    };
  },
});