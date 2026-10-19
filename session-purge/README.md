# 删除会话（Delete Session）

在侧栏每个会话行的**悬停按钮**和**「…」菜单**里加一个「删除会话」，把会话从磁盘上连根清掉——不是归档，是删除。

官方的会话生命周期只有归档 / 取消归档（`dsh-session-persistence-jsonl/README.zh.md:163` 写明「不删除会话文件……seam 无删除接口」；workspace 的 README 把「会话删除」列为尚未提供的功能），所以本插件自己在宿主半边实现删除，页面只负责问一句、再做汇报。设计与每条依据见 [`DESIGN.md`](DESIGN.md)（v8）。

## 删掉什么

| # | 位置 | 内容 |
|---|---|---|
| 1 | `<DSH_HOME>/sessions/<项目目录>/<会话目录>/` | 会话日志的全部格式代际 + `session.lock`；**含它的子 agent 会话**（子会话是同根的兄弟目录，header 带 `origin: "subagent"` + `parentSession`，默认递归一起删）。**从该会话「分叉」出来的独立会话不会被删**——fork 也带 `parentSession` 但没有 `origin`，官方同样不把它算作血缘；对话框会把它们列出来，让你知道留下了什么。会话目录是**软链接**时，删的是链接本身和目标里的会话文件，目标里别的文件原样保留 |
| 2 | 投影检查点（`session_projcache`） | 经检查点服务自己的表删除，内存与磁盘一起变；连同存储域可能留下的 `.bak.<时间戳>` / `.tmp` |
| 3 | `workspace.json` | 工作区归属槽位、归档集合、置顶集合——走 Workspace 注册表自己的方法，不手改文档 |
| 4 | `schedule.json` | 绑在该会话上的**所有**提醒（含已失效的，它们还留着投递历史与指令快照）——走 Schedule 服务删除 |
| 5 | `<临时目录>/dsh-spill-*/session-<sha256(id)[:12]>/` | 工具大输出的落盘文件，只按目标 id 精确定位，绝不碰别的实例的 spill |
| 6 | 浏览器 Local Storage | 由客户端半边清理 `dsh.conversation.<id>`、`dsh.sidebar-right.v1.<id>`、`dsh.user-questions.drafts.v1.<id>`，并在 `dsh.sessions.current` 指向被删会话时移除它 |

**附件字节不在删除里动**：内容寻址、跨会话去重，删一个会话时它引用的图片很可能别的会话也在用。要回收，用设置页的「附件回收」（见下）。

## 一次删除是怎么做的

一次删除是一个**有提交点的事务**（`index.js` + `txn.js` + `engine.js`）：

1. **围栏**：对每个目标调用 `sessionPersistence.open(id, 'write')`。拿到写句柄，就同时拿到了进程内的单写者声明和跨进程的内核租约——会话活着时这一步原子地失败，不靠"读一眼是不是活的"来猜。拿到之后再核两件事：后端的根目录就是本插件配置的根；POSIX 上目标目录的 `session.lock` 确实被占着。两条有一条不符，就说明围住的不是要移走的目录，整批拒绝。
2. **提交**：先写预写清单，再把每个会话目录 `rename` 进会话根旁边的 `.session-purge-staging/`（同卷，原子），并 fsync 两侧父目录。**在这之前没有任何外部改动**，所以围栏失败、取消、跨卷，都等于什么都没发生。
3. **清理各域**：工作区、检查点、提醒、spill 依次走各自的服务；然后删掉 staging 里的条目。
4. **校验**：逐域读回；读不到的域如实报 `unverified`，结果是 `verified` / `verified-with-gaps` / `incomplete` / `failed-partial` 之一，不会静默算通过。审计追加到 `.session-purge-staging/audit.jsonl`（不记标题、不记内容，8 MiB 滚动）。
5. **收敛**：一个提交前就读完了日志的读者，可能在删除之后把检查点写回来。插件监听 `domain/changed`，**按日志身份**（不是按 id）把这种迟到写回删掉；同 id 新建的会话身份不同，不会被误删。启动时再按保留期内（7 天）的清单复检一次。

