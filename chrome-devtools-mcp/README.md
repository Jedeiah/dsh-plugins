# 浏览器调试（Browser Debugging）

把 [`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp) 接进当前 dsh profile。官方 `@deepseek-ai/dsh-mcp-client` 桥负责拉起 MCP 服务器，本包另外把它自带的 7 个调试技能分发给智能体，并提供一个可开关的设置页。

## 功能

- 给模型提供浏览器调试工具：页面、快照、截图、DOM/JS 求值、控制台、网络和性能分析。
- 工具名形如 `mcp__chrome-devtools__<tool>`。
- 可以自己拉起一个独立 Chrome，也可以接管你正在使用的 Chrome（复用登录态和标签页）。
- 随包提供 7 个调试技能，可在设置页打开或关闭。

## 浏览器模式

| 模式 | 行为 | 代价 |
|---|---|---|
| `launch`（默认） | MCP 自己拉起一个 Chrome，profile 在 `~/.cache/chrome-devtools-mcp/chrome-profile` | 独立浏览器，没有你当前的标签页与登录态；用户零操作 |
| `attach` | 用 `--autoConnect` 接管你正在使用的 Chrome | 需要 **Chrome 144+**，先在 `chrome://inspect/#remote-debugging` 打开 Remote Debugging；每次连接 Chrome 会弹一次 Allow |

在 Plugins 页的设置页切换 `browser` 即可，不需要重启。

## 技能

| 技能 | 用途 |
|---|---|
| `chrome-devtools` | 总览：怎么用这套工具 |
| `chrome-devtools-cli` | CLI 形态的用法与安装 |
| `a11y-debugging` | 无障碍（a11y）问题调试 |
| `cookie-debugging` | Cookie 相关问题排查 |
| `debug-optimize-lcp` | LCP 性能诊断与优化 |
| `memory-leak-debugging` | 内存泄漏定位 |
| `troubleshooting` | 连接与常见故障排查 |

技能默认关闭，与上游一致；打开后智能体可在下一步拿到技能目录。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `skills` | `false` | 是否把随包技能提供给智能体 |
| `browser` | `launch` | 浏览器模式：`launch` 或 `attach` |

在 **Plugins 页 → 展开本插件卡片 → 点开「浏览器调试」那一行** 修改。

## 安装与卸载

- **Plugins 页**：Add plugin，填 `github:Jedeiah/dsh-plugins#path:chrome-devtools-mcp`，安装后启用。
- **`plugin_manager`**：`action: install_bundle`，`target: github:Jedeiah/dsh-plugins#path:chrome-devtools-mcp`。
- **卸载**：Plugins 页 Remove，或 `plugin_manager` → `action: remove_bundle`，`target: @jedeiah/chrome-devtools-mcp`。

## 环境要求

- 宿主 `PATH` 上有 `node` / `npm`；首次运行由 `npx` 拉取 `chrome-devtools-mcp`，之后缓存在 npm 的 npx 缓存里。
- `attach` 模式额外要求 Chrome 144+ 并开启 Remote Debugging。

## 已知边界

- **设置页改动后，插件列表那两行的状态不会自动刷新**：列表可能显示过期状态；请以设置页的 `browser` 开关为准。
- **输入框的 `/` 技能建议列表不会实时刷新**：运行时改技能开关会立即作用于模型，但 `/` 列表只在切换预设、重连或插件管理变更时重建；重开对话或切换预设即可。

## 兼容性

适配 dsh **0.2.2-rc.1**，不兼容更早版本。
