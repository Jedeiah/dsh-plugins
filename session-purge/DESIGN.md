# 设计 v5：会话删除（最终稿）

> 本版是**四轮**审查后的收敛稿：自审、外部审计两轮、终审（v6）。正文只写**现在的设计**。
> 所有"事实"都标了源码位置；所有"猜"都不写成事实。v6 修了终审的 8 条（其中 6 条我核实成立）。

---

## 1. 问题

dsh 的会话日志是只追加的，`seam 无删除接口`（`dsh-session-persistence-jsonl/README.zh.md:167`）。
所以"删一个会话"不是删文件，而是：

> **撤销一份权威，并让所有派生在有限步内收敛到没有它。**

---

## 2. 正确性模型

### 2.1 不变量（已按能力边界收窄）

| # | 不变量 | 说明 |
|---|---|---|
| **I1** | **单域原子 + 跨域完成后一致** | 会话目录这一个域内，任何观察者看不到中间态（`rename` 保证）；跨域不追求"同一瞬间消失"，由 verify 证明**完成之后**各域一致 |
| **I2** | **无悬空权威** | 完成之后不存在指向它的权威记录（记账 / 归档 / 置顶 / 提醒） |
| **I3** | **无共享伤害** | 其他会话仍引用的字节必须完好；delete **结构性不碰**共享字节 |
| **I4** | **不可复活（可检测）** | 在线删除的上限是"复活会被**检测到并修复**"；只有离线（停掉所有写入者）才谈得上证明 |
| **I5** | **收敛** | 崩溃后重跑达到"完成"状态；**只向前**，不回滚已提交目标 |
| **I6** | **可证伪** | 每次结束都校验，且如实报告读不到的域 |
| **I7** | **可补偿（有界）** | 提交前的**持久化**改动可还原（尽力 + 回读）；被中断的工作不可还原，必须事先声明 |

**I4 为什么只能"可检测"**：`detach()` 同步返回 void，检查点写回是另一个包里 **async 且未被 await** 的
`session/disposed` 监听器（§3.4 有源码）。系统里不存在"写入者完成"的信号，所以任何有限次读取都只是检测。

### 2.2 假设

| # | 假设 | 不成立时 |
|---|---|---|
| A1 | 会话根与 staging 父目录同设备 | `cross-device` 拒绝整批，不降级 `rm -rf` |
| A2 | POSIX 有 `flock`；Windows 无锁文件 | Windows 退化为"`rename` 失败即拒绝" |
| A3 | 远端已上传文件由提供方过期回收 | 报告里点名，不假装清掉 |

### 2.3 可证明不可达（写清楚，才谈得上"绝对"）

跨域原子提交、Windows 跨进程写者、远端副本、不可枚举的草稿引用——这四件只能拒绝或声明。
**"绝对"= 所有失败模式被枚举 + 每种有确定行为 + 每种有测试**，不是"不会出问题"。

---

## 3. 域与所有权

### 3.1 七个域

| 域 | 性质 | 处置 |
|---|---|---|
| 会话目录（日志 + `session.lock`） | **权威** | 命名空间提交点：移出树 |
| 投影检查点 | 派生 | purge 阶段删（有界重试）；verify 复读 |
| 工作区记账（成员 / 归档 / 置顶） | **权威** | 走注册表服务；归档会清置顶，必须能还原 |
| 提醒 | **权威** | 走 Schedule 服务 |
| 附件字节 | **共享权威** | **delete 绝不碰**（§6） |
| 搜索索引 | 派生 | 不碰（每次搜索前自对账） |
| spill / 引用副本 / 临时对象 | 临时 | 顺手删；上游 `cleanupPeriodDays` **默认 30、启动时清扫、可配置**——所以"30 天"是默认策略不是保证；**别人的转录副本删不到**（§6.3） |

### 3.2 所有权：停 → 静置 → 复检 → 围栏 → 驱逐

顺序是有理由的，不能换：

```
prior := { archived, pinned }                      // 从注册表读，用于补偿

停     : prior.archived
           ? ctx.parallel('workspace/session-stop', {sessionId})   // archive 对已归档 id 直接 return，不会停
           : registry.archiveSession(id, { stopActivity: true })

静置   : 一个窗口，让最末 turn/end 落盘

复检   : 先查服务——ctx.get('agents').get(id)、ctx.get('sessions').get(id)
         服务答不了再试事件 workspace/session-activity（try/catch，拿不到记 unverified）
         仍有活动 → live-unstoppable，按 §3.3 补偿

围栏   : POSIX：open('r+') + tryLockExclusive(fd) + 校验 inode 仍是该路径；争用 → foreign-writer
         Windows：无锁文件，这一步只能靠后面的 rename 失败来拒绝

驱逐   : ctx.get('sessions').store.get(id).detach()   // 内部缝，feature-detect，拿不到就不驱逐并注明
```

