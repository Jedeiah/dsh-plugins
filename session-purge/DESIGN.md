# 设计 v8：会话删除

> **状态：已落地**（2026-10-18，`b69f428` 立即路径 / `2e67431` 延期路径 / `cd2b692` 附件回收）。落地时对本稿的
> 修正都已改进正文，并汇总在 §17 的"实现"一行。
>
> v8 是**换路线**，不是给 v7 打补丁。前五轮（v3–v7）都在"驱逐 → 围栏 → 检测复活"这条路上修洞，
> 每修一处就冒出新的竞态；根子在于**我们去抢一个不归我们管的生命周期**。v8 只走 dsh 给的门：
> 会话冷着就用官方写句柄把它围住再删；活着就登记意图、停活归档，等它冷了再删。
> 所有"事实"都标了依据；没核实的写成"未实测 / 未核实"。v7 原文保留在 `DESIGN.v7.md` 供对照。
>
> 依据记法：`<pkg>:N` = `/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/<pkg>/lib/index.js` 第 N 行（dsh 0.2.1-rc.2）；
> `docs:<页>` = <https://deepseek-harness.github.io/deepseek-harness/en/> 下的页面。

---

## 0. 一页结论

```
            ┌─ 全部目标都能 open(id,'write') ──→ 立即路径：围住 → 移出树 → 清各域 → 校验     （提交前零副作用）
确认删除 ──┤
            └─ 任一目标被别人持有 ────────────→ 延期路径：登记意图 → 归档并停活 → 等它冷 → 立即路径
```

- **围栏 = 官方写句柄。** `ctx.sessionPersistence.open(id, 'write')` 同时取进程内单写者声明和跨进程内核租约，
  会话活着就原子地失败（`SessionAlreadyOwnedError`）。不读状态猜"是不是活的"，**拿到就是证明**。
- **不驱逐。** 会话的生命周期属于它的 Agent fiber，插件拿不到 disposer；v5–v7 用的 `store.detach` 内部缝正是文档点名的危险做法（§5.4）。
- **复活靠墓碑收敛，不靠检测。** 对 `domain/changed` 的公开事件按目标 id 立即删回，启动时再定点复检。
- **附件不在删除里动。** gc 是独立的手工操作。

---

## 1. 问题

dsh 的会话日志是只追加的，`seam 无删除接口`（`dsh-session-persistence-jsonl/README.zh.md:167`）。
所以"删一个会话"不是删文件，而是：

> **撤销一份权威，并让所有派生在有限步内收敛到没有它。**

---

## 2. 设计原则（五轮审查的教训）

| # | 原则 | 反例（之前踩过的） |
|---|---|---|
| P1 | **权威数据只经它主人的服务改**；文件系统只用来移走"已被我们围住"的目录 | 删检查点文件绕过内存表，内存行还在、下次写回（v7 §3.4） |
| P2 | **围栏必须是原子的获取，不是事后检测** | "停 → 静置 → 复检"是三次读，读完就过期 |
| P3 | **提交点之前零副作用** | `archiveSession({stopActivity})` 先写归档、还删提醒，失败只能"尽力补偿" |
| P4 | **拿不到就等，不抢** | 驱逐别人的会话 → 自锁 / 丢事件 / 绕过守卫（v6、v7） |
| P5 | **收敛要有确切目标** | 启动时按"缺了什么"去推断残留 → 误删别的实例的 spill（v6 §7.3） |
| P6 | **每个降级都要留一声**（AGENTS.md） | 静默失效看起来像"插件坏了" |

---

## 3. 正确性模型

### 3.1 不变量

| # | 不变量 | 说明 |
|---|---|---|
| **I1** | **单域原子 + 跨域完成后一致** | 会话目录这个域内 `rename` 原子；跨域由 verify 证明**完成之后**一致 |
| **I2** | **无悬空权威** | 完成后不存在指向它的记账 / 归档 / 置顶 / 提醒 |
| **I3** | **无共享伤害** | 其他会话（含**其他 dsh 实例**）引用的字节完好；delete 结构性不碰附件，spill 只按目标 id 精确定位 |
| **I4** | **不可复活** | 日志域：**可证明**（持有写句柄期间无人能写，§6）；检查点域：**确定性收敛**（墓碑监听，§10），磁盘上可能短暂出现、一定被删回 |
| **I5** | **收敛** | 崩溃后重跑达到完成；**只向前**，不回滚已提交目标 |
| **I6** | **可证伪** | 每次结束都校验；读不到的域如实报 `unverified` |
| **I7** | **副作用可还原或事先声明** | 立即路径提交前**没有**副作用；延期路径的副作用（停活、删活跃提醒）在确认框里写明，取消时尽力还原（§5.3） |

### 3.2 假设

| # | 假设 | 不成立时 |
|---|---|---|
| A1 | 会话目录与 staging 同卷 | prepare 阶段 `stat().dev` 预检，拒绝整批（`cross-device`） |
| A2 | 同一 `DSH_HOME` 同一时刻只有一个 dsh 进程 | 日志仍有跨进程租约保护；全局互斥（§7.4）与附件 gc（§11）在 Windows 上只保护本进程 |
| A3 | 远端已上传文件由提供方过期回收 | 报告里点名，不假装清掉 |
| A4 | dsh ≥ 0.2.1 | 依赖面（§4）每条 feature-detect；缺失即降级并告警 |

### 3.3 可证明不可达（写清楚，才谈得上"绝对"）

