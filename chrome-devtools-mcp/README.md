# 浏览器调试（Browser Debugging）

把 [`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp) 接进当前 dsh profile：
官方 `@deepseek-ai/dsh-mcp-client` 桥负责拉起 MCP 服务器，本包另外把它自带的 7 个调试技能
分发给 agent，并提供一个**可开关**的设置页。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 组合包清单：`dsh.bundle.patch` + `dsh.client` |
| `cordis.patch.yml` | 三条 insert（本包 / MCP 桥 / 技能提供方） |
| `index.js` | **Host 半**：持有 `skills` 开关，并把它变成文件系统事件 |
| `client.js` | **Client 半**：Plugins 页面的设置页 |
| `typert.js` | Remote 协议声明（手写，与生成产物同契约） |
| `skills/` | 随包分发的 7 个技能副本 |
| `locale/{en,zh}.json` | Plugins 卡片上的标题与描述 |
| `icon.svg` | 卡片图标 |

## 三条 insert

```yaml
- insert:
    - id: chrome-devtools-mcp        # ① 本包（Host 半 + Client 半）
      name: '@jedeiah/chrome-devtools-mcp'

    - id: chrome-devtools-bridge     # ② 官方 MCP 桥
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: chrome-devtools, transport: stdio, command: npx, args: [...] }

    - id: chrome-devtools-skills     # ③ 技能提供方，扫本包 skills-live/
      name: '@deepseek-ai/dsh-skill-filesystem'
      config: { providerName: chrome-devtools-skills, includeDefaultRoots: false, customSkillDirs: [...] }
```

**① 行名必须是本包名** —— 浏览器模块表按行名取包，写官方桥名的话本包的 Client 半边永远不会被加载。
**② 单独一行**，这样 MCP 工具不受技能开关影响。

## 技能开关

**默认关闭**，与上游一致：`chrome-devtools-mcp` 以 MCP 服务器形态分发，它仓库里的 `skills/`
是给"有技能机制的 agent"额外提供的（上游对 Claude Code / Gemini 提供「MCP + Skills」装法，
对纯 MCP 客户端只给工具）。dsh 有技能机制但不在那份名单里，所以本包补上这一档，并让它可以关。

**开关怎么生效**：

```
设置页改 skills → Host 半 1 秒轮询读到新值
                → 维护 skills-live/（开：软链 7 个技能；关：清空）
                → 显式调 ctx.skills.invalidateCache()
                → agent 在下一步（agent/pre-step）拿到新目录
```

**为什么要显式 invalidate**：官方 provider 的失效路径只认「通过 dsh 工具产生的文件变更」
（`ctx.on("fs/observed", ...)` 里 `mutationToolName(actor) === void 0` 就返回），
而 `syncLiveSkills` 是我们直接用 `fs` 写的，它看不见。所以缓存得由我们自己失效。

> ⚠️ **`skills-live/` 必须在启动时就存在**（哪怕空着）。provider 的 watcher 只监视它首次看到的根目录，
> 后创建的目录不会被监听到，技能会静默不出现且无任何报错。所以 `syncLiveSkills` 会先 `mkdirSync` 再决定是否填充。

## ⚠️ 已知边界：`/` 列表不会实时刷新

开关**立即**作用于模型 —— `dsh-tool-skill` 在 `agent/pre-step` 里每步重取目录并比对 digest，
**已实测：关掉开关后发一条消息，模型列的技能里就没有了**。

但**输入框的 `/` 建议列表**不会立刻变。原因在客户端 `dsh-client-ui-skill`：

```js
const invalidate = (key) => { fetches.delete(key); entry.abort.abort(); notifyLexicon(key); };
ctx.remote.$on("agent-preset/selected", invalidate);   // ← 只有这两个
ctx.on("connection/reset", clearAll);                  // ← 连接重置（重启）
```

它按 `sessionId` 缓存技能列表，只在**切换预设**或**重连**时重建。它不监听技能注册表的
`skills/change`（该事件也没有进入 `dsh-api-remotes` 的转发白名单），所以**运行时改技能根
不在它的设计场景里**。

**规避**：重开对话，或切一下预设 —— 那个列表就刷新了。**功能不受影响。**

## 它是怎么连的

```yaml
serverName: chrome-devtools
transport: stdio
command: npx
args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect', '--no-usage-statistics', '--no-performance-crux']
```

`npx` 从宿主 `PATH` 解析，所以需要装好 node/npm，且首次运行要能访问 npm 源。包会缓存
在 `~/.npm/_npx/`，之后启动直接复用。工具对模型呈现为 `mcp__chrome-devtools__<tool>`。

## 随包的技能

| 技能 | 用途 |
|---|---|
| `chrome-devtools` | 总览：怎么用这套工具 |
| `chrome-devtools-cli` | CLI 形态的用法与安装 |
| `a11y-debugging` | 无障碍（a11y）问题调试 |
| `cookie-debugging` | Cookie 相关问题排查 |
| `debug-optimize-lcp` | LCP 性能诊断与优化 |
| `memory-leak-debugging` | 内存泄漏定位 |
| `troubleshooting` | 连接与常见故障排查 |

**为什么要随包带**：这些技能原本只存在于 `~/.npm/_npx/…/chrome-devtools-mcp/skills/`。
而 `dsh-skill-filesystem` 只扫 `<项目>/.agents/skills`、`$DSH_HOME/skills`、`~/.agents/skills`、
`customSkillDirs`、`bundledSkillDir` —— **npx 缓存不在其中**，所以它们此前**从未生效**。

> ⚠️ **`ctx.baseUrl` 指向 profile 目录**（`~/.dsh/profiles/<name>/`），**不是**提供 patch 的
> bundle 目录。不能直接往它上面拼 `skills/` —— 那样会指向一个不存在的空目录，技能**静默消失**。
> 这里用 `createRequire(ctx.baseUrl).resolve('<包名>/package.json')` 从 profile 锚点解析出本包
> 真实安装位置，与 dsh 自己的 preset patch 是同一手法。

技能副本取自 `chrome-devtools-mcp@1.10.1`。需要更新时，用上游仓库 `skills/` 覆盖本包 `skills/`。

## 安装 / 卸载

在 Plugins 页面安装，或用 `plugin_manager` 工具：

- 安装：`action: install_bundle`，`target: <本目录的绝对路径>`
- 卸载：`action: remove_bundle`，`target: @jedeiah/chrome-devtools-mcp`

**保持本目录在原位。** `install_bundle` 是把 profile 链接到这个路径、而不是复制，所以
移动或删除目录会让组合包失效。

**卸载后不留残留**：MCP 桥与技能提供方都由本包的 patch 层提供，插件不在就都不生效。
技能提供方只扫本包 `skills-live/`（`includeDefaultRoots: false`），**不读写 `~/.agents/skills`**。

## 改配置

编辑 `cordis.patch.yml`，然后把组合包关掉再打开（或重启 Harness）以重新组合。
它在本包目录里，不在 profile 内。

## 平台

MCP 服务器的进程启动交给官方 `@deepseek-ai/dsh-mcp-client`（dsh 的 subprocess seam 处理平台差异）。
共同前提是宿主 `PATH` 上有 `node` / `npm`：首次运行由 `npx` 拉取 `chrome-devtools-mcp`，
之后缓存在 npm 的 npx 缓存里。
