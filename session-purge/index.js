/**
 * Session Purge — host half.
 *
 * The Session persistence seam has no delete interface (its reader accumulates
 * logs "until an external removal"), so a delete is a transaction this plugin
 * runs itself, through the doors dsh provides (DESIGN.md v8):
 *
 *   fence    every target is opened for write through `ctx.sessionPersistence`;
 *            holding that handle is the proof that no one — in this process or
 *            another — can write the log, and a live session refuses it;
 *   commit   each session directory is renamed out of the tree into a staging
 *            area on the same volume, behind a write-ahead manifest;
 *   purge    the derived and accounting state is cleared through its owners'
 *            services: Workspace registry, the projection checkpoint table,
 *            Schedule, plus the spilled output;
 *   verify   every domain is read back; what could not be read is reported;
 *   converge a `domain/changed` watcher deletes a checkpoint that a late cold read
 *            writes back for a deleted log, and startup re-checks the same ids.
 *
 * Nothing outside the targets changes before the commit, so a refused or failed
 * fence needs no compensation. A crash is recovered on the next start from the
 * manifests, forward only.
 *
 * @module @jedeiah/session-purge
 */
import { mkdir, open as openFile, readFile, readdir, realpath, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import {
  discoverSpillRoots,
  digestsIn,
  indexStoredSessions,
  listAttachmentObjects,
  markAttachmentRoots,
  throwIfAborted,
  planPurge,
  readCachedTitle,
  readStoredTitle,
  removeAttachments,
  removeProjectionRecords,
  removeSpillDirectories,
  scanResidue,
} from './engine.js';
import * as txn from './txn.js';

/*
 * Imported through `import()` rather than a static import: measured on dsh
 * 0.2.0-rc.2, a static import of a dsh package inside a profile-linked bundle can
 * fail to resolve, and the loader then reports only "failed to import".
 */
/**
 * How old a directory with no readable header must be before the residue sweep
 * offers it. A session created a moment ago has no header yet (`create()` writes
 * nothing until its first append), so a young directory is not residue.
 */
const RESIDUE_MIN_AGE_MS = 60_000;

/** How long a finished run's manifest — and its tombstones — are kept (DESIGN.md §10.2). */
const RETAIN_MANIFEST_MS = 7 * 24 * 60 * 60 * 1000;

/** After this many failed attempts a deferred delete stops retrying on its own (DESIGN.md §5.3). */
const MAX_DEFERRED_ATTEMPTS = 3;

/** How long to wait after an agent disposal before trying a deferred delete: its write handle drains first. */
const DEFERRED_SETTLE_MS = 300;

/** Retries of a deferred delete that found its session still owned, right after a disposal. */
const DEFERRED_RETRIES = 10;

/** An unreferenced attachment object must be at least this old to be a gc candidate (DESIGN.md §11). */
const GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** The second gc round runs no sooner than this after the first. */
const GC_ROUND_GAP_MS = 24 * 60 * 60 * 1000;

/** A run id as `txn.newRunId()` mints it. */
const RUN_ID_PATTERN = /^[0-9a-z]{1,16}-[0-9a-f]{12}$/;

/** The projection checkpoint domain and table (`dsh-session-projection-cache:90`, `:100`). */
const CHECKPOINT_DOMAIN = 'session_projcache';
const CHECKPOINT_TABLE = 'sessions';

let RemoteError;
let TypertRemoteService;
let resolveDshHome;
try {
  ({ RemoteError, TypertRemoteService } = await import('@deepseek-ai/dsh-typert-protocol'));
  ({ resolveDshHome } = await import('@deepseek-ai/dsh-home-paths'));
} catch (error) {
  throw new Error('session-purge: could not import the dsh packages this bundle is built on', { cause: error });
}

/**
 * `tryLockExclusive` for the global mutex and the lease probe. Optional: without
 * it (Windows, or a dsh that stopped shipping the addon) the purge still fences
 * through the persistence seam, it only loses the cross-process mutex and the
 * root probe — and says so.
 */
let tryLockExclusive;
try {
  ({ tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock'));
} catch {
  tryLockExclusive = undefined;
}

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'session-purge';

/**
 * The fence needs the persistence seam; liveness is answered by the Agent and
 * Session registries. Every other service this plugin touches is looked up per
 * call, so a composition without the Schedule plugin or without a Workspace
 * registry still loads and simply purges (and verifies) less.
 */
export const inject = ['agents', 'sessions', 'sessionPersistence'];

/** Row configuration. Volatile fields are the ones surfaced on the Plugins page. */
export const Config = z.object({
  /** Session log root; empty resolves `$DSH_HOME/sessions`, the shipped backend's root. */
  sessionsRoot: z.string().default(''),
  /** Storage domain root; empty resolves `$DSH_HOME/storages`. */
  storagesRoot: z.string().default(''),
  /** Attachment object root; empty resolves `$DSH_HOME/attachments`. */
  attachmentsRoot: z.string().default(''),
  /** Delay before the startup recovery pass; negative disables it (tests drive it by hand). */
  recoveryDelayMs: z.number().default(1500),
  /** The DeepSeek adapter's upload manifest, an attachment gc root; empty resolves `$DSH_HOME/llm-deepseek/files-v3.json`. */
  llmFilesPath: z.string().default(''),
  /** Extra spill roots to sweep besides the `dsh-spill-*` roots under the OS temp directory. */
  spillRoots: z.array(z.string()).default([]).volatile(),
  /** Delete subagent descendants of a deleted session in the same operation. */
  includeDescendants: z.boolean().default(true).volatile(),
  /** Drop a project directory once its last session is gone. */
  removeEmptyProjectDirectory: z.boolean().default(true).volatile(),
  /** Delete reminders bound to the deleted sessions. */
  purgeSchedules: z.boolean().default(true).volatile(),
  /** Delete spilled tool output owned by the deleted sessions. */
  purgeSpill: z.boolean().default(true).volatile(),
  /**
   * Retired. A delete no longer touches attachment bytes (DESIGN.md §6.1); the
   * separate two-round gc on the settings page reclaims them. Kept in the schema
   * so an existing configuration still validates, and named in the report when on.
   */
  purgeAttachments: z.boolean().default(false),
});

/** Prototype key the Typert Remote markers live under. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * Mark Remote methods the way the TypeScript decorator transpiles to: one
 * versioned descriptor on the class prototype. Writing it here keeps this bundle
 * decorator-free and buildless while the Gateway still resolves the endpoint
 * through `remoteMethods()`.
 * @param prototype - the service class prototype.
 * @param methods - exported method names.
 */
function markRemoteMethods(prototype, methods) {
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map((method) => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  });
}

/**
 * Read one configured value.
 *
 * A field marked `.volatile()` arrives as a live reference — a frozen handle
 * with `get()` whose value the settings service rewrites without remounting the
 * row — so reading `config.flag` directly would yield the handle object (always
 * truthy) instead of the configured value. Plain fields pass through unchanged.
 * @param value - the configured value or volatile reference.
 * @param fallback - used when the field is absent or unreadable.
 * @returns the current plain value.
 */
function readConfigValue(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value?.get === 'function') {
    try {
      const current = value.get();
      return current === undefined ? fallback : current;
    } catch {
      return fallback;
    }
  }
  return value;
}

/** Whether an error is the persistence seam's "another owner holds the write handle". */
function isOwned(error) {
  return error?.name === 'SessionAlreadyOwnedError';
}

/** A fresh removal counter set. */
function emptyCounters() {
  return { sessionDirectories: 0, projectDirectories: 0, projectionRecords: 0, spillDirectories: 0, schedules: 0, workspaceSlots: 0, attachmentObjects: 0, attachmentLinks: 0, bytesFreed: 0 };
}

/** The Remote service: preview, purge, residue sweep — and the recovery behind them. */
class SessionPurgeService extends TypertRemoteService {
  /**
   * @param ctx - owning Cordis context.
   * @param config - the row configuration as Cordis delivers it (volatile fields
   *   are live references; see {@link readConfigValue}).
   */
  constructor(ctx, config) {
    super(ctx, 'sessionPurge');
    this.config = config ?? {};
    /**
     * The target set the dialog last showed, per session. `purge` compares it
     * with a fresh plan so a child created between preview and confirmation can
     * never be deleted without having been listed.
     */
    this.previewed = new Map();
    /** Deleted logs whose checkpoint must not come back: id → `{ createdAt, cwd, expiresAt }`. */
    this.tombstones = new Map();
    /** Logged once: the lease addon is missing, so the mutex and root probe are off. */
    this.warnedNoFlock = false;
    /** Session ids a deferred delete is waiting on; an agent disposal for one of them wakes it. */
    this.pendingIds = new Set();
    /** Pending deferred-delete timers, cleared when the row unmounts. */
    this.timers = new Set();

    this.ctx.on('domain/changed', (change) => this.onDomainChanged(change));
    this.ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id ?? payload?.agent?.session?.id;
      if (typeof id === 'string' && this.pendingIds.has(id)) this.scheduleDeferred(DEFERRED_SETTLE_MS, DEFERRED_RETRIES);
    });
    this.ctx.effect(() => () => {
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear();
    }, 'session-purge: deferred timers');
    const delay = readConfigValue(this.config.recoveryDelayMs, 1500);
    if (typeof delay === 'number' && delay >= 0) {
      this.ctx.effect(() => {
        const timer = setTimeout(() => {
          this.recover().catch((error) => this.warn(`startup recovery failed: ${String(error?.stack ?? error)}`));
        }, delay);
        timer.unref?.();
        return () => clearTimeout(timer);
      }, 'session-purge: startup recovery');
    }
  }

  /**
   * Log a warning through the context logger.
   * @param message - the message.
   */
  warn(message) {
    try {
      this.ctx.logger?.warn?.(`session-purge: ${message}`);
    } catch {
      /* a broken logger must not fail the operation */
    }
  }

  /**
   * Read one configuration field with its fallback.
   * @param name - field name.
   * @param fallback - value used when the field is absent.
   * @returns the current plain value.
   */
  setting(name, fallback) {
    return readConfigValue(this.config[name], fallback);
  }

  /** The operation's settings, read once so one purge cannot see two config revisions. */
  settings() {
    return {
      sessionsRoot: this.setting('sessionsRoot', ''),
      storagesRoot: this.setting('storagesRoot', ''),
      attachmentsRoot: this.setting('attachmentsRoot', ''),
      spillRoots: Array.isArray(this.setting('spillRoots', [])) ? this.setting('spillRoots', []) : [],
      llmFilesPath: this.setting('llmFilesPath', ''),
      includeDescendants: this.setting('includeDescendants', true) !== false,
      removeEmptyProjectDirectory: this.setting('removeEmptyProjectDirectory', true) !== false,
      purgeSchedules: this.setting('purgeSchedules', true) !== false,
      purgeSpill: this.setting('purgeSpill', true) !== false,
      purgeAttachments: this.setting('purgeAttachments', false) === true,
    };
  }

  /**
   * Describe what deleting one session would remove, without writing anything.
   * @param sessionId - the session the operator selected.
   * @param signal - aborts the scan.
   * @returns the preview.
   */
  async inspect(sessionId, signal) {
    assertSessionId(sessionId);
    const settings = this.settings();
    const root = this.sessionsRoot();
    const plan = await planPurge({
      root,
      sessionId,
      includeDescendants: settings.includeDescendants,
      spillRoots: settings.spillRoots,
      signal,
    });
    if (plan === undefined) {
      throw new RemoteError('session-purge/session-unknown', `no stored session "${sessionId}" exists under the configured session root`, { sessionId, root });
    }
    const live = plan.targetIds.filter((id) => this.isLive(id));
    const schedules = await this.scheduleTasks(plan.targetIds);
    const pendingRun = await this.pendingCovering(plan.targetIds);
    this.previewed.set(sessionId, { ids: [...plan.targetIds], liveIds: [...live], at: Date.now() });
    return {
      sessionId,
      root,
      pendingRunId: pendingRun?.runId ?? null,
      live: this.isLive(sessionId),
      forkIds: plan.forkIds,
      logBytes: plan.logBytes,
      spillBytes: plan.spillBytes,
      blocked: live.length === 0 ? null : { reason: 'live-session', sessionIds: live },
      sizeBytes: plan.sizeBytes,
      scheduleCount: schedules.length,
      spillDirectoryCount: plan.spillDirectories.length,
      includeDescendants: settings.includeDescendants,
      targets: await Promise.all(plan.targets.map(async (target) => ({
        sessionId: target.id,
        title: await this.titleOf(target),
        cwd: typeof target.header.cwd === 'string' ? target.header.cwd : null,
        createdAt: target.header.createdAt,
        origin: target.header.origin === 'subagent' ? 'subagent' : 'root',
        delegationDepth: target.header.delegationDepth ?? 0,
        parentSession: typeof target.header.parentSession === 'string' ? target.header.parentSession : null,
        live: live.includes(target.id),
        sizeBytes: target.sizeBytes,
      }))),
    };
  }

  /**
   * Delete one session and, by configuration, its subagent descendants.
   * @param sessionId - the session the operator selected.
   * @param signal - cancels the operation up to the commit; after it, the purge
   *   finishes regardless (forward only).
   * @returns the report the Client half shows.
   */
  async purge(sessionId, signal) {
    assertSessionId(sessionId);
    const settings = this.settings();
    const root = this.sessionsRoot();
    let staging;
    try {
      staging = await txn.stagingRootFor(root);
    } catch {
      throw new RemoteError('session-purge/session-unknown', `no stored session "${sessionId}" exists under the configured session root`, { sessionId, root });
    }
    const previewed = this.previewed.get(sessionId);
    this.previewed.delete(sessionId);
    // Plan under the mutex: a second purge of the same session that queued behind
    // the first must see the store as the first one left it, not as it was.
    return this.exclusive(staging, async () => {
      const plan = await planPurge({
        root,
        sessionId,
        includeDescendants: settings.includeDescendants,
        spillRoots: settings.spillRoots,
        signal,
      });
      if (plan === undefined) {
        throw new RemoteError('session-purge/session-unknown', `no stored session "${sessionId}" exists under the configured session root`, { sessionId, root });
      }
      // The preview is the contract with the operator: if the set grew since the
      // dialog rendered (a child was created), stop and make them look again.
      if (previewed !== undefined) {
        const before = new Set(previewed.ids);
        const now = new Set(plan.targetIds);
        const added = plan.targetIds.filter((id) => !before.has(id));
        const gone = previewed.ids.filter((id) => !now.has(id));
        if (added.length > 0 || gone.length > 0) {
          throw new RemoteError(
            'session-purge/target-set-changed',
            `the set of sessions to delete changed since the dialog was rendered (+${String(added.length)} / -${String(gone.length)}); reopen the dialog to confirm the new list`,
            { sessionId, added, removed: gone },
          );
        }
      }

      // A delete already waiting for these sessions is not started twice.
      const pendingRun = await this.pendingCovering(plan.targetIds, staging);
      if (pendingRun !== undefined) {
        throw new RemoteError('session-purge/already-pending', `a deletion of these sessions is already waiting (run "${pendingRun.runId}"); retry or cancel it from the plugin settings page`, { runId: pendingRun.runId });
      }

      // A live target defers the delete — but only when the operator saw that in
      // the dialog. A session that came to life after a "cold" preview is not
      // something they agreed to stop.
      const consented = (previewed?.liveIds ?? []).length > 0;
      const refuseLive = (ids) => {
        throw previewed === undefined ? liveError(ids) : becameLiveError(ids);
      };
      const live = plan.targetIds.filter((id) => this.isLive(id));
      if (live.length > 0) {
        if (!consented) refuseLive(live);
        return this.runDeferred({ staging, plan, settings });
      }
      try {
        return await this.runImmediate({ staging, plan, settings, signal });
      } catch (error) {
        if (error?.code !== 'session-purge/session-live') throw error;
        if (!consented) refuseLive(error.details?.sessionIds ?? []);
        return this.runDeferred({ staging, plan, settings });
      }
    });
  }

  /**
   * Run an operation under the global mutex, mapping contention to a stable code.
   * @param staging - the staging root.
   * @param operation - the work.
   * @returns what the work returned.
   */
  async exclusive(staging, operation) {
    if (tryLockExclusive === undefined && !this.warnedNoFlock) {
      this.warnedNoFlock = true;
      this.warn('@deepseek-ai/node-addon-system/flock is unavailable: the cross-process mutex and the lease probe are off; the persistence fence still applies');
    }
    try {
      return await txn.withGlobalLock(staging, tryLockExclusive, operation);
    } catch (error) {
      if (error?.code === 'busy') throw new RemoteError('session-purge/busy', String(error.message), {});
      throw error;
    }
  }

  /**
   * The immediate path (DESIGN.md §5.2): fence, commit, purge, verify.
   * @param params.staging - the staging root.
   * @param params.plan - the purge plan.
   * @param params.settings - the settings snapshot.
   * @param params.signal - cancels up to the commit.
   * @param params.resumeFrom - a deferred run being completed: its run id, path
   *   and creation time carry over.
   * @param params.vanished - ids of a deferred run whose directories are already
   *   gone; their domains are still cleared.
   * @returns the report.
   */
  async runImmediate({ staging, plan, settings, signal, resumeFrom, vanished = [] }) {
    const warnings = [];
    const removed = emptyCounters();
    const records = plan.targets.flatMap((target) => [target, ...target.duplicates].map((record, index) => ({ target, record, primary: index === 0 })));

    // prepare — refuse a layout the commit cannot rename atomically.
    const stagingDevice = String((await stat(staging, { bigint: true })).dev);
    for (const { record } of records) {
      if ((await txn.parentDevice(record.directory)) !== stagingDevice) {
        throw new RemoteError('session-purge/cross-device', `session directory "${record.directory}" is not on the same volume as the staging area "${staging}"; refusing rather than copying`, { directory: record.directory, staging });
      }
    }
    throwIfAborted(signal);

    if (settings.purgeAttachments) {
      warnings.push('purgeAttachments is retired: a delete no longer removes attachment bytes; use "attachment reclaim" on the plugin settings page');
    }
    const fence = await this.fence(plan.targets);
    let manifest;
    try {
      if (fence.owned.length > 0) throw liveError(fence.owned);
      const liveNow = plan.targetIds.filter((id) => this.isLive(id));
      if (liveNow.length > 0) throw liveError(liveNow);
      // The last cancellation point: past here the purge only moves forward.
      throwIfAborted(signal);

      const runId = resumeFrom?.runId ?? txn.newRunId();
      const entries = [];
      for (const { target, record, primary } of records) {
        const linked = record.linked === true;
        entries.push({
          id: target.id,
          primary,
          source: record.directory,
          projectDirectory: record.projectDirectory,
          staged: txn.stagedPathFor(staging, runId, record.directory),
          identity: await txn.entryIdentity(record.directory),
          linked,
          realTarget: linked ? await realpath(record.directory) : null,
          realTargetIdentity: linked ? await txn.targetIdentity(record.directory) : null,
          state: 'PLANNED',
        });
      }
      manifest = {
        version: txn.MANIFEST_VERSION,
        runId,
        path: resumeFrom?.path ?? 'immediate',
        state: 'FENCED',
        createdAt: resumeFrom?.createdAt ?? new Date().toISOString(),
        completedAt: null,
        attempts: resumeFrom?.attempts ?? 0,
        lastError: null,
        settings: {
          removeEmptyProjectDirectory: settings.removeEmptyProjectDirectory,
          purgeSchedules: settings.purgeSchedules,
          purgeSpill: settings.purgeSpill,
          spillRoots: settings.spillRoots,
        },
        targets: [
          ...plan.targets.map((target) => ({
            id: target.id,
            state: 'FENCED',
            sizeBytes: target.sizeBytes,
            checkpoint: fence.tombstones.get(target.id) ?? tombstoneOf(target.header),
          })),
          ...vanished.map((id) => ({
            id,
            state: 'COMMITTED',
            vanished: true,
            sizeBytes: 0,
            checkpoint: resumeFrom?.targets?.find((target) => target.id === id)?.checkpoint ?? null,
          })),
        ],
        entries,
        steps: { ...(resumeFrom === undefined ? {} : { quiesce: resumeFrom.steps?.quiesce ?? 'done' }), fence: 'done', commit: 'pending', workspace: 'pending', cache: 'pending', schedules: 'pending', spill: 'pending', cleanup: 'pending', verify: 'pending' },
        outcome: null,
        unverified: [],
      };
      await txn.writeManifest(staging, manifest);
      // Armed before anything moves: a late write-back between the commit and the
      // checkpoint delete must already meet the watcher.
      this.armTombstones(manifest, Date.now() + RETAIN_MANIFEST_MS);

      for (const entry of manifest.entries) {
        try {
          await txn.commitEntry(entry.source, entry.staged);
          entry.state = 'COMMITTED';
        } catch (error) {
          entry.state = 'FAILED';
          warnings.push(`could not move ${entry.source} out of the session tree: ${String(error)}`);
        }
      }
      settleTargetStates(manifest);
      // A target whose directory never left the tree is still a session: its
      // checkpoint is its own again.
      this.disarmTombstones(manifest.targets.filter((target) => target.state !== 'COMMITTED').map((target) => target.id));
      manifest.steps.commit = 'done';
      manifest.state = 'COMMITTED';
      await txn.writeManifest(staging, manifest);
    } finally {
      await fence.release();
    }

    for (const target of manifest.targets) {
      if (target.state === 'COMMITTED') removed.bytesFreed += target.sizeBytes;
    }
    removed.sessionDirectories = manifest.entries.filter((entry) => entry.state === 'COMMITTED').length;
    await this.completeCommitted({ staging, manifest, warnings, removed });
    return this.reportOf(plan.sessionId, plan, manifest, removed, warnings);
  }

  /**
   * The deferred path (DESIGN.md §5.3): record the intent, stop and archive the
   * live targets, and finish when they are cold — on an agent disposal or at the
   * next start. The operator saw and confirmed this in the dialog.
   * @param params.staging - the staging root.
   * @param params.plan - the purge plan.
   * @param params.settings - the settings snapshot.
   * @returns the report.
   */
  async runDeferred({ staging, plan, settings }) {
    const warnings = [];
    const registry = this.ctx.get('workspaceRegistry');
    const archived = new Set(Array.isArray(registry?.archivedSessionIds) ? registry.archivedSessionIds : []);
    const pinned = new Set(Array.isArray(registry?.pinnedSessionIds) ? registry.pinnedSessionIds : []);
    // Snapshot before stopping: the stop deletes every active reminder.
    const reminders = await this.scheduleTasks(plan.targetIds);
    const manifest = {
      version: txn.MANIFEST_VERSION,
      runId: txn.newRunId(),
      path: 'deferred',
      state: 'PENDING',
      createdAt: new Date().toISOString(),
      completedAt: null,
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      settings: {
        removeEmptyProjectDirectory: settings.removeEmptyProjectDirectory,
        purgeSchedules: settings.purgeSchedules,
        purgeSpill: settings.purgeSpill,
        spillRoots: settings.spillRoots,
      },
      targets: await Promise.all(plan.targets.map(async (target) => ({
        id: target.id,
        state: 'PENDING',
        sizeBytes: target.sizeBytes,
        // Kept only while the delete is pending, for the settings page; stripped
        // when the run completes.
        title: await this.titleOf(target),
        checkpoint: tombstoneOf(target.header),
        prior: {
          archived: archived.has(target.id),
          pinned: pinned.has(target.id),
          reminders: reminders.filter((row) => row.sessionId === target.id && row.status === 'active').map(reminderSnapshot),
        },
      }))),
      entries: [],
      steps: { quiesce: 'pending', fence: 'pending', commit: 'pending', workspace: 'pending', cache: 'pending', schedules: 'pending', spill: 'pending', cleanup: 'pending', verify: 'pending' },
      outcome: null,
      unverified: [],
    };
    await txn.writeManifest(staging, manifest);
    manifest.steps.quiesce = await this.quiesce(manifest.targets, warnings);
    await txn.writeManifest(staging, manifest);
    for (const id of plan.targetIds) this.pendingIds.add(id);
    return {
      sessionId: plan.sessionId,
      runId: manifest.runId,
      path: 'deferred',
      deferred: true,
      pendingIds: [...plan.targetIds],
      targets: plan.targetIds,
      removedIds: [],
      failedIds: [],
      forkIds: plan.forkIds,
      removed: emptyCounters(),
      outcome: null,
      unverified: [],
      warnings,
    };
  }

  /**
   * Stop the targets' work and block their wakes: archive with `stopActivity`
   * (the archive set is what a provider's `agent/pre-step` gate reads,
   * `dsh-workspace:512-524`); an already archived id is not stopped by
   * `archiveSession` (`:528`), so it gets the stop request directly.
   * @param targets - the manifest targets (with `prior`).
   * @param warnings - the warning sink.
   * @returns the step state: `'done'`, or `'stop-only'` without a registry.
   */
  async quiesce(targets, warnings) {
    const registry = this.ctx.get('workspaceRegistry');
    for (const target of targets) {
      try {
        if (registry !== undefined && typeof registry.archiveSession === 'function' && target.prior?.archived !== true) {
          await registry.archiveSession(target.id, { stopActivity: true });
        } else {
          await this.ctx.parallel('workspace/session-stop', { sessionId: target.id });
        }
      } catch (error) {
        warnings.push(`could not stop "${target.id}": ${String(error?.message ?? error)}`);
      }
    }
    return registry === undefined || typeof registry.archiveSession !== 'function' ? 'stop-only' : 'done';
  }

  /**
   * Try to finish one deferred delete. Must run under the mutex.
   * @param staging - the staging root.
   * @param manifest - the deferred run's manifest.
   * @returns `{ status: 'done' | 'in-use' | 'failed' | 'stuck', report?, error? }`.
   */
  async attemptDeferred(staging, manifest) {
    if (manifest.state !== 'PENDING') return { status: String(manifest.state).toLowerCase() };
    const warnings = [];
    if (manifest.steps?.quiesce === 'pending') manifest.steps.quiesce = await this.quiesce(manifest.targets, warnings);
    manifest.lastAttemptAt = new Date().toISOString();
    const ids = manifest.targets.map((target) => target.id);
    if (ids.some((id) => this.isLive(id))) {
      await txn.writeManifest(staging, manifest);
      return { status: 'in-use' };
    }
    const index = await indexStoredSessions(this.sessionsRoot());
    const present = ids.map((id) => index.get(id)).filter((record) => record !== undefined);
    const plan = { sessionId: ids[0], targets: present, targetIds: present.map((record) => record.id), forkIds: [], index };
    try {
      const report = await this.runImmediate({
        staging,
        plan,
        settings: { ...manifest.settings, purgeAttachments: false },
        resumeFrom: manifest,
        vanished: ids.filter((id) => !index.has(id)),
      });
      for (const id of ids) this.pendingIds.delete(id);
      for (const warning of warnings) report.warnings.push(warning);
      return { status: 'done', report };
    } catch (error) {
      // If the completion got as far as its own manifest, the run belongs to
      // recovery now: never write the pending manifest back over it.
      const current = await txn.readManifest(txn.runDirectory(staging, manifest.runId));
      if (current !== undefined && current.state !== 'PENDING' && current.state !== 'STUCK') {
        this.warn(`deferred delete ${manifest.runId} stopped after its fence: ${String(error?.message ?? error)}; recovery finishes it`);
        return { status: 'failed', error: String(error?.message ?? error) };
      }
      if (error?.code === 'session-purge/session-live') {
        await txn.writeManifest(staging, manifest);
        return { status: 'in-use' };
      }
      manifest.attempts = (manifest.attempts ?? 0) + 1;
      manifest.lastError = String(error?.message ?? error);
      if (manifest.attempts >= MAX_DEFERRED_ATTEMPTS) manifest.state = 'STUCK';
      await txn.writeManifest(staging, manifest);
      this.warn(`deferred delete ${manifest.runId} failed (attempt ${String(manifest.attempts)}): ${manifest.lastError}`);
      return { status: manifest.state === 'STUCK' ? 'stuck' : 'failed', error: manifest.lastError };
    }
  }

  /**
   * Try every pending deferred delete soon, retrying while a session is still
   * owned — a disposal releases its write handle only after the final drain.
   * @param delayMs - when to try.
   * @param retries - how many more tries an `in-use` answer earns.
   */
  scheduleDeferred(delayMs, retries) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.processDeferred()
        .then((statuses) => {
          if (retries > 0 && statuses.includes('in-use')) this.scheduleDeferred(delayMs * 2, retries - 1);
        })
        .catch((error) => this.warn(`deferred deletes could not run: ${String(error?.message ?? error)}`));
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  /**
   * One pass over the pending deferred deletes.
   * @returns the attempt statuses.
   */
  async processDeferred() {
    let staging;
    try {
      staging = await txn.stagingRootFor(this.sessionsRoot());
      await stat(staging);
    } catch {
      return [];
    }
    return this.exclusive(staging, async () => {
      const statuses = [];
      for (const run of await txn.listRuns(staging)) {
        if (run.manifest?.outcome !== null || run.manifest?.state !== 'PENDING') continue;
        statuses.push((await this.attemptDeferred(staging, run.manifest)).status);
      }
      return statuses;
    });
  }

  /**
   * The deferred deletes still waiting, for the settings page.
   * @returns `{ runs }`, one entry per pending or stuck run.
   */
  async pending() {
    let staging;
    try {
      staging = await txn.stagingRootFor(this.sessionsRoot());
    } catch {
      return { runs: [] };
    }
    const runs = [];
    for (const run of await txn.listRuns(staging)) {
      const manifest = run.manifest;
      if (manifest === undefined || manifest.outcome !== null || (manifest.state !== 'PENDING' && manifest.state !== 'STUCK')) continue;
      runs.push({
        runId: manifest.runId,
        state: manifest.state,
        createdAt: manifest.createdAt,
        lastAttemptAt: manifest.lastAttemptAt ?? null,
        attempts: manifest.attempts ?? 0,
        lastError: manifest.lastError ?? null,
        inUse: manifest.targets.some((target) => this.isLive(target.id)),
        targets: manifest.targets.map((target) => ({ sessionId: target.id, title: typeof target.title === 'string' ? target.title : '' })),
      });
    }
    return { runs };
  }

  /**
   * Cancel a deferred delete that has not committed: unarchive and re-pin what
   * it changed, rebuild the reminders the stop deleted, and read it all back.
   * @param runId - the run to cancel.
   * @returns what was restored, and what could not be.
   */
  async cancelPending(runId) {
    const { staging, manifest } = await this.pendingRun(runId);
    return this.exclusive(staging, async () => {
      const current = await txn.readManifest(txn.runDirectory(staging, runId));
      if (current === undefined || current.outcome !== null || (current.state !== 'PENDING' && current.state !== 'STUCK')) {
        throw new RemoteError('session-purge/not-pending', `run "${runId}" is no longer waiting; it cannot be cancelled`, { runId, state: current?.state ?? manifest.state });
      }
      const registry = this.ctx.get('workspaceRegistry');
      const schedule = this.ctx.get('schedule');
      const report = { runId, restored: [], reminders: { recreated: 0, failed: [] }, drift: [], warnings: [] };
      for (const target of current.targets) {
        const prior = target.prior ?? {};
        try {
          if (prior.archived !== true && typeof registry?.unarchiveSession === 'function') await registry.unarchiveSession(target.id);
          // Pinning an archived id throws (`dsh-workspace:581`), so this follows the unarchive.
          if (prior.pinned === true && typeof registry?.pinSession === 'function') await registry.pinSession(target.id);
          report.restored.push(target.id);
        } catch (error) {
          report.warnings.push(`could not restore "${target.id}": ${String(error?.message ?? error)}`);
        }
        for (const snapshot of prior.reminders ?? []) {
          const request = reminderRequest(snapshot);
          if (request === undefined || typeof schedule?.create !== 'function') {
            report.reminders.failed.push({ sessionId: target.id, title: String(snapshot.title ?? ''), reason: request === undefined ? 'cannot-recreate' : 'schedule-unavailable' });
            continue;
          }
          try {
            await schedule.create(target.id, request);
            report.reminders.recreated += 1;
          } catch (error) {
            report.reminders.failed.push({ sessionId: target.id, title: String(snapshot.title ?? ''), reason: String(error?.message ?? error) });
          }
        }
      }
      // No CAS on the registry: read back and report what does not match.
      const archived = Array.isArray(registry?.archivedSessionIds) ? registry.archivedSessionIds : undefined;
      const pinned = Array.isArray(registry?.pinnedSessionIds) ? registry.pinnedSessionIds : undefined;
      for (const target of current.targets) {
        const prior = target.prior ?? {};
        if (archived !== undefined && archived.includes(target.id) !== (prior.archived === true)) report.drift.push({ sessionId: target.id, field: 'archived' });
        if (pinned !== undefined && pinned.includes(target.id) !== (prior.pinned === true)) report.drift.push({ sessionId: target.id, field: 'pinned' });
        this.pendingIds.delete(target.id);
      }
      await txn.removeRun(staging, runId);
      try {
        await txn.appendAudit(staging, { runId, path: 'deferred', outcome: 'cancelled', targets: current.targets.map((target) => ({ id: target.id })), reminders: { recreated: report.reminders.recreated, failed: report.reminders.failed.length }, drift: report.drift.length });
      } catch {
        /* the audit is best effort */
      }
      return report;
    });
  }

  /**
   * Try a deferred delete now; a stuck one starts counting again.
   * @param runId - the run to retry.
   * @returns the attempt's status (and report when it finished).
   */
  async retryPending(runId) {
    const { staging } = await this.pendingRun(runId);
    return this.exclusive(staging, async () => {
      const current = await txn.readManifest(txn.runDirectory(staging, runId));
      if (current === undefined || current.outcome !== null || (current.state !== 'PENDING' && current.state !== 'STUCK')) {
        throw new RemoteError('session-purge/not-pending', `run "${runId}" is no longer waiting`, { runId });
      }
      if (current.state === 'STUCK') {
        current.state = 'PENDING';
        current.attempts = 0;
      }
      return { runId, ...(await this.attemptDeferred(staging, current)) };
    });
  }

  /**
   * The waiting deferred delete that covers any of these sessions.
   * @param ids - session ids.
   * @param stagingRoot - the staging root, when already resolved.
   * @returns its manifest, or `undefined`.
   */
  async pendingCovering(ids, stagingRoot) {
    let staging = stagingRoot;
    if (staging === undefined) {
      try {
        staging = await txn.stagingRootFor(this.sessionsRoot());
      } catch {
        return undefined;
      }
    }
    const wanted = new Set(ids);
    for (const run of await txn.listRuns(staging)) {
      const manifest = run.manifest;
      if (manifest === undefined || manifest.outcome !== null || (manifest.state !== 'PENDING' && manifest.state !== 'STUCK')) continue;
      if (manifest.targets.some((target) => wanted.has(target.id))) return manifest;
    }
    return undefined;
  }

  /**
   * Find a pending run by id.
   * @param runId - the run id from the Client.
   * @returns the staging root and the manifest.
   */
  async pendingRun(runId) {
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
      throw new RemoteError('session-purge/invalid-run-id', 'a run id must look like the ones pending() returns', { runId: String(runId) });
    }
    let staging;
    try {
      staging = await txn.stagingRootFor(this.sessionsRoot());
    } catch {
      throw new RemoteError('session-purge/run-unknown', `no run "${runId}" exists`, { runId });
    }
    const manifest = await txn.readManifest(txn.runDirectory(staging, runId));
    if (manifest === undefined) throw new RemoteError('session-purge/run-unknown', `no run "${runId}" exists`, { runId });
    return { staging, manifest };
  }

  /**
   * Fence the targets: open each for write through the persistence seam.
   *
   * Holding the write handle means the in-process single-writer claim and the
   * cross-process lease are ours (`dsh-session-persistence-jsonl:2488-2556`); a
   * resident session refuses it with `SessionAlreadyOwnedError`. Before trusting
   * that, the fence proves it guards *the directories this plugin will move*: the
   * backend's root must be the configured one, and on POSIX each target's
   * `session.lock` must be contended once the handle is held.
   * @param targets - the plan's targets.
   * @returns `{ owned, tombstones, release }`; `owned` lists live targets (all
   *   handles are already released then).
   */
  async fence(targets) {
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined || typeof persistence.open !== 'function') {
      throw new RemoteError('session-purge/fence-unavailable', 'no session persistence service is mounted, so no write fence can be taken', {});
    }
    if (typeof persistence.root === 'string') {
      const [ours, theirs] = await Promise.all([realpath(this.sessionsRoot()).catch(() => this.sessionsRoot()), realpath(persistence.root).catch(() => persistence.root)]);
      if (ours !== theirs) {
        throw new RemoteError('session-purge/fence-mismatch', `the configured session root "${ours}" is not the persistence backend's root "${theirs}"; a fence there would guard other files`, { configured: ours, backend: theirs });
      }
    }
    const handles = [];
    const leases = [];
    const owned = [];
    const tombstones = new Map();
    const release = async () => {
      for (const handle of handles.splice(0)) {
        try {
          await handle.close();
        } catch (error) {
          this.warn(`could not close a write handle: ${String(error)}`);
        }
      }
      for (const lease of leases.splice(0)) await lease.close().catch(() => undefined);
    };
    try {
      for (const target of [...targets].sort((left, right) => left.id.localeCompare(right.id))) {
        let handle;
        try {
          handle = await persistence.open(target.id, 'write');
        } catch (error) {
          if (isOwned(error)) {
            owned.push(target.id);
            continue;
          }
          if (error?.name === 'SessionPersistenceNotFoundError') {
            throw new RemoteError('session-purge/fence-mismatch', `the persistence backend does not know session "${target.id}", although its directory is under the configured root`, { sessionId: target.id });
          }
          if (error?.name === 'SessionPersistenceCorruptionError' || error?.name === 'SessionFormatUnsupportedError') {
            // Nobody can open this log for write, so nobody writes it; on POSIX
            // the same kernel lease the backend takes still excludes any process
            // that would try (DESIGN.md §6.3).
            const lease = await this.rawLease(target.directory);
            if (lease === 'owned') {
              owned.push(target.id);
              continue;
            }
            if (lease === undefined) {
              throw new RemoteError('session-purge/fence-unavailable', `session "${target.id}" cannot be opened for write (${String(error.name)}) and this platform has no lease to fall back on; use the residue sweep instead`, { sessionId: target.id });
            }
            leases.push(lease);
            tombstones.set(target.id, tombstoneOf(target.header));
            continue;
          }
          throw new RemoteError('session-purge/fence-unavailable', `session "${target.id}" could not be opened for write: ${String(error?.message ?? error)}`, { sessionId: target.id });
        }
        handles.push(handle);
        tombstones.set(target.id, tombstoneOf(handle.header ?? target.header));
        if (!(await this.leaseContended(target.directory))) {
          throw new RemoteError('session-purge/fence-mismatch', `the write handle for session "${target.id}" does not hold the lease of "${target.directory}"; the backend is guarding another directory`, { sessionId: target.id, directory: target.directory });
        }
        // A second directory claiming the same id is not the one the backend
        // opens; hold its lease too so no process can pick it up mid-commit.
        for (const duplicate of target.duplicates) {
          const lease = await this.rawLease(duplicate.directory);
          if (lease === 'owned') {
            owned.push(target.id);
            break;
          }
          if (lease !== undefined) leases.push(lease);
        }
      }
      if (owned.length > 0) await release();
      return { owned, tombstones, release };
    } catch (error) {
      await release();
      throw error;
    }
  }

  /**
   * Whether another descriptor holds a directory's `session.lock` — the check
   * that a held write handle guards this very directory. Without flock (Windows)
   * it cannot be asked; the root comparison is then the only check.
   * @param directory - the session directory.
   * @returns whether the lease is held elsewhere (true when it cannot be probed).
   */
  async leaseContended(directory) {
    if (tryLockExclusive === undefined || process.platform === 'win32') return true;
    let handle;
    try {
      handle = await openFile(join(directory, 'session.lock'), 'r+');
    } catch {
      return false;
    }
    try {
      await tryLockExclusive(handle.fd);
      return false;
    } catch (error) {
      if (error?.code === 'ERR_FLOCK_UNSUPPORTED_PLATFORM') return true;
      return error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK';
    } finally {
      await handle.close();
    }
  }

  /**
   * Take a session directory's kernel lease the way the backend does
   * (`dsh-session-persistence-jsonl:692-712`): open, flock, and check the locked
   * inode is still the file at the path.
   * @param directory - the session directory.
   * @returns the held file handle, `'owned'` under contention, or `undefined`
   *   when this platform has no lease.
   */
  async rawLease(directory) {
    if (tryLockExclusive === undefined || process.platform === 'win32') return undefined;
    const path = join(directory, 'session.lock');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const handle = await openFile(path, 'w', 0o600);
      try {
        await tryLockExclusive(handle.fd);
      } catch (error) {
        await handle.close();
        if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') return 'owned';
        if (error?.code === 'ERR_FLOCK_UNSUPPORTED_PLATFORM') return undefined;
        throw error;
      }
      const held = await handle.stat({ bigint: true });
      const current = await stat(path, { bigint: true }).catch(() => undefined);
      if (current !== undefined && current.ino === held.ino && current.dev === held.dev) return handle;
      await handle.close();
    }
    return 'owned';
  }

  /**
   * Everything after the commit, shared by a fresh purge and by recovery: drop
   * emptied project directories, clear the domains, remove the staged entries,
   * verify, and record the outcome. Idempotent step by step.
   * @param params.staging - the staging root.
   * @param params.manifest - the run's manifest (mutated and persisted).
   * @param params.warnings - the warning sink.
   * @param params.removed - removal counters.
   */
  async completeCommitted({ staging, manifest, warnings, removed }) {
    const committedIds = manifest.targets.filter((target) => target.state === 'COMMITTED').map((target) => target.id);
    const settings = manifest.settings ?? {};

    if (settings.removeEmptyProjectDirectory !== false) {
      const projects = new Set(manifest.entries.filter((entry) => entry.state === 'COMMITTED').map((entry) => entry.projectDirectory));
      for (const project of projects) {
        try {
          await rmdir(project);
          removed.projectDirectories += 1;
        } catch {
          /* a project directory that still holds sessions stays */
        }
      }
    }

    if (manifest.steps.workspace !== 'done') {
      const workspace = await this.detachWorkspaces(committedIds, warnings);
      removed.workspaceSlots += workspace.count;
      manifest.steps.workspace = workspace.available ? 'done' : 'unavailable';
    }
    if (manifest.steps.cache !== 'done') {
      const cache = await this.removeCheckpoints(committedIds, warnings);
      removed.projectionRecords += cache.count;
      manifest.steps.cache = cache.table ? 'done' : 'files-only';
    }
    if (manifest.steps.schedules !== 'done') {
      if (settings.purgeSchedules === false) {
        manifest.steps.schedules = 'skipped';
      } else {
        const schedules = await this.removeSchedules(committedIds, warnings);
        removed.schedules += schedules.count;
        manifest.steps.schedules = schedules.available ? 'done' : 'unavailable';
      }
    }
    if (manifest.steps.spill !== 'done') {
      if (settings.purgeSpill === false) {
        manifest.steps.spill = 'skipped';
      } else {
        removed.spillDirectories += await removeSpillDirectories({ ids: committedIds, roots: await discoverSpillRoots(settings.spillRoots ?? []), warnings });
        manifest.steps.spill = 'done';
      }
    }
    await txn.writeManifest(staging, manifest);
    announceRemoved(this.ctx, committedIds);

    if (manifest.steps.cleanup !== 'done') {
      for (const entry of manifest.entries) {
        if (entry.state !== 'COMMITTED') continue;
        try {
          await txn.cleanupEntry({ stagedPath: entry.staged, linked: entry.linked, realTarget: entry.realTarget, realTargetIdentity: entry.realTargetIdentity }, warnings);
          entry.state = 'CLEANED';
        } catch (error) {
          warnings.push(`could not clean up ${entry.staged}: ${String(error)}`);
        }
      }
      const entriesDirectory = join(txn.runDirectory(staging, manifest.runId), 'entries');
      if (manifest.entries.every((entry) => entry.state !== 'COMMITTED')) {
        await rm(entriesDirectory, { recursive: true, force: true });
        await txn.fsyncDirectory(txn.runDirectory(staging, manifest.runId));
        manifest.steps.cleanup = 'done';
      }
    }

    const verification = await this.verify(committedIds, staging, manifest);
    manifest.steps.verify = 'done';
    manifest.unverified = verification.unverified;
    manifest.outcome = manifest.targets.some((target) => target.state !== 'COMMITTED')
      ? 'failed-partial'
      : verification.failures.length > 0 ? 'incomplete' : verification.unverified.length > 0 ? 'verified-with-gaps' : 'verified';
    for (const failure of verification.failures) warnings.push(`verify: ${failure}`);
    manifest.state = 'DONE';
    manifest.completedAt = new Date().toISOString();
    for (const target of manifest.targets) delete target.title;
    await txn.writeManifest(staging, manifest);
    this.armTombstones(manifest, Date.now() + RETAIN_MANIFEST_MS);
    try {
      await txn.appendAudit(staging, {
        runId: manifest.runId,
        path: manifest.path,
        targets: manifest.targets.map((target) => ({ id: target.id, state: target.state, sizeBytes: target.sizeBytes })),
        steps: manifest.steps,
        outcome: manifest.outcome,
        unverified: manifest.unverified,
      });
    } catch (error) {
      warnings.push(`could not write the audit record: ${String(error)}`);
    }
  }

  /**
   * Read every domain back after a purge (DESIGN.md §9.1).
   * @param ids - the committed session ids.
   * @param staging - the staging root.
   * @param manifest - the run's manifest.
   * @returns `{ failures, unverified }`.
   */
  async verify(ids, staging, manifest) {
    const failures = [];
    const unverified = new Set();
    const persistence = this.ctx.get('sessionPersistence');
    for (const id of ids) {
      if (this.isLive(id)) failures.push(`session "${id}" is live again`);
      if (persistence === undefined || typeof persistence.open !== 'function') {
        unverified.add('persistence');
        continue;
      }
      try {
        const handle = await persistence.open(id, 'read');
        await handle.close?.();
        failures.push(`session "${id}" still opens through the persistence seam`);
      } catch (error) {
        if (error?.name !== 'SessionPersistenceNotFoundError') unverified.add('persistence');
      }
    }

    const table = this.checkpointTable();
    if (table === undefined) unverified.add('checkpoint-memory');
    const checkpointDirectory = join(this.storagesRoot(), 'session_projcache', 'sessions');
    let files = [];
    try {
      files = await readdir(checkpointDirectory);
    } catch {
      /* no checkpoint directory: nothing on disk to find */
    }
    for (const id of ids) {
      if (table !== undefined) {
        try {
          if (table.get(id) !== undefined) failures.push(`checkpoint "${id}" is still in the projection cache`);
        } catch {
          unverified.add('checkpoint-memory');
        }
      }
      if (files.some((file) => file === `${id}.json` || file.startsWith(`${id}.json.`))) failures.push(`checkpoint file of "${id}" is still on disk`);
    }

    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined || typeof registry.list !== 'function') {
      unverified.add('workspace');
    } else {
      try {
        for (const workspace of registry.list()) {
          const raw = Array.isArray(workspace?.record?.sessionIds) ? workspace.record.sessionIds : undefined;
          if (raw === undefined) unverified.add('workspace-raw');
          const view = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : [];
          for (const id of ids) {
            if ((raw ?? []).includes(id) || view.includes(id)) failures.push(`workspace "${String(workspace.id)}" still accounts "${id}"`);
          }
        }
        const archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : undefined;
        const pinned = Array.isArray(registry.pinnedSessionIds) ? registry.pinnedSessionIds : undefined;
        if (archived === undefined || pinned === undefined) unverified.add('workspace-sets');
        for (const id of ids) {
          if ((archived ?? []).includes(id)) failures.push(`"${id}" is still in the archive set`);
          if ((pinned ?? []).includes(id)) failures.push(`"${id}" is still in the pin set`);
        }
      } catch {
        unverified.add('workspace');
      }
    }

    if ((manifest.settings ?? {}).purgeSchedules !== false) {
      const schedule = this.ctx.get('schedule');
      if (schedule === undefined || typeof schedule.catalog !== 'function') {
        unverified.add('schedule');
      } else {
        try {
          const wanted = new Set(ids);
          for (const task of await schedule.catalog()) {
            if (wanted.has(task.sessionId)) failures.push(`reminder "${String(task.id)}" is still bound to "${String(task.sessionId)}"`);
          }
        } catch {
          unverified.add('schedule');
        }
      }
    }

    try {
      await stat(join(txn.runDirectory(staging, manifest.runId), 'entries'));
      failures.push('staged entries are still on disk');
    } catch {
      /* gone, as it should be */
    }
    return { failures, unverified: [...unverified] };
  }

  /**
   * Recover the staging area: finish interrupted runs forward, forget expired
   * ones, re-arm the tombstones of recent ones and re-check their checkpoints.
   * Runs once at startup; tests call it directly.
   * @returns what the pass did.
   */
  async recover() {
    let staging;
    try {
      staging = await txn.stagingRootFor(this.sessionsRoot());
      // Nothing was ever staged: do not create the staging area just to look.
      await stat(staging);
    } catch {
      return { resumed: [], expired: [], abandoned: [], unknown: [], resurrections: 0 };
    }
    return this.exclusive(staging, async () => {
      const report = { resumed: [], expired: [], abandoned: [], unknown: [], resurrections: 0 };
      for (const run of await txn.listRuns(staging)) {
        const manifest = run.manifest;
        if (manifest === undefined) {
          report.unknown.push(run.runId);
          this.warn(`unknown residue in the staging area, left alone: ${run.directory}`);
          continue;
        }
        if (manifest.outcome !== null) {
          const completedAt = Date.parse(manifest.completedAt ?? manifest.createdAt);
          if (!Number.isFinite(completedAt) || Date.now() - completedAt > RETAIN_MANIFEST_MS) {
            await txn.removeRun(staging, run.runId);
            report.expired.push(run.runId);
            continue;
          }
          this.armTombstones(manifest, completedAt + RETAIN_MANIFEST_MS);
          report.resurrections += await this.recheckCheckpoints(manifest);
          if (manifest.steps?.cleanup !== 'done') await this.retryCleanup(staging, manifest);
          continue;
        }
        if (manifest.state === 'PENDING' || manifest.state === 'STUCK') {
          for (const target of manifest.targets) this.pendingIds.add(target.id);
          if (manifest.state === 'PENDING') {
            const attempt = await this.attemptDeferred(staging, manifest);
            (report.deferred ??= []).push({ runId: run.runId, status: attempt.status });
          }
          continue;
        }
        const outcome = await this.resume(staging, manifest);
        (outcome === 'abandoned' ? report.abandoned : report.resumed).push(run.runId);
      }
      return report;
    });
  }

  /**
   * Finish one interrupted run, trusting the filesystem over the manifest: an
   * entry is committed when its staged path carries the recorded identity.
   * @param staging - the staging root.
   * @param manifest - the run's manifest.
   * @returns `'abandoned'` when nothing had moved, else `'resumed'`.
   */
  async resume(staging, manifest) {
    const warnings = [];
    const removed = emptyCounters();
    const relocate = [];
    for (const entry of manifest.entries) {
      if (entry.state === 'CLEANED') continue;
      const staged = await txn.entryIdentity(entry.staged);
      const source = await txn.entryIdentity(entry.source);
      if (staged !== undefined && staged === entry.identity) {
        entry.state = 'COMMITTED';
      } else if (source !== undefined && source === entry.identity) {
        // Still in the tree. When the manifest says the commit finished, the
        // rename did not survive (its directory entry was never flushed): redo it.
        if (manifest.steps.commit === 'done' && entry.state === 'COMMITTED') relocate.push(entry);
        else entry.state = 'FAILED';
      } else if (source !== undefined || staged !== undefined) {
        entry.state = 'DRIFT';
        warnings.push(`identity-drift: ${entry.source} is no longer the directory this run recorded; left alone`);
      } else if (entry.state === 'COMMITTED') {
        entry.state = 'CLEANED';
      } else {
        entry.state = 'FAILED';
      }
    }
    if (relocate.length > 0) {
      const ids = [...new Set(relocate.map((entry) => entry.id))];
      const targets = ids.map((id) => ({ id, directory: relocate.find((entry) => entry.id === id && entry.primary)?.source ?? relocate.find((entry) => entry.id === id).source, header: {}, duplicates: [] }));
      let fence;
      try {
        fence = await this.fence(targets);
        for (const entry of relocate) {
          if (fence.owned.includes(entry.id)) {
            entry.state = 'FAILED';
            warnings.push(`session "${entry.id}" came back to life before its interrupted commit could be redone; left in place`);
            continue;
          }
          try {
            await txn.commitEntry(entry.source, entry.staged);
            entry.state = 'COMMITTED';
          } catch (error) {
            entry.state = 'FAILED';
            warnings.push(`could not redo the commit of ${entry.source}: ${String(error)}`);
          }
        }
      } catch (error) {
        for (const entry of relocate) entry.state = 'FAILED';
        warnings.push(`could not fence the interrupted commit: ${String(error?.message ?? error)}`);
      } finally {
        await fence?.release();
      }
    }
    settleTargetStates(manifest);
    this.disarmTombstones(manifest.targets.filter((target) => target.state !== 'COMMITTED').map((target) => target.id));
    if (!manifest.targets.some((target) => target.state === 'COMMITTED')) {
      // Nothing left the tree: the run never passed its commit point, and the
      // handles it held died with its process. There is nothing to undo.
      await txn.removeRun(staging, manifest.runId);
      try {
        await txn.appendAudit(staging, { runId: manifest.runId, path: manifest.path, outcome: 'abandoned', targets: manifest.targets.map((target) => ({ id: target.id })) });
      } catch {
        /* the audit is best effort */
      }
      return 'abandoned';
    }
    manifest.steps.commit = 'done';
    manifest.state = 'COMMITTED';
    this.armTombstones(manifest, Date.now() + RETAIN_MANIFEST_MS);
    await txn.writeManifest(staging, manifest);
    await this.completeCommitted({ staging, manifest, warnings, removed });
    for (const warning of warnings) this.warn(`recovery of ${manifest.runId}: ${warning}`);
    return 'resumed';
  }

  /**
   * Retry the cleanup of a finished run whose staged entries could not all be
   * removed the first time.
   * @param staging - the staging root.
   * @param manifest - the finished run's manifest.
   */
  async retryCleanup(staging, manifest) {
    const warnings = [];
    for (const entry of manifest.entries) {
      if (entry.state !== 'COMMITTED') continue;
      try {
        await txn.cleanupEntry({ stagedPath: entry.staged, linked: entry.linked, realTarget: entry.realTarget, realTargetIdentity: entry.realTargetIdentity }, warnings);
        entry.state = 'CLEANED';
      } catch (error) {
        warnings.push(`could not clean up ${entry.staged}: ${String(error)}`);
      }
    }
    if (manifest.entries.every((entry) => entry.state !== 'COMMITTED')) {
      await rm(join(txn.runDirectory(staging, manifest.runId), 'entries'), { recursive: true, force: true });
      manifest.steps.cleanup = 'done';
    }
    await txn.writeManifest(staging, manifest);
    for (const warning of warnings) this.warn(`cleanup retry of ${manifest.runId}: ${warning}`);
  }

  /**
   * Arm the tombstones of a run's committed targets.
   * @param manifest - the run's manifest.
   * @param expiresAt - when the tombstones lapse.
   */
  armTombstones(manifest, expiresAt) {
    for (const target of manifest.targets) {
      if (target.state === 'FAILED' || target.checkpoint === undefined || target.checkpoint === null) continue;
      if (typeof target.checkpoint.createdAt !== 'number') continue;
      this.tombstones.set(target.id, { createdAt: target.checkpoint.createdAt, cwd: target.checkpoint.cwd, expiresAt });
    }
  }

  /**
   * Forget tombstones whose sessions turned out not to be deleted.
   * @param ids - the session ids.
   */
  disarmTombstones(ids) {
    for (const id of ids) this.tombstones.delete(id);
  }

  /**
   * Delete a checkpoint written back for a deleted log (DESIGN.md §10.2). The
   * event arrives after durability in write-chain order, so the delete lands
   * after the write it answers. Identity decides, not the id: a new session that
   * reuses the id keeps its checkpoint.
   * @param change - the `domain/changed` payload.
   */
  onDomainChanged(change) {
    if (change?.domain !== CHECKPOINT_DOMAIN || change.operation !== 'put') return;
    const tombstone = this.tombstones.get(change.key);
    if (tombstone === undefined) return;
    if (tombstone.expiresAt < Date.now()) {
      this.tombstones.delete(change.key);
      return;
    }
    if (!txn.checkpointIdentityMatches(tombstone, change.value?.identity)) return;
    const table = this.checkpointTable();
    if (table === undefined) return;
    table.delete(change.key).then(
      () => this.warn(`removed a checkpoint written back for deleted session "${String(change.key)}"`),
      (error) => this.warn(`could not remove a written-back checkpoint of "${String(change.key)}": ${String(error)}`),
    );
  }

  /**
   * Startup half of the convergence: a write-back that landed after the
   * watcher's process died is still on disk; delete it.
   * @param manifest - a finished run's manifest.
   * @returns how many checkpoints were removed.
   */
  async recheckCheckpoints(manifest) {
    const table = this.checkpointTable();
    if (table === undefined) return 0;
    let removed = 0;
    for (const target of manifest.targets) {
      const tombstone = this.tombstones.get(target.id);
      if (tombstone === undefined) continue;
      try {
        const record = table.get(target.id);
        if (record !== undefined && txn.checkpointIdentityMatches(tombstone, record.identity) && await table.delete(target.id)) removed += 1;
      } catch (error) {
        this.warn(`could not re-check the checkpoint of "${target.id}": ${String(error)}`);
      }
    }
    return removed;
  }

  /**
   * The projection checkpoint table, through the storage facility's documented
   * diagnostic lookup (`docs:reference/subsystems/storage`, "get(name) is an
   * untyped diagnostic lookup"). The handle is the same stable table the cache
   * writes (`dsh-storage-domain:187-191`), so a delete shares its write chain.
   * @returns the table, or `undefined` when it cannot be reached.
   */
  checkpointTable() {
    try {
      const table = this.ctx.get('storageDomain')?.get?.(CHECKPOINT_DOMAIN)?.table?.(CHECKPOINT_TABLE);
      return typeof table?.delete === 'function' && typeof table?.get === 'function' ? table : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Delete the checkpoints of the committed sessions: through the table when it
   * is reachable (memory and disk change together), then whatever backup or
   * temporary file the table does not track.
   * @param ids - the session ids.
   * @param warnings - the warning sink.
   * @returns `{ count, table }`.
   */
  async removeCheckpoints(ids, warnings) {
    const table = this.checkpointTable();
    let count = 0;
    if (table === undefined) {
      warnings.push('the projection checkpoint table is unreachable: checkpoint files are removed directly, and a cached row may stay in memory until restart');
    } else {
      for (const id of ids) {
        try {
          if (await table.delete(id)) count += 1;
        } catch (error) {
          warnings.push(`could not delete the checkpoint of "${id}": ${String(error)}`);
        }
      }
    }
    count += await removeProjectionRecords({ storagesRoot: this.storagesRoot(), ids, warnings });
    return { count, table: table !== undefined };
  }

  /**
   * List — and, on request, delete — session directories whose header cannot be
   * read.
   *
   * dsh's persistence backend omits an unreadable header from discovery and
   * `list()`, so these directories are invisible in the interface and can never
   * be selected for deletion, yet they keep their bytes. The call is its own
   * preview: `apply: false` reports exactly what `apply: true` would remove, and
   * the deletion recomputes the set on the Host — the browser never supplies a path.
   *
   * @param apply - whether to delete the reported directories.
   * @param signal - aborts between directories.
   * @returns the residue, its total size, and what the call removed.
   */
  async sweepResidue(apply, signal) {
    const root = this.sessionsRoot();
    const scan = await scanResidue({ root, minimumAgeMs: RESIDUE_MIN_AGE_MS, signal });
    const warnings = [];
    const report = {
      root,
      apply: apply === true,
      bytes: scan.bytes,
      removed: 0,
      failed: 0,
      directories: scan.directories.map((entry) => ({ directory: entry.directory, sizeBytes: entry.sizeBytes })),
      warnings,
    };
    if (apply !== true) return report;
    const projects = new Set();
    for (const entry of scan.directories) {
      throwIfAborted(signal);
      projects.add(entry.projectDirectory);
      try {
        await rm(entry.directory, { recursive: true, force: true });
        report.removed += 1;
      } catch (error) {
        report.failed += 1;
        warnings.push(`could not remove residue ${entry.directory}: ${String(error)}`);
      }
    }
    if (this.setting('removeEmptyProjectDirectory', true) !== false) {
      for (const project of projects) {
        try {
          await rmdir(project);
        } catch {
          /* the project directory still holds something */
        }
      }
    }
    return report;
  }

  /**
   * The attachment gc (DESIGN.md §11), separate from any delete and never run on
   * its own. Attachment bytes are content-addressed and shared, and a client's
   * unsent draft can point at one no log mentions yet, so reclaiming is slow on
   * purpose:
   *
   *   status   what round one recorded, and when round two may run;
   *   scan     round one — record unreferenced objects older than the grace
   *            period as candidates; nothing is deleted;
   *   collect  round two, at least a day later — mark again and delete only
   *            candidates that are still unreferenced, while an insertion
   *            barrier on `session/event` withdraws any digest a new event names.
   *
   * Any log that cannot be read in full, or any session-shaped directory whose
   * header cannot be read, stops the whole pass: a hidden reference would make a
   * delete irreversible damage.
   * @param mode - `'status'`, `'scan'` or `'collect'`.
   * @param signal - aborts the marking.
   * @returns what the pass found or did.
   */
  async attachmentGc(mode, signal) {
    // The barrier goes up before anything awaits: from here to the last unlink,
    // a reference written anywhere in this process withdraws its digest.
    const withdrawn = new Set();
    const lowerBarrier = mode === 'collect'
      ? this.ctx.on('session/event', (_session, event) => { for (const digest of digestsIn(event)) withdrawn.add(digest); })
      : () => undefined;
    try {
      if (mode !== 'status' && mode !== 'scan' && mode !== 'collect') {
        throw new RemoteError('session-purge/invalid-gc-mode', 'mode must be status, scan or collect', { mode: String(mode) });
      }
      const root = this.sessionsRoot();
      let staging;
      try {
        staging = await txn.stagingRootFor(root);
      } catch {
        throw new RemoteError('session-purge/session-unknown', `the session root "${root}" does not exist`, { root });
      }
      const candidatesPath = join(staging, 'gc', 'candidates.json');
      const readCandidates = async () => {
        try {
          const value = JSON.parse(await readFile(candidatesPath, 'utf8'));
          return value?.version === 1 && Array.isArray(value.digests) && typeof value.markedAt === 'number' ? value : undefined;
        } catch {
          return undefined;
        }
      };
      if (mode === 'status') {
        const candidates = await readCandidates();
        return {
          mode,
          candidates: candidates?.digests.length ?? 0,
          markedAt: candidates?.markedAt ?? null,
          eligibleAt: candidates === undefined ? null : candidates.markedAt + GC_ROUND_GAP_MS,
          bytes: candidates?.bytes ?? 0,
        };
      }
      return await this.exclusive(staging, async () => {
        const manifestFiles = [this.llmFilesPath()];
        const now = Date.now();
        if (mode === 'scan') {
          const mark = await markAttachmentRoots({ sessionsRoot: root, manifestFiles, signal });
          if (!mark.complete) return { mode, aborted: true, reason: mark.reason, candidates: 0, bytes: 0 };
          const objects = (await listAttachmentObjects(this.attachmentsRoot()))
            .filter((object) => !mark.referenced.has(object.digest) && now - object.modifiedAt >= GC_GRACE_MS);
          const digests = [...new Set(objects.map((object) => object.digest))];
          const bytes = objects.reduce((total, object) => total + object.sizeBytes, 0);
          await mkdir(join(staging, 'gc'), { recursive: true, mode: 0o700 });
          await txn.writeJsonDurable(candidatesPath, { version: 1, markedAt: now, digests, bytes });
          return { mode, aborted: false, candidates: digests.length, bytes, eligibleAt: now + GC_ROUND_GAP_MS };
        }
        const candidates = await readCandidates();
        if (candidates === undefined) {
          throw new RemoteError('session-purge/gc-no-candidates', 'run the first round (scan) before collecting', {});
        }
        if (now - candidates.markedAt < GC_ROUND_GAP_MS) {
          throw new RemoteError('session-purge/gc-too-early', 'the second round runs at least a day after the first, so references created in between are seen', { eligibleAt: candidates.markedAt + GC_ROUND_GAP_MS });
        }
        const mark = await markAttachmentRoots({ sessionsRoot: root, manifestFiles, signal });
        if (!mark.complete) return { mode, aborted: true, reason: mark.reason, removed: 0, links: 0, bytes: 0, kept: candidates.digests.length };
        const present = new Map((await listAttachmentObjects(this.attachmentsRoot())).map((object) => [object.digest, object]));
        const warnings = [];
        const report = { mode, aborted: false, removed: 0, links: 0, bytes: 0, kept: 0, warnings };
        for (const digest of candidates.digests) {
          const object = present.get(digest);
          // Withdrawn by the barrier, referenced again, or touched since round one.
          if (object === undefined || withdrawn.has(digest) || mark.referenced.has(digest) || now - object.modifiedAt < GC_GRACE_MS) {
            report.kept += 1;
            continue;
          }
          const removed = await removeAttachments({ root: this.attachmentsRoot(), digests: [digest], warnings });
          report.removed += removed.objects;
          report.links += removed.links;
          if (removed.objects > 0) report.bytes += object.sizeBytes;
        }
        await rm(candidatesPath, { force: true });
        try {
          await txn.appendAudit(staging, { gc: 'collect', removed: report.removed, kept: report.kept, bytes: report.bytes });
        } catch {
          /* the audit is best effort */
        }
        return report;
      });
    } finally {
      lowerBarrier();
    }
  }

  /** Resolve the DeepSeek adapter's upload manifest, an attachment gc root. */
  llmFilesPath() {
    const configured = this.setting('llmFilesPath', '');
    return configured !== '' ? configured : join(resolveDshHome(), 'llm-deepseek', 'files-v3.json');
  }

  /** Resolve the configured session log root, defaulting to the shipped layout. */
  sessionsRoot() {
    const configured = this.setting('sessionsRoot', '');
    return configured !== '' ? configured : join(resolveDshHome(), 'sessions');
  }

  /** Resolve the configured storage root, defaulting to the shipped layout. */
  storagesRoot() {
    const configured = this.setting('storagesRoot', '');
    return configured !== '' ? configured : join(resolveDshHome(), 'storages');
  }

  /** Resolve the configured attachment root, defaulting to the shipped layout. */
  attachmentsRoot() {
    const configured = this.setting('attachmentsRoot', '');
    return configured !== '' ? configured : join(resolveDshHome(), 'attachments');
  }

  /**
   * Whether this process holds a live Agent or Session for an id. Advisory: the
   * preview shows it, and the fence re-checks it under the write handle.
   * @param sessionId - the candidate.
   * @returns whether the id is live here.
   */
  isLive(sessionId) {
    return this.ctx.get('agents')?.get(sessionId) !== undefined || this.ctx.get('sessions')?.get(sessionId) !== undefined;
  }

  /**
   * A title for the dialog: the projection checkpoint when it has one, else the
   * last title the log recorded.
   * @param target - an indexed session.
   * @returns the title, or an empty string.
   */
  async titleOf(target) {
    const cached = await readCachedTitle({ storagesRoot: this.storagesRoot(), sessionId: target.id });
    if (cached !== undefined) return cached;
    return (await readStoredTitle(target.directory)) ?? '';
  }

  /**
   * Read every task bound to the targets through the Schedule service, which
   * owns the durable rows. `catalog()` lists every row whatever its status
   * (`dsh-schedule:2129-2136`); an inactive row still carries its delivery
   * history and instruction snapshots, so it is just as much the session's.
   * @param ids - the session ids.
   * @returns the matching task records, each carrying its own session binding.
   */
  async scheduleTasks(ids) {
    const schedule = this.ctx.get('schedule');
    if (schedule === undefined || typeof schedule.catalog !== 'function') return [];
    const wanted = new Set(ids);
    try {
      return (await schedule.catalog()).filter((task) => wanted.has(task.sessionId));
    } catch {
      return [];
    }
  }

  /**
   * Delete the reminders bound to the targets.
   * @param ids - the session ids.
   * @param warnings - the operation's warning sink.
   * @returns `{ count, available }`.
   */
  async removeSchedules(ids, warnings) {
    const schedule = this.ctx.get('schedule');
    if (schedule === undefined || typeof schedule.delete !== 'function' || typeof schedule.catalog !== 'function') return { count: 0, available: false };
    let count = 0;
    for (const task of await this.scheduleTasks(ids)) {
      try {
        const result = await schedule.delete({ sessionId: task.sessionId, id: task.id });
        if (result?.deleted === true) count += 1;
      } catch (error) {
        warnings.push(`could not delete reminder ${String(task.id)}: ${String(error)}`);
      }
    }
    return { count, available: true };
  }

  /**
   * Drop every id from the Workspace registry's accounting slots, archive set and
   * pin set, through the registry's own methods.
   *
   * After the commit the filtered `sessionIds` view may already hide the id
   * (`dsh-workspace:102-104`): it only lists ids whose header the index still
   * maps to a path. The raw record keeps the slot until the next mutation prunes
   * it. So a workspace is selected by either, and `detachSession` — which
   * rewrites the raw record and is idempotent (`dsh-workspace:148-152`) — is
   * called only on workspaces that actually account the id, never on the others.
   * @param ids - the session ids.
   * @param warnings - the operation's warning sink.
   * @returns `{ count, available }`.
   */
  async detachWorkspaces(ids, warnings) {
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined || typeof registry.list !== 'function') return { count: 0, available: false };
    let count = 0;
    for (const workspace of registry.list()) {
      const raw = Array.isArray(workspace?.record?.sessionIds) ? workspace.record.sessionIds : [];
      const view = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : [];
      for (const id of ids) {
        if (!raw.includes(id) && !view.includes(id)) continue;
        try {
          await workspace.detachSession(id);
          count += 1;
        } catch (error) {
          warnings.push(`could not detach "${id}" from workspace "${String(workspace.id)}": ${String(error)}`);
        }
      }
    }
    for (const id of ids) {
      for (const [label, operation] of [['archive', 'unarchiveSession'], ['pin', 'unpinSession']]) {
        if (typeof registry[operation] !== 'function') continue;
        try {
          await registry[operation](id);
        } catch (error) {
          warnings.push(`could not clear the ${label} entry of "${id}": ${String(error)}`);
        }
      }
    }
    return { count, available: true };
  }

  /**
   * The report the Client half renders.
   * @param sessionId - the selected session.
   * @param plan - the purge plan.
   * @param manifest - the finished run's manifest.
   * @param removed - removal counters.
   * @param warnings - the warning sink.
   * @returns the report.
   */
  reportOf(sessionId, plan, manifest, removed, warnings) {
    const removedIds = manifest.targets.filter((target) => target.state === 'COMMITTED').map((target) => target.id);
    const failedIds = manifest.targets.filter((target) => target.state !== 'COMMITTED').map((target) => target.id);
    for (const id of failedIds) warnings.push(`session "${id}" was not removed: its directory could not be moved out of the session tree, so nothing else about it was changed`);
    return {
      sessionId,
      runId: manifest.runId,
      path: manifest.path,
      targets: plan.targetIds,
      removedIds,
      failedIds,
      forkIds: plan.forkIds,
      removed,
      outcome: manifest.outcome,
      unverified: manifest.unverified,
      warnings,
    };
  }
}

