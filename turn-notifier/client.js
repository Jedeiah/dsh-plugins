/**
 * Client half of the Chime bundle.
 *
 * Two contributions live on the row whose specifier is this package name:
 *
 *  - An invisible entry in `shell.overlay` (id `turn-notifier-alert`) that
 *    rings when any session in this window finished a turn or is waiting for
 *    the user — not only the one on screen. The slot is a root-scoped list the
 *    app frame always renders, so the entry outlives session switches and pages
 *    that show no conversation at all.
 *  - The row's settings page in `plugins.row.config`, registered inside a gate
 *    that depends on this bundle's own Host service (`remote.turnNotifier`).
 *    The gate is what makes the page survive an off→on toggle of this row: dsh
 *    does not always re-run a client half's `apply` (deepseek-harness#8452), but
 *    `ctx.inject` does re-run its callback once the dependency reappears.
 *
 * Tunables come from the Host row's `Config` (see ../index.js) through
 * `ctx.configForms`. They are read in the browser, so changing them takes effect
 * without reloading the module. Status signals come from the root
 * `useSessionStatus` standard prop: one map from every session id this window
 * knows to `{ running, pendingInteraction, completionUnread }`. The root
 * `useSessions` prop tells subagent runs apart, whose finished turns stay silent.
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

/**
 * Slot this plugin's notification entry occupies.
 *
 * Not `conversation.composer.dock`, where it used to live: that slot has
 * `session` scope and is rendered only inside the composer of the conversation
 * on screen, so the entry saw one session, remounted on every switch and did
 * not exist on pages without a conversation. `shell.overlay` is declared by the
 * app frame with `root` scope and rendered unconditionally.
 */
const SLOT_NAME = 'shell.overlay';

/** Fallbacks, mirroring the Host schema defaults. */
const DEFAULTS = Object.freeze({
  muted: false,
  notifyOnTurnEnd: true,
  notifyOnWaiting: true,
  repeatCount: 3,
  intervalMs: 5000,
  volume: 1,
  waveform: 'sine',
  voice: 'classic',
  finishedPattern: '880:170, 1318.5:300',
  interactionPattern: '1046.5:140, 1318.5:140, 1046.5:200',
});

/** Oscillator waveforms the Host schema accepts. */
const WAVEFORMS = Object.freeze(['sine', 'square', 'triangle']);

/**
 * Voices: how one note sounds.
 *
 * `classic` is the original single oscillator in the chosen waveform, cut off at
 * the end of its note. Every other voice is additive: partials at a ratio of the
 * note's frequency, each with its own level and decay (seconds until it is
 * inaudible), so a note keeps ringing after the next one starts, the way a struck
 * bar or bell does. That ring-out, the inharmonic partials of bars and bells, and
 * a short room tail (`reverb`, the send level) are what make these sound like
 * instruments rather than beeps. `fm` adds a decaying frequency modulation to the
 * first partial — the bright attack of an electric-piano tine.
 *
 * Partial ratios follow the instruments' measured modes: a marimba bar's second
 * mode sits near 3.93×, a kalimba tine's near 6.3×, a tubular bell has its hum an
 * octave below the strike tone plus a minor third (1.19×) and a fifth (1.5×), a
 * singing bowl beats between two nearly equal modes.
 */
const VOICES = Object.freeze({
  classic: null,
  musicBox: Object.freeze({ attack: 0.002, reverb: 0.25, partials: [[1, 1, 1.4], [2, 0.18, 0.5], [5.4, 0.08, 0.12]] }),
  marimba: Object.freeze({ attack: 0.003, reverb: 0.2, partials: [[1, 1, 0.55], [3.93, 0.3, 0.14], [9.2, 0.08, 0.05]] }),
  kalimba: Object.freeze({ attack: 0.002, reverb: 0.22, partials: [[1, 1, 1.1], [2, 0.08, 0.35], [6.27, 0.16, 0.07]] }),
  electricPiano: Object.freeze({ attack: 0.004, reverb: 0.22, fm: Object.freeze({ ratio: 1, index: 2.2, decay: 0.35 }), partials: [[1, 1, 1.6], [14, 0.03, 0.08]] }),
  bell: Object.freeze({ attack: 0.002, reverb: 0.3, partials: [[0.5, 0.3, 3.2], [1, 1, 2.4], [1.19, 0.4, 1.8], [1.5, 0.32, 1.5], [2, 0.36, 1.3], [2.52, 0.2, 0.9], [3.01, 0.14, 0.7], [4.07, 0.08, 0.4]] }),
  bowl: Object.freeze({ attack: 0.03, reverb: 0.35, partials: [[1, 1, 4.5], [1.004, 0.7, 4.5], [2.71, 0.35, 2.8], [5.15, 0.12, 1.4]] }),
});

