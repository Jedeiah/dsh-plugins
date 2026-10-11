# 逆向工程（Reverse Engineering）

把 [REA](https://github.com/morluto/rea) 的 MCP 服务器接进本 dsh profile，并附带它的技能副本。
原先需要手写在 profile `cordis.patch.yml` 里的那几行，现在由这个组合包管理 —— 于是它能像其它插件一样从 Plugins 页面启用、停用与卸载。

## 装了什么

| 项 | 说明 |
|---|---|
| **MCP 服务器** | `npx -y rea-agents@latest mcp`，工具注册为 `mcp__rea__<tool>` |
| **技能** | `reverse-engineer-anything`（`SKILL.md` + 6 篇 `references/`） |
| **能力** | 分析原生二进制、Electron/JavaScript 应用、.NET 程序集、APK、固件与网页 |

## 前置条件

- 宿主有 `node` / `npm` —— 首次运行由 `npx` 拉取 MCP 服务器，需要能访问 npm registry
- 原生反编译另需 **Hopper / Ghidra / IDA** 之一；**纯静态 JavaScript 分析不需要**任何原生分析引擎

## 技能从哪来

技能随本包分发，位于 `skills/reverse-engineer-anything/`。插件生效时：

1. **以副本为基线** —— 用 `createRequire(ctx.baseUrl).resolve('@jedeiah/rea-mcp/package.json')` 解析出本包的真实安装位置，再取其中的 `skills/`，**不硬编码任何机器路径**

   > ⚠️ **注意**：`ctx.baseUrl` 指向的是 **profile 目录**（`~/.dsh/profiles/<name>/`），**不是**提供 patch 的 bundle 目录。所以不能直接往它上面拼 `skills/` —— 那样会指向一个不存在的空目录，技能会静默消失。这里的 `createRequire` 锚点手法与 dsh 自己的 preset patch 一致。
2. **机会性刷新** —— 若 `~/.npm/_npx` 下当时恰好存在 `rea-agents/skills`，就覆盖副本

**为什么这样做**：MCP 每次由 `npx` 拉起，包目录**用完即弃**，没有稳定路径可指；所以必须自带副本兜底。而技能是**用法说明**，MCP 工具本身始终是 `@latest` —— 真正干活的工具一直在更新，滞后的只是说明文字，因此副本稍有滞后可以接受。

需要强制刷新技能副本时，重新拉取 REA 的 `.agents/skills/reverse-engineer-anything/` 覆盖本包 `skills/` 即可。

## 卸载

从 Plugins 页面移除即可。MCP 桥与技能提供方都由本包的 patch 层提供 —— **插件不在，两行就不生效**。

技能提供方只扫本包副本（`includeDefaultRoots: false`），**不会读写 `~/.agents/skills`**，卸载后不留残留。

## 与 dsh-purge 的关系

两者**正交**，可共存：

- **dsh-purge** 改造宿主，解除 dsh 自身的限制 —— 管的是"能不能"
- **本插件** 给模型逆向工程的能力 —— 管的是"会不会"

## 出处

技能副本取自 [morluto/rea](https://github.com/morluto/rea) 的 `.agents/skills/reverse-engineer-anything/`（MIT）。