活会话的即时删除（插件没有卸载它的能力）、跨域原子提交、远端副本、不可枚举的客户端草稿引用、
别的会话 spill 里的转录副本——这五件只能**等待、声明或拒绝**。
**"绝对" = 所有失败模式被枚举 + 每种有确定行为 + 每种有测试**，不是"不会出问题"。

---

## 4. 依赖面（每条都分级）

| 接口 | 级别 | 依据 | 拿不到时 |
|---|---|---|---|
| `ctx.sessionPersistence.open(id,'write')` / `handle.close()` | **公开 seam** | `docs:reference/capability-seams`；`docs:reference/subsystems/persistence`（"the handle is the single door the cross-process write lease guards"） | 整个插件不可用（报错，不降级） |
| `SessionAlreadyOwnedError`（按 `error.name` 判） | 公开导出 | `dsh-session-persistence:44-51`；会话控制器也按 name 判（`dsh-api-session-controller:243`、`:462`） | — |
| `ctx.sessions.get` / `ctx.agents.get` | 公开 | `docs:reference/subsystems/session`、`docs:reference/subsystems/core` | 只用作复核，缺失记 `unverified` |
| `workspaceRegistry.archiveSession / unarchiveSession / pinSession / unpinSession`、`Workspace.detachSession` | 公开 | `dsh-workspace/README.md:99-101` | 工作区域记 `unverified` |
| `workspace.record.sessionIds`（原始记录） | **内部字段** | `dsh-workspace:79` | 只用于 verify，缺失记 `unverified: ['workspace-raw']` |
| `ctx.storageDomain.get('session_projcache').table('sessions')` | **文档化的诊断入口** | `docs:reference/subsystems/storage`（"get(name) is an untyped diagnostic lookup"）；域名 `dsh-session-projection-cache:90`；表句柄稳定 `dsh-storage-domain:187-191` | 退回删文件 + 墓碑复检，告警 |
| `domain/changed` 事件 | 公开 | `docs:reference/subsystems/storage`（"strictly after the backend acknowledged durability … in write-chain order"） | 墓碑监听不可用，只剩启动复检，告警 |
| `schedule.catalog / delete / create` | 公开 Host 方法 | `docs:reference/subsystems/schedule`；`dsh-schedule:2083`、`:2129`、`:2164` | 提醒域记 `unverified` |
| `agent/disposed` 事件 | 公开 | `docs:reference/subsystems/core`（"Disposal removes the agent from the registry and emits agent/disposed"） | 延期路径只在启动时推进 |
| `node-addon-system/flock` 的 `tryLockExclusive` | 公开子路径；但 `session.lock` 协议是 jsonl 后端内部的 | `node-addon-system/package.json` `exports`；协议 `dsh-session-persistence-jsonl:617-646` | 只用于"日志读不出"的后备路径（§6.3） |
| spill 目录名 `session-<sha256(id)[:12]>` | 内部约定 | `dsh-spill-local:70` | spill 域记 `unverified` |

**明确不用**：`ctx.sessions.store`、`entry.detach`、`SessionProjectionCache#table`（v5–v7 用过的内部缝）。

---

## 5. 两条路径

### 5.1 分流

1. **prepare**（只读 header，绝不冷读日志）：目标集（含子 agent 会话）、血缘、链接解析、`dev` 预检、prior 快照
   （`archived`/`pinned`/全部提醒的完整记录）。预览里的"谁在用"来自 `sessions.get`/`agents.get`，**仅供展示**。
2. **确认框**按预览分两种文案：全冷 → "将立即删除"；含活会话 → "这些会话正在使用：将**停止**并**归档**，
   **活跃提醒会被删除**，内容在**下次启动 dsh 时**删除；在此之前可以取消"。
3. **执行时以围栏为准**：按 id 排序依次 `open(id,'write')`。全部成功 → 立即路径；任一 `SessionAlreadyOwnedError`
   → 立刻关掉已拿到的句柄 → 延期路径（确认框已覆盖这种情况；若预览时全冷、执行时有人抢先打开，
   返回 `became-live`，让用户重新确认，不自动降级到会停活的路径）。

整组同进同退：一个目标集要么全部走立即路径，要么全部延期。

### 5.2 立即路径（目标全冷）

```
fence    : 持有每个目标的写句柄；再核一次 sessions.get(id)、agents.get(id) 均为 undefined
arm      : 在内存墓碑集里加入目标 id（§10），先于提交
commit   : 每个目标 rename 进 staging + fsync 两个父目录（§7）
release  : 关闭写句柄（目录已在树外）
purge    : 工作区 → 检查点 → 提醒 → spill → 广播 api-session/removed
cleanup  : 删 staging 条目（链接规则见 §7.3）+ fsync 父目录
verify   : §9；写审计；清单保留到墓碑过期
```

**fence 之前和 fence 失败时什么都没发生**（P3）。唯一的例外是 `open('write')` 对旧格式日志会先发布当前代际
（`dsh-session-persistence-jsonl:2529`）——这与 dsh 自己恢复任何旧会话时做的完全一样，不算副作用。

### 5.3 延期路径（有目标活着）

```
intent   : 写清单，状态 PENDING（先于任何外部写入）
quiesce  : 对每个目标 registry.archiveSession(id, { stopActivity: true })
           （已归档的改发 ctx.parallel('workspace/session-stop', {sessionId})，因为 archive 对已归档 id 直接 return，dsh-workspace:528）
hide     : 客户端清掉指向它的 dsh.sessions.current，让下次启动不自动打开它
wait     : 监听 agent/disposed（目标 id）→ 尝试立即路径；每次启动时也尝试一次
```

