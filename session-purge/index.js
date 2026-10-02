/**
 * Session Purge — host half.
 *
 * Deleting a session is out-of-band by design: the Session persistence seam has
 * no delete interface (its reader accumulates logs "until an external removal"),
 * so a purge is a coordinated filesystem sweep plus the reference bookkeeping the
 * composed Host already owns. This half owns the pieces that need a live Host —
 * the liveness guard, the Workspace registry, the Schedule service and the
 * browser notification — and delegates every filesystem step to `engine.js`,
 * which stays testable on its own.
 *
 * What one session owns, and what this removes:
 *
 *   1. its session directory under the log root (all format generations plus
 *      `session.lock`), including subagent children, which are ordinary stored
 *      sessions linked by `parentSession`;
 *   2. its projection checkpoint (`session_projcache`);
 *   3. its Workspace accounting slot, archive entry and pin entry — through the
 *      registry's own methods, never by editing `workspace.json`;
 *   4. its reminders — through the Schedule service, because a reminder that
 *      outlives its session keeps firing into a log that no longer exists;
 *   5. its spilled tool output;
 *   6. optionally, attachment objects no surviving session references.
 *
 * Liveness is a hard guard, not a warning. A session resident in this process
 * still holds a write handle and a checkpoint obligation, so deleting its files
 * under it would either fail silently (writes to an unlinked inode) or rebuild
 * the checkpoint on disposal. The purge refuses while any target is live here and
 * names them, so the Client can say what to do about it (restart, then delete).
 *
 * @module @jedeiah/session-purge
 */
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import {
  discoverSpillRoots,
  throwIfAborted,
  planPurge,
  readCachedTitle,
  readStoredTitle,
  removeAttachments,
  removeProjectionRecords,
  removeSessionDirectories,
  removeSpillDirectories,
  unreferencedDigests,
} from './engine.js';

/*
 * Imported through `import()` rather than a static import: measured on dsh
 * 0.2.0-rc.2, a static import of a dsh package inside a profile-linked bundle can
 * fail to resolve, and the loader then reports only "failed to import".
 */
let RemoteError;
let TypertRemoteService;
let resolveDshHome;
try {
  ({ RemoteError, TypertRemoteService } = await import('@deepseek-ai/dsh-typert-protocol'));
  ({ resolveDshHome } = await import('@deepseek-ai/dsh-home-paths'));
} catch (error) {
  throw new Error('session-purge: could not import the dsh packages this bundle is built on', { cause: error });
}

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'session-purge';

/**
 * Liveness is answered by the Agent and Session registries. Every other service
 * this plugin touches is looked up per call, so a composition without the
 * Schedule plugin or without a Workspace registry still loads and simply purges
 * less.
 */
export const inject = ['agents', 'sessions'];

