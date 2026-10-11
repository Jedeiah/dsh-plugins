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

## 细节在 `.agents/notes/`

`AGENTS.md` 只放契约定；踩坑的**理由**与**复现**在 notes 里（沿用 dsh 自己的 `.agents/notes/` 约定）：

- [bundle 的技能开关](.agents/notes/implemented/architecture/2026-10-11-bundle-skill-toggle.md) —— 开关怎么变成文件系统事件、为什么 `/` 列表不实时刷新
- [bundle 写作要点](.agents/notes/implemented/architecture/2026-10-11-bundle-authoring.md) —— `ctx.baseUrl` 指向哪、schemastery 读默认值、安装 spec 的形态
- [给 bundle 写离线自测](.agents/notes/implemented/process/2026-10-11-bundle-selftest.md) —— 绕过裸导入、可注入的纯函数

本机特定的事项在 `AGENTS.local.md`（不入 git）。
