/**
 * Client half of the Turn Notifier Settings bundle.
 *
 * One contribution: the notifier's settings page in `plugins.row.config`, the
 * keyed slot the Plugins page looks a row's page up in. The key is
 * `<package>#<row id>`, so the page below registers as
 * `@jedeiah/turn-notifier#turn-notifier` and the `›` appears on the notifier's
 * row — not on this bundle's row.
 *
 * Why the page is not part of the notifier bundle: a browser half is mounted on
 * the row whose specifier is exactly its package name, so the page used to live
 * and die with the notifier's row. Switching such a row off tears the half down
 * and switching it back on does not mount it again (known dsh issue
 * deepseek-harness#8452: the module table reports the bundle as already loaded,
 * so `apply` never re-runs), and the row's `›` disappeared with it. This
 * bundle's own row is a no-op and is not meant to be switched off, which is what
 * makes the page survive the notifier's switch.
 *
 * Tunables come from the notifier's Host row `Config` (../turn-notifier/index.js)
 * through the global `configForms` service, which the Plugins page hands to this
 * page as `{ state, mutate }`. Nothing is imported from the other bundle, and
 * `@deepseek-ai/dsh-client-ui-conversation` is not injected here: this half only
 * draws the page and never observes session status.
 */

/** The bundle whose settings this page edits. */
const NOTIFIER_BUNDLE = '@jedeiah/turn-notifier';
/** The notifier's profile row id; also the Host settings namespace this page edits. */
const NOTIFIER_ROW_ID = 'turn-notifier';
/** This bundle's package name: the browser module id. */
const BUNDLE_NAME = '@jedeiah/turn-notifier-settings';
/** Dictionary namespace owned by this plugin. */
const LOCALE_NS = 'plugin.turnNotifierSettings';

/** The keyed slot the Plugins page reads a row's own page from. */
const SLOT_NAME = 'plugins.row.config';

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
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'The notifier row is switched off, so there is nothing to configure right now.',
  saveFailed: 'The deployment did not accept that value; it was left for you to correct.',
  saving: 'Loading settings…',
  pageIntro: 'Three groups, volume, chimes and repeat count. Changes apply immediately. To go quiet use Mute — do not switch the plugin row off.',
  groupWhen: 'When it rings',
  groupHow: 'How it rings',
  groupRepeat: 'Repeats and stopping',
  muteLabel: 'Mute',
  muteHint: 'Use this switch to go quiet. Do not switch the plugin row off instead: after off→on the browser half is not remounted (known dsh issue deepseek-harness#8452), so this page stays away until the page is reloaded.',
  turnEndLabel: 'A turn finishes',
  waitingLabel: 'It stops to wait for you (approval or question)',
  preview: 'Preview',
  stopHint: 'Any pointer or key activity stops the repeats immediately.',
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
  readOnly: '本部署的设置为只读。',
  unavailable: '回合提醒那一行处于停用状态，现在没有可配置的内容。',
  saveFailed: '本部署没有接受这个值，已保留供你修改。',
  saving: '正在读取设置…',
  pageIntro: '三组开关、音量、音调与重复次数，改完立即生效。临时安静请用「静音」，不要停用插件行。',
  groupWhen: '什么时候响',
  groupHow: '怎么响',
  groupRepeat: '重复与停止',
  muteLabel: '静音',
  muteHint: '临时安静用这个开关。不要用停用插件行来代替——停用再启用后浏览器半边不会重新挂载（dsh 的已知问题 deepseek-harness#8452），设置页会一直缺席到重载界面为止。',
  turnEndLabel: '智能体答完一轮',
  waitingLabel: '停下来等你操作（审批 / 提问）',
  preview: '试听',
  stopHint: '鼠标或键盘一动，正在重复的提醒立即停止。',
};

