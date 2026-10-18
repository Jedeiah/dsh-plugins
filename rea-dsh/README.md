# 逆向工程（Reverse Engineering）

把 [REA](https://github.com/morluto/rea) 接进当前 dsh profile：官方 `@deepseek-ai/dsh-mcp-client` 桥负责
拉起 MCP 服务器，本包另外把它的技能分发给 agent，并提供一个**可开关**的设置页。

REA 官方支持 dsh，但要求手工往 `cordis.patch.yml` 追加 `dsh-mcp-client` 条目 —— 它自己的
`setup --client` 不认 dsh 的 Cordis YAML 格式。本组合包把这件事收进插件，于是可一键安装/卸载。

与手工装法相比，这一版多做了两件事：**怎么拉起 REA 由四级阶梯决定**（不再写死 `npx`），
**技能自动取与桥同版本的官方原件**（不再是一份会僵住的副本），版本只需在桥那一行的配置里声明一次。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 组合包清单：`dsh.bundle.patch` + `dsh.client` |
| `cordis.patch.yml` | 三条 insert（本包 / MCP 桥 / 技能提供方） |
| `launcher.cjs` | 同步解析"怎么拉起 REA"的四级阶梯与版本（CJS：`!!js` 在激活时同步求值） |
| `launcher.mjs` | 桥实际拉起的透明启动器：选路、拉起、转发信号、按进程组收尾、**记录本次用的版本** |
| `skill-source.js` | 从 npm registry 取官方技能：校验 integrity、解 tar、落缓存 |
| `profile-override.js` | 往 profile 的 `cordis.patch.yml` 写/删「钉版本」的管理块（整行锚定的定界符、dsh 同一把文件锁、原子写，只动自己那块） |
| `skills/LICENSE` | 随包分发的技能副本的**上游 MIT 许可**（REA，Copyright © 2026 morluto） |
| `index.js` | **Host 半**：持有 `skills` 开关，维护技能来源，并把它变成文件系统事件 |
| `client.js` | **Client 半**：Plugins 页面的设置页 |
| `typert.js` | Remote 协议声明（手写，与生成产物同契约） |
| `skills/` | 随包分发的技能副本 —— **仅作离线兜底** |
| `cache/` | 运行时缓存（技能 + 启动器状态），git 忽略，随包目录一起消失 |
| `locale/{en,zh}.json` | Plugins 卡片上的标题与描述 |
| `icon.svg` | 卡片图标 |

## 三条 insert

```yaml
- insert:
    - id: rea-dsh        # ① 本包（Host 半 + Client 半）
      name: '@jedeiah/rea-dsh'

    - id: rea-bridge     # ② 官方 MCP 桥；command/args 由 launcher.cjs 解析
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: rea, transport: stdio, command: !!js …, args: !!js … }

    - id: rea-skills     # ③ 技能提供方，扫本包 skills-live/
      name: '@deepseek-ai/dsh-skill-filesystem'
      config: { providerName: rea-skills, includeDefaultRoots: false, customSkillDirs: [!!js …] }
```

**① 行名必须是本包名** —— 浏览器模块表按行名取包，写官方桥名的话本包的 Client 半边永远不会被加载。
**② 单独一行**，这样 MCP 工具不受技能开关影响。

`!!js` 在**条目激活时**求值（官方文档 `develop/cordis-tutorial/05-config`）。它在这里决定的是
**走哪一级**（有 node 就用 `launcher.mjs`，否则退回裸 `npx`）；REA 的**版本**则来自桥这一行自己的
配置（`env.REA_SPEC` 或 `args` 里的 `--spec=`），由 `launcher.mjs` 在拉起时读取并**记录下来**。
具体见《版本与更新逻辑》。

## 怎么拉起 REA（四级阶梯）

**为什么不能写死 `command: npx`**：那要求 `npx` 恰好在宿主传给 MCP 子进程的 PATH 上。
实测本机 dsh 自带运行时里**只有 `node`、没有 `npx`/`npm`**，系统 `/usr/bin` 下也没有，
`launchctl` 的 PATH 是空的 —— 桥能起来，靠的是 dsh 启动时自己去跑了一次登录 shell
把用户环境取了回来（其宿主子进程的 PATH 里带着 fnm 的按会话目录）。这条链换个 node 管理器、
换台机器、或那次 shell 环境解析不成功，就会断，而且是**静默**断（`failOnStartupError` 默认 false，
只在日志里留一行）。

所以 `launcher.cjs` 按固定阶梯选路，**每一级都可探测、可报告**。顺序是"**先复用宿主已有的，再用自足的兜底**"：

| 级 | 条件 | 实际执行 |
|---|---|---|
| 1 `global` | PATH 上有全局 `rea`（npm i -g） | `绝对 node` + `scripts/rea.mjs mcp`（realpath 解析 bin，不问 npm 全局根在哪） |
| 2 `npx` | 找到了 node，且找到了 `npx` | `绝对 node` + `npx-cli.js -y rea-agents@<版本> mcp`（走 JS 入口，绕开 shebang 对 PATH 的二次依赖） |
| 3 `bundled` | 找到了 node，且找到了 dsh 自带的 pnpm | `dsh自带node` + `…/dependencies/pnpm/bin/pnpm.mjs dlx rea-agents@<版本> mcp` |
| 4 `bare` | 什么都没有 | 字面 `npx`（= 改动前的行为） |

**为什么 `npx` 排在 `bundled` 前面**：两者都能起来，但 `npx` **复用你已有的 npm 缓存**，
而 `bundled` 会把 REA 那套依赖（149 个包）在 pnpm store 里再落一份。既然不新增磁盘占用就能跑，
就先走 `npx`；**第 3 级是"宿主没有 node/npm、或 GUI 启动没拿到 PATH"时才启用的自足兜底**。

第 1–3 级都通过 `launcher.mjs`，由它**在拉起时**再解析一次（所以期间装了全局 `rea` 会被下一次拉起用上，
不用重启），并负责：把 PATH 补宽给子进程、按**进程组**转发 SIGTERM/SIGINT/SIGHUP（先给 5 秒宽限再 SIGKILL）、
把本次实际用的命令写进 `cache/status.json`、失败时往 stderr 打一行可读诊断。

> ⚠️ **两条容易写错的地方**：
>
> 1. `launcher.mjs` 是被 **dsh 自带运行时那个 node** 启动的，而它是**普通 Node**，那里**没有
>    `process.resourcesPath`**。如果只用这个属性去找自带运行时，`bundled` 这一级就永远不会被选中
>    （表现为"明明自带运行时在，却总是走 npx/裸 npx"）。所以这里改为**从解释器自身路径向上推**
>    `resources` 根，`process.resourcesPath` 只是额外来源之一。
> 2. **自带 pnpm 的位置跟着 dsh 版本挪过。** 0.2.0 是 `runtime/pnpm/bin/pnpm.mjs`；0.2.1 收进了
>    `runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`（node 也一起搬到了旁边的
>    `dependencies/node/bin/node`）。只认旧路径的后果是**静默**的：`bundled` 一级失效，退到 `bare` 的
>    字面 `npx`——在没装 node 的机器上等于起不来。现在 `bundledPnpmIn()` 两种布局都探。
>
> `selftest.mjs` Part D 守住这两条（含"PATH 里没有任何包管理器时仍能给出真实可执行的命令"，以及
> "从运行时 node 反推出的 resources 根下确实找得到 pnpm"）。

实测（本机，解释器 = dsh 自带 node v24.21.0）：

```
A) PATH 正常（宿主有 node/npm）            → mode=npx
   command = …/runtime/primary-runtime/dependencies/node/bin/node
   args    = [<fnm>/…/npm/bin/npx-cli.js, -y, rea-agents@6.4.0, mcp]

B) PATH 被剥光（模拟没有 node/npm / GUI 拿不到 PATH） → mode=bundled
   command = …/runtime/primary-runtime/dependencies/node/bin/node
   args    = […/primary-runtime/dependencies/pnpm/bin/pnpm.mjs, dlx, rea-agents@6.4.0, mcp]

C) 连自带运行时都没有                      → mode=bare（保持旧行为，并在 notes 里说明）
```

`bundled` 与 `npx` 两级的**执行**分别实测过（不是同一次）：`pnpm dlx rea-agents@6.4.0 mcp`
自己把包拉齐（resolved 149 / added 144 / exit 0）；而完整 MCP `initialize` 握手
（收到 `serverInfo: {name:"rea",version:"6.4.0"}`）是在**经由本启动器**拉起服务器时收到的。

## 技能跟随版本

**它解决的问题**：MCP 工具永远是最新的，而随包技能是仓库里的死文件 —— 两者会漂。
这不是理论问题：本仓库随包副本相对当时正在跑的 **6.4.0** 就少了 `SKILL.md` 里讲
`get_evidence_bundle` + `detail: "summary"` 翻页的那一段（工具在、说明不在）。上游自己
在技能开头就写了这类错配是已知故障模式。

**做法**：技能**没有自己的版本**。它跟着启动器记录的那个版本走。

```
桥被拉起 → launcher.mjs 记录实际使用的 spec 到 cache/status.json
        → Host 半读这份记录 → 从 npm 取对应版本的官方技能
        → 用 dist.integrity（sha512 SRI）校验 tarball
        → zlib 解压 + 内置 ustar 读取器（含 PAX path / 长名、拒绝 ../ 与绝对路径）
        → 只取 package/skills/**，落 cache/skill/<版本>/
```

**不启任何子进程、不依赖 npm、不依赖 PATH** —— 技能是 7 个纯文本文件，这段代码自带 tar 读取器就够。
拿不到就**退回包内副本**并告警，绝不因为网络问题拖垮这一行。

实测：拉到的 6.4.0 技能与官方 tarball **逐字节一致（7/7 文件 sha256 相同）**；二次调用命中缓存不再下载；
版本不存在时正确抛错并回落。

**为什么不放一个版本文件**（曾经有，已删）：那个文件的存在只是为了让"两处声明"看起来一致 ——
而技能根本不需要声明自己的版本。改成跟着记录走之后，**结构上不可能漂**：技能只能是在跑的那个
服务器的对应版本。唯一残留的比对是"记录 vs 技能当前"，由 `drift` 如实报告。

## 版本与更新逻辑

**默认不锁版本**（跟随 npm 的 `latest`）。钉版本就写在**桥那一行自己的配置**里：

```yaml
- id: rea-bridge
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: rea
    transport: stdio
    env:
      REA_SPEC: '6.4.0'      # ← 就加这一行；不写则跟随 latest
    command: !!js …          # 不用动
    args: !!js …             # 不用动
```

**为什么是这里，而不是设置页、也不是包内文件**：`dsh-settings` 的官方 README 把界线画得很清楚 ——
表单只负责 `.volatile()` 字段，而 *"ordinary configuration remains editable through Cordis
configuration files"*。REA 的版本要传给一个**独立进程**（启动器），进程内的设置镜像到不了那里，
所以它属于"普通配置"，规范位置就是 Cordis 配置文件。顺带的好处：**profile 层的 patch 优先于
bundle 层**，也就是说别人可以在自己的 profile 里覆盖这一行，不用改插件源码。

两条路径的时机**不同**：

| | 技能 | 桥（MCP 服务器） |
|---|---|---|
| 谁决定版本 | 读启动器的记录（`cache/status.json`） | 桥那一行的 `env.REA_SPEC` / `args --spec=` |
| 何时生效 | 记录变化后 **或桥每次重新启动后**（浮动 tag 会重新解析）**约 1 秒** | **桥进程下次启动时** |
| 能热更新吗 | **能** —— 拉新的、把软链指过去 | **不能** —— 正在跑的服务器不会换 |
| 怎么触发 | 自动（跟着记录；浮动 tag 每次桥启动都重解析一次） | 重启 dsh / 在 Plugins 页把这一行**停用再启用** / 桥自己崩溃后重连 |

**关键一条**：写死的版本号不可能变，所以只有浮动 tag（`latest`）会在每次桥启动时重新解析 ——
这正是"自动更新"真正生效的地方：REA 发了新版 → 桥下次启动自动跑新版 → 技能在约 1 秒内**跟着换到同一个发布版**。
代价是每次桥启动一次 registry 查询（不是每次轮询），断网时如实报「技能拉取失败」而不是假装对齐。

**实测（本机 dsh 0.2.0-rc.2，2026-10-11）**：在设置页改版本会往 profile 的 `cordis.patch.yml` 写一个
**带定界符的管理块**（对 `rea-bridge` 行的完整 `config` 覆盖 + `env.REA_SPEC`）。那个文件被 dsh 的 HMR 监视，
所以**桥会原地重载，不用重启**：

```
写入 REA_SPEC=6.4.0  → 桥重载，新 pid，status.json 记为 spec=6.4.0      （约 10 秒内）
撤掉该块 → 桥再次重载，status.json 记回 spec=latest                      （约 31 秒）
撤掉后文件与原始内容逐字节一致（零残留）
```

所以本节上面那句"要重启"只适用于**手工改配置**或极端情况；**用页面上的按钮不需要重启**。
页面的「检查更新 / 更新到 X / 跟随最新」走的就是这条路径，并且写入后会等启动器的记录来**证明**重载发生了
（最长等 45 秒），而不是自己宣布成功。

**为什么需要写"完整 config"**：`applyEntryPatches` 对 `config` 是**整体赋值**而不是深合并
（`cordis-plugin-include/lib/index.js` 的 `target[key] = value`），所以覆盖块必须带上 `serverName`/`transport`/
`command`/`args`，否则会把桥那一行配坏。`profile-override.js` 是按这条约束写的，`selftest.mjs` 的 Part F 守着它。

**为什么"桥重启"不需要重新求值 `!!js`**：版本号不在 patch 的 `!!js` 结果里（此时 `args` 只是
`[launcher.mjs, mcp]`），而由 `launcher.mjs` 在拉起时读 `env.REA_SPEC` 决定。唯一例外是 **bare 那一级**
（连 node 都没有）：那时版本被拼进 bridge 的 `args`，冻结在激活时刻 —— 那种环境下换版本必须重启 dsh。

**怎么确认现在跑的是哪个版本**（不用猜）：

- `cache/status.json` —— 启动器每次拉起写一份：`mode` / 完整 argv / `spec` / `pid` / 选路理由
- 设置页的「当前状态」区（它调的 Host 方法 `diagnose()`）：
  `drift`（`aligned` / `stale` / `unknown`，**由"启动器的记录"与"技能当前版本"比对得出**）、
  `bridge`（`mode` / `spec` / `launchedAt`）、`skill`（版本 / spec / 来源 / 错误）、
  `catalogInvalidation`、`resolution`（现在会选哪一级）

`drift.state` 有四个，区分得比"像不像"更细（都是实测过的语义）：

| 值 | 含义 |
|---|---|
| `aligned` | 技能正是桥在跑的那个发布版（写死的版本号对得上） |
| `stale` | 不一致 —— 具体原因在 `drift.reason`：`skill-refresh-failed`（拉取失败，正在用兜底副本）、`skill-not-fetched`（从没成功拉过）、`spec-mismatch`（正在切换，下次轮询跟上） |
| `unverified` | 两边都是同一个**浮动 tag**，且桥在本技能抓取之后重启过 —— 离线判不出来。**这是暂态**：下一次重解析（每次桥启动都会做）就会把它变成确定答案 |
| `unknown` | 还没有桥的记录（刚装上、或桥被停用） |

**这个判断永远来自记录与实际抓取结果，不来自任何声明值**；技能拉取失败时绝不会报成 `aligned`。

### 往 profile patch 写东西的规矩

钉版本会写你自己的 `cordis.patch.yml`，所以这一块按四条规矩做（每条都对应一个曾经的缺陷）：

1. **标记按整行匹配，且块内必须含本插件的行 id** —— 否则一段"提到"了标记的用户注释会被误当成我们的块，下一次移除就把用户自己的行一起删掉。
2. **拒绝 ≠ 已是最新**。遇到只有开始标记没有结束标记、或有形似标记但不含本插件行的块，**宁可不写**，并如实告诉你"为避免误删，文件没有改动"。
3. **原子写 + 用同一把锁 + 保留权限**。优先用 dsh 自己的 `@deepseek-ai/dsh-atomic-write`：`withFileLock` 锁在 **`<profile>/package.json`**（与 dsh 自己的写入者互斥 —— `dsh-config-editor` 写同一个文件时用的就是这把锁），再用 `writeFileAtomic` 落盘；拿不到这个包时回退到"同目录临时文件 + `rename`"。mode 固定 0600（原来是 `-rw-------`，不能悄悄放宽）。这个文件 dsh 自己也在写，写到一半崩了会让**下次启动**组不出配置。
4. **绝不写出 dsh 不接受的文件**。该文件必须解析成一个顶层数组；实测（用 dsh 自己那套 schema）空文件与纯注释文件都解析成 `undefined`/`null` 并触发 `config file must be a top-level array of entries`。所以"移除后什么都不剩"时要留下显式的 `[]`，而不是一个换行。

## 装完你会看到什么

装好并重启 dsh 后：

**1. Plugins 页多一张卡片** —— 「逆向工程 / Reverse Engineering」，描述里说明它接的是谁、能做什么。

**2. 点卡片那行的箭头（`›`）进设置页**，从上到下四块：

| 区块 | 内容 |
|---|---|
| 技能开关 | 一个开关：是否把 `reverse-engineer-anything` 技能提供给 agent。默认开。 |
| **当前状态** | 逐条自检：桥的启动记录（方式/时间/spec）、启动器按阶梯选了哪一级、技能与桥版本是否对齐、技能来源（npm 原件 / 包内兜底）、技能开关是否即时生效、缓存体积、当前是否钉了版本。**任何失败都在这里显示，不用去翻日志。** |
| **REA 版本** | 一个输入框 + 「应用」/「跟随最新」。留空应用 = 自动更新；填具体版本 = 钉住。 |
| 检查更新 | 一行按钮：显示「正在运行 / 最新发布」，有新版时给出「更新到 X」。同时报告**本插件自己**有没有新版。 |

**3. 模型那边**：工具以 `mcp__rea__<tool>` 出现；技能出现在会话技能目录里（可用 `/` 调）。

**4. 控制台/日志**：每次状态变化（技能安装、启动器选路）都会打一行 `rea-dsh:` 开头的日志，页面读的就是同一份事实。

## 技能开关

**默认开启**，与上游一致：REA 的引导式 setup *"installs the package's matching skill by default"*。
关掉后 agent 拿不到那套分析/取证方法说明，只剩 MCP 工具。

**开关怎么生效**：

```
设置页改 skills → Host 半 1 秒轮询读到新值
                → 维护 skills-live/（开：软链当前技能来源；关：清空）
                → 显式调 ctx.skills.invalidateCache()
                → agent 在下一步（agent/pre-step）拿到新目录
```

`invalidateCache()` **是必需的，不是优化**：provider 自己的 watcher 覆盖不到"已经收到过目录的会话"，
这是 `AGENTS.md` 记过的实测结论。但它**不在上游公开契约里** —— `dsh-skill` 的 README 只承诺
provider 自持的 `invalidate()`。所以这里对它做**存在性检测**：方法不在（dsh 改名/移除）就记
`catalogInvalidation: "missing"` 并告警，说明"技能变更改为需要重开会话"，而不是静默变成空操作。

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

- 本包对宿主的要求已降到最低：宿主有 node/npm 时复用它（复用 npm 缓存）；没有、或 GUI 启动没拿到 PATH 时
  **用 dsh 自带运行时**（自带 node + pnpm），所以桌面端**不装 node/npm 也能起**（见《怎么拉起 REA》）。
  装了全局 `rea` 会走最前面那一级。
- 首次拉取需要能访问 npm registry。
- 原生反编译另需 **Hopper / Ghidra / IDA** 之一；**纯静态 JavaScript 分析不需要**任何原生分析引擎。
  本机 `binary_session` 实测：Ghidra 未配置（`GHIDRA_INSTALL_DIR` 未设），Hopper 可用。

## 随包的技能

`skills/reverse-engineer-anything/`：`SKILL.md` + 6 篇 `references/`。它是**离线兜底**：
拿不到 npm 上的同版本技能时用它，保证断网也有技能可用。

**它不再需要手工维护**。桥跑哪个版本，技能就自动取哪个版本（见《技能跟随版本》），
仓库里这份只在拉取失败时被用到。真要刷新它，把 `skill-source.js` 的 `ensureSkillInCache`
指向一个目标目录跑一次即可 —— 它是纯函数，`cacheDir` 可以指到任意位置。

> ⚠️ **`ctx.baseUrl` 指向 profile 目录**（`~/.dsh/profiles/<name>/`），**不是**提供 patch 的
> bundle 目录。不能直接往它上面拼路径 —— 那样会指向一个不存在的空目录，技能**静默消失**。
> 这里用 `createRequire(ctx.baseUrl).resolve('@jedeiah/rea-dsh/package.json')` 从 profile 锚点
> 解析出本包真实安装位置，与 dsh 自己的 preset patch 是同一手法（`command`/`args`/技能目录
> 三处 `!!js` 都这么做）。

## 安装 / 卸载

在 Plugins 页面安装，或用 `plugin_manager` 工具：

- 安装：`action: install_bundle`，`target: <本目录的绝对路径>`
- 卸载：`action: remove_bundle`，`target: @jedeiah/rea-dsh`

**保持本目录在原位。** `install_bundle` 是把 profile 链接到这个路径、而不是复制。

**装完（或改动本包代码后）要重启 dsh** —— 桥的 `command`/`args` 是激活期求值的。

**卸载后不留残留**：MCP 桥与技能提供方都由本包的 patch 层提供，插件不在就都不生效。
技能提供方只扫本包 `skills-live/`（`includeDefaultRoots: false`），**不读写 `~/.agents/skills`**。
本包的全部写入都在**包目录之内**：

| 位置 | 内容 | 卸载后 |
|---|---|---|
| `skills-live/` | 指向当前技能来源的软链 | 随包目录消失 |
| `cache/skill/<版本>/` | 从 npm 取回的技能（含 `.origin.json` 记录来源与逐文件 sha256） | 随包目录消失 |
| `cache/status.json` | 启动器实际用的命令与选路理由 | 随包目录消失 |

**包目录之外，插件只在一种情况下写东西**：你在设置页**主动钉版本**时，它会往本 profile 的
`cordis.patch.yml` 追加一块带定界符的覆盖（`rea-bridge` 行的完整 config + `env.REA_SPEC`）。
那块是这个插件拥有的，点「跟随最新」即整块删除、文件逐字节还原（已实测）。

除此之外包目录外没有任何写入。剩下的痕迹是包管理器自己的缓存（`~/.npm/_npx/…`、pnpm store），
那是 npx/pnpm 的行为，任何用它们拉 MCP 服务器的插件都一样，可以随时安全删除。

> ⚠️ **卸载前建议先在页面上点一次「跟随最新」。** 如果留着覆盖块就卸载，profile 里会剩下一块指向
> 已消失的行的覆盖 —— dsh 只会记一条 `patch: entry not found` 的 warning，不影响启动，但那是块垃圾。
> （卸载后没有任何东西还在运行，也就没人能替你把这块删掉了。）

## 从上游文档的装法迁移过来（重要）

如果你之前照 REA 官方文档做过 dsh 接入，**先撤掉手工那两处再装本插件**，否则会出现两个同名注册：

1. profile 的 `cordis.patch.yml` 里手工追加的 `rea-mcp` 条目 —— 删掉它（本插件自带桥那一行）。
   上游原文：*"Register `serverName: rea` only once in each active profile"*；
   两个同名条目里**后一个会以 `serverName is already in use` 失败**。
2. `~/.agents/skills/reverse-engineer-anything/`（`rea setup --skill` 装的副本）—— 建议删掉。
   本插件**不写**那个目录，但 dsh 默认会扫它，于是同一份技能会被发现两次（本插件的
   `includeDefaultRoots: false` 只隔离了本提供方，隔离不了别的提供方）。

## 与 dsh-purge 的关系

两者**正交**，可共存：

- **dsh-purge** 改造宿主，解除 dsh 自身的限制 —— 管的是"能不能"
- **本插件** 给模型逆向工程的能力 —— 管的是"会不会"
