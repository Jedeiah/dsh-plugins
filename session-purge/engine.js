/**
 * Session Purge — filesystem engine.
 *
 * Pure Node: no Cordis, no dsh services. Everything here is derived from the
 * storage layouts the shipped packages document, so the engine stays testable
 * on its own (see `README.md` "离线自检") and the Cordis half (`index.js`) only
 * owns the pieces that need a live Host: the liveness guard, the Workspace
 * registry, the Schedule service and the browser notification.
 *
 * Layouts this module knows:
 *
 *   - Session logs: `<root>/<project>/<session-dir>/session[.vN].jsonl[.zstd]`
 *     where `<project>` is the readable `--<cwd>--` directory. A session's
 *     directory is named after its id, so subagent children (ids created by the
 *     runtime) sit beside their parent in the same project directory.
 *   - Projection checkpoints: `<storagesRoot>/session_projcache/sessions/<id>.json`,
 *     with `.bak.<stamp>` siblings the storage domain may leave behind.
 *   - Spilled tool output: `<tempRoot>/dsh-spill-<6 chars>/session-<sha256(id)[0..12]>/`.
 *   - Attachments: `<attachmentsRoot>/v1/{objects,file-objects}/<2 hex>/<sha256>`
 *     and reference links at `<attachmentsRoot>/v1/files/<2 hex>/<sha256>/<name>`.
 *
 * @module @jedeiah/session-purge/engine
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

/** Zstandard frame magic; a stored log is a concatenation of independent frames. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Content-addressed reference written into session logs. */
const DIGEST_PATTERN = /sha256:([0-9a-f]{64})/g;

/** A backend-generated default spill root name: `dsh-spill-` plus six characters. */
export const SPILL_ROOT_PATTERN = /^dsh-spill-[A-Za-z0-9]{6}$/;

/** A backend-generated per-session spill directory: `session-` plus 12 lowercase hex. */
export const SPILL_SESSION_PATTERN = /^session-[0-9a-f]{12}$/;

/**
 * Decode one zstd frame.
 * @param bytes - one frame's bytes.
 * @returns the decoded text, or `undefined` when the bytes are not a whole frame.
 */
function decodeFrame(bytes) {
  try {
    return zlib.zstdDecompressSync(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Walk every complete frame of a stored log, one frame at a time: a 5 MB
 * compressed log decodes to far more text than this process should hold at once.
 * @param buffer - the raw log file.
 * @param visit - called once per decoded frame, in file order.
 */
export function eachFrame(buffer, visit) {
  const offsets = [];
  let at = 0;
  while ((at = buffer.indexOf(ZSTD_MAGIC, at)) !== -1) {
    offsets.push(at);
    at += 4;
  }
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    const text = decodeFrame(buffer.subarray(offsets[index], end));
    if (text !== undefined) visit(text);
  }
}

/**
 * Pick the generation the backend would select: the highest `vN` compressed log,
 * falling back to the raw-line (`compression: 'none'`) shape.
 * @param entries - directory entry names.
 * @returns the file name to read, or `undefined` for a directory without a log.
 */
export function selectLogFile(entries) {
  let best;
  let bestVersion = -1;
  for (const entry of entries) {
    const match = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(entry);
    if (match === null) continue;
    const version = match[1] === undefined ? 0 : Number(match[1]);
    if (version > bestVersion) {
      bestVersion = version;
      best = entry;
    }
  }
  if (best !== undefined) return best;
  return entries.filter((entry) => /^session(?:\.v\d+)?\.jsonl$/.test(entry)).sort().at(-1);
}

/**
 * Read the stored header of one session directory.
 * @param directory - the session-owned directory.
 * @returns the header object, or `undefined` when nothing readable is stored.
 */
export async function readSessionHeader(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return undefined;
  }
  const file = selectLogFile(entries);
  if (file === undefined) return undefined;
  const path = join(directory, file);
  let probe;
  try {
    probe = await readFile(path);
  } catch {
    return undefined;
  }
  if (file.endsWith('.jsonl')) {
    try {
      return JSON.parse(probe.toString('utf8').split('\n', 1)[0]);
    } catch {
      return undefined;
    }
  }
  if (probe.length === 0 || probe.indexOf(ZSTD_MAGIC) !== 0) return undefined;
  // The first frame holds only the header line, so the probe's second magic
  // marks its end; without one the probe itself is the frame.
  const next = probe.indexOf(ZSTD_MAGIC, 4);
  const text = decodeFrame(next > 0 ? probe.subarray(0, next) : probe);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text.split('\n', 1)[0]);
  } catch {
    return undefined;
  }
}

/**
 * Read the last `session/title` a log recorded, for a preview the projection
 * checkpoint may not carry.
 * @param directory - the session-owned directory.
 * @returns the title text, or `undefined`.
 */