- **为什么要归档并停活**：用户已确认删除，不该让它继续跑、继续写新内容、继续被提醒唤醒。
  归档集正是 provider 的 `agent/pre-step` 闸门读的东西，停请求诱发的唤醒都会被挡住（`dsh-workspace:512-524` 注释）。
- **代价写在明处**：`stopActivity` 会让 schedule 把该会话所有 `active` 提醒直接删掉（`dsh-schedule:2056`、`:2273-2292`）；
  归档先持久化、再清置顶、最后才发停请求，失败不回滚（`dsh-workspace:527-541`）。
- **取消**（只有 `PENDING` 可取消）：`unarchiveSession` → `pinSession`（必须在 unarchive 之后，
  否则抛 `WorkspaceArchivedSessionPinError`，`dsh-workspace:581`）→ 用 prior 快照经 `schedule.create(sessionId, request)` 重建提醒。
  重建出来的是**新 id**，投递历史不在了（`docs:reference/subsystems/schedule`："Lost history … never reconstructed"）——
  取消确认框写明这一点。没有 CAS，补偿可能覆盖期间用户的合法操作：「记录 → 补偿 → 回读」，不一致记 `compensation-drift`。
- **重试与卡死**（吸取 Firefox Bug 1778090：待办在每次启动都静默失败、永远清不掉）：
  - `SessionAlreadyOwnedError` 不算失败，只说明还在用；超过 7 天仍在用 → 设置页提示。
  - 其他错误计数；连续 3 次 → 状态 `STUCK`，停止自动重试，设置页点名原因，提供"重试 / 取消"。

### 5.4 为什么不驱逐（v5–v7 的路线，正式放弃）

- 文档：Agent 的 disposer "is a CAPABILITY: among consumers, only the holder can tear this agent down"（`docs:reference/subsystems/core`）。
- 文档：agent 工厂把会话生命周期折进同一个 effect，"so a fiber unload tears the session + agent down as a single ORDERED chain
  rather than as racing sibling effects — which would remove the publication hooks before the driver's closing events commit, dropping them"
  （`docs:reference/subsystems/session`，`SessionStore.prepare`）。从外面 `detach` 正是这种"抢跑的兄弟 effect"。
- 源码：UI 会话的 Agent 由会话控制器 `agents.resume(...)` 创建后**只取 `.agent`、丢掉 handle**（`dsh-api-session-controller:399`、`:455`），
  所以活会话在本进程里一直活到退出；没有任何插件能拿到它的 disposer。
- v6 证明了驱逐前围栏会自锁，v7 证明了驱逐后还有在途写回、drain 失败丢事件、绕过 appending 守卫。
  这些都不是可以再补的洞，是路线本身的代价。

---

## 6. 围栏

### 6.1 `open(id,'write')` 到底做了什么

`dsh-session-persistence-jsonl:2488-2556`：

1. `tracker.claimWrite(id)`：进程内单写者声明，已被占用就抛 `SessionAlreadyOwnedError`（`:314-317`）；
   新建尚未落盘的会话也占着这个位（`registerCreated` 置 `writers.set(id, null)`，`:300-307`）。
2. `acquireLease`：跨进程内核租约。POSIX 是 `session.lock` 上的 `flock` + inode 复核；Windows 是命名内核信号量
   （`:617-646`、`:561-563`）。租约在写句柄**整个生命周期**内持有（`:620`）。
3. 读并校验整份日志（`requireStoredLog`）；旧格式就发布当前代际。

所以**持有写句柄 = 本进程和其他进程都不能再写这个会话**；`agents.resume` 走的也是 `open(write)`，会被同一把门挡住。
`close()` 只做 drain（我们从不追加，缓冲为空）、释放租约、`tracker.release`（只删声明，`:373-378`），**不写会话目录**。

持句柄的这段时间里，若界面恰好要打开这个会话，会话控制器会把 `SessionAlreadyOwnedError` 映射成
`session/writer-held` 返回（`dsh-api-session-controller:243`）——窗口是可见的、有确定错误，不会静默建出一个新会话。

代价：`open('write')` 会把整份日志读进内存校验。超大日志（数百 MB）会有一次内存尖峰——prepare 时按 `sizeBytes` 提示。

### 6.2 为什么还要再核 `sessions.get` / `agents.get`

文档保证"活会话的写句柄由其生命周期 owner 持有"（`docs:reference/subsystems/persistence`，Repair 一节），
但没有保证**每一种**进入 store 的会话都持有写句柄。持句柄之后再核一次，任何一个非空 → 释放句柄、按"活着"处理。
持句柄之后不会再有新的同 id 会话进入 store：恢复要先 `open('write')`，而那把门在我们手里。

### 6.3 日志读不出来的会话

`open('write')` 遇到损坏会抛 `SessionPersistenceCorruptionError` / `SessionFormatUnsupportedError`。这类会话：

- 它的 header 若也读不出，后端本来就不会列出它（`dsh-session-persistence-jsonl` README："omitted from discovery and `list()`"），
  界面上选不中——归"残留目录"手动清理（§10.3），不走本流程；
- header 读得出但正文坏：任何人都 `open('write')` 不了，所以也没有写者。POSIX 上退回**同一协议**的裸租约
  （`open(lockPath,'w')` + `tryLockExclusive` + inode 复核，照抄 `:692-712`）作围栏；Windows 上信号量获取函数未导出，
  只能拒绝（`fence-unavailable`），让用户走残留清理。

