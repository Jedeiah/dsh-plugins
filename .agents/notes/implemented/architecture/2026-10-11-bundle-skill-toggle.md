# bundle 的技能开关：把配置变成文件系统事件

**日期**：2026-10-11
**涉及**：`chrome-devtools-mcp` 1.2.0、`rea-dsh` 1.1.0

## 要解决什么

两个 MCP 组合包都随包带技能（chrome-devtools-mcp 7 个，REA 1 个），但希望**默认行为跟上游一致**：
chrome-devtools-mcp 上游是 MCP 服务器、README 从不提 skills 目录，所以默认**关**；REA 的引导式
安装默认会一并装上技能，所以默认**开**。

于是需要：一个能在 Plugins 页面开关的字段，**实时**决定 agent 能不能看到这些技能。

## 为什么不能自己实现技能提供方

官方 `@deepseek-ai/dsh-skill-filesystem` 的发现逻辑、frontmatter 解析、文件监视器都是**内部函数**
（`discoverRoot`、`parseSkillFile`、watcher），外部拿不到。重写一遍等于把这些都丢了。

## 采用的形状：开关 → 目录内容

patch 里挂**官方** provider，让它扫本包的 `skills-live/`：

```yaml
- id: chrome-devtools-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: chrome-devtools-skills
    includeDefaultRoots: false          # 不读写 ~/.agents/skills
    customSkillDirs:
      - !!js |-                          # ctx.baseUrl 指向 profile，见 bundle-authoring.md
        (() => {
          const path = process.getBuiltinModule('node:path');
          const { createRequire } = process.getBuiltinModule('node:module');
          const pkgDir = path.dirname(
            createRequire(String(ctx.baseUrl ?? '')).resolve('@jedeiah/chrome-devtools-mcp/package.json'),
          );
          return path.join(pkgDir, 'skills-live');
        })()
```

Host 半（`index.js`）按开关维护那个目录：**开**则把 `skills/` 下每个技能软链进去，**关**则清空。
provider 的 watcher（默认跟随软链）自己就会看到技能出现或消失。

轮询而不是订阅：volatile 字段被就地改写但**不发变更事件**，而且官方 `dsh-config-editor` 只有
`entries()` / `configuration()` / `inherited()` / `edit()`，**没有任何变更通知**。`settings/updated`
事件只存在于 dsh-purge 的 legacy settings API 里，用它会让插件依赖 purge。所以 1 秒轮询是必要的权宜。

## 两条踩过的硬约束

### 1. `skills-live/` 必须在启动时就存在（哪怕空着）

provider 的 watcher **只监视它第一次看到的根目录**。如果目录是后来才创建的（第一次把开关打开时），
watcher 永远不会注意到它，里面的技能就**静默地一直不生效**，没有任何报错。

所以 `syncLiveSkills` 无条件先 `mkdirSync`，再决定要不要填充：

```js
function syncLiveSkills(enabled, { liveDir = SKILLS_LIVE_DIR, sourceDir = SKILLS_SOURCE_DIR } = {}) {
  rmSync(liveDir, { recursive: true, force: true });
  mkdirSync(liveDir, { recursive: true });      // ← 关着也要建
  if (!enabled) return [];
  ...
}
```

（目录覆盖参数是给 selftest 用的，见 `bundle-selftest.md`。）

### 2. 必须显式调 `ctx.skills.invalidateCache()`

provider 的失效路径只认**通过 dsh 工具产生的文件变更**：

```js
ctx.on("fs/observed", (target, _observation, actor) => {
  if (mutationToolName(actor) === void 0) return;   // ← 不是工具改的就直接返回
  provider.observeHostMutation(target.displayPath);
});
```

而 `syncLiveSkills` 是插件**自己用 `fs` 写的**，它看不见。所以每次变化都要主动失效，否则
**已经收到过技能目录的会话永远拿不到新的**（只有之后新开的会话才有）：

```js
try { this.ctx?.get?.('skills')?.invalidateCache?.(); }
catch (error) { this.warn('skills cache invalidation', error); }
```

## 已验证的行为

模型端**实时生效**：`dsh-tool-skill` 在 `agent/pre-step` 里每步都 `ctx.skills.snapshot()` 并比对
digest，不同就替换 catalog 消息。实测：关掉开关后发一条消息，模型列的技能里就没有了。

## 已知边界：`/` 斜杠列表不实时刷新

**输入框的 `/` 建议列表**不会立刻变。原因在客户端 `dsh-client-ui-skill`（全文件 445 行）：
它按 `sessionId` 缓存技能列表，`fetches` 的**唯一**清理入口是 `invalidate` / `clearAll`，而它们
只在两个事件触发：

```js
ctx.remote.$on("agent-preset/selected", invalidate);   // 切换预设
ctx.on("connection/reset", clearAll);                  // 重连（重启）
```

它不监听技能注册表的 `skills/change`，那个事件也**没有进入 `dsh-api-remotes` 的转发白名单**。
所有读取路径（`candidates`、`lexicon`、`warm`、`openReference`）都经过同一个 `fetches` 缓存，
而这个缓存在包外**不可达** —— 所以插件层**没有非入侵的刷新手段**。

**对照**：命令列表有完整链路（`dsh-client-ui-commands` 订阅 `commands/change` → `invalidateAll()`），
技能没有。`skills/change` 目前**全树无任何消费者**，看起来是没做完而不是有意为之。

**已向上游提**：[discussion #9401](https://github.com/deepseek-ai/deepseek-harness/discussions/9401)
（dsh 不用 Issues，`has_issues: false`，反馈走 GitHub Discussions 的 Ideas 分类）。

**规避**：重开对话，或切一下预设。
