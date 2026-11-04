# 逆向工程（Reverse Engineering）

把 [REA](https://github.com/morluto/rea) 接进当前 dsh profile。官方 `@deepseek-ai/dsh-mcp-client` 桥负责拉起 MCP 服务器，本包另外把它的技能分发给智能体，并提供一个可开关、可查看状态和更新版本的设置页。

## 功能

- 给模型提供 REA 的逆向工程工具：原生二进制、Electron/JS 应用、.NET 程序集、APK、固件和网页分析。
- 工具名形如 `mcp__rea__<tool>`。
- 自动选择可用的 REA 启动方式：全局 `rea` → `npx` → dsh 自带运行时（自带 node + pnpm）。
- REA 默认跟随 npm `latest`，也可以钉住一个版本。
- 技能自动跟随桥实际使用的 REA 版本；拉不到 npm 原件时回退到包内副本。
- 设置页显示桥的启动方式、实际 spec、技能和桥是否对齐、技能来源和缓存等状态。

## 安装与卸载

- **Plugins 页**：Add plugin，填 `github:Jedeiah/dsh-plugins#path:rea-dsh`，安装后启用。
- **`plugin_manager`**：`action: install_bundle`，`target: github:Jedeiah/dsh-plugins#path:rea-dsh`。
- **卸载**：Plugins 页 Remove，或 `plugin_manager` → `action: remove_bundle`，`target: @jedeiah/rea-dsh`。

装好或更新本包后需要重启 dsh。

## 配置

### 技能开关

设置页的「技能」开关控制是否把 `reverse-engineer-anything` 技能提供给智能体，默认开启。关掉后智能体只剩 MCP 工具，没有分析/取证方法说明。

### REA 版本

默认跟随 npm `latest`。钉住版本时，在桥那一行的配置里写：

```yaml
- id: rea-bridge
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: rea
    transport: stdio
    env:
      REA_SPEC: '6.4.0'      # 不写则跟随 latest
    command: !!js …
    args: !!js …
```

设置页的「REA 版本」输入框也可以应用具体版本或恢复「跟随最新」；版本变更会触发桥重载。

## 设置页

点插件卡片那一行右侧的 `›`，从上到下包括：

| 区块 | 内容 |
|---|---|
| 技能开关 | 是否向智能体提供 `reverse-engineer-anything` 技能 |
| 当前状态 | 桥的启动记录、启动器选择的方式、技能与桥版本是否对齐、技能来源、缓存大小、当前是否钉住版本 |
| REA 版本 | 输入版本并应用，或跟随最新 |
| 检查更新 | 显示正在运行的版本和最新发布版本，有新版时可更新 |

## 技能

技能默认开启，与上游一致。技能内容由桥实际使用的 REA 版本决定：从 npm 取对应版本的官方技能，校验 tarball 完整性后落到缓存；拉取失败时用包内副本兜底。

## 环境要求

- 宿主有 `node`/`npm` 时复用其缓存；没有或 GUI 启动拿不到 `PATH` 时，使用 dsh 自带运行时（自带 node + pnpm），桌面端不装 node/npm 也能启动。
- 首次拉取技能需要访问 npm registry。
- 原生反编译需要 Hopper / Ghidra / IDA 之一；纯静态 JavaScript 分析不需要原生分析引擎。

## 已知边界

- 输入框的 `/` 技能建议列表不会实时刷新：技能开关会立即作用于模型，但 `/` 列表只在切换预设或重连时重建；重开对话或切换预设即可。
- 桥进程正在运行时不会切换版本；通过设置页修改版本会触发桥重载，手工改 `cordis.patch.yml` 后需要重启 dsh 或停用再启用桥那一行。

## 兼容性

适配 dsh **0.2.2-rc.1**，不兼容更早版本。