### 6.4 Windows（未实测）

写句柄持有的是信号量，"never a file lock or handle, so … directory removal proceed freely"（`:553`、`:624`），
所以持句柄期间 `rename` 目录应当可行。**未实测**：若有别的读者正开着日志文件（搜索索引、杀毒），`rename` 会失败 →
`commit-failed`，已提交的向前、未提交的原样留着，稍后重试。

---

## 7. 提交点与清单

### 7.1 布局

```
<stagingRoot>/                      = dirname(realpath(sessionsRoot))/.session-purge-staging
  .lock                             # 全局互斥（§7.4）
  runs/<runId>/
    manifest.json
    entries/<project>/<dirName>/    # 被移出的目录（链接布局则是一条链接）
  gc/candidates.json                # 附件 gc 第一轮候选（§11），与删除无关
```

`<stagingRoot>` **必须在会话树之外**（后端把根下每个目录都当项目，`dsh-session-persistence-jsonl:3506`），
又必须同卷；它只由 `realpath(sessionsRoot)` 派生，不是配置项。

### 7.2 清单

```json
{ "version": 5, "runId": "…", "path": "immediate | deferred", "state": "PREPARED",
  "createdAt": "…", "attempts": 0, "lastError": null,
  "targets": [{ "id": "…", "projectDir": "…", "dirName": "…", "linked": false, "realTarget": null,
                "identity": "dev:ino", "checkpointIdentity": { /* §10.2 */ }, "sizeBytes": 0,
                "prior": { "archived": false, "pinned": true, "reminders": [ /* 完整 ScheduleRecord */ ] },
                "state": "PREPARED" }],
  "steps": { "quiesce": "pending", "fence": "pending", "commit": "pending", "workspace": "pending",
             "cache": "pending", "schedules": "pending", "spill": "pending", "cleanup": "pending", "verify": "pending" },
  "outcome": null, "completedAt": null }
```

- 组状态：`PREPARED → (PENDING →) FENCED → COMMITTED → DONE`，旁支 `CANCELLED` / `STUCK` / `FAILED`；
- 目标状态：`PREPARED → FENCED → COMMITTED → DONE`；
- 结果 `outcome`：`verified` / `verified-with-gaps` / `incomplete` / `failed-partial`。任一目标无法判定，组就不能报 `verified`；成员结果逐条保留。

写入：`tmp → fsync → rename → fsync 父目录`。macOS 上 Node 的 `fsync` 经 libuv 发 `F_FULLFSYNC`，
失败才退到 `F_BARRIERFSYNC` 再到 `fsync`（libuv `src/unix/fs.c` 的 `uv__fs_fsync`）；SMB / virtiofs 不支持 `F_FULLFSYNC`，
那时只有写序、没有落盘保证——报告里不额外区分，写在这里。

### 7.3 提交

- **普通目录**：`<sessions>/<proj>/<dir>` → `runs/<runId>/entries/<proj>/<dir>`，同卷原子，随后 fsync 两个父目录。
- **链接目录**：`rename` 链接本身。cleanup **永不递归删目标**：目标里只有会话产物就删产物再 `rmdir`；
  还有别的文件就只删产物、其余保留并记 `leftover`；没有会话产物 → prepare 就拒绝。
  会话产物白名单：`session*.jsonl*`（含迁移临时文件 `session.migration.<token>.jsonl[.zstd].tmp`，`dsh-session-persistence-jsonl:1957`）
  与 `session.lock`（`:648`）。每处破坏性动作前重取身份，不符跳过并记 `identity-drift`；跨卷无写权限 → 只删链接，报 `external_target: PRESERVED`。
- **`EXDEV`**：prepare 预检 `dev`；预检之后挂载点变了导致 `EXDEV` → `commit-failed`，已提交的向前，未提交的原样留着。不降级 `rm -rf`。

### 7.4 全局互斥

POSIX：`flock(<stagingRoot>/.lock, LOCK_EX|LOCK_NB)`，拿不到 → `busy`。Windows：进程内互斥（A2）。
同一会话不可能被两个 run 同时提交——两边都要先拿它的写句柄。

---

## 8. purge：各域怎么清

| 域 | 怎么清 | 依据 / 注意 |
|---|---|---|
| 工作区记账 | 对**原始记录或过滤视图里含该 id** 的工作区调用 `detachSession(id)`；再 `unarchiveSession(id)`、`unpinSession(id)` | `detachSession` 改原始记录且幂等（`dsh-workspace:148-152`）；只看过滤视图 `sessionIds`（`:102-104`）会漏掉日志已删、索引已忘的槽位；但也**不能**对每个工作区无条件调用——每次变更都会顺手修剪该工作区里所有失效的槽位（`:176-180`），无条件调用等于替别的会话做了一次修剪；unarchive/unpin 对已不存在的 id 也能用（`:553-562`、`:597-606`） |
| 投影检查点 | `table.delete(id)`；再删 `<id>.json.bak.*` 这类表不追踪的备份文件 | 与所有写回同一条 FIFO 链，内存与磁盘一起变（`dsh-storage-domain:222-225`、`:264-276`）；拿不到表 → 删文件 + 告警 |
| 提醒 | `catalog()` 里 `sessionId` 等于目标的**所有**行（任何 status）逐条 `delete({sessionId, id})` | `delete` 不看 status（`dsh-schedule:2164-2181`）；非活跃行还留着投递历史与指令快照（`docs:reference/subsystems/schedule`）——隐私上必须删 |
| spill | 在本实例活动根与 `discoverDefaultRoots` 发现的根里，只删 `session-<sha256(id)[:12]>` | 目录名由目标 id 精确算出（`dsh-spill-local:70`），不会碰别的实例的会话（I3） |
| 浏览器状态 | 客户端半边清 `dsh.conversation.<id>` 等键（现有实现） | 广播 `api-session/removed` 只含真正提交的 id |
| 搜索索引 | 不碰 | 每次搜索前自对账（`dsh-session-query-sqlite` README） |
| 附件字节 | **不碰** | §11 |
| 别的会话 spill 里的引用副本 | **删不到，声明** | `dsh-session-reference` 把被引用会话的完整转录写进引用方自己的 spill，随上游清扫过期（默认 30 天，`dsh-spill-local:484`） |

