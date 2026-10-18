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
    check('exactly one row is left enabled',
      (text.match(/disabled: false/g) ?? []).length === 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('\nPart A3 — reading the rows back (the reconciler depends on this)');
{
  const root = mkdtempSync(join(tmpdir(), 'chrome-devtools-mcp-rows-'));
  const patch = join(root, 'cordis.patch.yml');
  const LAUNCH = 'chrome-devtools-launch';
  const ATTACH = 'chrome-devtools-attach';
  // Mirrors BUNDLE_ROW_ENABLED in ../index.js: what the bundle ships when the
  // profile says nothing about a row.
  const BUNDLE = { [LAUNCH]: true, [ATTACH]: false };
  try {
    // The state a fresh profile is in. The two rows are defined by *this bundle's*
    // patch, so the profile file has neither id — and that must not read as
    // "disabled", or the reconciler would take a fresh install for "both off" and
    // silently switch it to attach.
    writeFileSync(patch, '# nothing about the bridge rows yet\n');
    let rows = host.readBrowserRows(patch);
    check('an untouched profile reports neither row',
      rows[LAUNCH] === undefined && rows[ATTACH] === undefined, JSON.stringify(rows));
    check('…so the bundle default applies: launch on, attach off',
      (rows[LAUNCH] ?? BUNDLE[LAUNCH]) === true && (rows[ATTACH] ?? BUNDLE[ATTACH]) === false);

    host.writeBrowserMode(patch, 'launch');
    rows = host.readBrowserRows(patch);
    check('after writing launch: launch on, attach explicitly off',
      rows[LAUNCH] === true && rows[ATTACH] === false, JSON.stringify(rows));

    host.writeBrowserMode(patch, 'attach');
    rows = host.readBrowserRows(patch);
    check('after writing attach: attach on, launch explicitly off',
      rows[LAUNCH] === false && rows[ATTACH] === true, JSON.stringify(rows));

    // What the Plugins list produces: `plugin_manager` flips one row on its own, so
    // both end up enabled. The rows share no `serverName`, so that state is
    // survivable, and the reconciler reads it as "switch me to the other mode".
    writeFileSync(patch, readFileSync(patch, 'utf8').replace(
      '- id: chrome-devtools-launch\n  disabled: true',
      '- id: chrome-devtools-launch\n  disabled: false',
    ));
    rows = host.readBrowserRows(patch);
    check('a row flipped on by hand shows both enabled',
      rows[LAUNCH] === true && rows[ATTACH] === true, JSON.stringify(rows));

    writeFileSync(patch, readFileSync(patch, 'utf8')
      .replace('- id: chrome-devtools-launch\n  disabled: false', '- id: chrome-devtools-launch\n  disabled: true')
      .replace('- id: chrome-devtools-attach\n  disabled: false', '- id: chrome-devtools-attach\n  disabled: true'));
    rows = host.readBrowserRows(patch);
    check('both flipped off reads as both explicitly off',
      rows[LAUNCH] === false && rows[ATTACH] === false, JSON.stringify(rows));

    // The bundle's own rows are nested four spaces under `- insert:`, and a user may
    // have re-indented theirs; both must still be found.
    writeFileSync(patch, ['- insert:', `    - id: ${LAUNCH}`, '      disabled: true', ''].join('\n'));
    rows = host.readBrowserRows(patch);
    check('an indented entry (the bundle shape) is read too', rows[LAUNCH] === false, JSON.stringify(rows));

    // A CRLF file must not read as "row absent" — that would trigger one silent
    // flip to the other mode.
    writeFileSync(patch, `- id: ${LAUNCH}\r\n  disabled: false\r\n- id: ${ATTACH}\r\n  disabled: true\r\n`);
    rows = host.readBrowserRows(patch);
    check('a CRLF file reads the same as LF',
      rows[LAUNCH] === true && rows[ATTACH] === false, JSON.stringify(rows));

    // Later entries override earlier ones key by key, so the last explicit
    // `disabled` for an id is the one that counts.
    writeFileSync(patch, [
      `- id: ${LAUNCH}`,
      '  disabled: false',
      '',
      '# a later override of the same id',
      `- id: ${LAUNCH}`,
      '  disabled: true',
      '',
    ].join('\n'));
    rows = host.readBrowserRows(patch);
    check('the last explicit disabled wins', rows[LAUNCH] === false, JSON.stringify(rows));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('\nPart A4 — the Host Remote surface');
{
  check('switching() is gone (the settings page times the wait itself, not the Host)',
    host.ChromeDevtoolsMcpRuntime?.prototype?.switching === undefined);
  check('introspect() is still there',
    typeof host.ChromeDevtoolsMcpRuntime?.prototype?.introspect === 'function');

  const methods = TYPERT.invocations.map((entry) => entry.method).sort();
  check('the manifest declares exactly introspect',
    methods.join(',') === 'introspect', methods.join(','));
}

console.log('\nPart A5 — the three Remote declarations agree');
{
  // A Remote method has to be declared in THREE places, and missing any one of them
  // fails differently and quietly:
  //   - `typert.js`      — what the Host serves (the Gateway resolves this)
  //   - `client.js`      — the mirror it looks the method up in; a mismatch throws
  //                        inside the page's effect and blanks the settings page
  //   - `markRemoteMethods` below — what actually lands on the prototype; a mismatch
  //                        makes the call fail at runtime with no visible cause
  const served = TYPERT.invocations.map((entry) => entry.method).sort();
  check('typert.js declares a non-empty method set', served.length > 0, served.join(','));

  const source = readFileSync(join(here, 'client.js'), 'utf8');
  const declared = [...source.matchAll(/method: '([a-zA-Z]+)'/g)].map((match) => match[1]).sort();
  check('client.js declares exactly the methods typert.js serves',
    declared.join(',') === served.join(','),
    `host=[${served.join(',')}] client=[${declared.join(',')}]`);

  const descriptor = Object.getOwnPropertyDescriptor(
    host.ChromeDevtoolsMcpRuntime.prototype,
    '@deepseek-ai/dsh-typert-protocol/remote-methods',
  );
  const marked = (descriptor?.value?.methods ?? []).map((entry) => entry.method).sort();
  check('markRemoteMethods marks exactly those methods',
    marked.join(',') === served.join(','),
    `host=[${served.join(',')}] marked=[${marked.join(',')}]`);
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