/** Voice names, in menu order; the Host schema accepts exactly these. */
const VOICE_KEYS = Object.freeze(Object.keys(VOICES));

/** Length of the generated room tail every non-classic voice sends into. */
const REVERB_SECONDS = 1.8;

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

/**
 * How urgent each reason is. One alert plays at a time; a more urgent trigger
 * takes over a quieter alert, anything else folds into the one playing.
 */
const URGENCY = Object.freeze({ finished: 1, interaction: 2 });

/**
 * Triggers this close to the previous ring are "the same moment" and add no
 * ring of their own. Sessions report separately, so two that settle together
 * arrive a few frames apart and would otherwise stack two chimes.
 */
const COALESCE_MS = 2000;

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
    // The shell's controls, so this page looks like the rest of the interface
    // instead of hand-rolled buttons. They are *not* a plugin API: dsh's own
    // authoring guide (`cordis-plugin-development/references/practices.md` in the
    // agent preset) tells plugins to vendor them, and the 0.2.1 release dropped
    // `projectUserText` from this package with no deprecation. Keeping the import
    // is still worth the styling match, but a removed export must never take the
    // whole surface down — hence the check below and the gate at the page.
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** Every primitive this half renders with; checked before the page registers. */
    const REQUIRED_PRIMITIVES = ['Button', 'IconChevronDownOutlineRegular', 'Menu', 'SegmentedControl', 'Switch'];
    /** Symbols the installed dsh no longer exports. Non-empty hides the page only. */
    const missingPrimitives = REQUIRED_PRIMITIVES.filter((name) => primitives?.[name] === undefined);
    if (missingPrimitives.length > 0) {
      console.error(`[turn-notifier] @deepseek-ai/dsh-client-ui-primitives no longer exports ${missingPrimitives.join(', ')}. `
        + 'The settings page stays hidden; the chime itself keeps working. See the repo README, "已知的 dsh 侧问题".');
    }

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
        voice: VOICE_KEYS.includes(value.voice) ? value.voice : DEFAULTS.voice,
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
          voice: user?.voice !== undefined,
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
      // The room tail: one convolver over a generated impulse (decaying stereo
      // noise), shared by every note. `undefined` = not built yet, `null` = this
      // context cannot do it, and the voices play dry.
      let reverb;

      function ensureReverb(audio) {
        if (reverb !== undefined) return reverb;
        reverb = null;
        try {
          if (typeof audio.createConvolver !== 'function' || typeof audio.createBuffer !== 'function') return reverb;
          const rate = audio.sampleRate || 48000;
          const length = Math.floor(rate * REVERB_SECONDS);
          const impulse = audio.createBuffer(2, length, rate);
          for (let channel = 0; channel < 2; channel += 1) {
            const data = impulse.getChannelData(channel);
            for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * Math.exp(-3.5 * (i / rate));
          }
          const convolver = audio.createConvolver();
          convolver.buffer = impulse;
          convolver.connect(limiter ?? audio.destination);
          reverb = convolver;
        } catch {
          reverb = null;
        }
        return reverb;
      }

      /**
       * Play one note in an additive voice. Partials above the audible band of
       * this context are skipped instead of aliasing.
       * @param audio - the context.
       * @param voice - a {@link VOICES} entry.
       * @param frequency - the note.
       * @param startsAt - context time of the strike.
       * @param volume - the configured volume.
       */
      function strike(audio, voice, frequency, startsAt, volume, sources) {
        const nyquist = (audio.sampleRate || 48000) * 0.45;
        const partials = voice.partials.filter(([ratio]) => frequency * ratio < nyquist);
        // Partials add up in power, not in amplitude: scale by the root of the sum
        // of squares so every voice peaks near the classic one at the same volume.
        const norm = Math.sqrt(partials.reduce((sum, [, level]) => sum + level * level, 0)) || 1;
        const bus = audio.createGain();
        bus.connect(limiter ?? audio.destination);
        const room = ensureReverb(audio);
        if (room !== null) {
          const send = audio.createGain();
          send.gain.setValueAtTime(voice.reverb, startsAt);
          bus.connect(send);
          send.connect(room);
        }
        let lastsUntil = startsAt;
        partials.forEach(([ratio, level, decay], index) => {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(frequency * ratio, startsAt);
          const peak = Math.max(0.0002, (volume * level) / norm);
          gain.gain.setValueAtTime(0, startsAt);
          gain.gain.linearRampToValueAtTime(peak, startsAt + voice.attack);
          gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + voice.attack + decay);
          oscillator.connect(gain);
          gain.connect(bus);
          const endsAt = startsAt + voice.attack + decay + 0.05;
          if (index === 0 && voice.fm !== undefined) {
            const modulator = audio.createOscillator();
            const depth = audio.createGain();
            modulator.type = 'sine';
            modulator.frequency.setValueAtTime(frequency * voice.fm.ratio, startsAt);
            depth.gain.setValueAtTime(frequency * voice.fm.index, startsAt);
            depth.gain.exponentialRampToValueAtTime(Math.max(0.01, frequency * 0.01), startsAt + voice.fm.decay);
            modulator.connect(depth);
            depth.connect(oscillator.frequency);
            modulator.start(startsAt);
            modulator.stop(endsAt);
            sources.push(modulator);
          }
          oscillator.start(startsAt);
          oscillator.stop(endsAt);
          sources.push(oscillator);
          lastsUntil = Math.max(lastsUntil, endsAt);
        });
        return lastsUntil;
      }

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

      /**
       * Play one chime.
       * @param reason - `finished` or `interaction`.
       * @param settings - the projected settings (tones, voice, waveform, volume).
       * @returns `{ durationMs, stop }`: how long the chime sounds, tail included,
       *   and a function that silences it now (the settings page cuts one preview
       *   off when the next starts).
       */
      function ring(reason, settings) {
        const silent = { durationMs: 0, stop: () => {} };
        const audio = ensure();
        if (audio === null) return silent;
        const sources = [];
        const stop = () => {
          for (const source of sources) {
            try {
              source.stop();
            } catch {
              /* already stopped */
            }
          }
        };
        const tones = settings.tones?.[reason] ?? PATTERNS[reason] ?? PATTERNS.finished;
        const volume = settings.volume;
        const waveform = WAVEFORMS.includes(settings.waveform) ? settings.waveform : DEFAULTS.waveform;
        const base = audio.currentTime + 0.01;
        const voice = VOICES[settings.voice] ?? null;
        if (voice !== null) {
          // The pattern's durations space the strikes; each strike rings for as
          // long as its voice does.
          let until = base;
          for (const tone of tones) until = Math.max(until, strike(audio, voice, tone.frequency, base + tone.offsetMs / 1000, volume, sources));
          return { durationMs: Math.round((until - base) * 1000), stop };
        }
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
          sources.push(oscillator);
        }
        const last = tones.at(-1);
        return { durationMs: last === undefined ? 0 : last.offsetMs + last.durationMs + 30, stop };
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

    /**
     * Ring once now, then repeat until the count is used up or the user returns.
     * @param alertRef - holder of the one alert that may play.
     * @param audio - the chime synthesizer.
     * @param settings - projected settings, captured for every ring of this alert.
     * @param reason - which chime plays: `finished` or `interaction`.
     * @param causes - ids of the sessions this alert rings for, all for `reason`;
     *   the alert stops once none of them still needs the user.
     */
    function startAlert(alertRef, audio, settings, reason, causes) {
      stopAlert(alertRef);
      const alert = {
        reason,
        causes,
        timers: [],
        /** Repeats still scheduled after the ring in progress. */
        pendingRings: settings.repeatCount - 1,
        /** Whether a ring sounded within the last {@link COALESCE_MS}. */
        recent: false,
        onActivity: () => stopAlert(alertRef),
      };
      const ring = () => {
        audio.ring(reason, settings);
        alert.recent = true;
        alert.timers.push(window.setTimeout(() => { alert.recent = false; }, COALESCE_MS));
      };
      ring();
      for (let index = 1; index < settings.repeatCount; index += 1) {
        alert.timers.push(window.setTimeout(() => {
          alert.pendingRings -= 1;
          ring();
        }, settings.intervalMs * index));
      }
      for (const type of ACTIVITY_EVENTS) window.addEventListener(type, alert.onActivity, { passive: true });
      alertRef.current = alert;
    }

    /**
     * Which sessions newly need the user between two status snapshots.
     *
     * Only a change seen on both sides counts: a session entering the map (first
     * paint, a new session, a reconnect baseline) has no "before", and one leaving
     * it (deleted, list refresh) did not finish a turn.
     * @param before - the previous status map; `undefined` on the first render.
     * @param after - the current status map.
     * @param isSubagent - whether a session id names a subagent run. Its finished
     *   turns are steps of its parent's turn and stay silent; its questions and
     *   approvals still need the user and still ring.
     * @param wanted - which reasons the settings let ring.
     * @returns session id → reason, the more urgent reason when one session has both.
     */
    function triggersBetween(before, after, isSubagent, wanted) {
      const triggers = new Map();
      if (before === undefined || before === after) return triggers;
      for (const [sessionId, status] of after) {
        const previous = before.get(sessionId);
        if (previous === undefined) continue;
        const waiting = wanted.interaction
          && status.pendingInteraction !== undefined && previous.pendingInteraction === undefined;
        const finished = wanted.finished
          && previous.running === true && status.running !== true && !isSubagent(sessionId);
        if (waiting) triggers.set(sessionId, 'interaction');
        else if (finished) triggers.set(sessionId, 'finished');
      }
      return triggers;
    }

    /**
     * Whether the reason one session was chimed for still holds.
     * @param status - that session's current status, or `undefined` once it left the map.
     * @param reason - why it was chimed for.
     * @returns false once a finished session runs again or a waiting one stops waiting.
     */
    function causeHolds(status, reason) {
      if (status === undefined) return false;
      return reason === 'interaction' ? status.pendingInteraction !== undefined : status.running !== true;
    }

    /** Stand-in status map for slots that expose no `useSessionStatus` prop. */
    const EMPTY_STATUS = new Map();

    /** Reported once, so a renamed standard prop is diagnosable instead of silent. */
    let statusHookReported = false;

    /**
     * Selector over an empty status map, used when the slot provides no hook.
     *
     * Without the hook this half can never learn that the agent started or
     * stopped waiting, so the bell simply never rings — the exact failure this
     * bundle exists to prevent, and one that looks like "the plugin is broken" or
     * "the volume is off". Say so once, in the console, with the reason.
     */
    function readEmptyStatus(selector) {
      if (!statusHookReported) {
        statusHookReported = true;
        console.error('[turn-notifier] the slot supplies no useSessionStatus prop, so the chime cannot fire. '
          + 'dsh likely renamed it; see the repo README, "已知的 dsh 侧问题".');
      }
      return selector(EMPTY_STATUS);
    }

    /** Stand-in session list for slots that expose no `useSessions` prop. */
    const EMPTY_SESSIONS = Object.freeze({ ids: Object.freeze([]), byId: Object.freeze({}) });

    /** Reported once, like the status hook above. */
    let sessionsHookReported = false;

    /**
     * Selector over an empty session list, used when the slot provides no hook.
     *
     * The list is only how subagent runs are told apart, so without it the chime
     * still works but every subagent's finished turn rings as well — a bell that
     * suddenly rings far too often. Say so once instead of leaving that unexplained.
     */
    function readNoSessions(selector) {
      if (!sessionsHookReported) {
        sessionsHookReported = true;
        console.error('[turn-notifier] the slot supplies no useSessions prop, so subagent runs cannot be told apart '
          + 'and their finished turns chime too. dsh likely renamed it; see the repo README, "已知的 dsh 侧问题".');
      }
      return selector(EMPTY_SESSIONS);
    }

    /** Select the whole status map: the chime watches every session, not one. */
    const selectStatusMap = (snapshot) => snapshot;

    /** Select the session rows by id; a row's `origin` marks a subagent run. */
    const selectSessionRows = (list) => list?.byId;

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

    /**
     * The invisible entry that owns the notification behavior.
     *
     * It watches the whole status map, so a session in the background — or every
     * session, while a page without a conversation is open — rings exactly like
     * the one on screen. One alert plays at a time: triggers that land while it
     * still has rings to play, or within {@link COALESCE_MS} of its last ring,
     * fold into it, unless they are more urgent ("waiting for you" over
     * "finished"), in which case the urgent chime takes over.
     * @param audio - the chime synthesizer.
     * @param store - the settings store.
     * @returns the slot component.
     */
    function createNotifier(audio, store) {
      return function TurnNotifier(props) {
        const { useSessionStatus, useSessions } = props;
        const settings = useStoreValue(store);
        // A slot may not supply a hook; fall back instead of throwing, which
        // would blank the whole slot entry ("slot entry crashed in ...").
        const useStatus = typeof useSessionStatus === 'function' ? useSessionStatus : readEmptyStatus;
        const useRows = typeof useSessions === 'function' ? useSessions : readNoSessions;
        const status = useStatus(selectStatusMap);
        const rows = useRows(selectSessionRows);

        const previous = React.useRef(undefined);
        const alertRef = React.useRef(null);

        React.useEffect(() => {
          const before = previous.current;
          previous.current = status;

          if (settings.muted === true) {
            stopAlert(alertRef);
            return;
          }

          // The reason to chime is gone for a session — a new turn started, or
          // the pending interaction was answered — so it no longer holds the
          // alert; once no session does, the remaining repeats stop at once.
          const playing = alertRef.current;
          if (playing !== null) {
            for (const sessionId of playing.causes) {
              if (!causeHolds(status.get(sessionId), playing.reason)) playing.causes.delete(sessionId);
            }
            if (playing.causes.size === 0) stopAlert(alertRef);
          }

          const triggers = triggersBetween(before, status, (sessionId) => rows?.[sessionId]?.origin === 'subagent', {
            interaction: settings.notifyOnWaiting !== false,
            finished: settings.notifyOnTurnEnd !== false,
          });
          if (triggers.size === 0) return;
          const reason = [...triggers.values()].includes('interaction') ? 'interaction' : 'finished';
          const sessions = [...triggers].filter(([, why]) => why === reason).map(([sessionId]) => sessionId);
          const current = alertRef.current;
          if (current !== null && URGENCY[reason] <= URGENCY[current.reason] && (current.pendingRings > 0 || current.recent)) {
            // The chime already playing covers these; only same-reason sessions
            // join it, since only they can keep that chime meaningful.
            if (reason === current.reason) for (const sessionId of sessions) current.causes.add(sessionId);
            return;
          }
          startAlert(alertRef, audio, settings, reason, new Set(sessions));
        }, [status, rows, settings]);

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
      voice: DEFAULTS.voice,
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
        voice: false,
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
  groupHow: 'Volume and repeats',
  groupTones: 'Chime',
  tone: 'Chime set',
  toneHint: 'Picking a set plays it right away; Preview plays both chimes in turn.',
  customHint: 'Voice, waveform and both melodies. Picking any set above replaces them.',
  waveformClassicOnly: 'Only the classic voice uses a waveform.',
  stopPreview: 'Stop',
  tone_musicBox: 'Music box',
  tone_marimba: 'Marimba',
  tone_kalimba: 'Kalimba',
  tone_electricPiano: 'Electric piano',
  tone_doorbell: 'Doorbell',
  tone_bowl: 'Singing bowl',
  tone_bright: 'Classic \u00b7 bright',
  tone_soft: 'Classic \u00b7 soft',
  tone_deep: 'Classic \u00b7 deep',
  tone_single: 'Classic \u00b7 single',
  voice: 'Voice',
  voiceHint: 'The instrument every note is played on. Instrument voices ring on and carry a short room tail.',
  voice_classic: 'Classic (electronic)',
  voice_musicBox: 'Music box',
  voice_marimba: 'Marimba',
  voice_kalimba: 'Kalimba',
  voice_electricPiano: 'Electric piano',
  voice_bell: 'Bell',
  voice_bowl: 'Singing bowl',
  tone_custom: 'Custom\u2026',
  turnEndLabel: 'A turn finishes',
  waitingLabel: 'The agent waits for you',
  muteLabel: 'Mute',
  muteHint: 'Silences every chime and leaves the other settings alone.',
  volume: 'Volume',
  volumeHint: '0 is silent, 2 is the top.',
  waveform: 'Waveform',
  waveformHint: 'Timbre of the classic voice.',
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
  resetDefault: 'Reset to default',
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
  groupHow: '音量与重复',
  groupTones: '铃声',
  tone: '提示音',
  toneHint: '换一套会立刻试听；「试听」把两段依次播一遍。',
  customHint: '音色、波形和两段旋律。在上面选任意一套会覆盖这里的设置。',
  waveformClassicOnly: '只有「经典」音色用到波形。',
  stopPreview: '停止',
  tone_musicBox: '音乐盒',
  tone_marimba: '马林巴',
  tone_kalimba: '拇指琴',
  tone_electricPiano: '电钢琴',
  tone_doorbell: '门铃',
  tone_bowl: '颂钵',
  tone_bright: '经典 · 清脆',
  tone_soft: '经典 · 柔和',
  tone_deep: '经典 · 沉稳',
  tone_single: '经典 · 单音',
  voice: '音色',
  voiceHint: '每个音用什么乐器来奏。乐器音色会自然延音，并带一点空间混响。',
  voice_classic: '经典（电子音）',
  voice_musicBox: '音乐盒',
  voice_marimba: '马林巴',
  voice_kalimba: '拇指琴',
  voice_electricPiano: '电钢琴',
  voice_bell: '钟',
  voice_bowl: '颂钵',
  tone_custom: '自定义…',
  turnEndLabel: '答完一轮',
  waitingLabel: '停下来等你操作',
  muteLabel: '静音',
  muteHint: '只让铃不响，其它设置不受影响。',
  volume: '音量',
  volumeHint: '0 是静音，2 是最大。',
  waveform: '波形',
  waveformHint: '经典音色用的波形。',
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
  resetDefault: '恢复默认',
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
      /** The custom panel: set off from the picker it belongs to, never floating. */
      panel: { display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 14px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 },
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
    /*
     * The instrument sets share one musical rule: "done" ends on the home note of
     * its chord, so it sounds settled; "waiting for you" ends on a note outside
     * it, so it sounds like a question. Every note is from a major pentatonic or
     * its triad, so nothing clashes while strikes ring into each other.
     */
    const TONE_SETS = Object.freeze([
      { key: 'musicBox', voice: 'musicBox', finished: '1046.5:120, 1318.5:120, 1568:120, 2093:420', interaction: '1568:130, 1318.5:130, 1568:130, 1760:420' },
      { key: 'marimba', voice: 'marimba', finished: '523.25:110, 659.25:110, 783.99:110, 1046.5:320', interaction: '1046.5:120, 880:120, 1046.5:120, 1174.66:320' },
      { key: 'kalimba', voice: 'kalimba', finished: '587.33:150, 739.99:150, 880:150, 1174.66:420', interaction: '880:140, 739.99:140, 880:140, 987.77:420' },
      { key: 'electricPiano', voice: 'electricPiano', finished: '523.25:90, 659.25:90, 783.99:90, 987.77:600', interaction: '783.99:150, 880:150, 1046.5:150, 1174.66:480' },
      { key: 'doorbell', voice: 'bell', finished: '783.99:480, 523.25:900', interaction: '659.25:320, 783.99:320, 880:900' },
      { key: 'bowl', voice: 'bowl', finished: '440:1600', interaction: '587.33:700, 587.33:1400' },
      { key: 'bright', voice: 'classic', finished: '880:170, 1318.5:300', interaction: '1046.5:140, 1318.5:140, 1046.5:200' },
      { key: 'soft', voice: 'classic', finished: '660:190, 880:320', interaction: '784:150, 988:150, 784:210' },
      { key: 'deep', voice: 'classic', finished: '523:200, 392:340', interaction: '587:160, 523:160, 587:220' },
      { key: 'single', voice: 'classic', finished: '880:220', interaction: '1046.5:220' },
    ]);

    /**
     * Which set the current pair of patterns amounts to.
     * @param settings - the projected settings.
     * @returns a `TONE_SETS` key, or `'custom'` when no set matches.
     */
    function toneSetOf(settings) {
      const voice = settings.voice ?? DEFAULTS.voice;
      // A classic set is played in a sine wave; the same melody in a square wave is
      // a different sound, so it is custom — otherwise the name would lie.
      const waveformOk = (set) => set.voice !== 'classic' || (settings.waveform ?? DEFAULTS.waveform) === 'sine';
      const found = TONE_SETS.find((set) => set.voice === voice && waveformOk(set) && set.finished === settings.finishedPattern && set.interaction === settings.interactionPattern);
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
      const { key, t, label, hint, value, disabled, invalid, playing, onEdit, onCommit, onPreview, isDefault, onReset } = props;
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
          h(primitives.Button, {
            key: 'reset',
            variant: 'outline',
            // Nothing to restore when the row already holds the default.
            disabled: disabled || isDefault,
            onClick: onReset,
          }, t('resetDefault')),
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
     * A labelled menu button: names the current choice, opens a checked list.
     * A real component, not a helper called during render: it keeps its own open
     * state, and the custom panel mounts and unmounts it — a hook in a plain
     * function call would shift the page's hook order when that happens.
     * @param props - label, current label, items, selected id, disabled, onSelect,
     *   an optional `trailing` element beside the button, and an optional hint.
     * @returns the field element.
     */
    function ChoiceMenu(props) {
      const { label, current, items, selectedId, disabled, onSelect, trailing, hint } = props;
      const [open, setOpen] = React.useState(false);
      return h('div', { style: LAYOUT.field }, [
        h('label', { key: 'label', style: LAYOUT.label }, label),
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
            }, [current, h(primitives.IconChevronDownOutlineRegular, { key: 'chevron' })])),
            onClose: () => setOpen(false),
            items,
            selectedId,
            selection: 'check',
            onSelect: (id) => {
              setOpen(false);
              onSelect(id);
            },
          }),
          trailing ?? null,
        ]),
        hint === undefined ? null : h('span', { key: 'hint', style: LAYOUT.hint }, hint),
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
      const [customOpen, setCustomOpen] = React.useState(false);

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
      // One preview at a time: a new one silences the last, and "playing" lasts
      // exactly as long as the sound (instrument voices ring for seconds).
      const preview = React.useRef(null);
      const stopPreview = () => {
        const current = preview.current;
        preview.current = null;
        if (current === null) return;
        current.stop();
        for (const timer of current.timers) window.clearTimeout(timer);
      };
      React.useEffect(() => () => stopPreview(), []);
      /**
       * Preview one or both chimes with the page's current values, or with values
       * a control is about to write (`overrides`): the snapshot still carries the
       * old ones until the Host writes back.
       * @param reasons - `['finished']`, `['interaction']` or both, played in order.
       * @param overrides - settings to preview instead of the stored ones.
       */
      const play = (reasons, overrides = {}) => {
        stopPreview();
        const merged = { ...settings, ...overrides };
        const texts = {
          finished: overrides.finishedPattern ?? finished,
          interaction: overrides.interactionPattern ?? interaction,
        };
        const stops = [];
        const timers = [];
        const current = { stop: () => { for (const halt of stops) halt(); }, timers };
        preview.current = current;
        let at = 0;
        reasons.forEach((reason, index) => {
          const tones = parsePattern(texts[reason], PATTERNS[reason]);
          const sound = { ...merged, tones: { ...merged.tones, [reason]: tones } };
          const start = () => {
            if (preview.current !== current) return;
            const played = audio.ring(reason, sound);
            stops.push(played.stop);
            return played.durationMs;
          };
          if (index === 0) {
            at = start() ?? 0;
          } else {
            const gap = at + 250;
            timers.push(window.setTimeout(() => {
              const length = start() ?? 0;
              timers.push(window.setTimeout(() => {
                if (preview.current === current) {
                  preview.current = null;
                  setPlaying(null);
                }
              }, length));
            }, gap));
          }
        });
        setPlaying(reasons.length > 1 ? 'both' : reasons[0]);
        if (reasons.length === 1) {
          timers.push(window.setTimeout(() => {
            if (preview.current === current) {
              preview.current = null;
              setPlaying(null);
            }
          }, at));
        }
      };
      const disabled = settings.writable !== true;
      const finished = draftOf('finishedPattern', settings.finishedPattern);
      const interaction = draftOf('interactionPattern', settings.interactionPattern);
      const finishedOk = parsePattern(finished, null) !== null;
      const interactionOk = parsePattern(interaction, null) !== null;
      const toneSet = toneSetOf(settings);
      // "Custom" is shown when the person asked for it or when the stored sound
      // matches no set; the panel is where voice, waveform and melodies live.
      const custom = customOpen || toneSet === 'custom';
      const pickToneSet = (key) => {
        const set = TONE_SETS.find((candidate) => candidate.key === key);
        if (set === undefined) {
          setCustomOpen(true);
          return;
        }
        setCustomOpen(false);
        // One batch: a set is a single choice, and separate writes in one tick
        // would race each other's revision. A classic set also fixes its waveform,
        // so the set's name always means one sound.
        const fields = { voice: set.voice, finishedPattern: set.finished, interactionPattern: set.interaction };
        if (set.voice === 'classic') fields.waveform = 'sine';
        store.writeAll(fields);
        drop('finishedPattern');
        drop('interactionPattern');
        play(['finished'], fields);
      };
      // The slider previews and writes once, when it is let go: writing on every
      // step of a drag would rewrite the profile dozens of times.
      const volume = draftOf('volume', settings.volume);
      const commitVolume = () => {
        const next = drafts.volume;
        if (next === undefined) return;
        drop('volume');
        if (next === settings.volume) return;
        write('volume', next);
        play(['finished'], { volume: next });
      };
      const isClassic = settings.voice === 'classic';
      /**
       * Put one melody back to the factory default: drop any draft (even an
       * invalid one), write the default, and let it be heard.
       */
      const resetPattern = (field, reason) => {
        drop(field);
        if (settings[field] !== DEFAULTS[field]) write(field, DEFAULTS[field]);
        play([reason], { [field]: DEFAULTS[field] });
      };

      return h('div', { style: LAYOUT.page }, [
        section('when', t('groupWhen'), [
          switchRow('turnEnd', t('turnEndLabel'), settings.notifyOnTurnEnd, disabled, (next) => write('notifyOnTurnEnd', next)),
          switchRow('waiting', t('waitingLabel'), settings.notifyOnWaiting, disabled, (next) => write('notifyOnWaiting', next)),
          switchRow('mute', t('muteLabel'), settings.muted, disabled, (next) => write('muted', next), t('muteHint')),
        ]),
        section('tones', t('groupTones'), [
          h(ChoiceMenu, {
            key: 'picker',
            label: t('tone'),
            current: custom ? t('tone_custom') : t(`tone_${toneSet}`),
            items: TONE_SETS.map((set) => ({ id: set.key, label: t(`tone_${set.key}`) })).concat([{ id: 'custom', label: t('tone_custom') }]),
            selectedId: custom ? 'custom' : toneSet,
            disabled,
            onSelect: pickToneSet,
            hint: t('toneHint'),
            trailing: h(primitives.Button, {
              key: 'preview',
              variant: 'outline',
              disabled: disabled || !finishedOk || !interactionOk,
              onClick: () => (playing === 'both' ? (stopPreview(), setPlaying(null)) : play(['finished', 'interaction'])),
            }, playing === 'both' ? t('stopPreview') : t('preview')),
          }),
          custom ? h('div', { key: 'custom', style: LAYOUT.panel }, [
            h('span', { key: 'intro', style: LAYOUT.hint }, t('customHint')),
            h('div', { key: 'sound', style: LAYOUT.grid }, [
              h(ChoiceMenu, {
                key: 'voice',
                label: t('voice'),
                current: t(`voice_${settings.voice}`),
                items: VOICE_KEYS.map((name) => ({ id: name, label: t(`voice_${name}`) })),
                selectedId: settings.voice,
                disabled,
                onSelect: (next) => {
                  write('voice', next);
                  play(['finished'], { voice: next });
                },
                hint: t('voiceHint'),
              }),
              h('div', { key: 'waveform', style: LAYOUT.field }, [
                h('label', { key: 'label', style: LAYOUT.label }, t('waveform')),
                h(primitives.SegmentedControl, {
                  key: 'control',
                  id: `${BUNDLE_NAME}-waveform`,
                  label: t('waveform'),
                  value: settings.waveform,
                  // Kept in place for every voice so the panel never jumps; only the
                  // classic voice is played with it.
                  disabled: disabled || !isClassic,
                  options: WAVEFORMS.map((name) => ({ value: name, label: t(`waveform_${name}`) })),
                  onChange: (next) => {
                    write('waveform', next);
                    play(['finished'], { waveform: next });
                  },
                }),
                h('span', { key: 'hint', style: LAYOUT.hint }, isClassic ? t('waveformHint') : t('waveformClassicOnly')),
              ]),
            ]),
            // Stacked, not side by side: each row is an input plus two buttons, and
            // a melody is a long line of numbers that needs the width.
            h('div', { key: 'melodies', style: LAYOUT.section }, [
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
                onPreview: () => play(['finished']),
                isDefault: finished === DEFAULTS.finishedPattern,
                onReset: () => resetPattern('finishedPattern', 'finished'),
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
                onPreview: () => play(['interaction']),
                isDefault: interaction === DEFAULTS.interactionPattern,
                onReset: () => resetPattern('interactionPattern', 'interaction'),
              }),
            ]),
          ]) : null,
        ]),
        section('how', t('groupHow'), [
          // Capped like the other fields: a slider across the whole page puts the
          // value a screen away from its label.
          h('div', { key: 'volume', style: { ...LAYOUT.field, maxWidth: 520 } }, [
            h('div', { key: 'head', style: LAYOUT.row }, [
              h('label', { key: 'label', style: { ...LAYOUT.label, flex: 1 } }, t('volume')),
              h('span', { key: 'value', style: LAYOUT.value }, Number(volume).toFixed(2)),
            ]),
            h('input', {
              key: 'slider',
              type: 'range',
              min: 0,
              max: 2,
              step: 0.05,
              value: volume,
              disabled,
              onChange: (event) => edit('volume', Number(event.target.value)),
              onPointerUp: commitVolume,
              onKeyUp: commitVolume,
              onBlur: commitVolume,
              style: { width: '100%' },
            }),
            h('span', { key: 'hint', style: LAYOUT.hint }, t('volumeHint')),
          ]),
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

        // The ringing contribution, an invisible entry: it needs the root session
        // hooks only, and must keep observing every session whatever the main
        // panel shows and whether or not a settings surface is open. The
        // settings page registers on this same row from the gate below.
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
          // A missing primitive would throw inside render, and a throwing slot
          // entry blanks the whole slot. Skipping the page keeps the row usable.
          if (childForms?.whileServed !== undefined && missingPrimitives.length === 0) {
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
