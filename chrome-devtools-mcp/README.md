# @jedeiah/chrome-devtools-mcp

一个**纯配置型 dsh 组合包**：通过官方自带的 `@deepseek-ai/dsh-mcp-client` 桥接，把
[`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp) 服务器接进当前
Harness profile。

它存在的意义，是让这条 MCP 连接变成一个**受管理的组合包**（在 **Plugins** 页面里安装、
启用、卸载），而不是 profile 的 `cordis.patch.yml` 里手写的一行。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 组合包清单；`dsh.bundle.patch` 指向下面的 patch |
| `cordis.patch.yml` | 插入一行 `dsh-mcp-client`（`serverName: chrome-devtools`） |
| `locale/{en,zh}.json` | Plugins 卡片上的标题与描述 |
| `icon.svg` | 卡片图标 |

**没有 `index.js`**：本包只承载配置，没有宿主代码。

**行名故意指向官方桥**：`cordis.patch.yml` 里的 `name` 是 `@deepseek-ai/dsh-mcp-client`（不是本包名），因为真正要挂载的是 dsh 自带的 MCP 客户端。三个后果值得知道：

- Plugins 页那一行的标题/描述/图标来自**桥的清单**（它没有 `locale/`、没有 `icon`），所以显示的是英文原始名，本包的 `locale/` 与 `icon.svg` 不会作用到那一行；
- 该行**永远不会加载本包的客户端半边**（浏览器模块表的扫描按行名取包），将来若给本包加界面，需要把行名改回包名并自行插入桥；
- 如果你以前在 profile 的 `cordis.patch.yml` 里手写过 `dsh-mcp-client` 行，**先删掉它**再启用本包，否则同一个 `serverName` 会起两个服务器。

## 它是怎么连的

```yaml
serverName: chrome-devtools
transport: stdio
command: npx
args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect', '--no-usage-statistics', '--no-performance-crux']
```

`npx` 从宿主 `PATH` 解析，所以需要装好 node/npm，且首次运行要能访问 npm 源。包会缓存
在 `~/.npm/_npx/`，之后启动直接复用。工具对模型呈现为 `mcp__chrome-devtools__<tool>`。

## 安装 / 卸载

在 Plugins 页面安装，或用 `plugin_manager` 工具：

- 安装：`action: install_bundle`，`target: <本目录的绝对路径>`
- 卸载：`action: remove_bundle`，`target: @jedeiah/chrome-devtools-mcp`

**保持本目录在原位。** `install_bundle` 是把 profile 链接到这个路径、而不是复制，所以
移动或删除目录会让组合包失效。

## 改配置

编辑这里的 `cordis.patch.yml`，然后把组合包关掉再打开（或重启 Harness）以重新组合。
该文件在 profile 之外，不受 HMR 监视。

## 平台

本包只提供 patch 行，真正启动 MCP 服务器的是官方 `@deepseek-ai/dsh-mcp-client`，进程启动交给 dsh 的 subprocess seam（平台差异由它处理）。共同前提是宿主 PATH 上有 `node` / `npm`：首次运行由 `npx` 拉取 `chrome-devtools-mcp`，之后缓存在 npm 的 npx 缓存里。
