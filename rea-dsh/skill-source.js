/**
 * Acquire REA's bundled skill from the npm registry, at the version the bridge runs.
 *
 * Why this exists: the MCP bridge resolves its package spec at every start, but a
 * skill copy committed to this repository freezes at the day it was copied. The two
 * then drift, and a skill that describes tools the running server does not have is
 * worse than no skill at all — upstream says so itself ("a skill installed from
 * repository main may describe capabilities absent from an older npm release").
 * Taking `skills/` from the same release the bridge uses removes the drift by
 * construction instead of by discipline.
 *
 * Nothing here shells out: the client downloads the published tarball, verifies the
 * registry's own integrity hash, and reads it with a minimal ustar reader. So the
 * result depends on no host tool, no npm, and no PATH — the same properties the rest
 * of this bundle needs to keep.
 *
 * The failure contract is deliberate: every function throws on a real problem, and
 * the caller ({@link module:@jedeiah/rea-dsh}) treats any throw as "keep using the
 * bundled copy". A skill that cannot be refreshed must never take the row down.
 *
 * @module @jedeiah/rea-dsh/skill-source
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** npm's public registry. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** The published package whose skill this bundle distributes. */
export const REA_PACKAGE = 'rea-agents';

/** Directory name of the skill, in the tarball and on disk. */
export const SKILL_NAME = 'reverse-engineer-anything';

/** Everything under this prefix in the tarball is the skill payload. */
const PAYLOAD_PREFIX = 'package/skills/';

/** Default budget for one metadata or tarball request. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Ceilings for the two things a hostile or broken registry could otherwise make this
 * process do: hand us an unbounded body, or hand us a small gzip that expands without
 * limit. The integrity check runs before the gunzip and covers transport tampering, but
 * it validates against the same response that carries the payload, so it is not a bound.
 */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;

/* ------------------------------------------------------------------ digests */

/**
 * Verify a buffer against the registry's integrity metadata.
 *
 * npm publishes Subresource Integrity (`sha512-<base64>`) and, for older releases,
 * a bare sha1 `shasum`. Either is accepted; neither is guessed — an entry that
 * carries no verifiable hash is rejected by the caller, not trusted.
 * @param buffer - the downloaded bytes.
 * @param expected - `{ integrity?, shasum? }` from the version manifest.
 * @returns whether the bytes match a published hash.
 */
export function matchesIntegrity(buffer, { integrity, shasum } = {}) {
  if (typeof integrity === 'string' && integrity !== '') {
    const [algorithm, expected] = integrity.split('-', 2);
    if (!algorithm || !expected) return false;
    let actual;
    try {
      actual = createHash(algorithm).update(buffer).digest('base64');
    } catch {
      return false;
    }
    return actual === expected;
  }
  if (typeof shasum === 'string' && shasum !== '') {
    return createHash('sha1').update(buffer).digest('hex') === shasum;
  }
  return false;
}

/** @returns the sha256 of one buffer, hex. */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** @returns whether the registry gave us anything we can verify against. */
export function hasVerifiableHash({ integrity, shasum } = {}) {
  return (typeof integrity === 'string' && integrity !== '')
    || (typeof shasum === 'string' && shasum !== '');
}

/* ---------------------------------------------------------------------- tar */

/** Read a NUL-terminated UTF-8 string out of a fixed-width tar field. */
function cstring(buffer, start, max) {
  let end = start;
  const limit = start + max;
  while (end < limit && end < buffer.length && buffer[end] !== 0) end += 1;
  return buffer.toString('utf8', start, end);
}

/**
 * Read a tar numeric field.
 *
 * ustar spells sizes in NUL-or-space-padded octal. GNU's base-256 extension sets
 * the high bit of the first byte instead, which keeps working past 8 GiB; npm
 * tarballs are small enough that octal is the norm, but a reader that silently
 * mis-parses one would extract garbage, so both forms are handled.
 * @param buffer - the 512-byte header.
 * @param start - field offset.
 * @param length - field width.
 * @returns the decoded number.
 */
