#!/usr/bin/env node

/**
 * Transparent launcher for the REA MCP server.
 *
 * The bridge row runs this instead of a package manager directly. It exists for
 * three reasons that a static `command` in `cordis.patch.yml` cannot cover:
 *
 *   1. **The rung is decided late.** A `rea` the user installs after the harness
 *      started is picked up on the next spawn, with no restart — profile
 *      composition runs `!!js` once, at activation, and cannot see it.
 *   2. **Teardown is ours.** We spawn the real server in its own process group and
 *      forward termination signals to the whole group, so stopping the harness does
 *      not leave a package manager and a Node server behind.
 *   3. **Failure is visible.** A launch that cannot work says so on stderr in one
 *      line, instead of the bridge silently producing no tools.
 *
 * `stdin` is never touched: it carries the JSON-RPC stream straight through to the
 * server. Only stderr is ours to write.
 *
 * @module @jedeiah/rea-dsh/launcher
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveSpawnPlan, PACKAGE_DIR } = require('./launcher.cjs');

const WINDOWS = process.platform === 'win32';

/** How long a term signal is given before the group is killed outright. */
const TERMINATION_GRACE_MS = 5_000;

/** Arguments forwarded verbatim to the server, e.g. `mcp`. */
const forwarded = process.argv.slice(2).filter((argument) => !argument.startsWith('--spec='));

/** The spec override, when a caller passes one. */
const specArgument = process.argv.slice(2).find((argument) => argument.startsWith('--spec='));

/** @param message - a single diagnostic line. */
function report(message) {
  try {
    process.stderr.write(`rea-dsh: ${message}\n`);
  } catch {
    /* stderr closed: nothing useful left to say */
  }
}

/**
 * Record what was launched, so the truth is inspectable after the fact.
 *
 * Written once per spawn into the bundle's own cache directory, which is ignored by
 * git and never touches anything outside this package. Best effort: a read-only
 * install must not stop the server from running.
 * @param plan - the resolved spawn plan.
 * @param pid - the spawned child's pid, when it is known.
 */
function recordState(plan, pid) {
  try {
    const directory = join(PACKAGE_DIR, 'cache');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'status.json'), `${JSON.stringify({
      writtenAt: new Date().toISOString(),
      mode: plan.mode,
      command: plan.command,
      args: plan.args,
      notes: plan.notes,
      spec: plan.spec,
      pid,
    }, null, 2)}\n`);
  } catch (error) {
    report(`could not record launcher state: ${error?.message ?? error}`);
  }
}

const plan = resolveSpawnPlan({
  ...(specArgument === undefined ? {} : { spec: specArgument.slice('--spec='.length) }),
  forward: forwarded,
});
for (const note of plan.notes) report(note);

const child = spawn(plan.command, plan.args, {
  stdio: 'inherit',
  env: plan.env ?? process.env,
  // A separate process group is what makes the group kill below possible; without
  // it only the direct child would receive the signal.
  detached: !WINDOWS,
});

recordState(plan, child.pid);

child.on('error', (error) => {
  report(`could not start ${plan.command}: ${error?.message ?? error}`);
  process.exitCode = 127;
});

let graceTimer;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    try {
      process.kill(WINDOWS || child.pid === undefined ? child.pid : -child.pid, signal);
    } catch {
      /* the group is already gone */
    }
    // The server may ignore the first signal (a decompiler mid-request, say). Give
    // it a bounded chance to exit cleanly, then stop it for real.
    graceTimer ??= setTimeout(() => {
      try {
        process.kill(WINDOWS || child.pid === undefined ? child.pid : -child.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }, TERMINATION_GRACE_MS);
  });
}

// Last-resort teardown for exits this process did not handle as a signal — an uncaught
// exception, say. SIGKILL still leaves the group behind (nothing can run then), but every
// exit that *can* clean up should, or a harness restart would accumulate orphaned
// package managers and servers.
process.on('exit', () => {
  try {
    process.kill(WINDOWS || child.pid === undefined ? child.pid : -child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
});

child.on('exit', (code, signal) => {
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  // Report the child's own status: a plain code when it exited, and the POSIX
  // 128+signal convention when it was terminated — the client that asked for the
  // termination should not read it back as an ordinary failure.
  if (code !== null) {
    process.exitCode = code;
    return;
  }
  const number = osConstants.signals[signal] ?? 0;
  process.exitCode = number === 0 ? 1 : 128 + number;
});
