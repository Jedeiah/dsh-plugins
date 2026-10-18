/**
 * Session Purge — transaction storage.
 *
 * Pure Node, no Cordis. This module owns everything a purge writes for itself:
 * the staging area next to the session root, the write-ahead manifests a run is
 * recovered from, the commit (a same-volume `rename` out of the session tree),
 * the cleanup of what was committed, and the audit trail. `index.js` drives it;
 * `selftest.mjs` Part A drives it alone.
 *
 * Layout (DESIGN.md §7.1):
 *
 *   <stagingRoot>/                   = dirname(realpath(sessionsRoot))/.session-purge-staging
 *     .lock                          global mutex (POSIX flock)
 *     audit.jsonl                    append-only, rotated at 8 MiB
 *     runs/<runId>/manifest.json     intent, targets, step progress, outcome
 *     runs/<runId>/entries/<project>/<dirName>   what the commit moved out
 *     gc/candidates.json             attachment gc round one (§11)
 *
 * The staging root has to sit outside the session tree — the JSONL backend treats
 * every directory under its root as a project (`dsh-session-persistence-jsonl:3506`)
 * — and on the same volume, or the commit is not a rename.
 *
 * @module @jedeiah/session-purge/txn
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Manifest schema version this build writes and understands. */
export const MANIFEST_VERSION = 5;

/** Staging directory name, a sibling of the session root. */
export const STAGING_DIRECTORY = '.session-purge-staging';

/** Audit file size at which it is rotated to `audit.1.jsonl`. */
const AUDIT_ROTATE_BYTES = 8 * 1024 * 1024;

/**
 * Files a session directory is known to hold (DESIGN.md §7.3): every log
 * generation and migration temporary (`session*.jsonl*`, e.g.
 * `session.migration.<token>.jsonl.zstd.tmp`, `dsh-session-persistence-jsonl:1957`)
 * and the lease file (`session.lock`, `:648`). A linked target only ever loses
 * these; anything else in it belongs to someone else.
 */
const SESSION_ARTIFACT_PATTERN = /^session.*\.jsonl.*$/;
const LEASE_FILE = 'session.lock';

/**
 * Whether a file name is a session artifact.
 * @param name - a directory entry name.
 * @returns whether the purge may delete it from a linked target.
 */
export function isSessionArtifact(name) {
  return name === LEASE_FILE || SESSION_ARTIFACT_PATTERN.test(name);
}

/**
 * The staging root for a session root.
 * @param sessionsRoot - the configured session log root.
 * @returns the staging root path (not created).
 */
export async function stagingRootFor(sessionsRoot) {
  const resolved = await realpath(sessionsRoot);
  return join(dirname(resolved), STAGING_DIRECTORY);
}

/**
 * Create the staging root and its `runs/` directory.
 * @param stagingRoot - the staging root.
 */
export async function ensureStagingRoot(stagingRoot) {
  await mkdir(join(stagingRoot, 'runs'), { recursive: true, mode: 0o700 });
}

/** @returns a sortable, collision-safe run id. */
export function newRunId() {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

/**
 * The directory of one run.
 * @param stagingRoot - the staging root.
 * @param runId - the run id.
 * @returns its path.
 */
export function runDirectory(stagingRoot, runId) {
  return join(stagingRoot, 'runs', runId);
}

/**
 * Flush a directory's entries to stable storage. A `rename` or `unlink` is not
 * durable until its parent directory is (DESIGN.md §7.2). Windows cannot open a
 * directory for this; there the call is a no-op, which the design states.
 * @param directory - the directory to flush.
 */
export async function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Write a JSON document durably: temporary file, fsync, rename over the target,
 * fsync the directory. A crash leaves either the old document or the new one.
 * @param path - the target file.
 * @param value - the JSON value.
 */
export async function writeJsonDurable(path, value) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await fsyncDirectory(dirname(path));
}

/**
 * Read one run's manifest.
 * @param directory - the run directory.
 * @returns the manifest, or `undefined` when it is missing, unreadable or of an
 *   unknown version — such a run is "unknown residue" and is never acted on.
 */
