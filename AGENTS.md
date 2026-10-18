# AGENTS.md

自用的 **dsh 插件集**：每个插件一个顶层目录，各自是一个可独立安装的组合包（bundle）。

> 非官方项目，与 deepseek-ai 无隶属关系。总览、版本与四种安装方式见 [README.md](README.md)。

## 仓库结构

| 目录 | 一句话 |
|---|---|
| `turn-notifier/` | 提示铃：智能体需要你注意时响铃提醒 |
| `session-purge/` | 删除会话：把会话连同子 agent 会话真正从磁盘删掉 |
| `chrome-devtools-mcp/` | 浏览器调试：接入 chrome-devtools-mcp（MCP + 7 个可选技能） |
| `rea-dsh/` | 逆向工程：接入 REA 的 MCP 服务器（MCP + 1 个可选技能） |
| `web-fetch-fakeip/` | 代理抓取：让 `web_fetch` 在 TUN + fake-ip 代理下可用 |

每个插件目录自带 `README.md`，写它自己的设计取舍与踩坑。

## 硬约定

写新插件或改现有插件时这几条不能破：

1. **不猜、不推断 —— 涉及 dsh 的行为，先读官方文档，再读源码。**

   文档站：<https://deepseek-harness.github.io/deepseek-harness/>。**两侧都要读，并顺着左侧导航把相关页面都读掉** ——
   只读别人给的那一页会漏掉前提（本仓库就这么错过一次）。

   - **`develop/`**：`basic/`（第一个插件、插件配置、Tool、打包与安装）、`cordis-tutorial/01..07`
     （第 5 章讲配置与 `volatile`，第 6 章讲组合与热重载）、`framework/`（服务、事件）、
     `practice/`（动态 Cordis、LLM 适配器）。
   - **`reference/`**：**`cookbook/` 是插件写法的真源**（新增 Package / Tool / LLM Adapter / 设置页 / 扩展模式）、
     `cordis-api/`（context / events / fiber / inherited / registry / service）、`cordis-primer`、
     `subsystems/`（tools / skills / settings / client-modules / client-resources / typert / invariants / session …）。
   - 文档没讲清的，才去读源码
     `/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/*/lib/index.js`。
   - 结论里注明依据：**文档哪一节**，还是**源码哪一行**。两者都没有，就不要当成事实写进代码或文档。

   **踩过的坑（记为教训）**：`config` 里的 `!!js` 只在**条目激活时**求值 —— 这写在文档
   `develop/cordis-tutorial/05-config` 里；当时只读源码、推断了相反结论，做出了一版"切换必须重启"的实现，
   白绕好几轮。而 `disabled` 的 `!!js` 是**另一条路径**（每次挂载决策时求值），文档也写了。

2. **纯 JS、零构建。** 直接写 `index.js` / `client.js`；不要 `src/`、不要 tsdown、不要 install 脚本。
   这是 `github:…#path:` 免 clone 安装方式可行的前提 —— 官方文档警告 git 安装拉的是**源码**、
   不会跑构建脚本，TypeScript 包到手会缺 `lib/` 而加载失败。
3. **从 dsh 安装目录 import 的包，必须写进该插件的 `peerDependencies`。** 这些插件是 `link:`
   进 profile 的，裸导入靠这条声明被路由到安装里的副本，否则 `ERR_MODULE_NOT_FOUND`。
4. **`locale/{zh,en}.json` 的结构必须是 `{"meta": {"title", "description"}}`，中英同步改。**
   描述里若要提配置入口，统一用「**点组件行的箭头可设置 …**」/「**use the row's arrow to set …**」，
   并且**只有该插件确实有配置页时才提**。改完同步仓库根 `README.md` 的插件表，两边逐字一致。
5. **可调参数走 `Config` schema**（`import z from '@deepseek-ai/schemastery'`），字段加
   `.volatile()` 才会出现在 Plugins 页面的配置表单里。
6. **有 Host 半的插件要带 `selftest.mjs`。** 没有 dsh 安装时打印 `skip` 并以 0 退出。

## 常用命令

```bash
# 语法检查（本机没有独立的 node，用 dsh 内置的）
EXE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$EXE" --check <插件>/index.js

# 自测
ELECTRON_RUN_AS_NODE=1 "$EXE" <插件>/selftest.mjs

# 改过插件代码或 locale 之后要重启 dsh 才生效
osascript -e 'if application "DeepSeek Harness" is running then tell application "DeepSeek Harness" to quit'
open "/Applications/DeepSeek Harness.app"
```

## 容易重踩的坑

下面每条都踩过，且**多数是静默失败** —— 不报错，只是功能不出现。