/** Token-only styling, so light and dark follow the host theme automatically. */
const STYLE = Object.freeze({
  /** Inline notice/error lines shared by the settings surfaces. */
  notice: { opacity: 0.7, fontSize: 12, lineHeight: 1.6 },
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: 1.5 },
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
    });


    /** The row page's current owner form; see {@link TurnNotifierRowConfig}. */
    const rowBridge = { current: undefined };

    /** Stable store identity for the row page, delegating to {@link rowBridge}. */
    const ROW_STORE = Object.freeze({
      getSnapshot: () => project(rowBridge.current?.state),
      subscribe: () => () => undefined,
      write: (field, value) => Promise.resolve(rowBridge.current?.mutate([{ op: 'set', path: [field], value }], rowBridge.current.state.revision)).then((accepted) => accepted !== false),
      reset: (field) => Promise.resolve(rowBridge.current?.mutate([{ op: 'unset', path: [field] }], rowBridge.current.state.revision)).then((accepted) => accepted !== false),
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
     * The settings body: three groups, rendered by the notifier's row page. Every
     * value comes from the one form the owner hands that page — the notifier's
     * own `ctx.configForms.get('turn-notifier')` — so the values the chime reads
     * and the values this page shows can never disagree.
     */
    function TurnNotifierGroups(props) {
      const { t, store, snapshot, audio } = props;
      // Hooks must run unconditionally: subscribe to the live store when one is
      // given, otherwise to a frozen stand-in, and let an explicit snapshot win.
      const live = useStoreValue(store ?? FALLBACK_STORE);
      const settings = snapshot ?? live;
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
      const disabled = settings.writable !== true;

      return h(React.Fragment, null, [
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
          h('div', { key: 'repeatCountHint', style: { opacity: 0.66, fontSize: 12, margin: '-6px 0 10px' } }, t('repeatCountHint')),
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
          h('div', { key: 'intervalSecondsHint', style: { opacity: 0.66, fontSize: 12, margin: '-6px 0 10px' } }, t('intervalSecondsHint')),
          h('div', { key: 'stop', style: { opacity: 0.66, fontSize: 12, lineHeight: 1.5 } }, t('stopHint')),
        ]),
        failed ? h('div', { key: 'failed', role: 'alert', style: STYLE.error }, t('saveFailed')) : null,
      ]);
    }

    /**
     * The notifier row's configuration page on the Plugins page. The owner hands
     * the page its form as `{ state, mutate }`; the adapter below narrows that to
     * the store shape the body already consumes, so the page and the chime read
     * one form.
     */
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
      return h('div', { key: 'page' }, [
        form.state.writable === true ? null : h('div', { key: 'readonly', style: STYLE.notice }, t('readOnly')),
        h('p', { key: 'intro', style: { margin: '0 0 12px', opacity: 0.75, lineHeight: 1.6 } }, t('pageIntro')),
        h(TurnNotifierGroups, {
          key: 'groups',
          t,
          store: ROW_STORE,
          snapshot: project(form.state),
          audio,
        }),
      ]);
    }

    /** The notifier's settings page, mounted on the notifier's own row. */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'turn-notifier-settings: dictionaries');

        // `configForms` is read defensively instead of being part of this plugin's
        // `inject` face: a plugin whose activation waits on a service that is
        // being rebuilt during a row toggle can end up never activating, which is
        // exactly how the row page (`›`) disappeared after 停用→启用. The service
        // is only consulted to skip the registration in a composition that has no
        // settings UI at all; whether the notifier's own namespace is currently
        // served is deliberately NOT part of the decision, because that namespace
        // comes and goes with the notifier's row — the owner then hands the page
        // no form, and the page degrades to nothing instead of the `›` vanishing.
        const forms = ctx.get('configForms');

        // Preview only: the click that asks for it is the user gesture the
        // autoplay policy wants, so there is no unlock listener to install here.
        const audio = createAudio();

        // session-purge 的形状：把注册项挂在"命名空间是否在服务中"这道反应式门上。
        // 停用 notifier 那一行时它的命名空间消失 → 条目随之撤掉（此时那一行本就关着，
        // 不需要 `›`）；重新启用时命名空间回来 → **门再次触发 → 条目自动重挂**。
        // 一次性 `register` 没有这条回路，条目一旦被包级卸载摘掉就再也回不来。
        if (forms?.whileServed === undefined) return;

        // The page belongs to the *notifier's* row, not to this bundle's own row:
        // `plugins.row.config` is keyed `<package>#<row id>`, and the notifier's
        // row id is also the Host settings namespace the page edits.
        ctx.effect(() => forms.whileServed([NOTIFIER_ROW_ID], () => ctx.slots.inject(SLOT_NAME, () => ctx.slots.register({
          name: SLOT_NAME,
          key: `${NOTIFIER_BUNDLE}#${NOTIFIER_ROW_ID}`,
          locale: LOCALE_NS,
          inject: () => ({ audio }),
        }, TurnNotifierRowConfig))), 'turn-notifier-settings: row configuration page');
      },
    };
  },
});
