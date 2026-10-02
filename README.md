# dsh 插件集

一组 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）** 组合包（bundle）：
装上就能用的小功能，每个插件一个顶层目录。

> ⚠️ **非官方项目。** 本仓库由社区维护，与 deepseek-ai 无隶属关系，也不属于官方插件市场。

## 插件一览

| 插件 | 作用 | 版本 |
|---|---|---|
| **[turn-notifier](turn-notifier/README.md)** | **回合提醒**：智能体答完一轮、或停下来等你操作（审批 / 提问）时响铃；不动鼠标键盘就按设定间隔重复（默认 5 秒 ×3），一动就停。两种场景两套音，音调 / 波形 / 音量 / 次数都能在 Plugins 页面里配置 | 1.5.1 |
| **[web-fetch-fakeip](web-fetch-fakeip/README.md)** | **抓取兼容 fake-ip 代理**：复用官方 HTTP 抓取提供方的整条流水线，只额外放行本地 TUN 代理（Clash / Shadowrocket）的 fake-ip 段，让 `web_fetch` 开着代理时也能正常工作 | 5.0.0 |
| **[chrome-devtools-mcp](chrome-devtools-mcp/README.md)** | **Chrome DevTools MCP**：给模型浏览器调试工具（页面管理、快照、截图、DOM/JS 求值、控制台、网络、性能分析），工具名形如 `mcp__chrome-devtools__<tool>` | 1.0.0 |

每个插件都是**独立、可单独安装**的组合包：`package.json` 里声明 `dsh.bundle.patch`，patch 文件插入该插件的行；带界面/交互的插件再声明 `dsh.client` 提供客户端半边。

## 环境要求

| 项 | 说明 |
|---|---|
| dsh 版本 | **0.2.0-rc.2**（桌面端）实测通过；更早版本未验证 |
| 构建步骤 | **不需要** —— 三个插件都是**纯 JS、零构建**（没有 `src/`、没有 tsdown、没有 install 脚本） |
| 依赖安装 | **不需要手动装** —— 对 dsh 自带包的依赖写在 `peerDependencies` 里，由 dsh 的模块解析器路由到安装里的副本 |
| 平台 | 插件本身与平台无关；`chrome-devtools-mcp` 需要宿主有 `node`/`npm`（首次运行由 `npx` 拉取 MCP 服务器） |
| 适用场景 | `web-fetch-fakeip` 只在使用 TUN + fake-ip 代理（Clash / Shadowrocket 等）时才有意义 |

## 安装

**方式一（界面）**：把本仓库放到一个**不会被移动**的目录，然后在 dsh 的 **Plugins 页 → Add plugin** 里填**该插件目录的绝对路径** → 安装 → Enable now。

**方式二（工具）**：`plugin_manager` → `action: install_bundle`，`target: <插件目录绝对路径>`。

**方式三（不用 clone，直接从 GitHub 只装其中一个）**

本仓库是单仓多包。pnpm 支持用 `#path:` 精确到子目录，所以可以直接装任意一个插件：

```bash
dsh plugin --profile <你的profile> add "git+https://github.com/Jedeiah/dsh-plugins.git#path:turn-notifier"

# 简写形式（github: 是 git URL 的简写）
dsh plugin --profile <你的profile> add "github:Jedeiah/dsh-plugins#path:turn-notifier"
```

把 `turn-notifier` 换成 `web-fetch-fakeip` 或 `chrome-devtools-mcp` 就能装别的。要点：

- `#path:` 后面**不要多写斜杠**（写成 `#path:/turn-notifier` 会失败）—— 已在 pnpm 11.22 实测。
- 这种方式会**克隆整个仓库**（不是 sparse checkout），仓库小所以无所谓。
- 装出来的是 **git 依赖**（不是 `link:`），升级 = 重新 `add` 一次。

> **为什么本仓库的插件能这样装？** 官方《打包与安装插件》警告：git 安装拉的是**源码**、
> 不会运行构建脚本，所以 TypeScript 包到手时缺 `lib/` 输出、加载会失败。本仓库的插件全是
> **纯 JS、零构建**（直接写 `index.js` / `client.js`，没有 `src/`、没有 tsdown），因此不受这条
> 限制。**新增插件时请保持这一点**，否则 `#path:` 这种安装方式会失效。

> ⚠️ 方式一、方式二装出来的是 `link:` 软链，不是复制。**不要移动或删除插件目录**，否则 bundle 会失效（典型表现：`包元信息错误`、或该行 `failed to import`、或行启用了但功能不出现）。

**卸载**：Plugins 页里 Remove，或 `plugin_manager` → `action: remove_bundle`。

## 新增一个插件

在仓库根下建一个目录，放这些文件：

| 文件 | 必需 | 说明 |
|---|---|---|
| `package.json` | ✅ | 声明 `dsh.bundle.patch`；有客户端半边再声明 `dsh.client` |
| `cordis.patch.yml` | ✅ | `insert:` 该插件的行（`id` + `name`） |
| `index.js` | ✅ | 宿主半边；纯客户端插件可以导出空的 `apply` |
| `client.js` | 可选 | 客户端半边，用 `window.__ModuleLoader__.load({ id, factory })` 注册 |
| `locale/{en,zh}.json` | 可选 | Plugins 卡片的标题与描述，**结构必须是 `{"meta": {"title", "description"}}`** |
| `icon.svg` | 可选 | 卡片图标 |

约定（来自官方文档；踩过的坑都记在各插件自己的 README 里）：

- **宿主半边不要写死可调参数。** 导出 `Config` schema（`import z from '@deepseek-ai/schemastery'`），字段加 `.volatile()`，这样它们才会出现在 Plugins 页面的配置表单里。
- **从 dsh 安装目录里 import 的包，必须写进该插件的 `peerDependencies`。** 本仓库的插件是 `link:` 进 profile 的，裸导入靠这条声明被路由到安装里的副本（否则报 `ERR_MODULE_NOT_FOUND` → 该行 `failed to import`）。
- **客户端半边别写 `immediately: true`**，除非真的需要启动期预取——它会把这一行划进 bootstrap 阶段，而 bootstrap 条目无法被动态移除/替换。
- `@local/*` 只是本地作用域名。**改名要同步改 `cordis.patch.yml` 里的行名并重新安装。**

## 已知的 dsh 侧问题

- **停用一行带客户端半边的插件后再启用，客户端半边不会重新挂载**，需要重启 App 才能恢复（表现为该行的界面/配置页消失，内置插件面板报 `loaded without registering ... via __ModuleLoader__.load`）。已上报：[deepseek-harness#8452](https://github.com/deepseek-ai/deepseek-harness/discussions/8452)。在修好之前：**别用行开关去临时静音**，改用插件自己的配置（例如把音量调 0）。
- **在 `link:` 安装的 bundle 里，对 dsh 自带包的静态 `import` 会失败**（条目连 fiber 都建不起来，诊断只报 `failed to import`，不打印真实原因）；同一 specifier 改成模块作用域的 `await import(...)` 就正常。`web-fetch-fakeip` 就是这么处理的，见它的 README《实现注记》。

## 贡献

欢迎提 PR / issue：

- 加插件：按上面《新增一个插件》的文件与约定来。
- 改现有插件：请保持**纯 JS、零构建**，可调参数走 `Config`，界面文案走客户端 locale。
- 如果踩到 dsh 自身的坑，欢迎连带把复现步骤写进对应插件的 README（本仓库的风格是"把坑记在原地"）。

## 许可

[MIT](LICENSE) —— 与 dsh 本身一致。