**为什么围栏在驱逐之前**：驱逐不可逆（对象从 store 移除后，原 agent 的写句柄就没了）。
如果先驱逐、后围栏，一旦 flock 失败，我们就白白杀掉了一个会话的活句柄——那比"什么都没发生"糟得多。
放在租约之后，**所有可能失败的检查都在不可逆动作之前**。

### 3.3 补偿（I7）

fence 阶段、commit 之前的失败或取消，把副作用还回去：

| 做过的 | 还法 | 备注 |
|---|---|---|
| 新写入的归档位 | `unarchiveSession(id)` | 原本已归档的不要动 |
| 被归档清掉的置顶 | `pinSession(id)` | **必须在 unarchive 之后**：pin 已归档 id 会抛 `WorkspaceArchivedSessionPinError` |
| 被中断的运行中工作 | **还不了** | 唯一不可还原的副作用，确认框必须写明 |

补偿也不是无竞争的：注册表没有 CAS 令牌，`unarchive`/`pin` 会覆盖这期间用户的合法操作。
所以只能「记录 → 补偿 → 回读比对」，不一致记 `compensation-drift`。

### 3.4 驱逐到底发生了什么（源码核对）

```js
// dsh-session
detachEntered(entry) {                 // 同步，返回 void
  this.store.delete(entry.id);
  attachments.delete(entry.session);
  if (entry.announced) this.emitDisposed(entry);          // 同步 emit
}
// dsh-session-projection-cache
this.ctx.on('session/disposed', (session) => {
  this.flushSoft(session, 'detach');   // async，且监听器**没有 await**
  this.markClean(session);
});
```

三条事实：

1. **`detach()` 返回 `undefined`**，没有 promise 可等（我早前写"await 驱逐"是错的，已删）。
2. **检查点写回是 fire-and-forget**，没有完成信号 → 只能检测。
   注意租约的**作用域**：`session.lock` 的 `flock` 只约束"写日志"的那条路径（后端写打开会取同一把锁），
   **不约束检查点域**——检查点写入根本不碰这把锁。所以 I4 的证据只覆盖日志，检查点靠检测。
3. `store` / `entry.detach` 是**未公开的内部缝**，必须 feature-detect；拿不到就不驱逐并写进报告。

---

## 4. 状态机与预写清单

### 4.1 清单（staging 之外、会话树之内都不放）

```
<stagingRoot>/<runId>/
  manifest.json                    # 意图 + 目标 + 每步进度 + 结果
  entries/<project>/<dirName>/     # 被移出的真实目录（链接布局则是一条链接）
```

`<stagingRoot>` = `dirname(realpath(sessionsRoot))/.session-purge-staging`：**必须在会话树之外**
（后端 `listProjectDirs` 把根下每个目录都当项目，放进去会被重新列出来），又必须同卷。

写入：`tmp → fsync → rename`，且 **`rename` 后 fsync 源与目标两个父目录**（目录项也要落盘）。

```json
{ "version": 3, "runId": "…", "startedAt": 0, "callerSessionId": null,
  "states": { "group": "PREPARED", "members": { "session-…": "PREPARED" } },
  "targets": [{ "id": "…", "projectDir": "…", "dirName": "…",
                "linked": false, "realTarget": null, "identity": "dev:ino",
                "sizeBytes": 0, "prior": { "archived": false, "pinned": true } }],
  "steps": { "fence": "pending", "evict": "pending", "commit": "pending",
             "workspace": "pending", "cache": "pending", "schedules": "pending" },
  "outcome": null }
```

**恢复只认清单里的 runId**；没有清单的残骸一律不动，只记"未知残骸"。

### 4.2 生命周期

| 阶段 | 动作 | 失败语义 |
|---|---|---|
| prepare | 索引、目标集、血缘、链接解析、prior 快照、`callerSessionId` 检查 | 什么都没发生 |
| fence | 停 → 静置 → 复检 → 围栏 | 补偿后什么都没发生 |
| evict | 驱逐内存条目（feature-detect） | 已过不可逆线，继续 |
| commit | 每目标 `rename` 进 `entries/` + fsync 目录 | 部分已提交 → 向前收敛 |
| purge | 工作区 → 检查点（有界重试） → 提醒 | 已提交，重试/汇报 |
| cleanup | `rm -rf entries/` + **fsync 其父目录**（删除也要落盘） | 已提交，重试 |
| verify | §7 断言 + 审计 | 已提交，可能 verify-failed |

