/**
 * Browser Debugging — offline self-test.
 *
 *   node selftest.mjs [--app /path/to/app/dsh/node_modules/@deepseek-ai]
 *
 * The Host half imports `@deepseek-ai/dsh-typert-protocol`, which only resolves
 * inside a dsh installation. Instead of installing anything, this registers a
 * one-line resolver that anchors every `@deepseek-ai/*` specifier at the
 * installation's own package directory (`--app`, or the default location).
 *
 * Part A drives what the `skills` toggle is built from:
 *
 *  - `CONFIG_DEFAULTS` is read out of the schema, so it cannot drift away from
 *    the `Config` it claims to mirror (the reason `schemaDefaults` exists);
 *  - the schema's own default agrees with it;
 *  - `.volatile()` really does arrive as a live handle, which is why
 *    `readConfigValue` unwraps one instead of reading the field directly;
 *  - `syncLiveSkills` links on, empties-but-keeps-the-directory off, and is
 *    idempotent — driven against a temporary directory pair, never the bundle's
 *    real `skills-live/`.
 *
 * Part B validates the hand-written Host manifest with the installation's own
 * `validateTypertManifest`.
 *
 * Nothing outside a temporary directory is written, and nothing in the bundle is
 * touched.
 *
 * @module @jedeiah/chrome-devtools-mcp/selftest
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = '@jedeiah/chrome-devtools-mcp';
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

console.log("\nPart A — the toggle's building blocks");
{
  check('CONFIG_DEFAULTS was read from the schema, not hand-copied',
    Object.keys(host.CONFIG_DEFAULTS).sort().join(',') === 'browser,skills'
    && host.CONFIG_DEFAULTS.skills === false
    && host.CONFIG_DEFAULTS.browser === 'launch',
    JSON.stringify(host.CONFIG_DEFAULTS));

  const validated = host.Config['~standard'].validate({});
  check('the row configuration validates',
    validated.issues === undefined, JSON.stringify(validated.issues));
  check("the schema's own defaults agree with CONFIG_DEFAULTS",
    validated.issues === undefined
    && plain(validated.value.skills) === host.CONFIG_DEFAULTS.skills
    && plain(validated.value.browser) === host.CONFIG_DEFAULTS.browser,
    JSON.stringify([plain(validated.value.skills), plain(validated.value.browser)]));
  check('.volatile() arrives as a live handle (why readConfigValue exists)',
    typeof validated.value?.skills?.get === 'function'
    && typeof validated.value?.browser?.get === 'function');

  const root = mkdtempSync(join(tmpdir(), 'chrome-devtools-mcp-selftest-'));
  const liveDir = join(root, 'live');
  const sourceDir = join(root, 'source');
  try {
    mkdirSync(join(sourceDir, 'alpha'), { recursive: true });
    mkdirSync(join(sourceDir, 'beta'), { recursive: true });
    writeFileSync(join(sourceDir, 'alpha', 'SKILL.md'), '# alpha\n');

    check('off: reports no failures', host.syncLiveSkills(false, { liveDir, sourceDir }).length === 0);
    // The provider only watches roots that exist when it first looks, so the
    // directory has to be there even with nothing in it.
    check('off: the directory still exists', existsSync(liveDir));
    check('off: and holds nothing', readdirSync(liveDir).length === 0);

    check('on: reports no failures', host.syncLiveSkills(true, { liveDir, sourceDir }).length === 0);
    check('on: every source skill is exposed',
      readdirSync(liveDir).sort().join(',') === 'alpha,beta', readdirSync(liveDir).join(','));
    check('on: entries are symlinks, not copies',
      lstatSync(join(liveDir, 'alpha')).isSymbolicLink());

    check('repeating the same state changes nothing',
      host.syncLiveSkills(true, { liveDir, sourceDir }).length === 0
      && readdirSync(liveDir).sort().join(',') === 'alpha,beta');

    host.syncLiveSkills(false, { liveDir, sourceDir });
    check('off again: the directory remains, emptied',
      existsSync(liveDir) && readdirSync(liveDir).length === 0);

    host.syncLiveSkills(true, { liveDir, sourceDir });
    check('a missing source directory is not an error',
      host.syncLiveSkills(true, { liveDir, sourceDir: join(root, 'absent') }).length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('\nPart A2 — the browser switch rewrites the profile patch');
{
  const root = mkdtempSync(join(tmpdir(), 'chrome-devtools-mcp-browser-'));
  const patch = join(root, 'cordis.patch.yml');
  try {
    // Stand in for a user's patch file: their own entries and comment.
    writeFileSync(patch, [
      '# 用户自己的注释',
      '- insert:',
      '    - id: something-else',
      "      name: 'some-plugin'",
      '',
    ].join('\n'));

    check('first write appends the managed block', host.writeBrowserMode(patch, 'launch') === true);
    let text = readFileSync(patch, 'utf8');
    check("the user's own content survives",
      text.startsWith('# 用户自己的注释') && text.includes('some-plugin'));
    check('launch enables launch and disables attach',
      text.includes('- id: chrome-devtools-launch\n  disabled: false')
      && text.includes('- id: chrome-devtools-attach\n  disabled: true'));

    check('writing the same mode again is a no-op (so HMR is not re-triggered every second)',
      host.writeBrowserMode(patch, 'launch') === false);

    check('switching to attach rewrites the block', host.writeBrowserMode(patch, 'attach') === true);
    text = readFileSync(patch, 'utf8');
    check('attach enables attach and disables launch',
      text.includes('- id: chrome-devtools-launch\n  disabled: true')
      && text.includes('- id: chrome-devtools-attach\n  disabled: false'));
    check('the block is replaced, not appended a second time',
      text.split('browser mode (managed) — begin').length === 2);
    check('exactly one row is left enabled (both enabled would collide on serverName)',
      (text.match(/disabled: false/g) ?? []).length === 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