export async function readStoredTitle(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return undefined;
  }
  const file = selectLogFile(entries);
  if (file === undefined) return undefined;
  let buffer;
  try {
    buffer = await readFile(join(directory, file));
  } catch {
    return undefined;
  }
  let title;
  const collect = (text) => {
    for (const line of text.split('\n')) {
      if (line === '' || !line.includes('session/title')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const value = event?.data?.title;
      if (typeof value === 'string' && value.length > 0) title = value;
    }
  };
  if (file.endsWith('.jsonl')) collect(buffer.toString('utf8'));
  else eachFrame(buffer, collect);
  return title;
}

/**
 * Index every session a persistence root stores.
 * @param root - the session log root.
 * @returns a map from session id to its stored record.
 */
export async function indexStoredSessions(root) {
  const records = new Map();
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return records;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDirectory = join(root, project.name);
    let entries;
    try {
      entries = await readdir(projectDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(projectDirectory, entry.name);
      const header = await readSessionHeader(directory);
      if (header === undefined || typeof header.id !== 'string') continue;
      let sizeBytes = 0;
      try {
        for (const file of await readdir(directory)) {
          const info = await stat(join(directory, file));
          if (info.isFile()) sizeBytes += info.size;
        }
      } catch {
        /* a directory that vanished mid-scan keeps its zero size */
      }
      records.set(header.id, { id: header.id, directory, projectDirectory, header, sizeBytes });
    }
  }
  return records;
}

/**
 * Collect a session and every descendant recorded through `parentSession`,
 * breadth-first from the selected session.
 * @param index - the stored-session index.
 * @param rootId - the session the caller selected.
 * @returns the root followed by its descendants.
 */
export function lineageOf(index, rootId) {
  const ordered = [];
  const seen = new Set();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const record = index.get(id);
    if (record !== undefined) ordered.push(record);
    for (const candidate of index.values()) {
      if (candidate.header.parentSession === id && !seen.has(candidate.id)) queue.push(candidate.id);
    }
  }
  return ordered;
}

/**
 * The spill directory the backend derives for one session id.
 * @param sessionId - the session id.
 * @returns the directory name.
 */
