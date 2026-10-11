/**
 * The managed override block this bundle writes into a profile's `cordis.patch.yml`.
 *
 * Why this file can pin a version at all: `applyEntryPatches` in
 * `cordis-plugin-include` copies every key except `id`/`insert`/`name` onto the target
 * entry, and **`config` is assigned wholesale, not merged**. So an override that names
 * the bridge row must carry that row's complete configuration. That is what makes this
 * module necessary rather than a one-line `env` edit, and what makes it dangerous: a
 * block that drops `serverName` or `transport` would break the row it is meant to
 * configure. {@link renderOverrideBlock} therefore always renders the full plan the
 * launcher would produce, and never a partial one.
 *
 * The profile patch is the one file dsh's HMR watches, which is why a version change
 * lands without a restart: the row is updated in place, and `dsh-mcp-client` reloads
 * the server connection for an edited configuration entry (its own README's words).
 *
 * Three rules this module holds itself to, each of them a defect it used to have:
 *
 *   1. **Markers are matched as whole lines, and the block between them must look like
 *      ours.** A substring search would treat a user comment that merely mentions the
 *      begin marker as the start of our block, and the next removal would delete the
 *      user's own rows along with it. Anchoring to lines plus checking the body
 *      contains our row id makes "not our block" a refusal instead of a deletion.
 *   2. **Refusals are reported as refusals.** "I could not recognise the layout" and
 *      "the content already matches" are different answers; reporting the first as the
 *      second tells someone their pin was applied when it was not.
 *   3. **The file is written atomically, with its mode preserved.** This file belongs
 *      to the user and is written by other parts of the harness too; a crash midway
 *      through a plain write would leave a truncated patch that the next boot refuses
 *      to compose, and a fresh file would silently widen its permissions.
 *
 * @module @jedeiah/rea-dsh/profile-override
 */

import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The harness's own atomic write and its file lock, imported the way this bundle
 * imports every harness package (dynamically: a static import of a dsh package inside a
 * profile-linked bundle can fail to resolve, and the loader then reports only
 * "failed to import"). Both are optional: without them the write still goes through a
 * sibling temporary file and a rename, which is atomic but does not serialize against
 * the harness's own writers of the same file.
 */
const atomicWrite = await import('@deepseek-ai/dsh-atomic-write').catch(() => null);

/** The mode every writer of the profile patch uses: 0600. */
const PATCH_MODE = 0o600;

/** First line of the block this bundle owns. */
export const BLOCK_BEGIN = '# @jedeiah/rea-dsh: pinned bridge version (managed) — begin';

/** Last line of the block this bundle owns. */
export const BLOCK_END = '# @jedeiah/rea-dsh: pinned bridge version (managed) — end';

/** The bridge row this block overrides, spelled as the bundle's patch declares it. */
export const BRIDGE_ROW_ID = 'rea-bridge';

/**
 * What a spec may contain.
 *
 * The value is written into a YAML file, so it is validated rather than trusted:
 * dist-tags and versions both match this charset, and nothing else gets near the file.
 */
export const SPEC_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

/** A begin marker occupying a line of its own. */
const BEGIN_LINE = /^[ \t]*# @jedeiah\/rea-dsh: pinned bridge version \(managed\) — begin[ \t]*$/m;

/** An end marker occupying a line of its own. */
const END_LINE = /^[ \t]*# @jedeiah\/rea-dsh: pinned bridge version \(managed\) — end[ \t]*$/m;

/** The row this module owns inside the block; its presence is what makes a block ours. */
const OWNED_ROW = /^[ \t]*- id:[ \t]*rea-bridge[ \t]*$/m;

/**
 * Absolute path of this profile's patch file.
 *
 * `ctx.baseUrl` is the *profile* directory, not the bundle directory — the same trap
 * the bundle patch's `!!js` works around. Here it is exactly the right anchor: the only
 * file that can override a row is the profile's own patch.
 * @param ctx - owning Cordis context.
 * @returns the patch path, or undefined when the profile location is unavailable.
 */
export function profilePatchPath(ctx) {
  const base = String(ctx?.baseUrl ?? '');
  if (base === '') return undefined;
  try {
    return join(fileURLToPath(base), 'cordis.patch.yml');
  } catch {
    return undefined;
  }
}

/**
 * Quote one scalar for YAML, single-quoted style.
 *
 * Single quotes are the only style with no escapes beyond doubling the quote itself,
 * which keeps the result readable and independent of indentation or leading
 * characters — the values here include absolute paths with spaces.
 * @param value - the scalar to quote.
 * @returns the quoted scalar, including its quotes.
 */