export async function readManifest(directory) {
  let text;
  try {
    text = await readFile(join(directory, 'manifest.json'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const manifest = JSON.parse(text);
    if (manifest?.version !== MANIFEST_VERSION || typeof manifest.runId !== 'string' || !Array.isArray(manifest.targets)) return undefined;
    return manifest;
  } catch {
    return undefined;
  }
}

/**
 * Persist one run's manifest.
 * @param stagingRoot - the staging root.
 * @param manifest - the manifest to write.
 */
export async function writeManifest(stagingRoot, manifest) {
  const directory = runDirectory(stagingRoot, manifest.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeJsonDurable(join(directory, 'manifest.json'), manifest);
}

/**
 * Every run under the staging root, oldest first.
 * @param stagingRoot - the staging root.
 * @returns `{ runId, directory, manifest }` entries; `manifest` is `undefined` for unknown residue.
 */
export async function listRuns(stagingRoot) {
  let names;
  try {
    names = await readdir(join(stagingRoot, 'runs'));
  } catch {
    return [];
  }
  const runs = [];
  for (const runId of names.sort()) {
    const directory = runDirectory(stagingRoot, runId);
    try {
      if (!(await lstat(directory)).isDirectory()) continue;
    } catch {
      continue;
    }
    runs.push({ runId, directory, manifest: await readManifest(directory) });
  }
  return runs;
}

/**
 * Remove a finished run's directory and make that durable.
 * @param stagingRoot - the staging root.
 * @param runId - the run id.
 */
export async function removeRun(stagingRoot, runId) {
  await rm(runDirectory(stagingRoot, runId), { recursive: true, force: true });
  await fsyncDirectory(join(stagingRoot, 'runs'));
}

/**
 * The identity of a directory entry itself (a link is identified as a link).
 * @param path - the path.
 * @returns `dev:ino`, or `undefined` when nothing is there.
 */
export async function entryIdentity(path) {
  try {
    const info = await lstat(path, { bigint: true });
    return `${String(info.dev)}:${String(info.ino)}`;
  } catch {
    return undefined;
  }
}

/**
 * The identity of what a path resolves to.
 * @param path - the path.
 * @returns `dev:ino`, or `undefined` when nothing is there.
 */
export async function targetIdentity(path) {
  try {
    const info = await stat(path, { bigint: true });
    return `${String(info.dev)}:${String(info.ino)}`;
  } catch {
    return undefined;
  }
}

/**
 * Device of the directory an entry would be renamed out of, so a cross-device
 * layout is refused before anything moves (DESIGN.md §7.3).
 * @param path - the entry.
 * @returns the device number as a string.
 */
export async function parentDevice(path) {
  return String((await stat(dirname(path), { bigint: true })).dev);
}

/**
 * Where one committed entry lives inside its run.
 * @param stagingRoot - the staging root.
 * @param runId - the run id.
 * @param source - the entry's original path (`<sessions>/<project>/<dir>`).
 * @returns the staged path.
 */
export function stagedPathFor(stagingRoot, runId, source) {
  return join(runDirectory(stagingRoot, runId), 'entries', basename(dirname(source)), basename(source));
}

/**
 * The commit of one entry: a same-volume rename out of the session tree, made
 * durable by flushing both parent directories.
 * @param source - the entry's original path.
 * @param destination - its staged path.
 */
export async function commitEntry(source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rename(source, destination);
  await fsyncDirectory(dirname(source));
  await fsyncDirectory(dirname(destination));
}

/**
 * Remove one committed entry from staging.
 *
 * A real directory was ours from the commit on and goes whole. A link is
 * different (DESIGN.md §7.3): matching inodes prove nothing about who else keeps
 * files in the folder it points at, so only session artifacts are removed from
 * the target, the target is removed only once that leaves it empty, and the link
 * goes last. The target is identified by the `realpath` recorded before the
 * commit, never by reading the moved link — a relative link means something else
 * once it lives in staging.
 * @param entry - `{ stagedPath, linked, realTarget, realTargetIdentity }`.
 * @param warnings - the warning sink.
 * @returns `{ leftover: string[], preserved: boolean }`.
 */
export async function cleanupEntry(entry, warnings) {
  const result = { leftover: [], preserved: false };
  if (!entry.linked) {
    await rm(entry.stagedPath, { recursive: true, force: true });
    return result;
  }
  const current = await targetIdentity(entry.realTarget);
  if (current !== undefined && current === entry.realTargetIdentity) {
    let names = [];
    try {
      names = await readdir(entry.realTarget);
    } catch (error) {
      warnings.push(`could not read linked target ${entry.realTarget}: ${String(error)}`);
    }
    for (const name of names) {
      if (!isSessionArtifact(name)) {
        result.leftover.push(name);
        continue;
      }
      try {
        // Re-check before every destructive step: the folder may have been
        // swapped for another one since the commit.
        if ((await targetIdentity(entry.realTarget)) !== entry.realTargetIdentity) {
          warnings.push(`identity-drift: linked target ${entry.realTarget} changed during cleanup; left alone`);
          result.leftover.push(name);
          break;
        }
        await rm(join(entry.realTarget, name), { force: true });
      } catch (error) {
        result.preserved = true;
        result.leftover.push(name);
        warnings.push(`external target preserved: could not remove ${join(entry.realTarget, name)}: ${String(error)}`);
      }
    }
    if (result.leftover.length === 0) {
      try {
        await rmdir(entry.realTarget);
        await fsyncDirectory(dirname(entry.realTarget));
      } catch {
        /* not empty after all, or not ours to remove: the link still goes */
      }
    } else {
      warnings.push(`leftover: linked target ${entry.realTarget} kept ${String(result.leftover.length)} file(s) that are not session artifacts`);
    }
  } else if (current !== undefined) {
    warnings.push(`identity-drift: linked target ${entry.realTarget} is not the folder the commit recorded; left alone`);
  }
  try {
    await unlink(entry.stagedPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return result;
}

/** In-process queues, keyed by staging root: one purge step sequence at a time. */
const queues = new Map();

/**
 * Run an operation under the global mutex (DESIGN.md §7.4): serialized within
 * this process, and excluded across processes by a POSIX `flock` on
 * `<stagingRoot>/.lock`. Another process holding it is reported as `busy`.
 * Windows has no flock; there only this process is serialized (assumption A2).
 * @param stagingRoot - the staging root.
 * @param tryLock - `tryLockExclusive(fd)` from `node-addon-system/flock`, or `undefined`.
 * @param operation - the work to run while holding the mutex.
 * @returns what `operation` returned.
 * @throws an error with `code: 'busy'` when another process holds the lock.
 */
export async function withGlobalLock(stagingRoot, tryLock, operation) {
  const previous = queues.get(stagingRoot) ?? Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const chained = previous.then(() => turn);
  queues.set(stagingRoot, chained);
  await previous;
  try {
    await ensureStagingRoot(stagingRoot);
    let handle;
    if (typeof tryLock === 'function' && process.platform !== 'win32') {
      handle = await open(join(stagingRoot, '.lock'), 'a', 0o600);
      try {
        await tryLock(handle.fd);
      } catch (error) {
        await handle.close();
        if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') {
          throw Object.assign(new Error('another dsh process is running a session purge on this session root'), { code: 'busy' });
        }
        if (error?.code !== 'ERR_FLOCK_UNSUPPORTED_PLATFORM') throw error;
        handle = undefined;
      }
    }
    try {
      return await operation();
    } finally {
      await handle?.close();
    }
  } finally {
    release();
    if (queues.get(stagingRoot) === chained) queues.delete(stagingRoot);
  }
}

/**
 * Append one record to the audit trail. No titles, no content (DESIGN.md §9.2):
 * the trail must not become residue of what it records.
 * @param stagingRoot - the staging root.
 * @param record - the JSON record.
 */
export async function appendAudit(stagingRoot, record) {
  const path = join(stagingRoot, 'audit.jsonl');
  try {
    if ((await stat(path)).size >= AUDIT_ROTATE_BYTES) await rename(path, join(stagingRoot, 'audit.1.jsonl'));
  } catch {
    /* no audit file yet */
  }
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.write(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Whether a checkpoint record belongs to the log a tombstone names, not to a new
 * session that reuses its id (DESIGN.md §10.2). The checkpoint identity is
 * derived from header fields only (`dsh-session-projection-cache:365-379`); a new
 * session under the same id always carries a new `createdAt`.
 * @param tombstone - `{ createdAt, cwd? }` recorded when the log was deleted.
 * @param identity - the checkpoint record's `identity`.
 * @returns whether the record is a resurrection of the deleted log.
 */
export function checkpointIdentityMatches(tombstone, identity) {
  if (identity === null || typeof identity !== 'object') return false;
  if (identity.createdAt !== tombstone.createdAt) return false;
  if (typeof tombstone.cwd === 'string' && typeof identity.cwd === 'string' && identity.cwd !== tombstone.cwd) return false;
  return true;
}
