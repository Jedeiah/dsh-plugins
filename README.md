# dsh 插件集

自用的 **dsh 组合包（bundle）** 集合，每个插件一个顶层目录。

每个目录都是一个**独立、可单独安装**的组合包：`package.json` 里声明 `dsh.bundle.patch`，patch 文件插入该插件的行；带界面/交互的插件再声明 `dsh.client` 提供客户端半边。

## 插件一览

| 目录 | 包名 | 作用 |
|---|---|---|
| [`turn-notifier/`](turn-notifier/README.md) | `@local/turn-notifier` | **回合提醒**：智能体答完一轮、或停下来等你操作时响铃；不动鼠标就按设定间隔重复（默认 5 秒 ×3），一动就停。两种场景两套音，音调/波形/音量/次数都能在 Plugins 页面里配 |
| [`chrome-devtools-mcp/`](chrome-devtools-mcp/README.md) | `@local/chrome-devtools-mcp` | 把 **chrome-devtools MCP 服务器**接进 dsh（stdio 桥接），工具名形如 `mcp__chrome-devtools__<tool>`；原先手写在 profile patch 里的那几行现在由本 bundle 管理 |

## 安装某个插件

**方式一（界面）**：把本仓库放到一个**不会被移动**的目录，然后在 dsh 的 **Plugins 页 → Add plugin** 里填**该插件目录的绝对路径** → 安装 → Enable now。

**方式二（工具）**：`plugin_manager` → `action: install_bundle`，`target: <插件目录绝对路径>`。

> ⚠️ **安装方式是 `link:` 软链，不是复制。** 装完**不要移动或删除插件目录**，否则 bundle 会失效（典型表现：`包元信息错误`、或该行 `failed to import`、或行启用了但功能不出现）。

卸载：Plugins 页里 Remove，或 `plugin_manager` → `action: remove_bundle`。

## 新增一个插件

在仓库根下建一个目录，放这些文件：

| 文件 | 必需 | 说明 |
|---|---|---|
| `package.json` | ✅ | 声明 `dsh.bundle.patch`；有客户端半边再声明 `dsh.client` |
| `cordis.patch.yml` | ✅ | `insert:` 该插件的行（`id` + `name`） |
| `index.js` | ✅ | 宿主半边；纯客户端插件可以导出空的 `apply` |
| `client.js` | 可选 | 客户端半边，用 `window.__ModuleLoader__.load({ id, factory })` 注册 |
| `locale/{en,zh}.json`、`icon.svg` | 可选 | Plugins 卡片的文案与图标 |

约定（来自官方文档，踩过坑的都记在各插件 README 里）：

- **宿主半边不要写死可调参数。** 导出 `Config` schema（`import z from '@deepseek-ai/schemastery'`），字段加 `.volatile()`，这样它们才会出现在 Plugins 页面的配置表单里。
- **从 dsh 安装目录里 import 的包，必须写进该插件的 `peerDependencies`。** 本仓库的插件是 `link:` 进 profile 的，裸导入靠这条声明被路由到安装里的副本（否则报 `ERR_MODULE_NOT_FOUND` → 该行 `failed to import`）。
- **客户端半边别写 `immediately: true`**，除非真的需要启动期预取——它会把这一行划进 bootstrap 阶段，而 bootstrap 条目无法被动态移除/替换。
- `@local/*` 只是本地作用域名。**改名要同步改 `cordis.patch.yml` 里的行名并重新安装。**

## 已知的 dsh 侧问题

- **停用一行带客户端半边的插件后再启用，客户端半边不会重新挂载**，需要重启 App 才能恢复（表现为该行的界面/配置页消失，内置插件面板报 `loaded without registering ... via __ModuleLoader__.load`）。已上报：[deepseek-harness#8452](https://github.com/deepseek-ai/deepseek-harness/discussions/8452)。在修好之前：**别用行开关去临时静音**，改用插件自己的配置（例如把音量调 0）。