export function yamlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Render the managed block for one pinned spec.
 *
 * The block carries the bridge row's **complete** configuration because
 * `applyEntryPatches` assigns `config` wholesale — a partial block would drop
 * `serverName` and break the row it is meant to configure.
 * @param options - `{ spec, plan }`: the spec to pin and the launcher's plan.
 * @returns the block text, without a trailing newline.
 */
export function renderOverrideBlock({ spec, plan }) {
  if (!SPEC_PATTERN.test(spec)) throw new Error(`refusing to write an unusable spec: ${JSON.stringify(spec)}`);
  const lines = [
    BLOCK_BEGIN,
    '# 由 rea-dsh 设置页写入；手工编辑会在下次写入时被替换。整块删除即回到「跟随最新」。',
    `- id: ${BRIDGE_ROW_ID}`,
    '  config:',
    '    serverName: rea',
    '    transport: stdio',
    `    command: ${yamlString(plan.command)}`,
    '    args:',
    ...plan.args.map((argument) => `      - ${yamlString(argument)}`),
    '    env:',
    `      REA_SPEC: ${yamlString(spec)}`,
    BLOCK_END,
  ];
  return lines.join('\n');
}

/**
 * Find every block this module owns.
 *
 * A begin marker only counts when an end marker follows it *and* the text between them
 * carries our row id. Anything else is either a user's comment or a foreign edit, and
 * is left for {@link applyOverrideBlock} to refuse rather than swallow.
 * @param text - the patch file's text.
 * @returns `{ blocks, stray }` where `blocks` are `{ start, end }` spans (end exclusive)
 *   and `stray` reports markers that look like ours but do not form one of them.
 */
export function findBlocks(text) {
  const blocks = [];
  let stray = null;
  let cursor = 0;
  while (cursor < text.length) {
    BEGIN_LINE.lastIndex = 0;
    const begin = BEGIN_LINE.exec(text.slice(cursor));
    if (begin === null) break;
    const start = cursor + begin.index;
    const afterBegin = cursor + begin.index + begin[0].length;

    END_LINE.lastIndex = 0;
    const end = END_LINE.exec(text.slice(afterBegin));
    if (end === null) {
      stray = stray ?? 'unterminated';
      break;
    }
    const endStart = afterBegin + end.index;
    const body = text.slice(afterBegin, endStart);
    if (!OWNED_ROW.test(body)) {
      // A marker pair without our row: someone else's edit, or a user who copied the
      // markers. Refuse the whole file rather than guess which of us it belongs to.
      stray = stray ?? 'unrecognised';
      cursor = endStart + end[0].length;
      continue;
    }
    blocks.push({ start, end: endStart + end[0].length });
    cursor = endStart + end[0].length;
  }
  return { blocks, stray };
}

/**
 * Whether a patch file's text holds at least one entry line.
 *
 * The loader parses this file with js-yaml and rejects anything that is not a top-level
 * array. Measured against the harness's own schema (`JSON_SCHEMA.extend(JsExpr)`):
 * an empty file and a comments-only file both parse to `undefined`/`null`, while `[]`
 * parses to an array. So "no entries left" must be written as an explicit empty list,
 * never as a bare newline — otherwise this bundle would hand dsh a config file it
 * refuses to load.
 * @param text - the text to inspect.
 * @returns whether at least one non-comment, non-blank line is present.
 */