**组状态**（吸收外部审计的 B 条）：`VERIFIED` / `INCOMPLETE` / `FAILED_PARTIAL`。
任何一个成员无法判定，组就不能报 VERIFIED；但**成员级结果必须逐条保留**——
"整组失败"不等于"什么都没发生"。

### 4.3 全局互斥

`flock(<stagingRoot>/.lock, LOCK_EX|LOCK_NB)`，拿不到 → `busy`。
**锁文件按 `realpath(sessionsRoot)` 派生**——否则两份配置指向不同 staging、同一个 sessions 根时互斥失效。

### 4.4 崩溃矩阵（只向前）

| 崩在 | 磁盘 | 恢复（启动时自动跑一次） |
|---|---|---|
| prepare | 只有清单 | 删清单目录；写过归档位则按 §3.3 还原 |
| fence | 清单 + 归档位 | 还原归档/置顶 → 删清单目录 |
| evict 后 / commit 前 | 清单 + 归档位 | 会话仍在原处：按"未提交"处理，还原 prior 并记 failed |
| commit 中 | 清单 + 部分条目 | **已提交的必须向前**（purge→cleanup→verify）；未提交的还原 prior |
| purge / cleanup 中 | 全部在 entries/ | 重做剩余步骤（幂等） |
| verify 后 | 清单未标 outcome | 重跑 verify |

**恢复先验身份**：清单记的 `identity`（`dev:ino`）与当前对象不一致 → **不碰**，记 `identity-drift`。
理由：已提交目标若被外部改写（从备份拷回同名目录、同 id 重建），只按 id 认人会把**新的**删掉。

---

## 5. 提交点

### 5.1 普通目录

`<sessions>/<proj>/<dir>` → `<staging>/<runId>/entries/<proj>/<dir>`，同设备、原子，随后 fsync 两个父目录。

### 5.2 链接目录

`rename` **链接本身**同样原子，提交点成立。cleanup 阶段**不递归删目标**——身份吻合不等于"目标里只有会话文件"：

- 目标里只有会话产物（`session*.jsonl*`、`session.lock`）→ 删这些文件，再 `rmdir` 目标（变空才成功），最后删链接；
- 目标里还有别的文件 → 只删会话产物，**其余原样保留**并记 `leftover`，链接照删；
- 目标里没有任何会话产物 → prepare 阶段就拒绝。

理由（外部审计指出）：`dev:ino` + "看起来像会话"都推不出**独占所有权**；递归删目标可能在
用户把会话目录链接到共享文件夹时带走别人的东西。**只删已知产物**把这个风险从"要靠证明"降成"结构性没有"。

**竞态**：`realpath` 到实际删除之间路径可变。所以每一处破坏性动作前**重新取一次身份**，
不符就跳过并记 `identity-drift`；这是能做的上限，残余窗口写进报告。

共享目标不再整批拒绝（上面的分支不碰非会话文件）。跨卷无写权限 → 只删链接并报 `external_target: PRESERVED`。

### 5.3 `EXDEV`

拒绝整批，不降级。

---

## 6. 共享字节

### 6.1 delete 绝不碰附件

这让 I3 从"靠算法保证"变成"结构性不可能违反"。

### 6.2 gc 是独立的手工操作（默认不跑，且分两轮）

**手工运行 ≠ 离线运行**：sweep 期间用户仍可能在别的会话里新建引用（比如把一张老图引用进新会话）。
宽限期救不了这种"对象很老、引用很新"的情况。所以 gc 分两轮、跨运行：

- 第一轮：只**登记候选**（不可达 + 超过宽限期），不动一个字节，候选写进清单；
- 第二轮（至少 `candidateAgeHours` 之后，默认 24h）：重新 mark，**只删两轮都不在根集合里的对象**。

两轮之间任何新引用都会让对象退出候选。代价是回收慢一天，收益是"新引用不会被扫掉"。

- **根**：所有**可读**会话日志的 `sha256:` 引用 + `~/.dsh/llm-deepseek/files-v3.json` 里的 `attachmentId`。
- **不可判定持有者**：任何"像会话但读不出头"的目录 → **整次 gc 中止**，一个字节都不删。
- **草稿/在途**：客户端不可枚举，服务端**无法证明**它不存在 → 宽限期（默认 7 天）只是降低概率，**不是证明**。
  因此 gc 默认关闭，结果里必须写"无法排除客户端草稿引用"。
