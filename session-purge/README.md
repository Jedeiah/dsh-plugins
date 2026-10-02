# 会话彻底删除（Session Purge）

在侧栏每个会话行的**悬停按钮**和**「…」菜单**里加一个「删除会话」，把会话从磁盘上连根清掉——不是归档，是删除。

官方的会话生命周期只有归档 / 取消归档（`dsh-session-persistence-jsonl/README.zh.md:163` 写明「不删除会话文件……seam 无删除接口」；workspace 的 README 把「会话删除」列为尚未提供的功能），所以本插件自己在宿主半边实现删除，页面只负责问一句、再做汇报。

## 删掉什么

点一次「删除会话」，宿主半边按顺序做这些事（`index.js` + `engine.js`）：

| # | 位置 | 内容 |
|---|---|---|
| 1 | `<DSH_HOME>/sessions/<项目目录>/<会话目录>/` | 会话日志的全部格式代际 + `session.lock`；**含它的子 agent 会话**（子会话是同根的兄弟目录，靠 header 的 `parentSession` 链找出来，默认一起删） |
| 2 | `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` | 投影检查点（连同存储域可能留下的 `.bak.<时间戳>`） |
| 3 | `workspace.json` | 工作区归属槽位、归档集合、置顶集合——走 Workspace 注册表自己的方法，不手改文档 |
| 4 | `schedule.json` | 绑在该会话上的提醒——走 Schedule 服务删除，避免提醒继续对着一个已经不存在的日志触发 |
| 5 | `<临时目录>/dsh-spill-*/session-<sha256(id)[:12]>/` | 工具大输出的落盘文件，扫掉之后空掉的 spill 根也一并回收 |
| 6 | `<DSH_HOME>/attachments/` | 附件对象与引用链接，**默认不删**（见下） |
| 7 | 浏览器 Local Storage | 由客户端半边清理 `dsh.conversation.<id>`、`dsh.sidebar-right.v1.<id>`、`dsh.user-questions.drafts.v1.<id>`，并在 `dsh.sessions.current` 指向被删会话时移除它 |

删除后会向所有已连接窗口广播官方事件 `api-session/removed`，侧栏立即掉行，不必刷新。

## 活会话是硬性拒绝，不是警告

如果目标会话（或它的某个子会话）**仍驻留在当前进程**里，删除会被拒绝，并返回稳定错误码 `session-purge/session-live`：

- 驻留的 Agent 仍握着写句柄，删掉它背后的日志只会让写落到已 unlink 的 inode；
- 会话被释放时投影缓存还会做最后一次检查点写入，**把刚删掉的 `session_projcache` 记录重建出来**。

所以正确姿势是：**先重启 App**（重启后除了你正在看的那个会话，其余都是冷的），再删。正在看的那个会话删不掉——它必然是活的。对话框会把「谁还活着」直接列出来。

## 附件默认不删，是有原因的

附件字节是**内容寻址 + 跨会话去重**的，而且「已存储的图片永远不会被自动删除，也没有任何机制回收未被引用的对象」（`dsh-attachment-local/README.zh.md:136`）。删除某个会话时，它引用过的对象很可能另一个会话也在引用，直接删会打断别的会话的图片读取。

要连附件一起清，把 `purgeAttachments` 打开（Plugins 页勾选，或写进 patch）。打开后宿主会**扫描保留会话的全部日志**做引用减法：只有「被删会话引用过、且没有任何保留会话再引用」的对象才会被删。日志越大这一步越慢。

## 配置

Plugins 页里可改的字段（`.volatile()`，改完立刻生效，不重挂行）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `includeDescendants` | `true` | 连同子 agent 会话一起删 |
| `removeEmptyProjectDirectory` | `true` | 项目目录里最后一个会话删掉后，把空目录也收掉 |
| `purgeSchedules` | `true` | 删除绑定的提醒 |
| `purgeSpill` | `true` | 删除工具落盘文件 |
| `purgeAttachments` | `false` | 见上文 |
| `spillRoots` | `[]` | 额外要扫的 spill 根（默认扫系统临时目录下的 `dsh-spill-*`） |

另外三个非易失字段（`sessionsRoot` / `storagesRoot` / `attachmentsRoot`）默认解析 `$DSH_HOME` 下的标准布局，只有把会话存到别处时才需要在 patch 里覆盖。

## 安装

方式一（界面）：**Plugins 页 → Add plugin**，填本目录绝对路径 → 安装 → Enable now → **重启 App**。

方式二（命令行，需要先退出 App）：

```bash
dsh plugin --profile desktop add ~/agentProjects/dsh-plugins/session-purge
```

> ⚠️ App 运行时**不要**用命令行装：桌面端 profile 由 Electron 应用独占，进程持有 `~/.dsh/profiles/desktop/package.json.lock`，`dsh plugin add` 会在 pnpm 阶段挂住（本次开发已实测，见下）。要么在 Plugins 页里装（它自己会与应用协调），要么先退出 App。