/** Row configuration. Volatile fields are the ones surfaced on the Plugins page. */
export const Config = z.object({
  /** Session log root; empty resolves `$DSH_HOME/sessions`, the shipped backend's root. */
  sessionsRoot: z.string().default(''),
  /** Storage domain root; empty resolves `$DSH_HOME/storages`. */
  storagesRoot: z.string().default(''),
  /** Attachment object root; empty resolves `$DSH_HOME/attachments`. */
  attachmentsRoot: z.string().default(''),
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
   * Delete attachment objects no surviving session references. Off by default:
   * attachment bytes are de-duplicated across sessions, so this is a corpus-wide
   * reference scan rather than a per-session delete.
   */
  purgeAttachments: z.boolean().default(false).volatile(),
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

/** The Remote service: a read-only preview, and the purge itself. */
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
      includeDescendants: this.setting('includeDescendants', true) !== false,
      removeEmptyProjectDirectory: this.setting('removeEmptyProjectDirectory', true) !== false,
      purgeSchedules: this.setting('purgeSchedules', true) !== false,
      purgeSpill: this.setting('purgeSpill', true) !== false,
      purgeAttachments: this.setting('purgeAttachments', false) === true,
    };
  }

  /**
   * Describe what deleting one session would remove, without writing anything.
   * The dialog needs answers a browser cannot derive: whether a target is still
   * live here (and therefore refuses deletion), which subagent descendants come
   * with it, how much disk and how many reminders the operation would clear.
   * @param sessionId - the session the operator selected.
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
    this.previewed.set(sessionId, { ids: [...plan.targetIds], at: Date.now() });
    return {
      sessionId,
      root,
      live: this.isLive(sessionId),
      forkIds: plan.forkIds,
      logBytes: plan.logBytes,
      spillBytes: plan.spillBytes,
      blocked: live.length === 0 ? null : { reason: 'live-session', sessionIds: live },
      sizeBytes: plan.sizeBytes,
      scheduleCount: schedules.length,
      spillDirectoryCount: plan.spillDirectories.length,
      includeDescendants: settings.includeDescendants,
      purgeAttachments: settings.purgeAttachments,
      targets: await Promise.all(plan.targets.map(async (target) => ({
        sessionId: target.id,
        title: await this.titleOf(target),
        cwd: typeof target.header.cwd === 'string' ? target.header.cwd : null,
        createdAt: target.header.createdAt,
        origin: target.header.origin === 'subagent' ? 'subagent' : 'root',
        delegationDepth: target.header.delegationDepth ?? 0,
        parentSession: typeof target.header.parentSession === 'string' ? target.header.parentSession : null,
        live: this.isLive(target.id),
        sizeBytes: target.sizeBytes,
      }))),
    };
  }

  /**
   * Delete one session and, by configuration, its subagent descendants.
   * @param sessionId - the session the operator selected.
   * @returns the report the Client half shows.
   */
  async purge(sessionId, signal) {
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
    if (live.length > 0) {
      throw new RemoteError(
        'session-purge/session-live',
        `session "${live[0]}" is still resident in this harness process; deleting it now would leave a live writer behind a removed log and rebuild its projection checkpoint on disposal`,
        { sessionIds: live },
      );
    }

    // The preview is the contract with the operator: if the set grew since the
    // dialog rendered (a child was created), stop and make them look again.
    const previewed = this.previewed.get(sessionId);
    this.previewed.delete(sessionId);
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

    const warnings = [];
    const removed = { sessionDirectories: 0, projectDirectories: 0, projectionRecords: 0, spillDirectories: 0, schedules: 0, workspaceSlots: 0, attachmentObjects: 0, attachmentLinks: 0, bytesFreed: 0 };
    const digests = settings.purgeAttachments
      ? await unreferencedDigests({
        doomed: plan.targets.map((target) => target.directory),
        survivors: [...plan.index.values()].filter((record) => !plan.targetIds.includes(record.id)).map((record) => record.directory),
        signal,
      })
      : undefined;

    // Workspace accounting first: the registry's `sessionIds` view is filtered by
    // a header index that a removed log directory empties, so detaching after the
    // delete would silently skip the slot and strand a dangling id.
    throwIfAborted(signal);
    removed.workspaceSlots = await this.detachFromWorkspaces(plan.targetIds, warnings);

    const directories = await removeSessionDirectories({
      plan,
      removeEmptyProjectDirectory: settings.removeEmptyProjectDirectory,
      warnings,
      signal,
    });
    Object.assign(removed, directories);
    removed.projectionRecords = await removeProjectionRecords({ storagesRoot: this.storagesRoot(), ids: plan.targetIds, warnings, signal });
    if (settings.purgeSpill) {
      removed.spillDirectories = await removeSpillDirectories({
        ids: plan.targetIds,
        roots: await discoverSpillRoots(settings.spillRoots),
        warnings,
        signal,
      });
    }
    if (settings.purgeSchedules) removed.schedules = await this.removeSchedules(plan.targetIds, warnings);
    if (digests !== undefined) {
      const attachments = await removeAttachments({ root: this.attachmentsRoot(), digests, warnings, signal });
      removed.attachmentObjects = attachments.objects;
      removed.attachmentLinks = attachments.links;
    }

    // Only sessions whose directory is really gone are announced; a partially
    // failed sweep must not drop rows that still exist on disk.
    for (const id of directories.failedIds) {
      warnings.push(`session "${id}" was not fully removed; its log directory is still present`);
    }
    announceRemoved(this.ctx, directories.removedIds);
    return {
      sessionId,
      targets: plan.targetIds,
      removedIds: directories.removedIds,
      failedIds: directories.failedIds,
      forkIds: plan.forkIds,
      removed,
      warnings,
    };
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
   * Whether this process still holds a live Agent or Session for an id. That is
   * what makes a purge unsafe: a resident Agent owns the write handle and the
   * checkpoint obligation.
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
   * owns the durable rows.
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
   * @returns how many tasks were deleted.
   */
  async removeSchedules(ids, warnings) {
    const schedule = this.ctx.get('schedule');
    if (schedule === undefined || typeof schedule.delete !== 'function') return 0;
    let removed = 0;
    for (const task of await this.scheduleTasks(ids)) {
      try {
        const result = await schedule.delete({ sessionId: task.sessionId, id: task.id });
        if (result?.deleted === true) removed += 1;
      } catch (error) {
        warnings.push(`could not delete reminder ${task.id}: ${String(error)}`);
      }
    }
    return removed;
  }

  /**
   * Drop every id from the Workspace registry's accounting slot, its archive set
   * and its pin set. All three go through registry methods, so the durable
   * document keeps its invariants.
   * @param ids - the session ids.
   * @param warnings - the operation's warning sink.
   * @returns how many membership slots were dropped.
   */
  async detachFromWorkspaces(ids, warnings) {
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) return 0;
    let dropped = 0;
    for (const id of ids) {
      for (const workspace of registry.list()) {
        if (!workspace.sessionIds.includes(id)) continue;
        try {
          await workspace.detachSession(id);
          dropped += 1;
        } catch (error) {
          warnings.push(`could not detach "${id}" from workspace "${workspace.id}": ${String(error)}`);
        }
      }
      for (const [label, operation] of [['archive', 'unarchiveSession'], ['pin', 'unpinSession']]) {
        if (typeof registry[operation] !== 'function') continue;
        try {
          await registry[operation](id);
        } catch (error) {
          warnings.push(`could not clear the ${label} entry of "${id}": ${String(error)}`);
        }
      }
    }
    return dropped;
  }
}

markRemoteMethods(SessionPurgeService.prototype, ['inspect', 'purge']);

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