---

## 9. 校验与审计

### 9.1 verify

1. `sessionPersistence` 列不出该 id；`sessions.get(id)`、`agents.get(id)` 为 undefined；
2. 检查点：`table.get(id) === undefined`，且 `<storages>/session_projcache/sessions/<id>.json*` 不存在（布局见 `dsh-session-projection-cache:15`）；
3. 工作区：原始 `workspace.record.sessionIds`（内部字段，feature-detect）、`archivedSessionIds`、`pinnedSessionIds` 都不含它。
   **过滤视图不能作证据**：它只放行 `sessionPaths` 里有路径的 id（`dsh-workspace:367`），日志一删、索引一刷就会把原始记录里的悬空格藏起来。
   README 的"missing-directory candidates retain their account"说的是**会话 cwd 不存在**（`dsh-workspace:892`），与日志被删无关；
4. 提醒：`catalog()` 里没有任何 `sessionId` 等于它的行；
5. `runs/<runId>/entries/` 已清空。

读不到的域记 `unverified: [...]`，`outcome: verified-with-gaps`，不许静默算通过。

### 9.2 审计

`<stagingRoot>/audit.jsonl`（与清单同卷、同生命周期，测试也能定位），追加、8 MiB 滚动到 `audit.1.jsonl`。每条：runId、路径（立即 / 延期）、目标 **id 与字节数**、每步结果、`outcome`、`unverified`。
**不记标题、不记内容**——审计不能成为被删会话的残留。

---

## 10. 收敛：墓碑

### 10.1 为什么需要

日志域被写句柄证明了；检查点域还有一个写回源我们挡不住：`coldSnapshot()` 的 fire-and-forget 写回
（`dsh-session-projection-cache:284-289`）。一个在提交前读完日志、在我们删除后才调用它的读者，会把检查点写回磁盘。
检查点按日志身份绑定，身份不符直接丢弃（`:156-170`），所以它**不会被误用**；问题只在隐私：磁盘上又有了被删会话的投影。

### 10.2 机制

- **arm**：commit 之前把目标 id 放进墓碑集（内存 + 清单）。
- **监听**：`ctx.on('domain/changed', c => c.domain === 'session_projcache' && c.operation === 'put' && matches(c.key, c.value.identity) && table.delete(c.key))`。
  事件在持久化确认之后、按写链顺序发出（`docs:reference/subsystems/storage`），并带着写入的记录（`dsh-storage-domain:288-295`），
  删除排在那次写回之后——**确定性删回**。
- **按身份认人，不按 id**：`matches` 要求 id 在墓碑集里，**且**记录的 `identity` 属于被删的那份日志。
  身份只由 header 字段推出（`formatVersion`/`createdAt`/`cwd`/`isSeeded` + `inheritedEventCount`，`dsh-session-projection-cache:372-379`）。
  落地时只比 `createdAt`（两边都有 `cwd` 时再比 `cwd`）：`formatVersion` 会因为 `open('write')` 发布新代际而变，
  而同 id 的新会话一定带新的 `createdAt`（`txn.js` 的 `checkpointIdentityMatches`）。不一致说明有人用同一个 id
  **新建**了会话——那不是复活，不碰。
- **启动复检**：插件启动时，对保留期内每份清单的目标 id 查表，身份一致就删。覆盖"写回发生在进程退出前、监听来不及"的窗口。
- **保留期**：墓碑随清单保留 7 天（`retainManifestDays`），过期即删清单。7 天远大于任何一次冷读的时长。

监听不可用时（事件或表拿不到）：只剩启动复检，告警。

### 10.3 不自动清"来路不明"的东西

读不出头的会话目录、没有会话目录的孤儿检查点，**只在设置页手动"扫描 → 看到路径 → 删除"**（现有安全阀）。理由：
它们没有清单、可能是损坏的用户数据；spill 根跨实例共享（`dsh-spill-local:393-430`）；会话根暂时不可达时"缺了什么"会一次误判全部。

---

## 11. 附件 gc（独立的手工操作，默认不跑）

- **根**：所有可读会话日志里的 `sha256:` 引用 + `~/.dsh/llm-deepseek/files-v3.json` 的 `attachmentId`。staging 里的日志不算根。
- **两轮**：第一轮只登记候选（不可达 + 超过宽限期 7 天）到 `gc/candidates.json`；至少 24h 后第二轮重新 mark，只删两轮都不可达的。
  这和 git gc 的 `gc.pruneExpire`（默认两周）同理：用宽限期挡"先写对象、后建立引用"的并发写者。
