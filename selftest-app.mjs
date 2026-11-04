/**
 * Locate the dsh installation for the repository self-tests.
 *
 * dsh 0.2.2 ships its runtime inside `Resources/app.asar`; the old flat
 * `Resources/app/dsh` directory no longer exists. ESM cannot import a module
 * from an asar path directly, so this helper materialises `dsh/node_modules`
 * once into the OS temp directory and returns the extracted `@deepseek-ai`
 * package directory.
 *
 * The helper is deliberately repo-side: selftests are development tools, not
 * part of an installed plugin's runtime.
 *
 * @module dsh-plugins/selftest-app
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** @returns the resource roots that may contain a dsh installation. */
function resourcesRoots() {
  const roots = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') roots.push(process.resourcesPath);
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    const contents = dirname(dirname(process.execPath));
    const resources = join(contents, 'Resources');
    if (existsSync(resources)) roots.push(resources);
    let cursor = dirname(process.execPath);
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(cursor, 'runtime', 'primary-runtime', 'dependencies'))) {
        roots.push(cursor);
        break;
      }
      cursor = dirname(cursor);
    }
  }
  return [...new Set(roots.map((root) => resolve(root)))];
}

/** @param path - candidate directory. @returns whether it is a directory. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Copy one tree out of an asar archive using Electron's fs shim.
 * @param source - source file or directory.
 * @param target - destination file or directory.
 */
function copyTree(source, target) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) {
    const linked = resolve(dirname(source), readlinkSync(source));
    copyTree(linked, target);
    return;
  }
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name));
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(source));
}

/**
 * Materialise the asar-installed dsh packages, reusing a per-version cache.
 * @param modules - the `dsh/node_modules` directory inside app.asar.
 * @param version - the dsh package version.
 * @returns the extracted `@deepseek-ai` directory.
 */
function materialise(modules, version) {
  const cache = join(tmpdir(), 'dsh-selftest-runtime', version);
  const packages = join(cache, 'node_modules', '@deepseek-ai');
  const marker = join(cache, '.complete');
  if (existsSync(marker) && isDirectory(packages)) return packages;
  if (process.versions?.electron === undefined) {
    throw new Error('dsh is packaged in app.asar; run the self-test with ELECTRON_RUN_AS_NODE=1 or pass --app <extracted @deepseek-ai>');
  }
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  copyTree(modules, join(cache, 'node_modules'));
  writeFileSync(marker, `${version}\n`);
  return packages;
}

/**
 * Resolve the installation's `@deepseek-ai` package directory.
 * @param explicit - an explicit `--app` value, when supplied.
 * @returns the package directory, or an empty string when no installation exists.
 */
export function resolveAppDirectory(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  const roots = resourcesRoots();
  for (const root of roots) {
    const legacy = join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai');
    if (isDirectory(legacy)) return legacy;
  }
  for (const root of roots) {
    const modules = join(root, 'app.asar', 'dsh', 'node_modules');
    if (!isDirectory(join(modules, '@deepseek-ai'))) continue;
    const manifest = JSON.parse(readFileSync(join(dirname(modules), 'package.json'), 'utf8'));
    return materialise(modules, String(manifest.version ?? 'unknown'));
  }
  return '';
}
