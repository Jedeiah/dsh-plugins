/**
 * Client half of the Session Purge bundle.
 *
 * Three contributions, all mounted on this bundle's single row:
 *
 *   1. `sidebar.workspaces.session.row.action` (order 300) — the hover button on
 *      a session row, next to pin and archive;
 *   2. `sidebar.workspaces.session.menu.item` (order 500) — the same action in
 *      the row's "…" menu, so it is reachable on touch and for discoverability;
 *   3. `shell.overlay` — the confirmation dialog and the result toast.
 *
 * All three read one small store created by this module, so the dialog survives
 * the menu that opened it (the menu unmounts on select; the overlay does not).
 *
 * The Host half owns the deletion itself. This half asks for a preview
 * (`sessionPurge.inspect`), renders exactly what the purge would remove, asks
 * the Host to do it (`sessionPurge.purge`) and then clears the browser-local
 * state that is keyed by session id — the row's conversation view, its
 * right-sidebar state, its queued-question drafts, and the "current session"
 * pointer when it named the deleted session. Those keys are this document's own
 * residue; the Host cannot reach them.
 *
 * The Remote descriptor is written here instead of `require`-ing a shared module
 * because the browser module table only ever serves a bundle's declared
 * `./client` entry, and this bundle is buildless: a second source file could not
 * be loaded. It mirrors `typert.js` one-for-one; the two are the only copies,
 * and every field the Gateway reads is one of the small fixed set documented in
 * that file.
 */

