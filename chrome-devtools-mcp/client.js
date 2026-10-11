/**
 * Client half of the chrome-devtools-mcp bundle.
 *
 * One contribution lives on the row whose specifier is this package name:
 *
 *  - The row's settings page in `plugins.row.config`, registered inside a gate
 *    that depends on this bundle's own Host service (`remote.chromeDevtoolsMcp`).
 *    The gate is what makes the page survive an off→on toggle of this row: dsh
 *    does not always re-run a client half's `apply` (deepseek-harness#8452), but
 *    `ctx.inject` does re-run its callback once the dependency reappears.
 *
 * The single tunable comes from the Host row's `Config` (see ../index.js) through
 * `ctx.configForms`. It is read in the browser, so changing it takes effect
 * without reloading the module.
 */

// These client.js files are loaded as plain scripts into one shared scope, so a
// top-level `const` collides with any other bundle declaring the same name.
// Everything below lives inside this IIFE; the only global effect is the
// __ModuleLoader__.load() call at the end.
(() => {

/** This bundle's package name: the browser module id. */
const BUNDLE_NAME = '@jedeiah/chrome-devtools-mcp';
/** Profile row id; also the Host settings namespace the settings bundle edits. */
const ENTRY_ID = 'chrome-devtools-mcp';

/** Locale namespace for this page's dictionary. */
const SETTINGS_LOCALE_NS = 'plugin.chromeDevtoolsMcpSettings';

/**
 * Token-only styling, so light and dark follow the host theme automatically.
 */
const LAYOUT = Object.freeze({
  page: { display: 'flex', flexDirection: 'column', gap: 16 },
  label: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  hint: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  switchRow: { display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'space-between' },
  switchText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
});

const STYLE = Object.freeze({
  /** Inline notice/error lines shared by the settings surfaces. */
  notice: { opacity: 0.7, fontSize: 12, lineHeight: 1.6 },
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: 1.5 },
});

window.__ModuleLoader__.load({
  id: BUNDLE_NAME,
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // Official primitives are a platform seed shared by every client bundle, so
    // the page gets the shell's control styling instead of hand-rolled buttons.
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** Browser-side mirror of `typert.js`; the Gateway reads these descriptors. */
    const TYPERT_REMOTE = {
      package: BUNDLE_NAME,
      descriptors: [
        {
          id: `${BUNDLE_NAME}#chromeDevtoolsMcp/introspect`,
          service: 'chromeDevtoolsMcp',
          namespace: 'chromeDevtoolsMcp',
          method: 'introspect',
          invocation: { kind: 'direct' },
          parameters: [],
          result: {
            mode: 'strict',
            typeSymbol: `${BUNDLE_NAME}#ChromeDevtoolsMcpConfig`,
            create: () => ({ parse: (value) => value }),
          },
        },
      ],
    };

    /** Page dictionary. Kept local: this bundle exposes no model-facing text. */
    const zh = {
      summary: '浏览器调试',
      pageIntro: 'chrome-devtools-mcp 自带 7 个调试技能（无障碍、Cookie、LCP 性能、内存泄漏等）。默认关闭，与上游一致——上游把它作为 MCP 服务器分发，技能是给有技能机制的 agent 额外提供的。',
      skillsLabel: '向智能体提供自带技能',
      skillsHint: '开启后，7 个技能会出现在会话的技能目录中，可用 / 调用。改动立即生效。',
      saving: '正在保存…',
      unavailable: '设置暂不可用',
      readOnly: '当前组合下不可修改（缺少设置界面时只读）。',
    };

    const en = {
      summary: 'Browser Debugging',
      pageIntro: 'chrome-devtools-mcp ships 7 debugging skills (a11y, cookies, LCP performance, memory leaks and more). Off by default, matching upstream — upstream distributes it as an MCP server, and the skills are an extra for agents that have a skill mechanism.',
      skillsLabel: 'Offer the bundled skills to the agent',
      skillsHint: 'When on, the 7 skills appear in the session skill catalog and can be called with /. Changes apply immediately.',
      saving: 'Saving…',
      unavailable: 'Settings unavailable',
      readOnly: 'Not editable in this composition (read-only without a settings surface).',
    };

    /**
     * One labelled switch, laid out like the other rows in this page family.
     * @param key - React key.
     * @param label - primary label text.
     * @param checked - current state.
     * @param disabled - whether the control is locked.
     * @param onChange - change handler.
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
     * The row's settings page.
     *
     * `view === 'summary'` is the collapsed row; the full page is only rendered
     * once the owner hands over a ready form.
     * @param props - the owner's page props: `t`, `view`, and `form`.
     * @returns the page element.
     */
    function ChromeDevtoolsRowConfig(props) {
      const { t, view, form } = props;
      if (view === 'summary') return t('summary');
      if (form?.state === undefined) return null;
      if (form.state.status === 'loading') return h('div', { role: 'status' }, t('saving'));
      if (form.state.status !== 'ready') return h('div', { style: STYLE.notice }, t('unavailable'));

      const locked = form.state.writable !== true;
      const skills = form.state.value?.skills === true;
      const write = (next) => {
        // The revision is deliberately left to the form: one read at render time
        // goes stale the moment the write lands.
        void form.mutate([{ op: 'set', path: ['skills'], value: next }]);
      };

      return h('div', { key: 'page', style: LAYOUT.page }, [
        locked ? h('div', { key: 'readonly', style: STYLE.notice }, t('readOnly')) : null,
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
        // dependencies become available again, and `remote.chromeDevtoolsMcp` —
        // this bundle's own Host service — is precisely the dependency that
        // disappears and returns with the row.
        const mounted = ctx.remote.$mount(TYPERT_REMOTE);
        const ui = ctx.inject(['remote.chromeDevtoolsMcp', 'slots', 'locale'], (child) => {
          const prune = [];
          prune.push(child.effect(() => child.locale.register(SETTINGS_LOCALE_NS, { zh, en }), 'chrome-devtools-mcp: settings dictionaries'));
          const childForms = child.get('configForms');
          if (childForms?.whileServed !== undefined) {
            prune.push(child.effect(() => childForms.whileServed([ENTRY_ID], () => child.slots.inject('plugins.row.config', () => child.slots.register({
              name: 'plugins.row.config',
              key: `${BUNDLE_NAME}#${ENTRY_ID}`,
              locale: SETTINGS_LOCALE_NS,
              inject: () => ({}),
            }, ChromeDevtoolsRowConfig))), 'chrome-devtools-mcp: row configuration page'));
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