- **staging 里的日志不算根**：它们对应已提交删除的会话。

### 6.3 删不到的副本（必须告知）

`dsh-session-reference` 用 `ctx.get('spillStore')` 把被引用会话的**完整转录**写进**引用方会话自己的 spill**
（`session-reference-N.txt`）。删 A 不会碰 B 那份，直到 B 的 spill 过期（30 天）。
这不是"复活"，但确实是残留——必须在"删什么 / 不删什么"里写明。

---

## 7. 校验与审计

### 7.1 verify

1. `sessions.list()` 不含该 id（提交后读一次，静置后再读一次）；
2. 检查点不存在——purge 已做有界重试（删 → 读 → 再删，最多 3 次），verify **再读一次**；
   仍在 → `cache-resurrection-detected`（这是检测，不是证明）；
3. `workspaceRegistry` 的每个 `sessionIds`、`archivedSessionIds`、`pinnedSessionIds` 都不含它（三者在 0.2.1 都可读）；
4. 提醒域：`schedule.catalog()` 里没有绑定到目标 id 的任务（**这一条原来漏了**，外部审计指出）；
5. `entries/<runId>` 已清空。

读不到的域记 `unverified: [...]`，`outcome: verified-with-gaps`，**不许静默算通过**。

### 7.2 审计

`<DSH_HOME>/session-purge/audit.jsonl`，追加、8 MiB 滚动。每条：runId、目标、字节、每步结果、组状态、`unverified`。

### 7.3 残留清扫：启动时自动跑（迟到的检查点靠它收敛）

因为"迟到写入"无法被有限的两次读证明掉（§3.4），检测之后必须有**收敛机制**，否则
`cache-resurrection-detected` 只是报警。所以残留清扫在**每次启动时自动执行一次**，且只处理两类明确目标。

`cache-resurrection-detected` 会在磁盘上留下**没有日志的检查点**。残留清扫因此有两类目标：
① 读不出头的**会话目录**（60 秒年龄门 + 名字/内容形状门）；② **没有会话目录的检查点与 spill 目录**。
两者都先预览、再删除，路径由宿主重算，浏览器从不传路径。

---

## 8. 失败分类

| 码 | 触发 | 副作用 |
|---|---|---|
| `session-unknown` | 索引里没有 | 无 |
| `caller-session` | 目标是 `callerSessionId` | 无（客户端必须在 args 里带这个字段） |
| `live-unstoppable` | 复检仍有活动 | 已补偿 |
| `foreign-writer` | flock 争用（仅 POSIX） | 已补偿、未驱逐 |
| `cross-device` | EXDEV | 无 |
| `linked-unresolvable` | 链接目标不可判定 | 无 |
| `busy` | 另一个 run 在跑 | 无 |
| `commit-failed` | `rename` 失败（含 Windows 句柄占用） | **部分已提交** |
| `verify-failed` / `cache-resurrection-detected` | 完成后残留 | **已提交**，附差异 |
| `identity-drift` | 恢复时身份不符 | 该条不动 |

前七条**全部在不可逆动作之前**，但语义要说准：

- `archiveSession({stopActivity:true})` **先持久化归档位、再清置顶、最后才发停请求**，provider 失败不会回滚归档；
  所以失败路径的准确说法是「**已尽力补偿、可能残留 `compensation-drift`**」，不是"没有副作用"。
- 补偿本身可能覆盖这期间用户的合法操作（注册表没有 CAS），因此 `compensation-drift` 是**上报项**，不是异常。

---

## 9. 验证计划

| 不变量 | 注入 | 断言 |
|---|---|---|
| I1 | commit 各 rename 之间崩溃 | 任一时刻 `list()` 无半状态 |
| I2 | 工作区摘除失败 | 组状态非 VERIFIED，成员结果保留 |
| I3 | 损坏日志 + 共享对象 + 跑 gc | gc 中止，一字节不删 |
| I4 | 驱逐后立刻读检查点；再延迟 500ms 读 | 有界重试覆盖；仍出现 → `cache-resurrection-detected` |
| I5 | 伪造"清单 + 部分条目" | 启动后向前收敛 |
| I6 | 校验读到残留 | `verify-failed` + 审计 |
| I7 | fence 后取消，原本 pinned | 置顶回来、归档位回到 false |
| I7 | **围栏失败，会话原本 live** | **未被驱逐**（围栏在驱逐之前） |
| 恢复防误删 | 提交后换成同名目录再触发恢复 | 不删（`identity-drift`） |
| A1 | staging 指到另一设备 | 拒绝、无变化 |
| A2 | 子进程持 flock | `foreign-writer`、无变化 |
| A3 | 附件有远端副本 | 报告点名 |

