/**
 * web-fetch-fakeip — offline self-test.
 *
 *   node selftest.mjs [--app /path/to/app/dsh/node_modules/@deepseek-ai]
 *
 * The Host half imports `@deepseek-ai/dsh-web-fetch-http`, which only resolves
 * inside a dsh installation. Instead of installing anything, this registers a
 * one-line resolver that anchors every `@deepseek-ai/*` specifier at the
 * installation's own package directory (`--app`, or the default location).
 *
 * Part A checks the row configuration:
 *
 *  - the schema accepts an empty config, so every field really has a default;
 *  - the documented defaults hold, including the `198.18.0.0/15` fake-ip range
 *    a local TUN proxy hands out — that value is the whole reason this bundle
 *    exists, so a silent change to it would be a silent regression;
 *  - **no** field is `.volatile()`. Unlike a tunable the settings page edits live,
 *    these describe one registration's behaviour; making them volatile would put
 *    live handles where the Host half reads plain numbers.
 *
 * Part A2 checks the patch this bundle ships, which is a contract with the
 * shipped provider rather than with the model: it disables `web-fetch-http` and
 * inserts itself. Both halves are load-bearing — leaving the shipped row enabled
 * gives two providers for an unconfigured id, which resolves to
 * `WEB_PROVIDER_AMBIGUOUS` and breaks `web_fetch` outright.
 *
 * There is no Part B: this bundle has no `typert.js`, because it exposes no
 * Remote service (the settings form is not part of its contract).
 *
 * Nothing is written; the patch is read as text and parsed with the
 * installation's own YAML dialect would be overkill for two structural facts.
 *
 * @module @jedeiah/web-fetch-fakeip/selftest
 */

import { existsSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
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

/** Unwrap a volatile handle if one is present; these fields should have none. */
const plain = (value) => (typeof value?.get === 'function' ? value.get() : value);

console.log('\nPart A — the row configuration');
{
  const empty = host.Config['~standard'].validate({});
  check('an empty config validates (every field has a default)',
    empty.issues === undefined, JSON.stringify(empty.issues));

  const value = empty.issues === undefined ? empty.value : {};

  check('allowRanges defaults to the fake-ip pool this bundle exists for',
    plain(value.allowRanges) === '198.18.0.0/15', String(plain(value.allowRanges)));
  check('maxResponseBytes defaults to 5e6', plain(value.maxResponseBytes) === 5e6,
    String(plain(value.maxResponseBytes)));
  check('maxBodyChars defaults to 1e5', plain(value.maxBodyChars) === 1e5,
    String(plain(value.maxBodyChars)));
  check('timeoutMs defaults to 30000', plain(value.timeoutMs) === 3e4, String(plain(value.timeoutMs)));
  check('maxRedirects defaults to 5', plain(value.maxRedirects) === 5, String(plain(value.maxRedirects)));
  check('userAgent has a non-empty default',
    typeof plain(value.userAgent) === 'string' && plain(value.userAgent).length > 0,
    String(plain(value.userAgent)));

  const volatileFields = Object.keys(value).filter((name) => typeof value[name]?.get === 'function');
  check('no field is .volatile() (these describe one registration, not a live tunable)',
    volatileFields.length === 0, volatileFields.join(','));
}

console.log('\nPart A2 — the patch that substitutes the shipped provider');
{
  const patch = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');

  // `- id: web-fetch-http` with `disabled: true` on the next line. Written as a
  // regex over the text because the two facts are structural, not semantic.
  check('the shipped web-fetch-http row is disabled',
    /-\s*id:\s*web-fetch-http\s*\n\s*disabled:\s*true\b/.test(patch));
  check('this bundle inserts its own row',
    /-\s*id:\s*web-fetch-fakeip\b/.test(patch));
  check("this bundle's row is not disabled",
    !/-\s*id:\s*web-fetch-fakeip\s*\n\s*disabled:\s*true\b/.test(patch));
  // The disable has to be a top-level row rather than something nested inside
  // `insert:` — patches reach an existing row by id, so a nested one would never
  // touch the shipped entry.
  const insertAt = patch.indexOf('- insert:');
  const disableAt = patch.search(/-\s*id:\s*web-fetch-http\s*\n\s*disabled:\s*true\b/);
  check('the disable is a top-level row, written before the insert',
    insertAt !== -1 && disableAt !== -1 && disableAt < insertAt,
    `insert@${String(insertAt)} disable@${String(disableAt)}`);
}

console.log('\nPart A3 — what the Host half exports');
{
  check('inject declares the web service it consumes',
    Array.isArray(host.inject) && host.inject.includes('web'),
    JSON.stringify(host.inject));
  check('apply is exported', typeof host.apply === 'function');
  check('name is the bundle name', host.name === 'web-fetch-fakeip', String(host.name));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${String(failures)} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