function numeric(buffer, start, length) {
  if ((buffer[start] & 0x80) !== 0) {
    let value = buffer[start] & 0x7f;
    for (let i = start + 1; i < start + length; i += 1) value = value * 256 + buffer[i];
    return value;
  }
  const text = cstring(buffer, start, length).trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new Error(`tar: unreadable numeric field ${JSON.stringify(text)}`);
  return value;
}

/**
 * Decode one PAX extended header record set (`<len> <key>=<value>\n`).
 * @param buffer - the record payload.
 * @returns a map of the attributes it declares.
 */
function parsePax(buffer) {
  const attributes = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(buffer.toString('utf8', offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = buffer.toString('utf8', space + 1, offset + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) attributes[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return attributes;
}

/**
 * Read every regular file out of a gzipped tar.
 *
 * Handles the header forms npm actually publishes: ustar name/prefix, PAX extended
 * headers (`x`, whose `path`/`size` override the following entry), and GNU long
 * names (`L`). Links are reported but never followed — a bundle has no business
 * reaching outside its own tree, and the caller only extracts regular files.
 * @param gzipped - the raw tarball bytes.
 * @returns `{ files, links }`, each entry `{ path, data }` / `{ path, target, type }`.
 */
export function readTarGz(gzipped) {
  const tar = gunzipSync(gzipped, { maxOutputLength: MAX_EXTRACTED_BYTES });
  const files = [];
  const links = [];
  let offset = 0;
  let pax = {};
  let longName;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // Two zero blocks end an archive; one is enough to stop, the rest is padding.
    if (header.every((byte) => byte === 0)) break;

    const type = String.fromCharCode(header[156] || 0x30);
    const name = longName ?? (() => {
      const prefix = cstring(header, 345, 155);
      const base = cstring(header, 0, 100);
      return prefix === '' ? base : `${prefix}/${base}`;
    })();

    if (type === 'x' || type === 'g') {
      const size = numeric(header, 124, 12);
      const body = tar.subarray(offset + 512, offset + 512 + size);
      const attributes = parsePax(body);
      if (type === 'x') pax = attributes;
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === 'L') {
      const size = numeric(header, 124, 12);
      longName = tar.toString('utf8', offset + 512, offset + 512 + size).replace(/\0+$/, '');
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }

    const size = pax.size === undefined ? numeric(header, 124, 12) : Number.parseInt(pax.size, 10);
    const path = pax.path ?? name;
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === '0' || type === '\0') files.push({ path, data: Buffer.from(body) });
    else if (type === '2' || type === '1') links.push({ path, target: cstring(header, 157, 100), type });

    pax = {};
    longName = undefined;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { files, links };
}

/**
 * Accept a tar path only if it stays inside the extraction root.
 * @param path - the raw entry path.
 * @returns the normalized relative path, or null when it is unsafe.
 */
export function safeRelativePath(path) {
  if (typeof path !== 'string' || path === '') return null;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts.join('/');
}

/* ----------------------------------------------------------------- registry */

/**
 * Resolve one spec — a dist-tag or an exact version — to a downloadable release.
 * @param spec - `latest`, another dist-tag, or a version such as `6.4.0`.
 * @param options - `{ registry, timeoutMs, fetchImpl }`.
 * @returns `{ version, tarball, integrity, shasum }`.
 */
export async function resolveRelease(spec, options = {}) {
  const {
    registry = DEFAULT_REGISTRY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options;
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');

  const url = `${registry.replace(/\/+$/, '')}/${REA_PACKAGE}/${encodeURIComponent(spec)}`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`registry returned ${response.status} for ${spec}`);

  const manifest = await response.json();
  const dist = manifest?.dist ?? {};
  if (typeof manifest?.version !== 'string' || typeof dist.tarball !== 'string') {
    throw new Error(`registry manifest for ${spec} has no version or tarball`);
  }
  return {
    version: manifest.version,
    tarball: dist.tarball,
    integrity: dist.integrity,
    shasum: dist.shasum,
  };
}

/** Download one URL into a buffer, with the same timeout budget as metadata. */
async function download(url, { timeoutMs, fetchImpl }) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`download returned ${response.status} for ${url}`);

  // A declared length is checked before the body is read, and the body is measured
  // again after: neither is trusted on its own.
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
    throw new Error(`declared tarball size ${String(declared)} exceeds the ${String(MAX_TARBALL_BYTES)} byte ceiling`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_TARBALL_BYTES) {
    throw new Error(`tarball is ${String(body.length)} bytes, over the ${String(MAX_TARBALL_BYTES)} byte ceiling`);
  }
  return body;
}