export function spillDirectoryName(sessionId) {
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`;
}

/**
 * List the spill roots this Host may have produced: the backend's per-process
 * `dsh-spill-<6 chars>` directories under the OS temp directory, plus any root
 * the operator configured explicitly.
 * @param configured - extra roots from configuration.
 * @returns absolute spill root paths.
 */
export async function discoverSpillRoots(configured = []) {
  const roots = new Set(configured);
  try {
    for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
      if (entry.isDirectory() && SPILL_ROOT_PATTERN.test(entry.name)) roots.add(join(tmpdir(), entry.name));
    }
  } catch {
    /* an unreadable temp directory only removes default discovery */
  }
  return [...roots];
}

/**
 * Collect every attachment digest one stored log references.
 * @param directory - the session-owned directory.
 * @param sink - the digest sink.
 */
export async function collectDigests(directory, sink) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  const file = selectLogFile(entries);
  if (file === undefined) return;
  let buffer;
  try {
    buffer = await readFile(join(directory, file));
  } catch {
    return;
  }
  const scan = (text) => {
    for (const match of text.matchAll(DIGEST_PATTERN)) sink.add(match[1]);
  };
  if (file.endsWith('.jsonl')) scan(buffer.toString('utf8'));
  else eachFrame(buffer, scan);
}

/**
 * Digests the doomed sessions reference and no surviving session does. Reading
 * the surviving corpus is what makes the subtraction safe: attachment bytes are
 * de-duplicated across sessions, so a digest is only garbage once nothing left
 * points at it.
 * @param params.doomed - directories of the sessions being deleted.
 * @param params.survivors - directories of the sessions that stay.
 * @returns the removable digests.
 */
export async function unreferencedDigests({ doomed, survivors }) {
  const referenced = new Set();
  for (const directory of doomed) await collectDigests(directory, referenced);
  if (referenced.size === 0) return new Set();
  const kept = new Set();
  for (const directory of survivors) await collectDigests(directory, kept);
  return new Set([...referenced].filter((digest) => !kept.has(digest)));
}

/**
 * Remove the objects and reference links behind a digest set.
 * @param params.root - the attachment root.
 * @param params.digests - digests nothing references any more.
 * @param params.warnings - the warning sink.
 * @returns how many objects and links were removed.
 */
export async function removeAttachments({ root, digests, warnings }) {
  let objects = 0;
  let links = 0;
  for (const digest of digests) {
    const prefix = digest.slice(0, 2);
    for (const tree of ['objects', 'file-objects']) {
      const path = join(root, 'v1', tree, prefix, digest);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        await rm(path, { force: true });
        objects += 1;
      } catch (error) {
        if (error?.code !== 'ENOENT') warnings.push(`could not remove attachment object ${digest}: ${String(error)}`);
      }
    }
    const references = join(root, 'v1', 'files', prefix, digest);
    try {
      await rm(references, { recursive: true, force: true });
      links += 1;
    } catch (error) {
      warnings.push(`could not remove attachment references ${digest}: ${String(error)}`);
    }
  }
  return { objects, links };
}

/**
 * The read-only half of a purge: what a deletion would touch. The dialog renders
 * this, and `executePurge` consumes the same plan so a preview and its execution
 * can never disagree about the target set.
 * @param params.root - the session log root.
 * @param params.sessionId - the selected session.
 * @param params.includeDescendants - whether children come with the parent.
 * @param params.spillRoots - extra spill roots to inspect.
 * @returns the plan, or `undefined` when the session is not stored.
 */
export async function planPurge({ root, sessionId, includeDescendants, spillRoots = [] }) {
  const index = await indexStoredSessions(root);
  const selected = index.get(sessionId);
  if (selected === undefined) return undefined;
  const targets = includeDescendants ? lineageOf(index, sessionId) : [selected];
  const spillRootsFound = await discoverSpillRoots(spillRoots);
  const spillDirectories = [];
  for (const target of targets) {
    const name = spillDirectoryName(target.id);
    for (const spillRoot of spillRootsFound) {
      const path = join(spillRoot, name);
      try {
        if ((await stat(path)).isDirectory()) spillDirectories.push(path);
      } catch {
        /* no spill directory for this session under this root */
      }
    }
  }
  return {
    sessionId,
    root,
    targets,
    targetIds: targets.map((target) => target.id),
    sizeBytes: targets.reduce((total, target) => total + target.sizeBytes, 0),
    spillDirectories,
    index,
  };
}

/**
 * Remove the session-owned directories of a plan, then the project directories
 * they leave empty.
 * @param params.plan - a plan from {@link planPurge}.
 * @param params.removeEmptyProjectDirectory - whether to drop emptied project directories.
 * @param params.warnings - the warning sink.
 * @returns the removal counters.
 */
export async function removeSessionDirectories({ plan, removeEmptyProjectDirectory, warnings }) {
  let sessionDirectories = 0;
  let bytesFreed = 0;
  let projectDirectories = 0;
  const projects = new Set();
  for (const target of plan.targets) {
    bytesFreed += target.sizeBytes;
    projects.add(target.projectDirectory);
    try {
      await rm(target.directory, { recursive: true, force: true });
      sessionDirectories += 1;
    } catch (error) {
      warnings.push(`could not remove ${target.directory}: ${String(error)}`);
    }
  }
  if (removeEmptyProjectDirectory) {
    for (const project of projects) {
      try {
        await rmdir(project);
        projectDirectories += 1;
      } catch {
        /* a project directory that still holds sessions stays */
      }
    }
  }
  return { sessionDirectories, projectDirectories, bytesFreed };
}

/**
 * Delete the persisted projection checkpoints of a set of sessions, including
 * any `.bak.<stamp>` document the domain moved aside for an invalid record.
 * @param params.storagesRoot - the storage domain root.
 * @param params.ids - the session ids.
 * @param params.warnings - the warning sink.
 * @returns how many documents were removed.
 */
export async function removeProjectionRecords({ storagesRoot, ids, warnings }) {
  const directory = join(storagesRoot, 'session_projcache', 'sessions');
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return 0;
  }
  const wanted = new Set(ids.map((id) => `${id}.json`));
  let removed = 0;
  for (const entry of entries) {
    if (!wanted.has(entry.split('.bak.')[0])) continue;
    try {
      await rm(join(directory, entry), { force: true });
      removed += 1;
    } catch (error) {
      warnings.push(`could not remove projection record ${entry}: ${String(error)}`);
    }
  }
  return removed;
}

/**
 * Delete the spill directories of a set of sessions across every spill root,
 * and prune a root once it is empty.
 * @param params.ids - the session ids.
 * @param params.roots - the spill roots to sweep.
 * @param params.warnings - the warning sink.
 * @returns how many directories were removed.
 */
export async function removeSpillDirectories({ ids, roots, warnings }) {
  const names = new Set(ids.map(spillDirectoryName));
  let removed = 0;
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !names.has(entry.name) || !SPILL_SESSION_PATTERN.test(entry.name)) continue;
      try {
        await rm(join(root, entry.name), { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        warnings.push(`could not remove spill directory ${join(root, entry.name)}: ${String(error)}`);
      }
      try {
        await rmdir(root);
      } catch {
        /* the process-private root disappears only when it is empty */
      }
    }
  }
  return removed;
}

/**
 * Read the title a projection checkpoint stored for a session.
 * @param params.storagesRoot - the storage domain root.
 * @param params.sessionId - the session id.
 * @returns the title, or `undefined`.
 */
export async function readCachedTitle({ storagesRoot, sessionId }) {
  try {
    const document = JSON.parse(await readFile(join(storagesRoot, 'session_projcache', 'sessions', `${sessionId}.json`), 'utf8'));
    const value = document?.record?.rows?.title?.val;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