卸载：Plugins 页里 Remove，或退出 App 后 `dsh plugin --profile desktop remove @jedeiah/session-purge`。

## 文件

| 文件 | 职责 |
|---|---|
| `index.js` | 宿主半边：Config、`sessionPurge` Remote 服务、存活守卫、Workspace/Schedule/广播接线 |
| `engine.js` | 纯 Node 的存储引擎：会话索引、血缘、计划、删除、附件引用减法（不依赖 Cordis，可单独跑） |
| `typert.js` | 手写的 Typert Host manifest（构建产物通常由生成器产出，本插件零构建） |
| `client.js` | 浏览器半边：行按钮、菜单行、确认框、Toast、Local Storage 清理（含内联的 Client manifest） |
| `selftest.mjs` | 自检：合成存储上的引擎测试 + 真实 Cordis/网关上的宿主回归 |
| `cordis.patch.yml` | 插入本插件的行 |

## 自检

```bash
node selftest.mjs            # 全量：引擎 + 真实网关回归
node selftest.mjs 2>&1 | tail -5
```

Part A 在临时目录里造一份合成存储（真·多帧 Zstandard 日志、投影检查点、spill 目录、附件对象），验证计划与删除的结果；Part B 用**安装里真实的** `validateTypertManifest`、`TypertRegistry`、`TypertGatewayService` 把宿主半边跑通，包括：

- 手写 manifest 通过安装自带的校验器；
- `sessionPurge.inspect` / `purge` 经网关调用成功，子会话随父会话一起删除，保留会话与它引用的附件完好；
- 活会话被拒绝（`session-purge/session-live`）且文件原封不动，转冷后再删成功。

本次记录：**32 项检查全部通过**。

## 实现注记（踩过的坑）

- **装饰器语法在运行时不存在。** `@Remote` 是 TC39 装饰器，官方包是编译产物（`__esDecorate` 辅助函数）。零构建插件必须手写原型描述符：

  ```js
  Object.defineProperty(Cls.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze([
      Object.freeze({ method: 'inspect', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'purge', invocation: Object.freeze({ kind: 'direct' }) }),
    ]) }),
  });
  ```

  少了它，网关会以 `gateway/invocation-unavailable` 拒绝——SRC 与严格两条路径都要读这个标记。

- **`.volatile()` 字段到手不是值，是活引用。** 宿主 `apply(ctx, config)` 拿到的 volatile 字段是 `{ get() }` 句柄（`cosmokit` 的 volatile 协议），直接当布尔用会永远为真。`index.js` 的 `readConfigValue()` 统一解包，并且在每次操作开始时读一次快照，避免一次删除看到两个配置版本。

- **浏览器半边拿不到 `./remote`。** 模块表只认平台 seed、已物化模块和已注册的包工厂，`require('./remote.js')` / `require('<pkg>/remote')` 都会抛。所以 Client manifest 内联在 `client.js` 里（与 `typert.js` 一一对应）。

- **客户端不能订阅自定义事件。** 转发事件的合法键集是编进应用的静态白名单（`API_REMOTE_FORWARDED_EVENTS`），第三方 `$on('自己的/事件')` 会静默注册、永不触发。本插件直接复用白名单里的 `api-session/removed`。

- **deletion 的引用面比想象广。** 只删日志目录能让会话从 UI 消失（列表靠 header，失效 id 会被过滤、下次变更时剪除），但投影缓存、工作区槽位、提醒、spill、浏览器状态都会留下痕迹；本插件的价值就在于把这些一次性做全。

## 平台

纯 Node（`node:fs` / `node:os` / `node:path` / `node:zlib` / `node:crypto`）+ 浏览器 API，代码里没有 `process.platform`、没有平台路径假设：

- 会话目录、项目目录都靠**读 header** 识别，不解析目录名，因此 POSIX 与 Windows 的存储布局都能处理；
- 存活判定走宿主服务（Agent / Session 注册表），不依赖 `session.lock` —— Windows 上那个锁是**命名内核信号量、没有锁文件**，本插件不受影响；
- 唯一平台差异在 `selftest.mjs`：Windows 下建符号链接用 junction（普通 symlink 需要开发者模式）；
- `selftest.mjs` 的 `--app` 默认指向 macOS 安装路径，其它平台用 `--app <你的 @deepseek-ai 目录>`，找不到安装时 Part B/C 会自动跳过。

## 已知限制

- **活会话删不掉**：需要先重启 App（这是刻意的，见上）。
- **正在输入的当前会话删不掉**：它一定活着。
- **附件清理是 `false` 默认**：开着会读遍保留会话的日志，且仍然可能因为「别的会话也引用同一份字节」而保留对象。
- **删除不可撤销**：没有回收站，也没有 undo（与「归档」不同）。
- **运行中删除需要重启才生效**：安装/更新插件后要重启 App；浏览器半边的静态导入与行开关行为受限，见本仓库 README 的「已知的 dsh 侧问题」。