崩溃了也不怕：启动时按清单**向前**收敛——什么都没移走的直接作废；移走了一部分的把移走的那部分做完；清单说提交了、目录却还在原处（目录项没落盘）的，重新围住再提交；原处换成了另一个同名目录的，一律不碰（`identity-drift`）。

### 正在使用的会话：延期删除

会话在本 App 里打开过，就一直被它的 Agent 持有到退出——插件没有任何正当手段把它卸下来（`DESIGN.md` §5.4 有依据）。所以：

- 预览会标出「正在使用」。确认时按钮变成「**停止并在重启后删除**」，并写明代价：正在跑的任务会被中断、**活跃提醒会被删除**。
- 确认之前先做两项检查：目录与 staging 区在同一个卷上、持久化后端的根就是配置的根。删不成的删除，**在停掉任何东西之前**就拒绝。
- 确认后先记下意图，再走官方的 `archiveSession({ stopActivity: true })` 停活并归档；浏览器只清掉「当前会话」指针（下次启动不会自动打开它），对话视图与未发送的草稿留着，取消时不会丢；删除真正完成时再清（收到 `api-session/removed`，或下次打开页面时按 `pending()` 给出的已完成列表）。
- 它一冷下来（Agent 被释放，或下次启动），删除自动完成。
- 在那之前可以在设置页「**待完成的删除**」里**取消**：恢复归档与置顶状态，并尽量重建被停掉的提醒（重建的是新提醒，投递历史不在了）；也可以「立即重试」。连续 3 次因非占用原因失败会停下（`STUCK`）并写明原因，不会每次启动都静默重试。
- 同意是**按会话**算的：预览时还是冷的、确认时才被打开的会话（哪怕同一批里别的会话预览时就在用），会以 `session-purge/became-live` 拒绝——停掉它不是你在对话框里同意过的事。确认失败后在同一个对话框里重试，这份同意仍然有效。
- 取消时，停活没能删掉的提醒原样保留、不重复重建。没有 Workspace 注册表时只能停、不能归档，报告里会写明。

### 日志头读不出来的目录（残留）

dsh 自己的后端遇到读不出的日志头会**直接从发现和 `list()` 里跳过**（`dsh-session-persistence-jsonl` README："Unreadable or unsupported headers … are omitted from discovery and `list()`"）。也就是说这类目录**界面上永远看不到**，自然也永远选不中删除——但字节一直占着盘。两种来源：日志事后写坏（校验和/解压/结构失败会报 corruption，不会静默截断），以及崩溃在「建了目录、还没写头」那一刻。

**设置页的「残留目录」一栏**：先「扫描」（`sweepResidue(false)`，只报告不动盘），看到**数量和体积、以及前 5 条具体路径**再决定「删除这些目录」（`sweepResidue(true)`，宿主**重新算一遍**再删，浏览器从不传路径）。三道收窄：只认"像会话"的目录（名字是 `session-<uuid>`/裸 uuid，或者目录里还有 `session*.jsonl*`）；60 秒内的目录放过；删除前先看到路径。这一项**只手动**，启动时不会自动扫——没有清单的东西不是本插件的事务残留。

### 附件回收（两轮）

设置页的「附件回收」：

1. **第一步：登记候选**——只记下"没有任何会话引用、且超过 7 天没动过"的附件对象，一个字节都不删。
2. **第二步：回收**——至少隔一天，重新扫描一遍，只删**两次都无人引用**的候选；从第二步开始到最后一次删除，本进程里新写入的任何引用都会立即把对应候选撤回。

根集合是所有可读会话日志里的 `sha256:` 引用，加上 DeepSeek 适配器的上传清单 `files-v3.json`。**只要有一个会话读不出来（软链接后面的也算）、或一份日志扫不完整，整次中止、一个字节都不删**；单份日志超过 1 GiB 时同样中止，原因写的是「太大」而不是「读不出」。仍然排除不了的：还没发送的草稿里引用的图片（客户端不可枚举）。

