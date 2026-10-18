/**
 * Client half of the rea-dsh bundle.
 *
 * One contribution lives on the row whose specifier is this package name:
 *
 *  - The row's settings page in `plugins.row.config`, registered inside a gate
 *    that depends on this bundle's own Host service (`remote.reaAgents`).
 *    The gate is what makes the page survive an off→on toggle of this row: dsh
 *    does not always re-run a client half's `apply` (deepseek-harness#8452), but
 *    `ctx.inject` does re-run its callback once the dependency reappears.
 *
 * The page has three jobs, in the order a reader meets them:
 *
 *   1. the one tunable — whether REA's skill is offered (`ctx.configForms`);
 *   2. **what is actually running** — the bridge's mode, the version the skill
 *      follows, and any failure the Host already knows about (`diagnose`);
 *   3. **what to do about it** — pin a version, follow `latest` again, or check
 *      whether a newer release exists (`setVersion`, `checkUpdate`).
 *
 * Every Host read is wrapped: a failing call must degrade to a line of text, never
 * blank the page. The namespace service is only reachable while its methods are
 * declared in *both* halves — `client.js`'s `TYPERT_REMOTE` mirror and `typert.js` —
 * and a mismatch throws during render, which React turns into an empty page.
 * `selftest.mjs` guards that pairing.
 */

