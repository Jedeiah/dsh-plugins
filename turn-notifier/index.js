import z from '@deepseek-ai/schemastery';

/*
 * Imported through `import()` rather than a static import: measured on dsh
 * 0.2.0-rc.2, a static import of a dsh package inside a profile-linked bundle can
 * fail to resolve, and the loader then reports only "failed to import".
 */
let TypertRemoteService;
try {
  ({ TypertRemoteService } = await import('@deepseek-ai/dsh-typert-protocol'));
} catch (error) {
  throw new Error('turn-notifier: could not import @deepseek-ai/dsh-typert-protocol', { cause: error });
}

/** Plugin name used by loader diagnostics. */
export const name = 'turn-notifier';

/**
 * Host half of the turn-notifier bundle.
 *
 * It owns the plugin's tunables so they can be set in `cordis.patch.yml` or on
 * the bundle's page, instead of being edited in the Client source. Only
 * `.volatile()` fields are projected to the browser; the settings service turns
 * them into the form the Client half reads through `ctx.configForms`.
 *
 * It also publishes the `turnNotifier` Remote service (see
 * {@link TurnNotifierRuntime}), which is what makes this bundle survive a
 * row switch: the Client half gates its settings entry on that service, so the
 * entry re-attaches by itself when the Host half is rebuilt. A Client half's own
 * `apply` is not re-run after 停用→启用 (deepseek-harness#8452), so a gate is the
 * only shape that works.
 *
 * `import z from '@deepseek-ai/schemastery'` is the documented way to describe a
 * Config. Because this bundle is linked in from outside the dsh installation,
 * the package must also be named in `peerDependencies` so the resolver routes
 * the bare specifier to the installation's copy.
 */
export const Config = z.object({
  /** Silence every chime without touching the profile row. */
  muted: z.boolean().default(false).volatile(),
  /** Ring when a turn finishes. */
  notifyOnTurnEnd: z.boolean().default(true).volatile(),
  /** Ring when the agent stops to wait for the operator (approval or question). */
  notifyOnWaiting: z.boolean().default(true).volatile(),
  /** How many times one alert rings, including the first. */
  repeatCount: z.number().step(1).min(1).max(10).default(3).volatile(),
  /** Milliseconds between the first ring and each repeat. */
  intervalMs: z.number().step(100).min(1000).max(60000).default(5000).volatile(),
  /** Chime volume, 0..1. */
  volume: z.number().min(0).max(1).default(0.35).volatile(),
  /** Oscillator waveform for every tone. */
  waveform: z.union(['sine', 'square', 'triangle']).default('sine').volatile(),
  /** Tones of the "turn finished" chime, as `frequencyHz:durationMs` pairs played in order. */
  finishedPattern: z.string().default('880:170, 1318.5:300').volatile(),
  /** Tones of the "waiting for you" chime, same notation. */
  interactionPattern: z.string().default('1046.5:140, 1318.5:140, 1046.5:200').volatile(),
});

/** Defaults mirroring the schema above, used when a field cannot be read. */
const CONFIG_DEFAULTS = Object.freeze({
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

/** Prototype key the Typert Remote markers live under. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * Mark Remote methods the way the TypeScript decorator transpiles to: one
 * versioned descriptor on the class prototype. Writing it here keeps this bundle
 * decorator-free and buildless while the Gateway still resolves the endpoint
 * through `remoteMethods()`.
 * @param prototype - the service class prototype.
 * @param methods - exported method names.
 */
function markRemoteMethods(prototype, methods) {
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map((method) => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  });
}

/**
 * Read one configured value.
 *
 * A field marked `.volatile()` arrives as a live reference — a frozen handle
 * with `get()` whose value the settings service rewrites without remounting the
 * row — so reading `config.flag` directly would yield the handle object (always
 * truthy) instead of the configured value. Plain fields pass through unchanged.
 * @param value - the configured value or volatile reference.
 * @param fallback - used when the field is absent or unreadable.
 * @returns the current plain value.
 */
function readConfigValue(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value?.get === 'function') {
    try {
      const current = value.get();
      return current === undefined ? fallback : current;
    } catch {
      return fallback;
    }
  }
  return value;
}

/** Defaults merged under a `null` protection so `introspect` never returns holes. */
function snapshotConfig(config) {
  const out = {};
  for (const [field, fallback] of Object.entries(CONFIG_DEFAULTS)) {
    out[field] = readConfigValue(config?.[field], fallback);
  }
  return out;
}

/**
 * The Remote service: the Host's authoritative view of this row's configuration.
 *
 * The Client half reads it when `configForms` is unavailable — a composition
 * without the settings UI — so the chime plays the values the Host actually
 * holds instead of a hard-coded snapshot. It doubles as the reactive dependency
 * the Client half's `ctx.inject` gate waits on.
 */
class TurnNotifierRuntime extends TypertRemoteService {
  /**
   * @param ctx - owning Cordis context.
   * @param config - the row configuration as Cordis delivers it (volatile fields
   *   are live references; see {@link readConfigValue}).
   */
  constructor(ctx, config) {
    super(ctx, 'turnNotifier');
    this.config = config ?? {};
  }

  /**
   * @returns this row's live configuration with schema defaults applied.
   */
  introspect() {
    return snapshotConfig(this.config);
  }

}


markRemoteMethods(TurnNotifierRuntime.prototype, ['introspect']);

/**
 * Mount the bundle for one profile row.
 * @param ctx - Host plugin context.
 * @param config - the row configuration.
 */
export function apply(ctx, config) {
  // NOTE: no `settings.configure({ auto: false })` here. It would remove this row
  // from `configForms`' namespace list, and the Plugins page hands a row's page
  // its form only when that list contains the row id (`configForm(rowId)`); with
  // `auto: false` the page receives `undefined` and renders nothing. The custom
  // page below is registered on `plugins.row.config`, which is a different slot
  // from the bundle-level auto form, so leaving the schema advertised costs
  // nothing.
  new TurnNotifierRuntime(ctx, config);
}

export { TurnNotifierRuntime };