### 索引这类「派生数据」不用管

`dsh-session-query-sqlite` 的全文索引是派生的：每次搜索前它会先跟存储对账，把**已删除**的会话行一并清掉再执行查询（"observing new, changed, deleted … reconciles on the next stable observation"）。所以本插件**不需要**去碰别人的数据库——碰了反而危险（那条路径可配，且属于另一个包）。

删除后会向所有已连接窗口广播官方事件 `api-session/removed`（只广播**确实删净**的那些），侧栏立即掉行，不必刷新。

### 安全阀

- **预览与执行必须一致**：对话框列出的目标集会随 `inspect` 记下；确认时若目标集变了（例如这期间又生成了一个子会话），以 `session-purge/target-set-changed` 拒绝。
- **同一批会话不会删两次**：已在等待的延期删除再点一次，以 `session-purge/already-pending` 拒绝；两个窗口同时删同一个会话，一个删掉、另一个得到 `session-unknown`。
- **另一个 dsh 进程正在删同一个会话根**：`session-purge/busy`（POSIX 上靠 staging 区的 `flock`）。
- **可取消**：提交点之前随时可取消，取消就是什么都没发生；提交点之后只向前做完。

## 配置

Plugins 页里可改的字段（`.volatile()`，改完立刻生效，不重挂行）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `includeDescendants` | `true` | 连同子 agent 会话一起删 |
| `removeEmptyProjectDirectory` | `true` | 项目目录里最后一个会话删掉后，把空目录也收掉 |
| `purgeSchedules` | `true` | 删除绑定的提醒 |
| `purgeSpill` | `true` | 删除工具落盘文件 |
| `spillRoots` | `[]` | 额外要扫的 spill 根（默认扫系统临时目录下的 `dsh-spill-*`） |

非易失字段（只在 patch 里覆盖）：`sessionsRoot` / `storagesRoot` / `attachmentsRoot` / `llmFilesPath` 默认解析 `$DSH_HOME` 下的标准布局；`recoveryDelayMs`（默认 1500，负数关闭启动恢复，自检用）。
`purgeAttachments` 已退役：仍能通过校验，但不再生效，打开时报告里会写明。

## 安装

方式一（界面）：**Plugins 页 → Add plugin**，填本目录绝对路径 → 安装 → Enable now → **重启 App**。

方式二（命令行，需要先退出 App）：

```bash
# 把路径换成你自己的 clone；desktop 是桌面端保留的 profile 名，装之前先完全退出 App
dsh plugin --profile desktop add "<本仓库绝对路径>/session-purge"
```

> ⚠️ App 运行时**不要**用命令行装：桌面端 profile 由 Electron 应用独占，进程持有 `~/.dsh/profiles/desktop/package.json.lock`，`dsh plugin add` 会在 pnpm 阶段挂住（本次开发已实测，见下）。要么在 Plugins 页里装（它自己会与应用协调），要么先退出 App。

卸载：Plugins 页里 Remove，或退出 App 后 `dsh plugin --profile desktop remove @jedeiah/session-purge`。

## 文件

| 文件 | 职责 |
|---|---|
| `index.js` | 宿主半边：Config、`sessionPurge` Remote 服务；围栏、提交、各域清理、校验、墓碑监听、启动恢复、延期删除、附件回收 |
| `txn.js` | 事务存储：staging 区、预写清单、同卷提交、链接目录的清理规则、全局互斥、审计（纯 Node） |
| `engine.js` | 存储引擎：会话索引（含软链接）、血缘、计划、残留扫描、spill、附件引用标记（纯 Node，不依赖 Cordis） |
| `typert.js` | 手写的 Typert Host manifest（构建产物通常由生成器产出，本插件零构建） |
| `client.js` | 浏览器半边：行按钮、菜单行、确认框、Toast、设置页（清理范围 / 残留目录 / 待完成的删除 / 附件回收）、Local Storage 清理（含内联的 Client manifest 与对话框几何样式） |
| `selftest.mjs` | 自检，见下 |
| `cordis.patch.yml` | 插入本插件的行 |

