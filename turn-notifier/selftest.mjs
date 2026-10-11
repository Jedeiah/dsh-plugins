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
 * Nothing outside a temporary directory is written, and nothing in the bundle is
 * touched.
 *
 * @module @jedeiah/turn-notifier/selftest
 */

import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const app = appDirectory();
if (!existsSync(app)) {
  console.log(`\nskip — no dsh installation at ${app} (pass --app <path>)`);
  process.exit(0);
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
  check('finishedPattern keeps its documented default',
    plain(value.finishedPattern) === '880:170, 1318.5:300', String(plain(value.finishedPattern)));
  check('interactionPattern keeps its documented default',
    plain(value.interactionPattern) === '1046.5:140, 1318.5:140, 1046.5:200',
    String(plain(value.interactionPattern)));

  const volatileFields = ['muted', 'notifyOnTurnEnd', 'notifyOnWaiting', 'repeatCount',
    'intervalMs', 'volume', 'waveform', 'finishedPattern', 'interactionPattern'];
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
