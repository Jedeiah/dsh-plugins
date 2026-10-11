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

1. **纯 JS、零构建。** 直接写 `index.js` / `client.js`；不要 `src/`、不要 tsdown、不要 install 脚本。
   这是 `github:…#path:` 免 clone 安装方式可行的前提 —— 官方文档警告 git 安装拉的是**源码**、
   不会跑构建脚本，TypeScript 包到手会缺 `lib/` 而加载失败。
2. **从 dsh 安装目录 import 的包，必须写进该插件的 `peerDependencies`。** 这些插件是 `link:`
   进 profile 的，裸导入靠这条声明被路由到安装里的副本，否则 `ERR_MODULE_NOT_FOUND`。
3. **`locale/{zh,en}.json` 的结构必须是 `{"meta": {"title", "description"}}`，中英同步改。**
   描述里若要提配置入口，统一用「**点组件行的箭头可设置 …**」/「**use the row's arrow to set …**」，
   并且**只有该插件确实有配置页时才提**。改完同步仓库根 `README.md` 的插件表，两边逐字一致。
4. **可调参数走 `Config` schema**（`import z from '@deepseek-ai/schemastery'`），字段加
   `.volatile()` 才会出现在 Plugins 页面的配置表单里。
5. **有 Host 半的插件要带 `selftest.mjs`。** 没有 dsh 安装时打印 `skip` 并以 0 退出。

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

本机特定的事项（node 从哪来、dsh 路径、重启命令等）在 `AGENTS.local.md`（不入 git）。