markRemoteMethods(SessionPurgeService.prototype, ['inspect', 'purge', 'sweepResidue', 'pending', 'cancelPending', 'retryPending', 'attachmentGc']);

/**
 * The checkpoint identity a stored header witnesses, reduced to what tells two
 * lives of one id apart (see `txn.checkpointIdentityMatches`).
 * @param header - a session header.
 * @returns `{ createdAt, cwd? }`, or `null` without a usable `createdAt`.
 */
function tombstoneOf(header) {
  if (typeof header?.createdAt !== 'number') return null;
  return typeof header.cwd === 'string' ? { createdAt: header.createdAt, cwd: header.cwd } : { createdAt: header.createdAt };
}

/**
 * A target is committed when its primary directory left the tree.
 * @param manifest - the manifest whose target states are derived from its entries.
 */
function settleTargetStates(manifest) {
  for (const target of manifest.targets) {
    if (target.vanished === true) continue;
    const primary = manifest.entries.find((entry) => entry.id === target.id && entry.primary);
    target.state = primary !== undefined && (primary.state === 'COMMITTED' || primary.state === 'CLEANED') ? 'COMMITTED' : 'FAILED';
  }
}

/**
 * The refusal for targets that are live in this process.
 * @param ids - the live session ids.
 * @returns the Remote error.
 */