// These client.js files are loaded as plain scripts into one shared scope, so a
// top-level `const` collides with any other bundle declaring the same name.
// Everything below lives inside this IIFE; the only global effect is the
// __ModuleLoader__.load() call at the end.
(() => {

/** This bundle's package name: the browser module id. */
const BUNDLE_NAME = '@jedeiah/rea-dsh';
/** Profile row id; also the Host settings namespace the settings bundle edits. */
const ENTRY_ID = 'rea-dsh';

/** Locale namespace for this page's dictionary. */
const SETTINGS_LOCALE_NS = 'plugin.reaDshSettings';

/**
 * Token-only styling, so light and dark follow the host theme automatically.
 */
const LAYOUT = Object.freeze({
  page: { display: 'flex', flexDirection: 'column', gap: 16 },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  hint: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  switchRow: { display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'space-between' },
  switchText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  mono: { fontFamily: 'var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: 12 },
});

const STYLE = Object.freeze({
  /** Inline notice/error lines shared by the settings surfaces. */
  notice: { opacity: 0.7, fontSize: 12, lineHeight: 1.6 },
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: 1.5 },
  checkLine: { fontSize: 12, lineHeight: 1.6 },
  ok: { color: 'var(--dsw-alias-label-tertiary)' },
  warn: { color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary))' },
  fail: { color: 'var(--dsw-alias-state-error-primary)' },
});

window.__ModuleLoader__.load({
  id: BUNDLE_NAME,
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // The shell's controls, so this page looks like the rest of the interface
    // instead of hand-rolled ones. They are *not* a plugin API: dsh's own
    // authoring guide (`cordis-plugin-development/references/practices.md` in the
    // agent preset) tells plugins to vendor them, and the 0.2.1 release dropped
    // `projectUserText` from this package with no deprecation. Keeping the import
    // is still worth the styling match, but a removed export must never take the
    // whole surface down — hence the check below and the gate at the page.
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** Every primitive this half renders with; checked before the page registers. */
    const REQUIRED_PRIMITIVES = ['Button', 'Input', 'Switch'];
    /** Symbols the installed dsh no longer exports. Non-empty hides the page only. */
    const missingPrimitives = REQUIRED_PRIMITIVES.filter((name) => primitives?.[name] === undefined);
    if (missingPrimitives.length > 0) {
      console.error(`[rea-dsh] @deepseek-ai/dsh-client-ui-primitives no longer exports ${missingPrimitives.join(', ')}. `
        + 'The settings page stays hidden; the REA server itself keeps working. See the repo README, "已知的 dsh 侧问题".');
    }

    /**
     * Browser-side mirror of `typert.js`; the Gateway reads these descriptors.
     *
     * Declared here *and* there — the Host manifest is what the loader validates, and
     * this mirror is what the browser resolves a call through. One side missing throws
     * synchronously inside the page's render, which React turns into a blank settings
     * page, so `selftest.mjs` compares the two method lists.
     */
    const TYPERT_REMOTE = {
      package: BUNDLE_NAME,
      descriptors: [
        {
          id: `${BUNDLE_NAME}#reaAgents/snapshot`,
          service: 'reaAgents',
          namespace: 'reaAgents',
          method: 'snapshot',
          invocation: { kind: 'direct' },
          parameters: [],
          result: {
            mode: 'strict',
            typeSymbol: `${BUNDLE_NAME}#ReaAgentsSnapshot`,
            create: () => ({ parse: (value) => value }),
          },
        },
        {
          id: `${BUNDLE_NAME}#reaAgents/diagnose`,
          service: 'reaAgents',
          namespace: 'reaAgents',
          method: 'diagnose',
          invocation: { kind: 'direct' },
          parameters: [],
          result: {
            mode: 'strict',
            typeSymbol: `${BUNDLE_NAME}#ReaAgentsDiagnosis`,
            create: () => ({ parse: (value) => value }),
          },
        },
        {
          id: `${BUNDLE_NAME}#reaAgents/checkUpdate`,
          service: 'reaAgents',
          namespace: 'reaAgents',
          method: 'checkUpdate',
          invocation: { kind: 'direct' },
          parameters: [],
          result: {
            mode: 'strict',
            typeSymbol: `${BUNDLE_NAME}#ReaAgentsUpdateCheck`,
            create: () => ({ parse: (value) => value }),
          },
        },
        {
          id: `${BUNDLE_NAME}#reaAgents/setVersion`,
          service: 'reaAgents',
          namespace: 'reaAgents',
          method: 'setVersion',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'spec',
              wire: 'spec',
              source: 'json',
              codec: {
                mode: 'strict',
                typeSymbol: `${BUNDLE_NAME}#ReaAgentsSetVersion:parameter:0`,
                create: () => ({ parse: (value) => value }),
              },
            },
          ],
          result: {
            mode: 'strict',
            typeSymbol: `${BUNDLE_NAME}#ReaAgentsSetVersionResult`,
            create: () => ({ parse: (value) => value }),
          },
        },
      ],
    };

    /** Page dictionary. Kept local: this bundle exposes no model-facing text. */
    const zh = {
      summary: '逆向工程',
      pageIntro: 'REA 自带 reverse-engineer-anything 技能，说明各类目标（原生二进制、应用、固件、网页）的分析与取证方法。上游的引导式安装默认会一并装上它。',
      skillsLabel: '向智能体提供自带技能',
      skillsHint: '开启后，技能会出现在会话的技能目录中，可用 / 调用。改动立即生效。',
      saving: '正在保存…',
      unavailable: '设置暂不可用',
      readOnly: '当前组合下不可修改（缺少设置界面时只读）。',
      saveFailed: '设置没能保存：本部署没有接受这个改动。',
      statusTitle: '当前状态',
      statusLoading: '正在读取…',
      statusFailed: '读不到状态',
      selfCheck: '重新自检',
      versionTitle: 'REA 版本',
      versionFollowing: '跟随最新（自动更新）',
      versionPinned: '已钉到',
      versionHint: '留空并点「应用」= 跟随最新：每次桥启动都取当时的最新发布版。填具体版本（如 6.4.0）则钉住不动。',
      versionPlaceholder: '留空 = 跟随最新',
      versionApply: '应用',
      versionFollow: '跟随最新',
      updateCheck: '检查更新',
      updateRunning: '正在运行',
      updateNewest: '最新发布',
      updateNewer: '有新版可用',
      updateNone: '已是最新',
      updateApply: '更新到',
      pluginLocal: '本插件',
      pluginNewer: '本插件：远端版本与本地不同',
      busy: '处理中…',
    };

    const en = {
      summary: 'Reverse Engineering',
      pageIntro: 'REA ships the reverse-engineer-anything skill, which describes how to analyse and gather evidence for each target kind (native binaries, applications, firmware, web). Upstream guided setup installs it alongside the MCP registration by default.',
      skillsLabel: 'Offer the bundled skill to the agent',
      skillsHint: 'When on, the skill appears in the session skill catalog and can be called with /. Changes apply immediately.',
      saving: 'Saving…',
      unavailable: 'Settings unavailable',
      readOnly: 'Not editable in this composition (read-only without a settings surface).',
      saveFailed: 'The change was not saved: this deployment did not accept it.',
      statusTitle: 'Current state',
      statusLoading: 'Reading…',
      statusFailed: 'Could not read the state',
      selfCheck: 'Check again',
      versionTitle: 'REA version',
      versionFollowing: 'Following latest (auto-update)',
      versionPinned: 'Pinned to',
      versionHint: 'Empty and Apply follows latest: every bridge start takes the newest release. A concrete version (for example 6.4.0) pins it.',
      versionPlaceholder: 'empty = follow latest',
      versionApply: 'Apply',
      versionFollow: 'Follow latest',
      updateCheck: 'Check for updates',
      updateRunning: 'Running',
      updateNewest: 'Newest published',
      updateNewer: 'A newer release is available',
      updateNone: 'Up to date',
      updateApply: 'Update to',
      pluginLocal: 'This plugin',
      pluginNewer: 'This plugin: the published version differs from this copy',
      busy: 'Working…',
    };

    /**
     * Take the payload out of one Remote answer.
     *
     * The gateway resolves with a discriminated envelope — `{ ok: true, value }` or
     * `{ ok: false, error }` — and never with the method's own return value
     * (`dsh-api-gateway`'s client `invoke`), which is why the official client packages
     * read results as `result.ok && result.value…`. A refused call arrives as a *value*
     * rather than as a rejection, so a caller that only wraps the call in `catch` ends up
     * rendering empty fields: that is exactly how this page first showed `?` for every
     * version it was asked about.
     * @param answer - whatever the namespace service resolved with.
     * @returns the method's own return value.
     * @throws when the envelope reports a failure.
     */
    function unwrap(answer) {
      if (answer === null || typeof answer !== 'object' || typeof answer.ok !== 'boolean') {
        return answer;
      }
      if (answer.ok === true) return answer.value;
      throw new Error(answer.error?.message ?? 'Remote call failed');
    }

    /**
     * Read a value from a control that may hand back either the next value or an event.
     *
     * The primitives disagree by design — `Switch` returns a value, `Input` wraps a
     * native input — so accepting both keeps the page from breaking on a prop
     * convention it guessed wrong.
     * @param eventOrValue - whatever the control passed.
     * @returns the resulting text.
     */
    function textOf(eventOrValue) {
      if (typeof eventOrValue === 'string') return eventOrValue;
      const value = eventOrValue?.target?.value;
      return typeof value === 'string' ? value : '';
    }

    /**
     * One labelled switch, laid out like the other rows in this page family.
     * @param key - React key.
     * @param label - primary label text.
     * @param checked - current state.
     * @param disabled - whether the control is locked.
     * @param onChange - change handler; receives the next value, not a DOM event.
     * @param hint - secondary explanatory line.
     * @returns the row element.
     */
    function switchRow(key, label, checked, disabled, onChange, hint) {
      return h('div', { key, style: LAYOUT.switchRow }, [
        h('div', { key: 'text', style: LAYOUT.switchText }, [
          h('span', { key: 'label', style: LAYOUT.label }, label),
          hint === undefined ? null : h('span', { key: 'hint', style: LAYOUT.hint }, hint),
        ]),
        h(primitives.Switch, { key: 'switch', checked, disabled, label, onChange }),
      ]);
    }

    /**
     * One line of the self-check report.
     * @param check - `{ id, level, title, detail }` from the Host.
     * @returns the line element.
     */
    function checkLine(check) {
      return h('div', { key: check.id, style: STYLE.checkLine }, [
        h('span', { key: 'title', style: STYLE[check.level] ?? STYLE.ok }, `• ${check.title}`),
        check.detail === undefined || check.detail === ''
          ? null
          : h('span', { key: 'detail', style: { ...LAYOUT.hint, marginLeft: 6 } }, check.detail),
      ]);
    }

    /**
     * The row's settings page.
     *
     * `view === 'summary'` is the collapsed row; the full page is only rendered
     * once the owner hands over a ready form.
     * @param props - the owner's page props: `t`, `view`, `form`, plus `service` —
     *   this bundle's Host namespace service, or undefined when it is not mounted.
     * @returns the page element.
     */
    function ReaDshRowConfig(props) {
      const { t, view, form, service } = props;
      // Hooks run before every early return: the owner renders this component in
      // both its summary and its page shape, so the hook order must not differ
      // between renders.
      const [saveFailed, setSaveFailed] = React.useState(false);
      const [report, setReport] = React.useState(null);
      const [update, setUpdate] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const active = view !== 'summary';

      /**
       * Ask the Host for the current state.
       *
       * Deliberately tolerant: a missing service or a rejected call becomes a line of
       * text in the status section, because the rest of the page — including the one
       * setting that matters — must keep working.
       */
      const readStatus = React.useCallback(() => {
        if (service === undefined || typeof service.diagnose !== 'function') {
          setReport({ error: 'unavailable', checks: [] });
          return;
        }
        Promise.resolve()
          .then(() => service.diagnose())
          .then((answer) => setReport(unwrap(answer) ?? { error: 'empty', checks: [] }))
          .catch((error) => setReport({ error: String(error?.message ?? error), checks: [] }));
      }, [service]);

      React.useEffect(() => {
        if (!active) return undefined;
        readStatus();
        return undefined;
      }, [active, readStatus, note]);

      // The version block is only meaningful once the Host answered, so the draft
      // follows the reported pin until the user types something else.
      const pinned = report?.facts?.profile?.pinned ?? null;
      const shownValue = draft === '' && pinned !== null ? pinned : draft;

      if (view === 'summary') return t('summary');
      if (form?.state === undefined) return null;
      if (form.state.status === 'loading') return h('div', { role: 'status' }, t('saving'));
      if (form.state.status !== 'ready') return h('div', { style: STYLE.notice }, t('unavailable'));

      const locked = form.state.writable !== true;
      // The `?? true` must match the `skills` default in ../index.js's Config:
      // a ready form carries the schema-projected value, but a field the schema
      // ever stops projecting would otherwise read as `undefined` and flip the
      // switch to the opposite of what the Host holds.
      const skills = form.state.value?.skills ?? true;
      const write = (next) => {
        // The revision is deliberately left to the form: one read at render time
        // goes stale the moment the write lands.
        //
        // The mutation resolves with whether the form accepted the change, and a
        // rejection is the same outcome from the reader's side. Either way the
        // switch must not silently spring back with no explanation.
        Promise.resolve(form.mutate([{ op: 'set', path: ['skills'], value: next }]))
          .then((accepted) => setSaveFailed(accepted === false))
          .catch(() => setSaveFailed(true));
      };

      /**
       * Run one Host action, reporting whatever it answers.
       * @param kind - the busy marker to show while it runs.
       * @param call - a function returning the Host's promise.
       * @param describe - turns a result into the line shown under the controls.
       */
      const act = (kind, call, describe) => {
        if (busy !== null) return;
        setBusy(kind);
        setNote(null);
        Promise.resolve()
          .then(call)
          .then((answer) => setNote(describe(unwrap(answer))))
          .catch((error) => setNote(String(error?.message ?? error)))
          .finally(() => setBusy(null));
      };

      /**
       * Ask what is published, and keep the answer for the block below.
       *
       * Guarded like every other Host read: a rejection lands in `note`, and the
       * button never leaves the page disabled.
       */
      const checkForUpdates = () => {
        if (busy !== null) return;
        setBusy('check');
        setNote(null);
        Promise.resolve()
          .then(() => service?.checkUpdate?.())
          .then((answer) => setUpdate(unwrap(answer) ?? null))
          .catch((error) => setNote(String(error?.message ?? error)))
          .finally(() => setBusy(null));
      };

      const statusLines = report === null
        ? [h('div', { key: 'loading', style: LAYOUT.hint }, t('statusLoading'))]
        : report.error !== undefined
          ? [h('div', { key: 'error', style: STYLE.error }, `${t('statusFailed')}: ${report.error}`)]
          : (report.checks ?? []).map(checkLine);

      return h('div', { key: 'page', style: LAYOUT.page }, [
        locked ? h('div', { key: 'readonly', style: STYLE.notice }, t('readOnly')) : null,
        saveFailed ? h('div', { key: 'failed', role: 'alert', style: STYLE.error }, t('saveFailed')) : null,
        h('p', { key: 'intro', style: { margin: 0, ...LAYOUT.hint, fontSize: 13 } }, t('pageIntro')),

        switchRow(
          'skills',
          t('skillsLabel'),
          skills,
          locked,
          // `primitives.Switch` hands back the next value, not a DOM event.
          (next) => write(next === true),
          t('skillsHint'),
        ),

        h('div', { key: 'status', style: LAYOUT.section }, [
          h('span', { key: 'label', style: LAYOUT.label }, t('statusTitle')),
          ...statusLines,
          h('div', { key: 'actions', style: LAYOUT.actions }, [
            h(primitives.Button, {
              key: 'selfcheck',
              variant: 'outline',
              onClick: () => act('diagnose', () => service?.diagnose?.(), () => null),
              disabled: busy !== null || service === undefined,
              children: t('selfCheck'),
            }),
          ]),
        ]),

        h('div', { key: 'version', style: LAYOUT.section }, [
          h('span', { key: 'label', style: LAYOUT.label }, t('versionTitle')),
          h('div', { key: 'state', style: LAYOUT.hint },
            pinned === null ? t('versionFollowing') : `${t('versionPinned')} ${pinned}`),
          h('div', { key: 'hint', style: LAYOUT.hint }, t('versionHint')),
          h('div', { key: 'controls', style: LAYOUT.actions }, [
            h(primitives.Input, {
              key: 'spec',
              value: shownValue,
              placeholder: t('versionPlaceholder'),
              disabled: busy !== null || service === undefined,
              'aria-label': t('versionTitle'),
              onChange: (eventOrValue) => setDraft(textOf(eventOrValue)),
            }),
            h(primitives.Button, {
              key: 'apply',
              variant: 'primary',
              disabled: busy !== null || service === undefined,
              // Sends what the field *shows*, not what was typed: with a pin in place the
              // field displays it while `draft` is still empty, and applying the empty
              // draft would silently unpin — the opposite of the visible state.
              // Clearing a pin is the 「跟随最新」 button's job.
              onClick: () => act('apply', () => service?.setVersion?.(shownValue.trim()), (result) => result?.detail ?? ''),
              children: busy === 'apply' ? t('busy') : t('versionApply'),
            }),
            h(primitives.Button, {
              key: 'follow',
              variant: 'ghost',
              disabled: busy !== null || service === undefined,
              onClick: () => act('follow', () => service?.setVersion?.(''), (result) => result?.detail ?? ''),
              children: t('versionFollow'),
            }),
          ]),
        ]),

        h('div', { key: 'update', style: LAYOUT.section }, [
          h('div', { key: 'controls', style: LAYOUT.actions }, [
            h(primitives.Button, {
              key: 'check',
              variant: 'outline',
              disabled: busy !== null || service === undefined,
              // `checkUpdate` answers with data rather than a sentence, so it keeps its
              // own handler instead of going through `act`: the result is rendered by
              // the block below, not reduced to the one-line note.
              onClick: checkForUpdates,
              children: busy === 'check' ? t('busy') : t('updateCheck'),
            }),
          ]),
          update === null ? null : h('div', { key: 'result', style: LAYOUT.section }, [
            h('div', { key: 'running', style: LAYOUT.hint },
              `${t('updateRunning')}: ${update.running?.version ?? '?'} (${update.running?.spec ?? '?'})`),
            h('div', { key: 'newest', style: LAYOUT.hint },
              `${t('updateNewest')}: ${update.newest?.version ?? '?'}`),
            update.newer === true
              ? h('div', { key: 'newer', style: LAYOUT.actions }, [
                  h('span', { key: 'label', style: STYLE.warn }, `${t('updateNewer')}: ${update.newest?.version}`),
                  h(primitives.Button, {
                    key: 'apply',
                    variant: 'primary',
                    disabled: busy !== null || service === undefined,
                    onClick: () => act('apply', () => service?.setVersion?.(update.newest?.version ?? ''), (result) => result?.detail ?? ''),
                    children: `${t('updateApply')} ${update.newest?.version ?? ''}`,
                  }),
                ])
              : h('div', { key: 'uptodate', style: LAYOUT.hint }, t('updateNone')),
            update.plugin?.newer == null
              ? h('div', { key: 'plugin', style: LAYOUT.hint }, `${t('pluginLocal')}: ${update.plugin?.local ?? '?'}`)
              : h('div', { key: 'plugin', style: STYLE.warn },
                  `${t('pluginNewer')}: ${update.plugin.local} → ${update.plugin.newer}`),
            ...(update.errors ?? []).map((line, index) => h('div', { key: `e${String(index)}`, style: STYLE.error }, line)),
          ]),
          note === null ? null : h('div', { key: 'note', style: LAYOUT.hint }, note),
        ]),
      ]);
    }

    return {
      inject: ['remote', 'slots', 'locale'],
      async apply(ctx) {
        // Mount this bundle's Remote service, then gate the settings entry on it.
        //
        // The gate is the whole point. This half's `apply` is NOT re-run after a
        // 停用→启用 cycle (deepseek-harness#8452), so anything registered directly
        // here is lost for good. `ctx.inject` re-runs its callback whenever its
        // dependencies become available again, and `remote.reaAgents` — this
        // bundle's own Host service — is precisely the dependency that disappears
        // and returns with the row.
        const mounted = ctx.remote.$mount(TYPERT_REMOTE);
        const ui = ctx.inject(['remote.reaAgents', 'slots', 'locale'], (child) => {
          const prune = [];
          // Reached through the child so the page keeps working when the namespace
          // service itself is later replaced: the component reads it from props, and
          // every call is guarded.
          const service = child.get('remote.reaAgents');
          prune.push(child.effect(() => child.locale.register(SETTINGS_LOCALE_NS, { zh, en }), 'rea-dsh: settings dictionaries'));
          const childForms = child.get('configForms');
          // A missing primitive would throw inside render, and a throwing slot
          // entry blanks the whole slot. Skipping the page keeps the row usable.
          if (childForms?.whileServed !== undefined && missingPrimitives.length === 0) {
            prune.push(child.effect(() => childForms.whileServed([ENTRY_ID], () => child.slots.inject('plugins.row.config', () => child.slots.register({
              name: 'plugins.row.config',
              key: `${BUNDLE_NAME}#${ENTRY_ID}`,
              locale: SETTINGS_LOCALE_NS,
              inject: () => ({}),
            }, (pageProps) => h(ReaDshRowConfig, { ...pageProps, service })))), 'rea-dsh: row configuration page'));
          }
          return () => {
            for (const dispose of prune.reverse()) {
              try { void dispose?.(); } catch { /* one failed teardown must not strand the rest */ }
            }
          };
        });
        try {
          await ui;
        } catch (error) {
          void mounted.then((dispose) => dispose(), () => undefined);
          throw error;
        }
        return async () => {
          await ui.dispose();
          void mounted.then((dispose) => dispose(), () => undefined);
        };
      },
    };
  },
});

})();
