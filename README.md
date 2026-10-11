# dsh 插件集

我自己在用的 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）** 插件集。

平时用得上、顺手的小功能，就写成一个组合包（bundle）收进来，每个插件一个顶层目录——换机器或重装时能一把装回；攒下来的顺手公开，别人看着有用可以直接拿去用。

> ⚠️ **非官方项目。** 与 deepseek-ai 无隶属关系，也不属于官方插件市场。仓库里都是自己用得上才写的插件，想到什么加什么。

## 插件一览

| 插件 | 作用 | 版本 |
|---|---|---|
| **[turn-notifier](turn-notifier/README.md)** | **提示铃**：智能体需要你注意时响铃提醒（答完一轮 / 停下来等你操作），不理会就按间隔重复，一动鼠标键盘就停。点组件行的箭头可调提示音、波形、音量与重复次数 | 1.7.0 |
| **[session-purge](session-purge/README.md)** | **删除会话**：在会话行的悬停按钮 / 「…」菜单里加「删除会话」，把会话连同子 agent 会话真正从磁盘上删掉。点组件行的箭头可配置清理范围 | 1.0.0 |
| **[chrome-devtools-mcp](chrome-devtools-mcp/README.md)** | **浏览器调试**：接入 chrome-devtools-mcp，给模型浏览器调试工具（页面、快照、截图、DOM/JS 求值、控制台、网络、性能），工具名形如 `mcp__chrome-devtools__<tool>`；并附带随包分发的 7 个调试技能 | 1.1.0 |
| **[rea-mcp](rea-mcp/README.md)** | **逆向工程**：接入 REA 的 MCP 服务器，给模型逆向工程工具（原生二进制、Electron/JS 应用、.NET 程序集、APK、固件、网页），工具名形如 `mcp__rea__<tool>`；并附带 `reverse-engineer-anything` 技能副本 | 1.0.0 |
| **[web-fetch-fakeip](web-fetch-fakeip/README.md)** | **代理抓取**：让 `web_fetch` 在 TUN + fake-ip 代理（Clash / Shadowrocket）下也能正常工作 | 5.1.0 |

每个插件都是**独立、可单独安装**的组合包：`package.json` 里声明 `dsh.bundle.patch`，patch 文件插入该插件的行；带界面/交互的插件再声明 `dsh.client` 提供客户端半边。

## 环境要求

| 项 | 说明 |
|---|---|
| dsh 版本 | **0.2.0-rc.2**（桌面端）实测通过；更早版本未验证 |
| 构建步骤 | **不需要** —— 五个插件都是**零构建**（没有 `src/`、没有 tsdown、没有 install 脚本）；`chrome-devtools-mcp` 与 `rea-mcp` 另含一段运行期 `!!js` 表达式，用于推导随包技能的位置 |
| 依赖安装 | **不需要手动装** —— 对 dsh 自带包的依赖写在 `peerDependencies` 里，由 dsh 的模块解析器路由到安装里的副本 |
| 平台 | 插件本身与平台无关；`chrome-devtools-mcp` 与 `rea-mcp` 需要宿主有 `node`/`npm`（首次运行由 `npx` 拉取 MCP 服务器） |
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

把 `turn-notifier` 换成 `web-fetch-fakeip`、`chrome-devtools-mcp` 或 `session-purge` 就能装别的。要点：

- `#path:` 后面按 pnpm 的写法不带斜杠最稳（作者在 pnpm 11.22 上见过一次 `#path:/x` 失败；本机 pnpm 11.7.0 与 12.8.1 复核两种写法都能装，姑且记作版本相关）。
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
| `index.js` | 可选 | 宿主半边；纯客户端插件可以导出空的 `apply`，纯 patch 组合包（如 `chrome-devtools-mcp`）不需要 |
| `client.js` | 可选 | 客户端半边，用 `window.__ModuleLoader__.load({ id, factory })` 注册 |
| `locale/{en,zh}.json` | 可选 | Plugins 卡片的标题与描述，**结构必须是 `{"meta": {"title", "description"}}`** |
| `icon.svg` | 可选 | 卡片图标 |

约定（来自官方文档；踩过的坑都记在各插件自己的 README 里）：

- **宿主半边不要写死可调参数。** 导出 `Config` schema（`import z from '@deepseek-ai/schemastery'`），字段加 `.volatile()`，这样它们才会出现在 Plugins 页面的配置表单里。
- **从 dsh 安装目录里 import 的包，必须写进该插件的 `peerDependencies`。** 本仓库的插件是 `link:` 进 profile 的，裸导入靠这条声明被路由到安装里的副本（否则报 `ERR_MODULE_NOT_FOUND` → 该行 `failed to import`）。
- **客户端半边别写 `immediately: true`**，除非真的需要启动期预取——它会把这一行划进 bootstrap 阶段，而 bootstrap 条目无法被动态移除/替换。
- `@jedeiah/*` 是这些包的作用域名（与仓库作者同名，避免与他人撞名）。**改名要同步改 `cordis.patch.yml` 里的行名、客户端半边的模块 id 并重新安装。**

## 已知的 dsh 侧问题

- **停用一行带客户端半边的插件后再启用，客户端半边不保证重新挂载**：浏览器模块表认为该包已加载，于是不再执行它的 `apply`（[deepseek-harness#8452](https://github.com/deepseek-ai/deepseek-harness/discussions/8452)）。
  **本仓库的规避方式**：把配置页的注册放进一道 `ctx.inject(['remote.<本插件自己的服务>', …], cb)` 依赖门里——`apply` 不重跑时，Host 半边重建仍会让依赖消失又出现，门于是重开、页面重新挂上。`turn-notifier` 与 `session-purge` 都用了这个形状，实测「停用 → 启用」后 `›` 和页面内容都在。
  隐形条目（响铃、按钮等）不走这道门，其恢复情况未逐项验证；**若发现某行界面消失，重载界面（⌘R）即可恢复**，不必重启 App。

- **静态 `import` dsh 自带包**：作者在 0.2.0-rc.2 上遇到过一次「条目建不起来、诊断只报 `failed to import`」（当时 specifier 就是同一个）；后续复核里，把该包写进 `peerDependencies` 之后静态导入可以正常组合（`schemastery`、`dsh-web-fetch-http` 都是静态导入）。因此本仓库仍统一用模块作用域的 `await import(...)` 兜底，见 `web-fetch-fakeip` 的 README《实现注记》。

## 反馈

仓库首先是自用的，插件都按"自己用得上"的标准写。有 bug、有建议，或者想加个类似的插件，欢迎提 issue / PR：

- 加插件：按上面《新增一个插件》的文件与约定来。
- 改现有插件：请保持**纯 JS、零构建**，可调参数走 `Config`，界面文案走客户端 locale。
- 如果踩到 dsh 自身的坑，欢迎连带把复现步骤写进对应插件的 README——本仓库的习惯是"把坑记在原地"。

## 许可

[MIT](LICENSE) —— 与 dsh 本身一致。