function liveError(ids) {
  return new RemoteError(
    'session-purge/session-live',
    `session "${ids[0]}" is still resident in this harness process; it can only be deleted once it is cold`,
    { sessionIds: ids },
  );
}

/**
 * The refusal for a target that came to life after a preview that showed it cold.
 * @param ids - the session ids.
 * @returns the Remote error.
 */
function becameLiveError(ids) {
  return new RemoteError(
    'session-purge/became-live',
    `session "${String(ids[0])}" was opened after the dialog showed it as cold; reopen the dialog to confirm stopping it`,
    { sessionIds: ids },
  );
}

/**
 * The minimal reminder record a cancelled deferred delete needs to rebuild a
 * reminder that `stopActivity` deleted (DESIGN.md §5.3).
 * @param row - a `schedule.catalog()` row.
 * @returns the snapshot.
 */
function reminderSnapshot(row) {
  const snapshot = {};
  for (const field of ['id', 'kind', 'title', 'prompt', 'scheduledAt', 'afterSeconds', 'everySeconds', 'time', 'timeZone', 'weekdays', 'expression']) {
    if (row?.[field] !== undefined) snapshot[field] = row[field];
  }
  return snapshot;
}

/**
 * The `schedule.create` request that recreates a snapshot (`ScheduleCreateRequest`,
 * `docs:reference/subsystems/schedule`; selectors read at `dsh-schedule:2084-2094`).
 * A one-shot keeps its absolute target; a past one cannot be recreated.
 * @param snapshot - a {@link reminderSnapshot}.
 * @returns the request, or `undefined` when it cannot be recreated.
 */