function hasEntryLines(text) {
  return text.split('\n').some((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
}

/**
 * Remove every owned block from a text.
 * @param text - the patch file's text.
 * @returns the text with the blocks taken out and no stray blank runs left behind.
 */
function stripBlocks(text) {
  const { blocks } = findBlocks(text);
  if (blocks.length === 0) return text;
  let out = text;
  for (const span of [...blocks].reverse()) {
    const before = out.slice(0, span.start).replace(/[ \t]*$/, '');
    const after = out.slice(span.end).replace(/^[ \t]*/, '');
    out = `${before}${after}`;
  }
  return out;
}

/**
 * Apply, replace, or remove the managed block inside a patch file's text.
 *
 * Pure, so the selftest can drive every branch — including the one that matters most,
 * "writing the same thing again changes nothing", which is what keeps a poll from
 * churning a file the loader watches.
 * @param text - the patch file's current contents.
 * @param block - the block to write, or null to remove the existing one.
 * @returns `{ text, changed, outcome }` where outcome is `written`, `unchanged`,
 *   `refused-unterminated`, or `refused-unrecognised`.
 */
export function applyOverrideBlock(text, block) {
  const { blocks, stray } = findBlocks(text);
  if (stray !== null) return { text, changed: false, outcome: `refused-${stray}` };

  let base = stripBlocks(text);

  if (block === null) {
    if (blocks.length === 0) return { text, changed: false, outcome: 'unchanged' };
    // The block may have sat mid-file, so removing it can leave the blank line that
    // separated it from its neighbours at either end. Trim exactly that, and nothing a
    // user wrote themselves.
    const before = base.replace(/\s+$/, '').replace(/^\n+/, '');
    // The loader rejects a file that does not parse as a top-level array, and both an
    // empty file and a comments-only one parse to `undefined`/`null`. Keep whatever
    // text the user has — comments included — and add an explicit empty list when that
    // text would otherwise hold no entries.
    const next = hasEntryLines(before) ? `${before}\n`
      : before === '' ? '[]\n' : `${before}\n[]\n`;
    return { text: next, changed: next !== text, outcome: 'written' };
  }

  // Every owned block is removed first, so a file that somehow carries two of them ends
  // up with exactly one — ours, as just rendered. `applyEntryPatches` applies patches in
  // order, so leaving a stale second block would silently beat the new one.
  const trimmed = base.replace(/\s*$/, '');
  const next = trimmed === '' ? `${block}\n` : `${trimmed}\n\n${block}\n`;
  // Re-writing the same block must report "unchanged", not "written": the caller decides
  // whether to wait for a reload based on that answer, and a no-op write does not reload
  // anything.
  const changed = next !== text;
  return { text: next, changed, outcome: changed ? 'written' : 'unchanged' };
}

/**
 * Read the spec the managed block currently pins.
 *
 * Reads the text rather than parsing YAML, for the same reason the block is spliced as
 * text: this file belongs to the user, and it may hold anything else.
 * @param text - the patch file's contents.
 * @returns the pinned spec, or null when the file has no block.
 */
export function readPinnedSpec(text) {
  const { blocks } = findBlocks(text);
  if (blocks.length === 0) return null;
  const block = text.slice(blocks[0].start, blocks[0].end);
  const found = /^[ \t]+REA_SPEC:[ \t]*'((?:[^']|'')*)'[ \t]*$/m.exec(block);
  return found === null ? null : found[1].replace(/''/g, "'");
}

/**
 * Write, replace, or remove the managed block in one patch file.
 *
 * Reads, splices, compares, and writes only when the text actually differs — the
 * loader watches this file, so a no-op write would remount a row for nothing. The write
 * itself goes through a sibling temporary file and a rename, preserving the original
 * mode: this file is written by other parts of the harness, and a truncated patch would
 * not fail the running session but would fail the next boot.
 * @param patchPath - absolute path of the profile patch.
 * @param block - the block to write, or null to remove it.
 * @returns `{ changed, outcome, pinnedSpec }` describing the result.
 */
export async function writeOverrideBlock(patchPath, block) {
  /**
   * Read, splice, and write — all inside whatever lock is held.
   *
   * The read has to happen *inside* the critical section: reading first and writing
   * later is exactly the interleave that loses the other writer's change.
   * @returns `{ changed, outcome, pinnedSpec }`.
   */
  const commit = async () => {
    const previous = readFileSync(patchPath, 'utf8');
    const { text, changed, outcome } = applyOverrideBlock(previous, block);
    if (!changed || outcome !== 'written') {
      return { changed: false, outcome, pinnedSpec: readPinnedSpec(previous) };
    }
    await writeText(patchPath, text);
    return { changed: true, outcome, pinnedSpec: readPinnedSpec(text) };
  };

  if (atomicWrite === null) return commit();
  // The harness serializes its own writers of this file on
  // `<profile>/package.json.lock` (measured in `dsh-config-editor`), so taking the same
  // lock is what keeps a pin and, say, a settings write from overwriting each other.
  return atomicWrite.withFileLock(join(dirname(patchPath), 'package.json'), commit);
}

/**
 * Write the patch text atomically.
 *
 * `writeFileAtomic` is preferred because it is what the harness's own writers use; the
 * fallback keeps the same guarantee (a rename cannot be observed half-done) for the case
 * where that package is unavailable.
 * @param patchPath - the file to replace.
 * @param text - its new contents.
 */
async function writeText(patchPath, text) {
  if (atomicWrite !== null) {
    await atomicWrite.writeFileAtomic(patchPath, text, { mode: PATCH_MODE });
    return;
  }
  let mode = PATCH_MODE;
  try {
    mode = statSync(patchPath).mode;
  } catch {
    /* a new file: the writer's own mode applies */
  }
  const staging = `${patchPath}.rea-dsh-${String(process.pid)}.tmp`;
  try {
    writeFileSync(staging, text, { mode });
    renameSync(staging, patchPath);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}
