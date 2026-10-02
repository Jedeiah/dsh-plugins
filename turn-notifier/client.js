/**
 * Client half of the Turn Notifier bundle.
 *
 * One contribution: an invisible entry in `conversation.composer.dock` that
 * rings when the viewed session finished a turn or is waiting for the user. No
 * UI, no text — everything the user sees or edits lives elsewhere.
 *
 * The settings page is NOT here: it used to be, mounted on this same row, and
 * that is exactly why it disappeared. A browser half is mounted on the row whose
 * specifier is exactly this package name, so switching this row off takes the
 * half down and switching it back on does not mount it again (known dsh issue
 * deepseek-harness#8452: the module table reports the bundle as already loaded,
 * so `apply` never re-runs) — the page died with the row and never came back.
 * It now lives in the paired bundle `@jedeiah/turn-notifier-settings`, which is
 * not meant to be switched off and registers the page against *this* row. This
 * half only has to keep ringing, so it stays as thin as possible.
 *
 * Tunables come from the Host row's `Config` (see ../index.js) through
 * `ctx.configForms`. They are read in the browser, so changing them takes effect
 * without reloading the module. Status signals come from the slot's
 * `useSessionStatus` standard prop, whose entries are
 * `{ running, pendingInteraction, completionUnread }`.
 */

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

window.__ModuleLoader__.load({
  id: BUNDLE_NAME,
  factory(require) {
    const React = require('react');
    const h = React.createElement;

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

    /**
     * Append one lifecycle marker to a browser-local trace.
     *
     * Whether this half re-ran after its row was switched back on is invisible
     * from outside the app: the chime either comes back or it does not, and
     * nothing says which half failed to re-apply. This trace answers it from
     * disk: browser localStorage lives in the app's LevelDB, so the operator
     * never has to open DevTools. The host half writes a matching trace to
     * `~/.dsh/turn-notifier-trace.log`, and the two together place the failure
     * on the Host or the browser side.
     *
     * It is temporary diagnostics: remove once the row-toggle behavior is settled.
     *
     * @param event - short marker name.
     * @param extra - optional extra fields.
     */
    function trace(event, extra) {
      try {
        const key = 'dsh.turn-notifier.trace';
        const previous = window.localStorage.getItem(key);
        const entries = previous === null ? [] : JSON.parse(previous);
        entries.push({ at: new Date().toISOString(), event, ...extra });
        window.localStorage.setItem(key, JSON.stringify(entries.slice(-40)));
      } catch {
        /* diagnostics must never break the plugin */
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // `configForms` is optional: a composition without the settings UI must
        // still get the chime (with schema defaults, read-only). It is also
        // deliberately NOT part of this plugin's `inject` face — a plugin whose
        // activation waits on a service that is being rebuilt during a row toggle
        // can end up never activating, which is how this half went missing after
        // 停用→启用 while the same-shaped session-purge survived.
        const forms = ctx.get('configForms');
        const form = forms?.get?.(ENTRY_ID);
        const store = form === undefined ? FALLBACK_STORE : createSettingsStore(form);
        if (form !== undefined) ctx.effect(() => () => store.dispose(), 'turn-notifier: settings subscription');

        const audio = createAudio();
        trace('client/apply', { entryId: ENTRY_ID });
        ctx.effect(() => () => trace('client/dispose'), 'turn-notifier: trace dispose');

        // Unlock the audio context on the first user gesture, as autoplay policy requires.
        ctx.effect(() => {
          const unlock = () => audio.ensure();
          for (const type of UNLOCK_EVENTS) window.addEventListener(type, unlock, { passive: true });
          return () => {
            for (const type of UNLOCK_EVENTS) window.removeEventListener(type, unlock);
          };
        }, 'turn-notifier: audio unlock');

        // The one contribution, an invisible entry: it needs the session status
        // hook only, and must keep observing whether or not a settings surface is
        // open. The settings page is not here — `@jedeiah/turn-notifier-settings`
        // owns it and registers it against this row, so that switching this row
        // off and on cannot take the page with it.
        ctx.slots.inject(SLOT_NAME, () =>
          ctx.slots.register({ name: SLOT_NAME, id: `${ENTRY_ID}-alert`, order: 91 }, createNotifier(audio, store)),
        );
      },
    };
  },
});