## 自检

```bash
node selftest.mjs            # 全量
node selftest.mjs 2>&1 | tail -5
```

| 部分 | 跑在什么上 | 验证什么 |
|---|---|---|
| Part 0 | `package.json` | 显示资源的导出 |
| Part A / A2 | 合成存储 | 日志代际选择、血缘、计划、spill 根发现 |
| Part A3 | 临时目录 | `txn.js`：清单、提交与身份、链接目录被替换时不碰、互斥、审计滚动 |
| Part C | 桩模块表 | 浏览器半边真跑 `load → factory → apply`；内联客户端 manifest 与 `typert.js` 逐字段对齐；词典无缺键、无死键 |
| Part B | 真实 Cordis + Gateway + 合成存储（持久化用带真实 `flock` 的桩） | 立即路径、活会话与围栏、按原始记录选工作区、全状态提醒、提交失败、取消的"全有或全无"性质测试、并发、`busy`、根与租约不符、软链接、四种崩溃恢复、延期删除全流程、附件两轮回收 |
| Part B2 | dsh **真实**服务 | DESIGN v8 的前提：驻留会话挡住写打开（含跨进程）、持句柄时 resume 被拒、迟到写回确会复活（对照）且能按身份删回 |
| Part B3 | dsh **真实**服务 | 插件端到端：真实会话的删除、真实检查点表、插件自己的监听删回真实迟到写回、真实 `archiveSession` 停活与 `agent/disposed` 驱动的延期完成 |

本次记录：**270 项全部通过**；另做了 11 处变异测试（故意改坏关键逻辑：租约探测、工作区选择、失败目标的墓碑、按会话的预览同意、取消顺序、插入屏障、宽限期、上传清单、按身份认人、延期前的预检、回收时跟随软链接），全部被测试捕获；修复审核问题之前的代码在新测试上失败 18 项。计数会随测试增加而变化，以实际输出为准。

## 实现注记（踩过的坑）

- **对话框的尺寸是自己划的，量的是遮罩的 padding box。** 预览是「一个会话一行」，子 agent 一多就没有上界：Modal 原语的卡片按内容定尺寸，只有 `className`（卡片）和 `contentClassName`（它自己文档里那个「可滚动内容区」）两个钩子，所以本插件注入一张 `<style>`（`data-plugin-css="@jedeiah/session-purge/client.css"`，与 dsh 自家客户端插件同一手法），给卡片 `width: min(560px, 100%)` + `max-height: min(800px, 100%)`，把 footer 钉住、让内容区滚动。
  两个数字都不是随手写的：`100%` 相对的是遮罩的内边距盒，**它已经含了标题栏的 overlay inset**（`Modal.module.css` 的注释明确要求消费方按这个盒子来封顶，「不要自己算 viewport」），硬写 `100dvh - 48px` 在带框架的窗口上会漏出去；宽度沿用上游内容最长的安装对话框（`dsh-client-ui-plugin-manager`）的 560px。

- **装饰器语法在运行时不存在。** `@Remote` 是 TC39 装饰器，官方包是编译产物（`__esDecorate` 辅助函数）。零构建插件必须手写原型描述符（见 `index.js` 的 `markRemoteMethods`）；少了它，网关会以 `gateway/invocation-unavailable` 拒绝。

- **`.volatile()` 字段到手不是值，是活引用。** 宿主 `apply(ctx, config)` 拿到的 volatile 字段是 `{ get() }` 句柄，直接当布尔用会永远为真。`index.js` 的 `readConfigValue()` 统一解包，并且在每次操作开始时读一次快照。