function reminderRequest(snapshot) {
  const base = { title: snapshot.title, prompt: snapshot.prompt };
  switch (snapshot.kind) {
    case 'at':
    case 'after':
      return Date.parse(snapshot.scheduledAt) > Date.now() ? { ...base, at: snapshot.scheduledAt } : undefined;
    case 'every':
      return typeof snapshot.everySeconds === 'number' ? { ...base, every_seconds: snapshot.everySeconds } : undefined;
    case 'daily':
      return { ...base, daily: { time: snapshot.time, time_zone: snapshot.timeZone } };
    case 'weekly':
      return { ...base, weekly: { time: snapshot.time, time_zone: snapshot.timeZone, weekdays: snapshot.weekdays } };
    case 'cron':
      return { ...base, cron: { expression: snapshot.expression, time_zone: snapshot.timeZone } };
    default:
      return undefined;
  }
}

/**
 * Notify connected browsers that a session is gone, so rows and dependent panels
 * drop it at once. `api-session/removed` is one of the Host events the API layer
 * forwards to every client; a purge of an already-cold session has no
 * `session/disposed` of its own to do this.
 * @param ctx - the plugin context.
 * @param sessionIds - the removed session ids.
 */
function announceRemoved(ctx, sessionIds) {
  for (const sessionId of sessionIds) {
    try {
      ctx.emit('api-session/removed', sessionId);
    } catch (error) {
      ctx.logger?.warn?.(`session-purge: could not announce removal of "${sessionId}": ${String(error)}`);
    }
  }
}

/**
 * Refuse anything that cannot be a session id before it is used as a path segment
 * or a map key.
 * @param value - the candidate id.
 */
function assertSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || /[/\\\0]/.test(value)) {
    throw new RemoteError('session-purge/invalid-session-id', 'a session id must be a non-empty path-safe string', { sessionId: String(value) });
  }
}

/**
 * Mount the purge service for one profile row.
 * @param ctx - the plugin context.
 * @param config - the row configuration.
 */
export function apply(ctx, config) {
  new SessionPurgeService(ctx, config);
}

export { SessionPurgeService };
