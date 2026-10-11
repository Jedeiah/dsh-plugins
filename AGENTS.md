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
- **一个 `serverName` 只能有一条 MCP 桥行。** 两条会起两个同名服务器、工具表打架。要提供互斥的两种
  连接方式（例："自己拉起 Chrome" / "接管我的浏览器"），就定义**两条行**、由开关改写 `disabled` 二选一。
- **想让开关"即点即生效"，载体必须是 patch 的结构性字段。** dsh 的 HMR 按 `id` 比较条目、只重挂变化
  的那几行，所以改 `disabled` 是即时的（本机实测约 4 秒，双向）。两个反例，都实现过：
  - **两次 `plugin_manager.setPluginEnabled()` 有竞态**：第一次返回时被禁用的那行 **fiber 还没卸载**，
    第二次启用就撞 `mcp-client` 的 `serverName is already in use`。一次写完两条没有这个中间态。
  - **`config` 里的 `!!js` 只在条目激活时求值**（`cordis-plugin-loader` 的 `interpolate` 在激活时跑，
    返回值是 `{__jsExpr}` 节点本身，比较时也与文本同值）。所以"把模式写进包内文件、让 `args` 读它"
    不会让任何条目激活（HMR 不监视 `node_modules`），切换就退化成"必须重启"。
    对比：`disabled` 的 `!!js` 是另一条路径 —— **每次挂载决策时求值**（官方文档
    `develop/cordis-tutorial/05-config` 明确写了这是 dsh 的扩展）。
- **改写 profile 的 `cordis.patch.yml` 必须幂等。** dsh 的 HMR **监视那个文件**（`dsh-hmr` 的
  `patchFiles = [profile.patchPath, join(profile.home, 'cordis.patch.yml')]`），插件若在 1 秒轮询里
  无脑写入 —— 哪怕内容没变 —— 会让 HMR 反复重挂那两行。**写前比较内容，一样就不写。**
  另外 `disabled` 是 patch 的合法字段，按 id 覆盖（`cordis-plugin-include` 的 `applyEntryPatches`
  把 `{id, insert, name, ...overrides}` 里的 overrides 盖到目标 entry），所以 profile 层能覆盖 bundle 层。

本机特定的事项（node 从哪来、dsh 路径、重启命令等）在 `AGENTS.local.md`（不入 git）。