window.__ModuleLoader__.load({
  id: '@local/session-purge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** This bundle's package name: the browser module id and the Remote package id. */
    const BUNDLE_NAME = '@local/session-purge';
    /** Dictionary namespace owned by this plugin. */
    const LOCALE_NS = 'plugin.sessionPurge';
    /** Hover-button list on a session row. */
    const ROW_SLOT = 'sidebar.workspaces.session.row.action';
    /** The row's "…" menu. */
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    /** Full-shell overlay slot: dialogs and toasts. */
    const OVERLAY_SLOT = 'shell.overlay';

    /** Hand-written Client manifest, mirroring `typert.js`. */
    const TYPERT_REMOTE = {
      package: BUNDLE_NAME,
      descriptors: [
        {
          id: `${BUNDLE_NAME}#sessionPurge/inspect`,
          service: 'sessionPurge',
          namespace: 'sessionPurge',
          method: 'inspect',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec() }],
          result: { mode: 'strict', typeSymbol: `${BUNDLE_NAME}#SessionPurgeInspection`, create: passthroughCodec },
        },
        {
          id: `${BUNDLE_NAME}#sessionPurge/purge`,
          service: 'sessionPurge',
          namespace: 'sessionPurge',
          method: 'purge',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec() }],
          result: { mode: 'strict', typeSymbol: `${BUNDLE_NAME}#SessionPurgeReport`, create: passthroughCodec },
        },
      ],
    };

    /** Browser-local keys keyed by session id; each is this plugin's residue to clear. */
    const UI_STATE_PREFIXES = ['dsh.conversation.', 'dsh.sidebar-right.v1.', 'dsh.user-questions.drafts.v1.'];
    /** The key naming the session the shell last had open. */
    const CURRENT_SESSION_KEY = 'dsh.sessions.current';
    /** How long a success toast stays up. */
    const TOAST_HOLD_MS = 6000;
    /** How long an error toast stays up. */
    const ERROR_TOAST_HOLD_MS = 12000;

    /** A strict codec whose parser accepts any value; result codecs are not executed. */
    const passthroughCodec = { parse: (value) => value };

    /** A strict codec for a session id: a non-empty, path-safe string. */
    function sessionIdCodec() {
      return {
        parse(value) {
          if (typeof value !== 'string' || value.length === 0) throw new Error('session-purge: sessionId must be a non-empty string');
          return value;
        },
      };
    }

    const zh = {
      menu: '删除会话…',
      action: '删除会话',
      dialogTitle: '彻底删除会话',
      dialogBody: '这会从磁盘上连根删除该会话：会话日志与锁文件、投影缓存、工作区归属、绑定的提醒、工具落盘文件。删除后无法恢复，归档/取消归档不受影响。',
      dialogLoading: '正在统计…',
      dialogFailed: '无法读取该会话的信息：',
      targetsHeading: '将删除的会话',
      childSuffix: '（子 agent）',
      rootLabel: '主会话',
      statsSessions: '会话数',
      statsSize: '占用磁盘',
      statsSchedules: '绑定的提醒',
      statsAttachments: '清理无引用附件',
      attachmentsOn: '是（会扫描其余会话的引用）',
      attachmentsOff: '否（附件对象保留）',
      liveWarning: '该会话仍驻留在当前进程里（本 App 运行期间打开过）。请先重启 App，再删除；现在删除会留下活着的写入方和可能重建的缓存记录。',
      liveTargets: '仍在驻留：',
      confirm: '删除',
      confirmPending: '正在删除…',
      cancel: '取消',
      close: '关闭',
      toastDeleted: '已删除 {count} 个会话，释放 {size}',
      toastWarned: '；有 {count} 条警告，详见日志',
      toastFailed: '删除失败：{message}',
    };

    const en = {
      menu: 'Delete session…',
      action: 'Delete session',
      dialogTitle: 'Delete this session permanently',
      dialogBody: 'This removes the session from disk: its log and lock file, its projection checkpoint, its workspace slot, its bound reminders and its spilled tool output. It cannot be undone; archive and unarchive are unaffected.',
      dialogLoading: 'Loading…',
      dialogFailed: 'Could not read this session: ',
      targetsHeading: 'Sessions to delete',
      childSuffix: ' (subagent)',
      rootLabel: 'main',
      statsSessions: 'Sessions',
      statsSize: 'On disk',
      statsSchedules: 'Bound reminders',
      statsAttachments: 'Purge unreferenced attachments',
      attachmentsOn: 'yes (scans the surviving sessions first)',
      attachmentsOff: 'no (attachment objects are kept)',
      liveWarning: 'This session is still resident in the running app. Restart the app and delete it then; deleting now would leave a live writer behind the removed log and could rebuild its cached record.',
      liveTargets: 'Still resident:',
      confirm: 'Delete',
      confirmPending: 'Deleting…',
      cancel: 'Cancel',
      close: 'Close',
      toastDeleted: 'Deleted {count} session(s), freed {size}',
      toastWarned: '; {count} warning(s) logged',
      toastFailed: 'Delete failed: {message}',
    };

    /**
     * A minimal external store: React reads it through `useSyncExternalStore`,
     * and the row button, the dialog and the toast all observe one instance.
     * @returns the store.
     */
    function createStore() {
      let snapshot = { request: null, toast: null, sequence: 0 };
      const listeners = new Set();
      const emit = (next) => {
        snapshot = next;
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            /* a broken listener must not stop the others */
          }
        }
      };
      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        read() {
          return snapshot;
        },
        setRequest(request) {
          emit({ ...snapshot, request });
        },
        setToast(toast) {
          emit({ ...snapshot, toast: toast === null ? null : { ...toast, seq: snapshot.sequence + 1 }, sequence: snapshot.sequence + 1 });
        },
      };
    }

    /** Subscribe to the store with the React the slot renderer supplies. */
    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.read, store.read);
    }

    /** Format a byte count the way the rest of the UI does (binary units). */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
    }

    /**
     * Highlight a destructive action the way the workspace-delete button does,
     * without depending on that package's private stylesheet.
     */
    const DESTRUCTIVE_STYLE = { color: 'var(--dsw-alias-state-error-primary)' };

    /** Clear the browser-local keys that name the deleted sessions. */
    function clearBrowserState(sessionIds) {
      const doomed = new Set(sessionIds);
      try {
        for (const sessionId of doomed) {
          for (const prefix of UI_STATE_PREFIXES) window.localStorage.removeItem(prefix + sessionId);
        }
        const raw = window.localStorage.getItem(CURRENT_SESSION_KEY);
        if (raw !== null) {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = undefined;
          }
          if (typeof parsed?.sessionId === 'string' && doomed.has(parsed.sessionId)) window.localStorage.removeItem(CURRENT_SESSION_KEY);
        }
      } catch {
        /* private-mode storage failures never fail the purge report */
      }
    }

    /**
     * Build the behavior the slot entries inject, closing over the runtime.
     * @param ctx - the client runtime.
     * @param store - the shared store.
     * @returns the injected behavior.
     */
    function createPurgeApi(ctx, store, mounted) {
      /** Run one Remote method, mapping the transport's result branches onto throws. */
      const call = async (method, sessionId) => {
        await mounted;
        const result = await ctx.remote.sessionPurge[method](sessionId);
        if (result?.ok !== true) throw result?.error ?? new Error('session-purge: the Remote call failed');
        return result.value;
      };
      return {
        /** Open the dialog for one session and load its preview. */
        open(sessionId, displayTitle) {
          store.setRequest({ sessionId, displayTitle, phase: 'loading', inspection: null, error: null, busy: false });
          call('inspect', sessionId).then(
            (inspection) => {
              const current = store.read().request;
              if (current === null || current.sessionId !== sessionId) return;
              store.setRequest({ ...current, phase: 'ready', inspection });
            },
            (reason) => {
              const current = store.read().request;
              if (current === null || current.sessionId !== sessionId) return;
              store.setRequest({ ...current, phase: 'error', error: reason instanceof Error ? reason.message : String(reason) });
            },
          );
        },
        /** Close the dialog unless the purge is already running. */
        dismiss() {
          const current = store.read().request;
          if (current === null || current.busy) return;
          store.setRequest(null);
        },
        /** Retire the toast the user dismissed or that timed out. */
        dismissToast() {
          store.setToast(null);
        },
        /** Run the purge and report the outcome. */
        async submit() {
          const current = store.read().request;
          if (current === null || current.busy) return;
          store.setRequest({ ...current, busy: true, error: null });
          try {
            const report = await call('purge', current.sessionId);
            clearBrowserState(report?.targets ?? [current.sessionId]);
            store.setRequest(null);
            store.setToast({
              kind: 'deleted',
              tone: 'success',
              holdMs: TOAST_HOLD_MS,
              count: report?.targets?.length ?? 1,
              size: formatBytes(report?.removed?.bytesFreed ?? 0),
              warnings: report?.warnings?.length ?? 0,
            });
          } catch (reason) {
            const latest = store.read().request;
            const message = reason instanceof Error ? reason.message : String(reason);
            store.setRequest(latest === null ? null : { ...latest, busy: false, error: message });
            store.setToast({ kind: 'failed', tone: 'error', holdMs: ERROR_TOAST_HOLD_MS, message });
          }
        },
      };
    }

    /** The hover button on a session row. */
    function PurgeRowButton({ sessionId, displayTitle, purge, t }) {
      return h(primitives.Tooltip, {
        label: t('action'),
        side: 'bottom',
        align: 'end',
        delayMs: 500,
        children: h('button', {
          type: 'button',
          'aria-label': t('action'),
          style: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' },
          onClick: (event) => {
            event.stopPropagation();
            purge.open(sessionId, displayTitle);
          },
          children: h(primitives.IconTrashOutlineRegular, { size: 14 }),
        }),
      });
    }

    /** The same action as a row in the row's "…" menu. */
    function PurgeMenuItem({ sessionId, displayTitle, useMenuOpenState, purge, t }) {
      const closeMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : undefined;
      return h(primitives.MenuItemButton, {
        danger: true,
        separatorBefore: true,
        icon: h(primitives.IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          closeMenu?.(false);
          purge.open(sessionId, displayTitle);
        },
        children: t('menu'),
      });
    }

    /** One preview line: the session's title, its lineage role and its size. */
    function targetLine(target, index, t) {
      const role = target.origin === 'subagent' ? t('childSuffix') : ` (${t('rootLabel')})`;
      return h('li', { key: `${target.sessionId}-${String(index)}` }, [
        target.title === '' ? target.sessionId : target.title,
        role,
        ' — ',
        formatBytes(target.sizeBytes),
        target.live ? ` · ${t('liveTargets')}${target.sessionId}` : '',
      ]);
    }

    /** The confirmation dialog, mounted in the shell overlay. */
    function PurgeConfirmDialog({ purge, t }) {
      const { request } = useStore(store);
      if (request === null) return null;
      const inspection = request.inspection;
      const blocked = inspection?.blocked ?? null;
      const rows = inspection === null ? [] : [
        h('li', { key: 'sessions' }, `${t('statsSessions')}: ${String(inspection.targets.length)}`),
        h('li', { key: 'size' }, `${t('statsSize')}: ${formatBytes(inspection.sizeBytes)}`),
        h('li', { key: 'schedules' }, `${t('statsSchedules')}: ${String(inspection.scheduleCount)}`),
        h('li', { key: 'attachments' }, `${t('statsAttachments')}: ${inspection.purgeAttachments ? t('attachmentsOn') : t('attachmentsOff')}`),
      ];
      return h(primitives.Modal, {
        open: true,
        onClose: () => purge.dismiss(),
        closeLabel: t('close'),
        title: t('dialogTitle'),
        description: t('dialogBody'),
        footer: h(React.Fragment, null, [
          h(primitives.Button, { key: 'cancel', variant: 'outline', disabled: request.busy, onClick: () => purge.dismiss() }, t('cancel')),
          h(primitives.Button, {
            key: 'confirm',
            variant: 'outline',
            disabled: request.busy || request.phase !== 'ready' || blocked !== null,
            onClick: () => {
              void purge.submit();
            },
            style: blocked === null ? DESTRUCTIVE_STYLE : undefined,
            children: request.busy ? t('confirmPending') : t('confirm'),
          }),
        ]),
        children: [
          blocked === null ? null : h('div', { key: 'live', role: 'alert', style: { color: 'var(--dsw-alias-state-warn-primary)', lineHeight: 1.6 } }, [
            t('liveWarning'),
            h('br'),
            `${t('liveTargets')} ${blocked.sessionIds.join(', ')}`,
          ]),
          request.phase === 'loading' ? h('div', { key: 'loading', role: 'status' }, t('dialogLoading')) : null,
          request.phase === 'error' ? h('div', { key: 'error', role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } }, `${t('dialogFailed')}${String(request.error)}`) : null,
          inspection === null ? null : h('div', { key: 'stats' }, [
            h('div', { key: 'targetsHeading', style: { fontWeight: 600, marginBottom: 4 } }, t('targetsHeading')),
            h('ul', { key: 'targets', style: { margin: '0 0 8px', paddingInlineStart: 18 } }, inspection.targets.map((target, index) => targetLine(target, index, t))),
            h('ul', { key: 'rows', style: { margin: 0, paddingInlineStart: 18 } }, rows),
          ]),
          request.error !== null && request.phase === 'ready' ? h('div', { key: 'failure', role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 8 } }, String(request.error)) : null,
          request.busy ? h('div', { key: 'pending', role: 'status', style: { marginTop: 8 } }, t('confirmPending')) : null,
        ].filter((entry) => entry !== null && entry !== false),
      });
    }

    /** The result toast, mounted in the same overlay. */
    function PurgeToast({ purge, t }) {
      const { toast } = useStore(store);
      if (toast === null) return null;
      const text = toast.kind === 'failed'
        ? t('toastFailed', { message: toast.message })
        : `${t('toastDeleted', { count: toast.count, size: toast.size })}${toast.warnings > 0 ? t('toastWarned', { count: toast.warnings }) : ''}`;
      return h(primitives.Toast, {
        text,
        tone: toast.tone,
        holdMs: toast.holdMs,
        onDone: () => purge.dismissToast(),
      }, `session-purge-toast-${String(toast.seq)}`);
    }

    // The store is module-scoped rather than created per `apply` call: the three
    // entries must share it, and one bundle row is mounted at most once per page.
    const store = createStore();

    /**
     * Activate the bundle: mount the Remote namespace, register the dictionaries
     * and the three slot entries.
     * @param ctx - the client runtime.
     */
    async function apply(ctx) {
      const mounted = ctx.remote.$mount(TYPERT_REMOTE);
      ctx.effect(() => () => {
        void mounted.then((dispose) => dispose(), () => undefined);
      }, 'session-purge: remote namespace');

      const purge = createPurgeApi(ctx, store, mounted);

      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'session-purge: dictionaries');

      ctx.slots.inject(ROW_SLOT, () => ctx.slots.register({
        name: ROW_SLOT,
        id: 'session-purge',
        order: 300,
        locale: LOCALE_NS,
        inject: () => ({ purge }),
      }, PurgeRowButton));

      ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
        name: MENU_SLOT,
        id: 'session-purge',
        order: 500,
        locale: LOCALE_NS,
        inject: () => ({ purge }),
      }, PurgeMenuItem));

      ctx.slots.inject(OVERLAY_SLOT, function* () {
        yield ctx.slots.register({
          name: OVERLAY_SLOT,
          id: 'session-purge-confirm',
          locale: LOCALE_NS,
          inject: () => ({ purge }),
        }, PurgeConfirmDialog);
        yield ctx.slots.register({
          name: OVERLAY_SLOT,
          id: 'session-purge-toast',
          locale: LOCALE_NS,
          inject: () => ({ purge }),
        }, PurgeToast);
      });

      return undefined;
    }

    return { apply, inject: ['remote', 'slots', 'locale'] };
  },
});
