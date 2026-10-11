# 逆向工程（Reverse Engineering）

把 [REA](https://github.com/morluto/rea) 接进当前 dsh profile：官方 `@deepseek-ai/dsh-mcp-client` 桥负责
拉起 MCP 服务器，本包另外把它自带的技能分发给 agent，并提供一个**可开关**的设置页。

REA 官方支持 dsh，但要求手工往 `cordis.patch.yml` 追加 `dsh-mcp-client` 条目 —— 它自己的
`setup --client` 不认 dsh 的 Cordis YAML 格式。本组合包把这件事收进插件，于是可一键安装/卸载。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 组合包清单：`dsh.bundle.patch` + `dsh.client` |
| `cordis.patch.yml` | 三条 insert（本包 / MCP 桥 / 技能提供方） |
| `index.js` | **Host 半**：持有 `skills` 开关，并把它变成文件系统事件 |
| `client.js` | **Client 半**：Plugins 页面的设置页 |
| `typert.js` | Remote 协议声明（手写，与生成产物同契约） |
| `skills/` | 随包分发的技能副本 |
| `locale/{en,zh}.json` | Plugins 卡片上的标题与描述 |
| `icon.svg` | 卡片图标 |

## 三条 insert

```yaml
- insert:
    - id: rea-dsh        # ① 本包（Host 半 + Client 半）
      name: '@jedeiah/rea-dsh'

    - id: rea-bridge     # ② 官方 MCP 桥
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: rea, transport: stdio, command: npx, args: ['-y', 'rea-agents@latest', 'mcp'] }

    - id: rea-skills     # ③ 技能提供方，扫本包 skills-live/
      name: '@deepseek-ai/dsh-skill-filesystem'
      config: { providerName: rea-skills, includeDefaultRoots: false, customSkillDirs: [...] }
```

**① 行名必须是本包名** —— 浏览器模块表按行名取包，写官方桥名的话本包的 Client 半边永远不会被加载。
**② 单独一行**，这样 MCP 工具不受技能开关影响。

## 技能开关

**默认开启**，与上游一致：REA 的引导式 setup *"installs the package's matching skill by default"*。
关掉后 agent 拿不到那套分析/取证方法说明，只剩 MCP 工具。

**开关怎么生效**：

```
设置页改 skills → Host 半 1 秒轮询读到新值
                → 维护 skills-live/（开：软链技能；关：清空）
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
不在它的设计场景里**。**规避**：重开对话，或切一下预设。**功能不受影响。**

## 前置条件

- 宿主有 `node` / `npm` —— 首次运行由 `npx` 拉取 MCP 服务器，需要能访问 npm registry
- 原生反编译另需 **Hopper / Ghidra / IDA** 之一；**纯静态 JavaScript 分析不需要**任何原生分析引擎

## 随包的技能

`skills/reverse-engineer-anything/`：`SKILL.md` + 6 篇 `references/`
（android-applications、connection-and-recovery、evidence-workflows、
javascript-applications、native-and-artifacts、runtime-observation）。

**为什么要随包带**：MCP 每次由 `npx` 拉起，包目录**用完即弃**，没有稳定路径可指；
所以必须自带副本兜底。副本之外的 MCP 工具本身始终是 `@latest` —— 真正干活的工具一直在更新，
滞后的只是说明文字。

> ⚠️ **`ctx.baseUrl` 指向 profile 目录**（`~/.dsh/profiles/<name>/`），**不是**提供 patch 的
> bundle 目录。不能直接往它上面拼路径 —— 那样会指向一个不存在的空目录，技能**静默消失**。
> 这里用 `createRequire(ctx.baseUrl).resolve('@jedeiah/rea-dsh/package.json')` 从 profile 锚点
> 解析出本包真实安装位置，与 dsh 自己的 preset patch 是同一手法。

需要更新技能副本时，重新拉取 [morluto/rea](https://github.com/morluto/rea) 的
`.agents/skills/reverse-engineer-anything/` 覆盖本包 `skills/`（MIT）。

## 安装 / 卸载

在 Plugins 页面安装，或用 `plugin_manager` 工具：

- 安装：`action: install_bundle`，`target: <本目录的绝对路径>`
- 卸载：`action: remove_bundle`，`target: @jedeiah/rea-dsh`

**保持本目录在原位。** `install_bundle` 是把 profile 链接到这个路径、而不是复制。

**卸载后不留残留**：MCP 桥与技能提供方都由本包的 patch 层提供，插件不在就都不生效。
技能提供方只扫本包 `skills-live/`（`includeDefaultRoots: false`），**不读写 `~/.agents/skills`**。

## 与 dsh-purge 的关系

两者**正交**，可共存：

- **dsh-purge** 改造宿主，解除 dsh 自身的限制 —— 管的是"能不能"
- **本插件** 给模型逆向工程的能力 —— 管的是"会不会"