- **`ctx.baseUrl` 指向 profile 目录，不是 bundle 目录。** 在 `!!js` 里推导自身路径必须用
  `createRequire(String(ctx.baseUrl ?? '')).resolve('<包名>/package.json')` 再取 `dirname`。
  直接往它上面拼 `skills/` 会指向一个不存在的空目录，**技能静默消失、无任何报错**。
- **被监视的目录必须在启动时就存在。** `dsh-skill-filesystem` 的 watcher 只监视它**第一次看到**的根；
  后来才创建的目录永远不被监听。所以 `skills-live/` 即使为空也要在启动时 `mkdirSync`。
- **改了技能目录要显式调 `ctx.skills.invalidateCache()`。** provider 的失效路径只认**经 dsh 工具
  产生的文件变更**（`fs/observed` 里非工具变更直接 return）；插件自己用 `fs` 写的它看不见，
  于是已经收到过目录的会话永远拿不到新的。
  补充（2026-10）：它**不在上游公开契约里** —— `dsh-skill` 的 README 只承诺 provider 自持的
  `invalidate()`，`invalidateCache` 只出现在 `lib` 实现中。所以它是"必需但非契约"的调用：
  保留，但做成可选链 + **缺失时告警**（否则 dsh 改名后静默失效，表现为"开关不生效"）。
  `rea-dsh` 的 `invalidateCatalog()` 与 `selftest.mjs` Part E 就是这么守的。
  *已知边界*：浏览器 `/` 列表另有一套按 session 的缓存，只在切预设或重连时重建，所以那个列表不会实时刷新
  （[讨论 #9401](https://github.com/deepseek-ai/deepseek-harness/discussions/9401)）；模型端是实时的。
- **`.volatile()` 字段是活句柄，不是值。** 直接读会拿到一个**永远为真**的句柄对象，要 `.get()` 解包；
  用 schema 校验 `{}` 时 volatile 字段同样给出句柄而不是默认值。读取失败**不要静默回退**，要报出来。
- **从 schema 自取默认值：`dict` 挂在 `refs[uid]` 节点上，顶层没有。**
  `schema.toJSON()` 里 `refs[json.uid].dict` 给「字段名 → uid」，再由 `refs[uid].meta.default` 取值。
  这种函数**一定要带空结果告警** —— 否则形状一变就静默丢光全部默认值。
- **`selftest.mjs` 要绕过裸导入。** bundle 顶部有 `import('@deepseek-ai/…')`，而 clone 没有自己的
  `node_modules`（profile 是 `link:` 过来的）。用 `module.register` 把 `@deepseek-ai/*` 锚到 `--app`
  目录（默认 `/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai`），
  不在磁盘上留任何东西。让纯函数接受可注入的目录参数，测试才不碰 bundle 自己的目录。
- **停用再启用带客户端半边的插件，`apply` 不保证重跑**（[deepseek-harness#8452](https://github.com/deepseek-ai/deepseek-harness/discussions/8452)）。
  配置页要注册在 `ctx.inject(['remote.<本插件自己的服务>', …], cb)` 依赖门里，靠 Host 半边重建把页面重新挂上。
- **要提供互斥的两种连接方式（例："自己拉起 Chrome" / "接管我的浏览器"），就定义两条行、由开关改写
  `disabled` 二选一 —— 但两条行的 `serverName` 必须给成不同的。** dsh 给**每一行**都配了启用开关，
  而那个开关只改自己那一行、管不了另一行；同名的话，用户在插件列表里点另一条**必然**撞上
  `mcp-client` 的 `serverName is already in use`（这一秒我们的轮询还没轮到）。不同名则那一瞬间两条
  可以并存，Host 半随后按设置页的值纠正 —— 也才谈得上"把列表里的点击当成切换意图"（写行 +
  `ctx.settings.update(ns, {…})` 把设置页的值也改过去，`ns` 是 profile 条目 id）。
  本仓库 `chrome-devtools-mcp` 就是这么做的，README 里有那张"两行状态 → 含义 → 处理"的表。
- **profile 的 `cordis.patch.yml` 必须是顶层数组；空文件与纯注释文件都过不了。**（2026-10 实测）
  用 dsh 自己的 schema（`JSON_SCHEMA.extend(JsExpr)`）测：`""`→`undefined`、`"\n"`→`undefined`、
  `"# 注释\n"`→`null`，而 `"[]\n"`→`[]`；`Include.read()` 对非数组直接抛
  `config file must be a top-level array of entries`。所以**插件往这个文件写东西时，"没内容了"要写成 `[]`**，
  不能留一个裸换行 —— 否则你交出去的是 dsh 拒绝加载的配置（当前会话不受影响，**下次启动组不出来**）。
- **改别人的文件要守三条：整行锚定标记、拒绝就说拒绝、原子写并保留 mode。**（2026-10 code review 教训）
  ① 标记用 `indexOf` 找子串的话，一段"提到"该标记的用户注释会被当成管理块的开始，下一次移除会**连带删掉用户自己的行**；
  改成按整行匹配 + 块内必须含本插件的行 id，不满足就拒写。
  ② "我认不出这个布局"和"内容已经一致"是两个答案，报成后者会让用户以为钉上了。
  ③ `writeFileSync` 直接写会截断（崩在中间 → 下次启动失败）且把 0600 变成 0644。正解是**用 dsh 自己那套**：
  `@deepseek-ai/dsh-atomic-write` 的 `withFileLock(join(profileDir,'package.json'), cb)` + `writeFileAtomic(path, text, {mode: 0o600})`
  —— `dsh-config-editor` 写同一个文件时锁的就是这个路径，锁对了才不会互相覆盖；`withFileLock` **会返回** cb 的结果（`return await operation()`），
  但读文件必须在**锁内**（先读后锁等于没锁）。裸导入这个包需要 `peerDependencies` 里声明。
- **`config` 覆盖能触发那一行原地重载 —— 但需要 10~30 秒，且必须写全量 config。**（2026-10 实测）
  在 profile 的 `cordis.patch.yml` 里按 id 写一行覆盖，`applyEntryPatches` 会把它盖到目标 entry 上；
  对 `config` 是**整体赋值**（`target[key] = value`），不是深合并 —— 少写一个 `serverName` 就把那一行配坏。
  实测：写入后桥约 10 秒重载（新 pid），撤销后约 31 秒重载；`rea-dsh` 的 `setVersion` 因此把等待窗口设为 45 秒，
  并等启动器自己的记录来证明重载发生，而不是自己宣布成功。
- **想让开关"即点即生效"，载体必须是 patch 的结构性字段。** dsh 的 HMR 按 `id` 比较条目、只重挂变化
  的那几行，所以改 `disabled` 是即时的（本机实测约 4 秒，双向）。两个反例，都实现过：
  - **两次 `plugin_manager.setPluginEnabled()` 有竞态**：第一次返回时被禁用的那行 **fiber 还没卸载**，
    第二次启用就撞 `mcp-client` 的 `serverName is already in use`。一次写完两条没有这个中间态。
  - **`config` 里的 `!!js` 只在条目激活时求值**（`cordis-plugin-loader` 的 `interpolate` 在激活时跑，
    返回值是 `{__jsExpr}` 节点本身，比较时也与文本同值）。所以"把模式写进包内文件、让 `args` 读它"
    不会让任何条目激活（HMR 不监视 `node_modules`），切换就退化成"必须重启"。
    对比：`disabled` 的 `!!js` 是另一条路径 —— **每次挂载决策时求值**（官方文档
    `develop/cordis-tutorial/05-config` 明确写了这是 dsh 的扩展）。
- **Remote 方法要在两处声明，缺一处会让设置页整个空白。** `typert.js` 的 `invocations` 是 Host 交给
  Gateway 的清单，`client.js` 里的 `TYPERT_REMOTE.descriptors` 是客户端查找用的镜像 —— 只加一处，
  调用时会在页面里**同步抛错**，而报错发生在 `useEffect` 里，React 会把整个设置页渲染成空白
  （现象：点组件行的箭头进去什么都没有）。`selftest.mjs` 的 Part A5 用文本比对守这条。
- **在页面组件里读 Host 状态要包 try/catch。** 上面那种缺声明就是同步抛，`Promise.resolve(fn())`
  包不住它。取数函数写成 `try { … } catch { return Promise.resolve(落空值) }`，页面最坏是少个提示而不是白屏。
  `patchFiles = [profile.patchPath, join(profile.home, 'cordis.patch.yml')]`），插件若在 1 秒轮询里
  无脑写入 —— 哪怕内容没变 —— 会让 HMR 反复重挂那两行。**写前比较内容，一样就不写。**
  另外 `disabled` 是 patch 的合法字段，按 id 覆盖（`cordis-plugin-include` 的 `applyEntryPatches`
  把 `{id, insert, name, ...overrides}` 里的 overrides 盖到目标 entry），所以 profile 层能覆盖 bundle 层。

- **共用控件（`@deepseek-ai/dsh-client-ui-primitives`）不是插件 API，用了就必须配一道降级门。**（2026-10，0.2.1 审计）
  dsh 自己的插件开发指南写在 `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`：
  "Do not `require('@deepseek-ai/dsh-client-ui-primitives')`… They change without notice… a throwing component
  blanks your slot entry"。0.2.1 就删掉了 `projectUserText`（本仓库没用，纯属运气）。
  本仓库为了外观一致仍然用它，但每个客户端半边都有 `REQUIRED_PRIMITIVES` + `missingPrimitives`：
  **缺任何一个 → 只隐藏依赖它的界面条目，并在 console 里点名缺哪个；Host 半边照常工作**。
  `Button`/`Switch`/`Modal`/`Toast`/… 这些符号在界面上用到哪些，那个数组就得列哪些 —— 漏列一个，
  就又回到"缺一个、炸整片 slot"的老样子（React 报 `Element type is invalid`，页面一片白）。
- **进程内直调 `gateway.invoke` 必须显式带 `peer`。**（2026-10，0.2.1）
  0.2.0 是 `request.peer ?? this.operatorPeer()`；0.2.1 去掉了默认值，`prepareInvocation` 先 `assertPeerLive(request.peer)`
  再读 `request.peer.principal.kind`，不带 peer 是 `TypeError: Cannot read properties of undefined (reading 'signal')`，
  连 `gateway/peer-disposed` 都轮不到。`session-purge` 的 Part B 因此用 `dsh-client-connection` 导出的 `Peer`
  （`new Peer(ctx, { principal: { kind: 'owner' } })`）为每次调用命名 Peer。浏览器端不受影响。
- **桌面运行时的路径会跟着 dsh 版本挪。**（2026-10，0.2.1）
  0.2.1 把 payload 收进了 `Resources/runtime/primary-runtime/dependencies/{node,pnpm}`，0.2.0 是
  `Resources/runtime/{node,pnpm}`。**两处都探**，别写死一处；`rea-dsh` 的"自带 node + 自带 pnpm"那一级
  就因为只认旧路径而静默退化成 `npx`——在没装 node 的机器上等于起不来。`rea-dsh/selftest.mjs` Part D 守这条。
- **显示资源要从 `exports` 里导出。**（2026-10，0.2.1）
  dsh 读 `meta.title`/`meta.description` 走 `exports["./locale/*.json"]`，图标走 `exports["./icon"]`；
  顶层 `icon` 字段仍然优先、仍然能用，但已是旧写法。五个包的 `selftest.mjs` Part 0 都断言了这两条导出、
  图标是 SVG 且在 256 KiB 内、`files` 里带上了它们。

- **失败路径必须把"先做的事"还回去。**（2026-10，功能审计）
  `session-purge` 的删除顺序被存储层逼成了"先摘工作区槽位、再删日志目录"——槽位不先摘，注册表的过滤视图
  就跳过它，槽位会永远悬空。代价是：**任何"日志没删掉"的分支**（`rm` 权限失败、扫描中途取消）都会留下
  一份**数据还在、但界面再也够不着**的孤儿。现在的约定是：只有日志目录真的没了，才继续清检查点 / spill /
  提醒；失败就把槽位挂回去并放过其余状态，取消则按"目录还在不在"逐个还原。
  `session-purge/selftest.mjs` 用 `chmod 0o500`（日志完好但删不掉）和一个会计数的假 `signal`（删到一半取消）
  分别复现这两条，断言"槽位回来了、检查点还在、未删的目标原封不动"。
  推论：**凡是"先改 A 才能改 B"的顺序，都要想清楚 B 失败时 A 怎么还。**
- **"拿不到就退化"的分支必须留一声。**（2026-10，同次审计）
  共用控件的降级门是一个例子；`turn-notifier` 的 `useSessionStatus` 是另一个——那个 prop 缺席时它会退化成
  空状态表，**铃永远不响、页面一切正常**，看起来像"插件坏了"或"音量没开"。现在两条都在控制台点名原因。
  判断标准：如果缺了这个东西，功能会**静默变成另一个功能**，那就必须有一行诊断。

- **派生数据先看它自己怎么对账，再决定要不要动。**（2026-10，功能审计）
  会话搜索的 SQLite 索引是**派生**的：每次搜索前先与存储对账，把已删会话的行一并清掉再执行查询，所以删会话
  **不需要**插件去改别人的库（那条路径可配、属于另一个包，改它只会多一个失败面）。投影缓存的规矩也一样——
  日志领先、缓存跟随。判断标准很简单：**这份数据能不能从别处重建**；能，就别写它，顶多删掉。
  反过来，**没有**别处能重建的（日志、附件字节），才轮到自己动手。

本机特定的事项（node 从哪来、dsh 路径、重启命令等）在 `AGENTS.local.md`（不入 git）。