---

## 10. 回收站

不加。归档已经是"可撤销的删除"；回收站 = 归档 + 延迟销毁，是第二套状态机，还会制造"已删"的隐私假象。
若要撤销窗口，形态是 `retainMinutes`（默认 0）+ `restore(runId)` + UI 明示"尚未释放"。

---

## 11. 竞品取舍

吸收：`stopActivity` 停活、驱逐后防写回、链接布局分策略（Baboo 实测六种布局）。
不吸收：回收站、直接重写 `workspace.json`、工作区级删除。
增量：预写清单、全局互斥、启动即恢复、校验 + 审计、跨进程围栏、GC 分离、残留清扫。

---

## 12. 一句话

> **删除 = 一次有身份、有提交点、有围栏、有补偿、有校验、有留痕的事务；共享字节不在这里动。**

---

## 13. 审查历史（三轮，只列改了什么）

| 轮次 | 发现 | 结果 |
|---|---|---|
| 自审 v3 | 附件自相矛盾、`stopActivity` 吞错导致错误码是死码、检查点"删两次"无对象、互斥锁键错、批量语义没说清、链接共享未考虑、gc 漏根、校验没说读不到怎么办、审计无上限、没有 caller 拒绝、依赖事件名 | 全部修 |
| 外部审计① | **异步 dispose 复活竞态**（保留）、目录 fsync、I7 自欺、域外残影；另主张全局墓碑 | 前四条采纳；墓碑驳回（插件改不了读取路径，`provide` 冲突直接抛错） |
| 外部审计② | **"await 驱逐"是错的**（`detach()` 返回 void）、两次读证明不了未来、组三态、链接归属不看 basename | 全部采纳，形成 v5 |
| 本次终审 | I1/I4 收窄后正文仍写旧承诺；**围栏与驱逐顺序**（先驱逐后围栏会白杀活会话）；检查点"删一次"与"有界重试"两处说法不一；§5.2 仍用 basename 判归属；gc 默认开关表述冲突；错误码缺 4 个；`callerSessionId` 没有入口 | 全部修，见正文 |

**仍未解决（写在明处）**：在线删除无法**证明**不复活，只能检测；跨卷只能拒绝；Windows 跨进程只能靠 `rename` 失败；
客户端草稿引用无法枚举；别的会话 spill 里的转录副本删不到。

---

## 14. 终审（外部审计第三轮）：8 条，6 条成立

| # | 它说的 | 核对 | 处置 |
|---|---|---|---|
| 1 | 链接目标递归删违反 I3：`dev:ino` + 像会话 ≠ 独占所有权 | 成立 | §5.2 改为**永不递归删目标**，只删会话产物；每处破坏性动作前重取身份 |
| 2 | 错误码的"无副作用"承诺与 `archiveSession` 先写归档相矛盾 | 成立 | §8 改成"已尽力补偿、可能 `compensation-drift`" |
| 3 | `flock` 不是上游写入者的围栏（合作式锁） | **部分**：后端写打开确实取同一把锁；但检查点域不取 | §3.4 写明**租约只覆盖日志域** |
| 4 | 双读不能保证检测到迟到写入 | 成立（与我的结论一致，但它指出"检测后要有收敛"） | §7.3 残留清扫改为**启动时自动跑** |
| 5 | gc 缺与新引用创建的屏障；手工 ≠ 离线 | 成立 | §6.2 改为**两轮候选**（跨 24h 重 mark） |
| 6 | verify 漏查提醒域 | 成立（我的验收清单确实没有） | §7.1 增加 `schedule.catalog()` 断言 |
| 7 | 递归 unlink 的崩溃持久性没闭合 | 成立（可补） | cleanup 后 fsync 父目录，并写明 VERIFIED 的口径 |
| 8 | "spill 30 天清除"是 backend 策略不是契约 | 成立 | §3.1 改成"默认 30、启动时清扫、可配置" |

**它这轮的价值**：不是新理论，而是抓具体——**漏了一个验收域**（提醒）、**一条承诺与实现的差**（归档先写）、
**一个我写成"证明"实际只是"检测"的洞**（迟到写入的收敛机制）。
