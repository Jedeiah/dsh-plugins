# dsh 插件集

自己用的 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）** 插件集。每个插件是一个独立、可单独安装的组合包（bundle）。

> **非官方项目。** 与 deepseek-ai 无隶属关系，也不属于官方插件市场。

## 插件一览

| 插件 | 作用 | 版本 | 安装 spec |
|---|---|---|---|
| **[turn-notifier](turn-notifier/README.md)** | **提示铃**：智能体需要你注意时响铃提醒；点组件行的箭头可设置铃声、音色、音量与重复次数。 | 1.9.1 | `github:Jedeiah/dsh-plugins#path:turn-notifier` |
| **[session-purge](session-purge/README.md)** | **删除会话**：在会话列表里添加「删除会话」，把会话真正从磁盘上删掉；点组件行的箭头可设置清理范围。 | 2.0.1 | `github:Jedeiah/dsh-plugins#path:session-purge` |
| **[chrome-devtools-mcp](chrome-devtools-mcp/README.md)** | **浏览器调试**：接入 chrome-devtools-mcp，让模型能调试真实浏览器；点组件行的箭头可设置技能开关，以及让智能体操作哪个浏览器。 | 1.3.1 | `github:Jedeiah/dsh-plugins#path:chrome-devtools-mcp` |
| **[rea-dsh](rea-dsh/README.md)** | **逆向工程**：接入 REA 的 MCP 服务器，让模型能逆向分析二进制、应用与网页；技能自动跟随 REA 版本；点组件行的箭头可查看状态与自检、并设置技能开关和版本。 | 1.5.1 | `github:Jedeiah/dsh-plugins#path:rea-dsh` |

每个插件都是独立、可单独安装的组合包：`package.json` 声明 `dsh.bundle.patch`；带界面的插件再声明 `dsh.client` 提供客户端半边。

## 环境要求

| 项 | 说明 |
|---|---|
| dsh 版本 | **0.2.2-rc.1**（桌面端）；只适配这一版，不兼容更早版本 |
| 构建步骤 | **不需要**：四个插件都是纯 JS、零构建，没有 `src/`、tsdown 或 install 脚本 |
| 依赖安装 | **不需要手动装**：对 dsh 自带包的依赖写在 `peerDependencies` 里，由 dsh 的模块解析器路由到安装里的副本 |
| 平台 | 插件本身与平台无关；`chrome-devtools-mcp` 需要宿主有 `node`/`npm`（首次运行由 `npx` 拉取 MCP 服务器）；`rea-dsh` 不需要，宿主没有 node/npm 时会改用 dsh 自带运行时 |

## 安装

### 方式一：Plugins 页面

打开 **Plugins 页 → Add plugin**，填下表中的安装 spec，安装后启用。

### 方式二：`plugin_manager` 工具

`plugin_manager` → `action: install_bundle`，`target:` 填安装 spec。

卸载用 `action: remove_bundle`，`target: <包名>`，例如 `@jedeiah/turn-notifier`。

### 方式三：`dsh` CLI

```bash
dsh plugin --profile <你的profile> add "github:Jedeiah/dsh-plugins#path:turn-notifier"
dsh plugin --profile <你的profile> remove @jedeiah/turn-notifier
```

`dsh plugin` 会把参数转发给 pnpm，在 profile 目录执行，会实际修改 profile。

## 安装 spec

推荐使用 **GitHub 子目录**，免 clone：

```text
github:Jedeiah/dsh-plugins#path:<插件目录>
```

取子目录用 `#path:`，后面不带前导斜杠。这样装出来的是 **git 依赖**，升级时重新执行一次 `add` 即可；pnpm 会锁定当时的 commit。

也支持：

| 形式 | 例子 | 装出来是什么 |
|---|---|---|
| GitHub 子目录 | `github:Jedeiah/dsh-plugins#path:turn-notifier` | git 依赖（克隆整仓，取子目录） |
| git URL | `git+https://github.com/Jedeiah/dsh-plugins.git#path:turn-notifier` | 同上 |
| 本地路径 | `/abs/path/to/turn-notifier` 或 `link:/abs/path/...` | `link:` 软链，仅开发用 |
| 压缩包 | `./pkg.tgz`、`https://…/pkg.tgz` | 解压副本 |

本地路径安装是软链，**不要移动或删除插件目录**，否则 bundle 会失效。

## 仓库结构

每个顶层目录是一个插件，目录内自带 `README.md`、`package.json`、`cordis.patch.yml`，带界面的插件还有 `index.js` / `client.js` 等文件。具体说明见各插件 README。

## 许可

[MIT](LICENSE)，与 dsh 本身一致。