- **插入屏障**：第二轮从 mark 开始到最后一个 unlink 结束，监听 `session/event`，事件里出现的 digest 立即移出待删集
  （Dijkstra 增量更新屏障的思路：变更者新建的引用要通知收集器）。这把"第二轮 mark → delete"的窗口在**本进程内**关掉。
- **关不掉的**：别的进程；客户端草稿里引用了一个**老对象**（重复上传命中去重，对象 mtime 仍是旧的）。
  所以 gc 默认关闭，结果里必须写"无法排除客户端草稿引用"。
- **不可判定持有者**：任何"像会话但读不出头"的目录 → 整次 gc 中止，一个字节都不删。

---

## 12. 恢复与崩溃矩阵（启动时自动跑，只向前）

| 崩在 | 磁盘 | 恢复 |
|---|---|---|
| prepare / fence（立即） | 只有清单；租约随进程死亡由内核释放（`:621-628`） | 删清单——什么都没发生 |
| intent 后、quiesce 中（延期） | 清单 PENDING + 可能部分归档 | 继续延期流程：启动时会话是冷的 → 直接走立即路径 |
| commit 中 | 部分条目 | 已提交的向前；未提交的：立即路径原样留着，延期路径保持 PENDING |
| commit 后、目录项未落盘（掉电） | 清单说已提交，目录却在原处 | 按 `identity` 认出同一对象 → 重新 fence + rename（提交幂等）；身份不符 → `identity-drift`，不碰 |
| purge / cleanup 中 | 条目在 staging | 重做剩余步骤（全部幂等） |
| verify 后、未写 outcome | — | 重跑 verify |

**恢复先验身份**：已提交目标若被外部改写（备份拷回同名目录、同 id 重建），只按 id 认人会把新的删掉——所以一律先比 `dev:ino`。
**没有清单的残骸**：一律不动，只记"未知残骸"。

---

## 13. 失败分类

| 码 | 触发 | 副作用 |
|---|---|---|
| `session-unknown` | 索引里没有 | 无 |
| `target-set-changed` | 确认时目标集与预览不同（现有安全阀） | 无 |
| `cross-device` | `dev` 预检不符 | 无 |
| `linked-unresolvable` | 链接目标不可判定 | 无 |
| `busy` | 另一个 run 持有全局锁 | 无 |
| `became-live` | 预览全冷、执行时有人抢先打开 | 无（等用户重新确认） |
| `fence-unavailable` | 日志损坏且平台没有后备围栏 | 无 |
| `deferred` | 有目标活着，转延期 | **已停活、已归档、活跃提醒已删**（确认框已写明） |
| `stuck` | 延期待办连续 3 次非占用错误 | 同上；停止自动重试 |
| `commit-failed` | `rename` 失败 | **部分已提交** → 向前 |
| `verify-failed` | 完成后有残留 | 已提交，附差异 |
| `identity-drift` | 恢复时身份不符 | 该条不动 |
| `compensation-drift` | 取消后回读与快照不一致 | 上报项，不是异常 |
| `already-pending` | 这批会话已有等待中的延期删除（落地时补） | 无；预览里给出 `pendingRunId` |
| `fence-mismatch` | 后端根目录与配置不符，或持有写句柄后目标的 `session.lock` 并未被占 | 无 |
| `run-unknown` / `not-pending` / `invalid-run-id` | 取消 / 重试一个不存在或已不在等待的延期删除 | 无 |
| `gc-no-candidates` / `gc-too-early` / `invalid-gc-mode` | 附件回收的两轮门槛 | 无 |

---

## 14. 验证计划（落到 `selftest.mjs`）

| 不变量 | 注入 | 断言 | 放在 |
|---|---|---|---|
| I4 日志 | 真实 Cordis 里 resume 一个会话，再对它 `open('write')` | 抛 `SessionAlreadyOwnedError`；owner dispose 后同一 open 成功 | **Part B2 P1 ✅** |
| I4 日志 | 子进程按同一协议持有 `session.lock` | `open('write')` 被拒；子进程退出后内核释放、open 成功 | **Part B2 P1b ✅**（POSIX） |
| I4 日志 | 我们持句柄时让 `agents.resume` 同一 id | resume 被拒、不留半截会话、目录未被改写 | **Part B2 P2 ✅** |
| P3 | 持句柄时把目录 rename 出树，再关句柄 | 不重建原目录、不往移走的目录写任何东西、`list()` 不再列出、再 `open('write')` 得 `NotFound` | **Part B2 P2 ✅**（POSIX） |
| P3 | fence 第 2 个目标失败 | 第 1 个的句柄已关；磁盘、注册表、提醒全无变化 | Part B |
| I4 检查点 | **对照**：不装监听，提交后调真实的 `coldSnapshot()` | 检查点确实复活（内存与磁盘） | **Part B2 P3 ✅** |
| I4 检查点 | 装上监听，再调 `coldSnapshot()` | 监听删回；put 事件带着记录与身份；delete 排在 put 之后；内存与磁盘都空 | **Part B2 P3 ✅** |
| I4 检查点 | 写回发生后立即重启（不给监听机会） | 启动复检删掉 | Part B |
| I4 检查点 | 删除后用同一 id **新建**会话（真实 `agents.create`），让 dsh 自己的 detach 写检查点 | 监听看到了这次 put，但身份不同、不碰 | **Part B2 P4 ✅** |
| I2 | 删除后刷新 header 索引再读原始记录 | 原始 `record.sessionIds` 不含 | Part B |
| I2 | 目标有一条 inactive 提醒 | `catalog()` 里也没了 | Part B |
| I3 | 另一个 `dsh-spill-<6>` 根里放一个别的 id 的 spill | 不被碰 | Part A2 |
| I1 | commit 各 rename 之间崩溃 | 任一时刻 `list()` 无半状态 | Part A |
| I5 | 伪造"清单 COMMITTED + 目录仍在原处、身份相同" | 重新提交并完成 | Part A |
| 防误删 | 伪造"清单 COMMITTED + 原处是身份不同的同名目录" | 不碰，`identity-drift` | Part A |
| 延期 | PENDING 后取消，原本 pinned + 两条活跃提醒 | 归档位 false、置顶回来、提醒以新 id 重建、报告写明历史丢失 | Part B |
| 卡死 | 让 `open('write')` 连续 3 次抛非占用错误 | 状态 `STUCK`，不再自动重试 | Part B |
| A1 | staging 指向另一设备 | prepare 拒绝，无任何外部写入 | Part A |
| 链接 | 链接目标里有用户文件 | 只删会话产物，用户文件在，记 `leftover` | Part A |