/* ------------------------------------------------------------------ install */

/**
 * Write the skill payload under `destination`, one file at a time.
 *
 * Every path is re-checked against the destination root before a byte is written:
 * a tarball is untrusted input, and `resolve()`-then-`startsWith()` is the check
 * that actually holds on both POSIX and Windows.
 * @param files - `{ path, data }` entries, already stripped of the payload prefix.
 * @param destination - the directory to write into (created if missing).
 * @returns the relative paths written.
 */
export function writePayload(files, destination) {
  const root = resolve(destination);
  const written = [];
  for (const { path, data } of files) {
    const relative = safeRelativePath(path);
    if (relative === null) throw new Error(`refusing unsafe tar path ${JSON.stringify(path)}`);
    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`refusing tar path escaping the extraction root: ${JSON.stringify(path)}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written.push(relative);
  }
  return written.sort();
}

/**
 * Ensure the skill for one spec is present in the cache.
 *
 * A cache hit is decided by the payload existing, not by a timestamp: the directory
 * is keyed by the exact published version, so content cannot go stale in place. A
 * miss installs into a sibling temporary directory and renames it over the target,
 * so a partial download can never be mistaken for a complete install.
 * @param options - see {@link resolveRelease}, plus `cacheDir` and `onEvent`.
 * @returns `{ version, directory, files, reused }`.
 */
export async function ensureSkillInCache(options) {
  const {
    spec,
    cacheDir,
    registry = DEFAULT_REGISTRY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    onEvent = () => {},
  } = options;
  if (typeof cacheDir !== 'string' || cacheDir === '') throw new Error('cacheDir is required');

  const release = await resolveRelease(spec, { registry, timeoutMs, fetchImpl });
  const directory = join(cacheDir, release.version);
  if (existsSync(join(directory, SKILL_NAME, 'SKILL.md'))) {
    onEvent({ kind: 'reuse', version: release.version, directory });
    return { version: release.version, directory, files: [], reused: true };
  }
  if (!hasVerifiableHash(release)) {
    throw new Error(`release ${release.version} publishes no verifiable hash`);
  }

  const gzipped = await download(release.tarball, { timeoutMs, fetchImpl });
  if (!matchesIntegrity(gzipped, release)) {
    throw new Error(`integrity mismatch for ${release.version} (${release.tarball})`);
  }

  const { files } = readTarGz(gzipped);
  const payload = [];
  for (const file of files) {
    if (!file.path.startsWith(PAYLOAD_PREFIX)) continue;
    payload.push({ path: file.path.slice(PAYLOAD_PREFIX.length), data: file.data });
  }
  if (!payload.some((file) => file.path === `${SKILL_NAME}/SKILL.md`)) {
    throw new Error(`release ${release.version} carries no ${SKILL_NAME}/SKILL.md`);
  }

  mkdirSync(cacheDir, { recursive: true });
  const staging = join(cacheDir, `.staging-${process.pid}-${Date.now()}`);
  rmSync(staging, { recursive: true, force: true });
  let written;
  try {
    mkdirSync(staging, { recursive: true });
    written = writePayload(payload, staging);
    // The origin record is what makes a cache directory auditable later: which
    // release it came from, and what the bytes hashed to.
    writeFileSync(join(staging, '.origin.json'), `${JSON.stringify({
      package: REA_PACKAGE,
      spec,
      version: release.version,
      tarball: release.tarball,
      integrity: release.integrity ?? null,
      shasum: release.shasum ?? null,
      fetchedAt: new Date().toISOString(),
      files: Object.fromEntries(payload.map((file) => [file.path, sha256(file.data)])),
    }, null, 2)}\n`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  rmSync(directory, { recursive: true, force: true });
  renameSync(staging, directory);
  onEvent({ kind: 'install', version: release.version, directory, files: written.length });
  return { version: release.version, directory, files: written, reused: false };
}
