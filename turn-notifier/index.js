import z from '@deepseek-ai/schemastery';

/**
 * Host half of the turn-notifier bundle.
 *
 * It owns the plugin's tunables so they can be set in `cordis.patch.yml` or on
 * the bundle's page, instead of being edited in the Client source. Only
 * `.volatile()` fields are projected to the browser; the settings service turns
 * them into the form the Client half reads through `ctx.configForms`.
 *
 * `import z from '@deepseek-ai/schemastery'` is the documented way to describe a
 * Config. Because this bundle is linked in from outside the dsh installation,
 * the package must also be named in `peerDependencies` so the resolver routes
 * the bare specifier to the installation's copy.
 */
export const Config = z.object({
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

/**
 * The bundle ships its own configuration page on the Plugins page, so the
 * settings service must not advertise an auto-generated form for it.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
}