Windows 两条（持句柄 rename、读者占用导致 `commit-failed`）**需要真机**，自测里标 `skip` 并打印原因。

**已实测的部分（2026-10-18，dsh 0.2.1-rc.2，macOS）**：标 ✅ 的行在 `selftest.mjs` Part B2 里跑在 dsh **自己的**
storage / storage-json / storage-domain / session / session-persistence-jsonl / session-projection-cache / agent / agent-loop 上，
配置照抄 `dsh-base/cordis.patch.yml`；只有 llm / tools / system-prompt 用的是 dsh 自带的空 hub（resume 在开 turn 之前不调用它们）。
Part B2 验证的是**dsh 的行为**（设计前提），不是插件——墓碑监听是测试自带的，插件里还没有。
**变异测试**：把监听的身份比对换成只比 id，P4 的三条立即失败（新会话的检查点被删）——这正是 §10.2 坚持按身份认人的实证。
其余行（P3 第一行、I2、延期、卡死等）依赖尚未实现的插件逻辑，等实现时再落。

---

## 15. 不做的事

| 不做 | 理由 |
|---|---|
| 驱逐活会话（`store.detach`） | §5.4 |
| 回收站 | 归档已经是可撤销的删除；延期路径的 PENDING 本身就是撤销窗口，不需要第二套状态机 |
| 启动时自动清来路不明的残留 | §10.3 |
| 直接改 `workspace.json` / `schedule.json` / 检查点文件 | P1；只用它们主人的服务 |
| 改别人的读取路径来"隐藏"已删会话（全局墓碑过滤） | 插件改不了读取路径，`provide` 冲突直接抛错（外部审计①已驳回） |
| 删除时顺带删附件 | I3 结构性保证；要回收就单独跑 §11 |

---

## 16. 业界先例