- **浏览器半边拿不到 `./remote`。** 模块表只认平台 seed、已物化模块和已注册的包工厂，所以 Client manifest 内联在 `client.js` 里（与 `typert.js` 一一对应，Part C 逐字段比对）。**新增 Remote 方法要两处都加**，只加一处设置页会白屏。

- **点号子服务必须在 `inject` 里声明。** `ctx.remote.<命名空间>` 只有在声明过的上下文里才可读。正确顺序是：先 `ctx.remote.$mount(manifest)`，再 `ctx.inject(['remote.sessionPurge', 'slots', 'locale'], child => …)`，在子上下文里注册全部界面。

- **客户端不能订阅自定义事件。** 转发事件的合法键集是编进应用的静态白名单（`API_REMOTE_FORWARDED_EVENTS`），第三方 `$on('自己的/事件')` 会静默注册、永不触发。本插件直接复用白名单里的 `api-session/removed`。

- **"会话是不是活的"不能靠读状态猜。** 早期版本先查 Agent/Session 注册表再删文件，中间永远有窗口；也试过从外面把会话从 store 里摘下来（内部缝），结果是自锁、丢事件、绕过守卫。现在的答案是官方写句柄：拿到就是证明，拿不到就延期（`DESIGN.md` §5.4、§15）。

- **存储域"先落盘、再改内存"。** 检查点表的 `get()` 读内存，而内存在磁盘写完之后才更新——一个会话刚被释放时，它的最终检查点要过一小会儿才在表里出现。删除不受影响（删除排在同一条写链上那次写之后），但测试要等记录真的出现再断言。

- **真实的 JSONL 后端要求"项目目录名由 header 的 cwd 派生"。** 布局对不上时它的 `list()` 直接抛错而不是跳过。Part B 的合成存储不遵守这个布局，所以那部分用带真实 `flock` 的持久化桩；真实后端的行为由 Part B2/B3 在真实会话上覆盖。

## 平台

纯 Node（`node:fs` / `node:os` / `node:path` / `node:zlib` / `node:crypto`）+ 浏览器 API：

- 会话目录、项目目录都靠**读 header** 识别，不解析目录名；
- 围栏走持久化的写句柄，Windows 上它持有的是命名内核信号量，同样有效；
- **Windows 上没有 `flock`**：跨进程的全局互斥与"租约探测"两项关闭（只剩进程内串行与根目录比对），插件会在日志里说一声；持句柄时 `rename` 目录、以及别的读者占用文件导致提交失败这两条行为**未在 Windows 真机上验证**；
- 目录的 fsync 在 Windows 上是空操作；macOS 上 Node 的 fsync 经 libuv 发 `F_FULLFSYNC`；
- `selftest.mjs` 的 `--app` 默认指向 macOS 安装路径，其它平台用 `--app <你的 @deepseek-ai 目录>`，找不到安装时 Part B/B2/B3/C 会自动跳过。

### 不在覆盖范围内

以下都是**派生数据**，本插件不碰：`<DSH_HOME>/cache/attachments` 的图片变体缓存；以及若把会话全文检索从默认的 `openAt: never`/`:memory:` 改成持久索引，那份 SQLite 里的行。二者都可以由各自的宿主在下次重建时自行纠正。

## 已知限制

- **正在使用的会话要等到它冷下来才真正删除**（通常是下次启动）；在那之前内容还在磁盘上。
- **取消延期删除时，提醒只能以新 id 重建**，投递历史不在了；已经过点的一次性提醒重建不了（会在结果里列出）。
- **别的会话里的引用副本删不到**：`dsh-session-reference` 会把被引用会话的转录写进**引用方**自己的 spill，随上游清扫过期（默认 30 天）。
- **附件回收看不到客户端草稿**：还没发送的草稿里引用的老图片，第二步仍可能把它回收。
- **删除不可撤销**：没有回收站（与「归档」不同）；延期期间可以取消，提交之后不能。
- **运行中删除需要重启才生效**：安装/更新插件后要重启 App；浏览器半边的静态导入与行开关行为受限，见本仓库 README 的「已知的 dsh 侧问题」。