| 做法 | 先例 | 对应本设计 |
|---|---|---|
| 正在使用的东西不硬删，登记后在下次启动完成 | Windows `MoveFileEx(…, MOVEFILE_DELAY_UNTIL_REBOOT)` 把待删项写进 `PendingFileRenameOperations`，重启时执行（[Microsoft Learn](https://learn.microsoft.com/pl-pl/windows/desktop/api/WinBase/nf-winbase-movefileexa)） | 延期路径 |
| 待办持久化 + 启动补做；但要防"永远静默重试" | Firefox `privacy.sanitize.pending`："retry sanitizations on startup in case they didn't run or were interrupted by a crash"（[Sanitizer.sys.mjs](https://searchfox.org/firefox-main/source/browser/modules/Sanitizer.sys.mjs)）；反例 [Bug 1778090](https://bugzilla.mozilla.org/show_bug.cgi?id=1778090) 每次启动都失败、什么都没清掉 | 清单 + 启动恢复；`STUCK` 状态 |
| 重活别放在退出时做 | Firefox 文档：关闭时清理太慢会让父进程被终止、变成 shutdown crash（[Data Sanitization](https://firefox-source-docs.mozilla.org/toolkit/components/antitracking/anti-tracking/data-sanitization/index.html)） | 延期删除放在**启动后**推进，不挂在退出钩子上 |
| 只在没有写者时清扫 | Claude Code 的 `cleanupPeriodDays` 在启动时（新版文档说是启动后的后台清扫）删过期转录（[分析](https://dev.classmethod.jp/en/articles/claude-code-conversation-history-retention/)）；它也因"静默、不可恢复"被投诉（[#62476](https://github.com/anthropics/claude-code/issues/62476)） | 启动推进延期删除；确认框必须写清楚 |
| 宽限期挡并发写者 | git gc `gc.pruneExpire` 默认两周，"prevent corruption when git gc runs concurrently with another process writing"（[git-gc](https://git-scm.com/docs/git-gc)；[Gitaly !4410](https://gitlab.com/gitlab-org/gitaly/-/merge_requests/4410)） | §11 两轮 + 宽限 |
| 并发收集时新引用必须通知收集器 | Dijkstra 插入屏障（[Go 提案 17503](https://go.googlesource.com/proposal/+/master/design/17503-eliminate-rescan.md)、[V8 并发标记](https://v8.dev/blog/concurrent-marking)） | §11 插入屏障 |
| 只追加日志里的"删除"是撤销 + 派生收敛 | 事件溯源处理擦除的几种通行做法：墓碑事件让各投影自己收敛、把敏感数据放在日志外、crypto-shredding（[Michiel Rook](https://www.michielrook.nl/2017/11/forget-me-please-event-sourcing-gdpr/)、[DEV 社区综述](https://dev.to/norbertrosenwinkel/you-cant-delete-an-event-gdpr-says-you-must-crypto-shredding-is-the-truce-26ak)） | §1 问题定义；§10 墓碑 |
| rename 之后要 fsync 父目录 | ALICE（OSDI '14）研究应用层崩溃一致性协议（[论文](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-pillai.pdf)） | §7.2 |
| macOS 上 `fsync` 不等于落盘 | libuv 在 Apple 上先发 `F_FULLFSYNC`（[libuv fs.c 镜像](https://clickhouse.tech/codebrowser/html_report/ClickHouse/contrib/libuv/src/unix/fs.c.html)；[pnpm#16858](https://github.com/pnpm/pnpm/pull/16858) 记录了 SMB/virtiofs 的回退） | §7.2 |

---

## 17. 审查历史

| 轮次 | 主要发现 | 结果 |
|---|---|---|
| 自审 v3 | 附件自相矛盾、错误码是死码、互斥锁键错、gc 漏根、校验没说读不到怎么办等 11 条 | 全部修 |
| 外部审计① | 异步 dispose 复活竞态、目录 fsync、I7 自欺、域外残影；全局墓碑 | 前四条采纳；墓碑驳回 |
| 外部审计② | "await 驱逐"是错的、两次读证明不了未来、组三态、链接归属 | 采纳 |
| 终审 v6 | 8 条成立 6 条（链接不递归删、提醒验收、gc 两轮等） | 采纳 |
| 源码复核 v7 | 围栏在驱逐前会自锁、`stopActivity` 删提醒、过滤视图不能作证据、Windows 信号量不挡 rename 等 13 处 | 采纳；但复核后又发现 v7 自己的"可排序消除"漏了在途写回 |
| **换路线 v8** | 驱逐路线的洞是结构性的：生命周期不归插件管（文档 + 会话控制器丢弃 handle） | 改为"官方写句柄围栏 + 延期到冷 + 墓碑收敛"；去掉全部 `store`/`detach`/私有字段依赖 |
| **实现（落地）** | ① 工作区不能无条件 `detachSession`（会替别的会话修剪，见 §8）；② 墓碑只比 `createdAt`+`cwd`（`formatVersion` 会变）；③ 同批会话重复删 → `already-pending`；④ 计划要在互斥锁**内**计算，否则排队的第二次删除会拿过期计划报误导性的错；⑤ 延期完成中途失败时先回读清单，已推进到围栏之后的交给恢复、不把 PENDING 写回；⑥ 存储域"先落盘再改内存"、真实后端要求 cwd 派生布局——都是测试侧的时序/布局事实；⑦ 索引原先跳过软链接会话目录，§7.3 的链接规则落地前根本走不到 | 全部改进正文与代码；252 项自测 + 9 处变异测试 |
| **v8 实测** | Part B2：I4 的四条前提 + 跨进程租约 + 持句柄 rename，26 项在真实服务上通过；对照证实冷读写回确会复活检查点；变异测试证实只按 id 认人会误删 | 前提成立；§14 标注 ✅ |

**仍未解决（写在明处）**：活会话只能延期到下次启动；延期期间内容仍在磁盘上；取消延期时提醒只能以新 id 重建；
客户端草稿引用无法枚举；别的会话 spill 里的转录副本删不到；Windows 两条行为未实测；§6.2"每一种进入 store 的会话都持有写句柄"只实测了 resume 这一条路径。

---

## 18. 落地影响（相对 v7 时的 `index.js` / `engine.js`；已全部完成）

| 现状 | v8 | 备注 |
|---|---|---|
| 活会话硬拒绝 `session-purge/session-live`，让用户先重启 | 转延期路径（§5.3），设置页列出待完成删除，可取消 / 重试 | README「活会话是硬性拒绝」一节要改写 |
| 先摘工作区槽位、再删目录，失败再挂回（`index.js:307-341`） | 先围住、再移出树、再摘槽位；提交前无副作用，不需要"挂回" | `index.js:312` 的注释把 README 的 "missing-directory" 读成了"日志目录被删"，实际指 cwd 缺失（§9.1） |
| 直接 `rm` 目录 | 持写句柄 → rename 进 staging → 清理 | 需要新的清单 / 恢复代码 |
| 删检查点文件 | 经 `session_projcache` 表删除 + 墓碑监听 | 文件删除降为后备 |
| 只删活跃提醒（经 Schedule 服务） | 删 `catalog()` 里该会话**所有**行 | 非活跃行带投递历史 |
| `purgeAttachments` 删除时顺带算引用减法 | 删除不碰附件；gc 独立、两轮、带插入屏障 | 配置项语义要改，旧配置给一次性迁移提示 |
| — | 新 Remote 方法：列出 / 取消 / 重试待完成删除 | **`typert.js` 的 `invocations` 与 `client.js` 的 `TYPERT_REMOTE.descriptors` 两处都要加**，否则设置页白屏（AGENTS.md） |
| — | 新依赖：`@deepseek-ai/dsh-session-persistence`（只为按 name 判错时的常量，可不导入）、`@deepseek-ai/node-addon-system`（§6.3 后备） | 裸导入的必须写进 `peerDependencies` |
