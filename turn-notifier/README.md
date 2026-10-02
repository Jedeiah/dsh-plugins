# 回合提醒（Turn Notifier）

一个 dsh 组合包插件：**智能体答完一轮、或停下来等你操作时响一声**。

- 你不动鼠标键盘的话，会按设定间隔**重复响**（默认 5 秒一次，共 3 次）——避免你切去做别的事就错过。
- 你一动鼠标/键盘/滚轮，**剩余的次数立刻取消**。
- 点"停止/继续"、回答提问这类**需要你操作**的时候，响的是另一套音（三音交替），和"答完"区分得开。

## 什么时候响

| 触发 | 条件 |
|---|---|
| **答完一轮** | 当前会话的 `running` 由 `true` 变 `false` |
| **需要你操作** | `pendingInteraction` 由"没有"变成"有"——审批提示或提问 |

每次提醒**立刻响一声**，然后按间隔重复，直到响满设定的次数。任何鼠标移动、点击、按键、滚轮都会取消剩余次数。

## 两种声音

| 场景 | 默认音调 | 含义 |
|---|---|---|
| 答完一轮 | `880:170, 1318.5:300` | 两音上行 |
| 需要你操作 | `1046.5:140, 1318.5:140, 1046.5:200` | 三音交替 |

音调写法是 **`频率Hz:时长ms`**，用逗号分隔，**按顺序依次播放**（前一个放完接下一个）。时长可以省略（默认 200ms）。

## 配置

九项都在宿主侧的 `Config` 里声明（`index.js`），所以**改完立即生效，不用重载模块**。

| 字段 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `muted` | `false` | 真/假 | 静音。**临时安静请用它，不要停用插件行**（原因见下） |
| `notifyOnTurnEnd` | `true` | 真/假 | 智能体答完一轮时响 |
| `notifyOnWaiting` | `true` | 真/假 | 停下来等你操作（审批 / 提问）时响 |
| `repeatCount` | `3` | 1–10 | 每次提醒响几声（含第一次） |
| `intervalMs` | `5000` | 1000–60000 | 两次之间的毫秒数（界面上按**秒**显示） |
| `volume` | `0.35` | 0–1 | 音量 |
| `waveform` | `sine` | `sine` / `square` / `triangle` | 波形：柔和 / 明亮 / 圆润 |
| `finishedPattern` | `880:170, 1318.5:300` | — | "答完"的音调 |
| `interactionPattern` | `1046.5:140, 1318.5:140, 1046.5:200` | — | "需要你操作"的音调 |

### 在 Plugins 页改（推荐）

**改了本插件的客户端半边（`client.js`）之后，必须完全退出并重开 App**：宿主在启动时把 bundle 字节快照进内存，并按 `mtime/ctime/size` 生成带 `rev` 的资源 URL，响应头又是 `immutable` 一年缓存——只重载页面拿到的仍是启动时那一份。判定方法：插件卡片上的版本号（现在是 **1.6.3**）。


### 在界面里改（Plugins 页卡片）

打开 **Plugins（插件）页 → 展开本插件卡片 → 点开 `turn-notifier` 那一行（右侧 `›`）**：同一个三组页面（键 `@jedeiah/turn-notifier#turn-notifier`）。

- 数字框和音调框：**失焦或回车才提交**，边打字边写库不会发生；开关、下拉、滑杆即时提交。
- 波形下拉框：选完立即生效。
- 音调框写错格式会**当场拒绝**并提示，不会把非法值写进去。
- 底部「全部恢复默认」清掉所有用户覆盖值（静音除外）；逐字段的覆盖标记在 1.6.0 重排时取消。

### 临时安静：用静音，不要停用插件行

停用再启用带客户端半边的插件行之后，**浏览器半边不会被重新挂载**（dsh 的已知问题 [deepseek-harness#8452](https://github.com/deepseek-ai/deepseek-harness/discussions/8452)）：模块表认为这个包已经加载过，于是不再执行它的 `apply`，界面与配置页就一直缺席——**重载界面（⌘R）即可恢复**，不必重启 App。所以想安静就用上面的「静音」开关；行开关留着真正想移除这个插件时用。

### 在 patch 里改

界面写入和手写写入的是**同一份** profile 补丁文件，所以两者永远一致：

```yaml
- id: turn-notifier
  name: '@jedeiah/turn-notifier'
  config:
    repeatCount: 4
    intervalMs: 3000
    volume: 0.5
    waveform: 'triangle'
    finishedPattern: '660:120, 990:260'
```

`index.js` 里调用了 `settings.configure({ auto: false })`，因为本插件**自带配置页**；不声明的话设置服务会对外宣称存在一个自动生成的表单，而目前没有任何自带客户端会渲染它。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 组合包清单：`dsh.bundle.patch` 与 `dsh.client` 声明 |
| `cordis.patch.yml` | 插入 `turn-notifier` 那一行 |
| `index.js` | 宿主半边：`Config` schema（九个可调项，含静音与两个触发场景开关）+ 页面策略 |
| `client.js` | 客户端模块：状态监听、合成提示音、重复/取消逻辑，以及 Plugins 页上的行配置页 |
| `locale/{en,zh}.json`、`icon.svg` | 插件卡片的文案与图标 |

## 为什么 `peerDependencies` 里要写 schemastery

宿主半边需要 `import z from '@deepseek-ai/schemastery'` 来描述 `Config`——这是官方文档的写法。但本插件装在 dsh 安装目录**之外**，裸导入本来解析不到，那一行会以 `failed to import` / `ERR_MODULE_NOT_FOUND` 激活失败。

dsh 的解析器专门处理了这种情况：对 **linked 包**，只要导入方自己的 `peerDependencies` 里点了名，就把裸导入路由到安装里的那份。判定发生在 `routeLinked()` 里，读的是"拥有最近一级 `node_modules` 的那个目录"的清单——所以必须写在 **peer** 里。

范围写 `*` 是故意的：这里**只匹配名字**，而且兼容性门只校验 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 开头的 peer。

`devDependencies` 里同样列了一份，这是官方文档要求的另一半（"与宿主共享实例的 dsh 包同时声明在 `peerDependencies` 与 `devDependencies` 中"），供类型检查和独立测试使用。本包是纯 JS、不做类型检查，所以它只起"照文档补齐"的作用。

以后**再往宿主半边加任何来自 dsh 安装的导入，都要在这里一起声明**。

## 工作原理

**一个设置入口（1.6.3 起）。**

| 入口 | 槽位 | 说明 |
|---|---|---|
| Plugins 页卡片里可点开的行（右侧 `›`） | `plugins.row.config`（key = `<包名>#<行 id>`） | 与 session-purge 同构；按 `whileServed(['turn-notifier'])` 注册，宿主不提供该设置命名空间时整页不出现 |

**不再有"卡片配置区"。** 1.6.0 曾在 `plugins.bundle.config` 另放一份，导致同一个卡片里出现"配置区 + 组件行页"两份入口（1.6.1 已删）。现在两处入口渲染的都是 `TurnNotifierGroups`（三组：什么时候响 / 怎么响 / 重复与停止），读写同一个 `ctx.configForms.get('turn-notifier')`，不存在两套界面或两套值。

**关于"停用/启用后 `›` 消失"**（1.6.5 起改为只声明常驻依赖）：`session-purge` 在同样操作下能保住行页，本插件不能——**确切机制仍在取证中**（有一个独立排查任务在用浏览器自动化复现，目标是给出 `arrive()` 早退 / 备用 URL / 批构成三者的定论）。已确认的事实：行页只由客户端半边注册，宿主侧没有兜底页；runner 在停用时确实会 dispose 插件实例并 `invalidate` 模块，所以理论上支持重新挂载。临时办法是**重载界面（⌘R）**。

若仍然出现 `›` 消失，**重载界面（⌘R）**即可恢复；想临时安静请用设置里的静音开关，不要动行开关。行配置页由宿主在每次渲染时新给一个 `{ state, mutate }`，插件侧用一个**身份稳定**的桥接对象 + 显式快照把新 revision 传进去——适配器若每次渲染都新建，`useStoreValue` 的依赖会不停变化并陷入 setState 循环。

**响铃行为是独立的隐形条目**（同一槽位、id `turn-notifier-alert`，渲染 `null`）：它只订阅 `useSessionStatus`，与设置页互不影响。

**想安静请用静音开关，不要停用行。** 停用再启用带客户端半边的插件行之后，浏览器半边不会被重新挂载（dsh 的已知问题 deepseek-harness#8452：模块表认为包已加载、不再执行它的 `apply`），界面与配置页会一直缺席，直到**重载界面（⌘R）**——为此本插件提供 `muted`，行开关留给真正想移除插件时用。

**`dsh.client` 里绝不能写 `immediately`。** 该字段把这一行划入 **bootstrap** 阶段，而客户端模块系统有一条明文限制：**"移除或替换 bootstrap 需要刷新页面"**。带它的行会出现"点停用移不掉、点启用加不回来、只有重载页面（重启桌面端）才生效"的现象。本插件不向其他插件提供任何东西，不需要启动期预取，因此不声明它——本行就是**可动态增删的普通条目**。

**状态信号**来自槽位的 `useSessionStatus` 标准属性，条目形如 `{ running, pendingInteraction, completionUnread }`。

**只在状态跳变时响：** 挂载后的第一次渲染、以及切到别的会话后的第一次渲染，都只记录基线——打开一个本来就空闲、或本来就在等你的会话，不会平白响一声。

**文案与配色**全部走客户端 locale 服务与 `--dsw-alias-*` 主题令牌，所以跟随语言切换与深浅色，无需额外处理。

## 验证情况

已验证：

| 项目 | 方式 |
|---|---|
| 逻辑 | 开发期曾用测试台覆盖过 **52 项断言**（状态跳变、会话切换不误报、**会话暂时从状态表消失不误报**、重复与取消、配置驱动行为、波形/音调配置生效、音调校验拒绝非法值、配置页结构与 key、写库时机、卸载清理）。按当时的验证约定，该测试台**已删除**，不再随包提供 |
| 语法与清单 | `node --check`、JSON 解析、patch YAML 解析 |
| 已安装后的实时槽位 | 客户端 `Slots.listSubTree`：root `conversation.composer.dock` 应有 `turn-notifier` 与 `turn-notifier-alert`；root `plugins.row.config` 应有 key `@jedeiah/turn-notifier#turn-notifier`（不再有 `plugins.bundle.config` 条目） |
| 行配置页 | 开发期临时探针（不随包提供）：物化客户端模块 → `apply` → 渲染行页，断言三组标题、复选框/滑杆/下拉/试听/静音/恢复默认齐备、写入经 `form.mutate` 带 revision 落地、用到的 `@deepseek-ai/dsh-client-ui-primitives` 名字存在于安装导出表、字典键中英齐全无冗余 |
| 配置 schema | 宿主 `Config.listConfigs`（name = `@jedeiah/turn-notifier`）：状态应为 `schema`（= fiber 存活且 Config 是原生 schemastery schema），并列出全部字段 |

**无法自动验证、需要你亲测的两件事：**

1. **表单长什么样。** 结构渲染有断言，但**没有做过视觉比对**（自动化能驱动的是 Chrome，而 Harness 界面在 Electron 里）；字号、间距、控件对齐仍需人眼确认。
2. **是否真的出声。** 需要真实音频设备与浏览器自动播放策略，只能在你的环境里确认。

## 平台

纯浏览器半边（Web Audio + Pointer Events），没有宿主代码、没有平台判断：桌面端（macOS / Windows / Linux）与 Web profile 都能用。唯一前提是页面能发声——浏览器要求先有一次用户手势，这也是它自己解锁音频上下文的原因。

## 已知限制

- **开发期测试台已按约定删除。** 它模拟过 React 与 DOM，违反了当时"禁止模拟 React/DOM"的约定；最后一轮代码审核中它抓到了一个真 bug（会话暂时离开状态表会误报"回合结束"），确认修复后即移除，包内不再包含测试代码。
- 文本框是**失焦/回车**提交，不是官方那套"暂存 + 保存/放弃"模型；数字、开关与下拉是即时提交。
- 界面原语（`Modal` / `Button` / `Tooltip` / 图标）通过 loader 的 `require` 解析 `@deepseek-ai/dsh-client-ui-primitives`——官方把它当作"隐式 baseline external"，**不要在依赖里再声明或打包副本**（见 `dsh-client-ui-workspace/README.zh.md` 的 lane 说明）。
- 状态跳变的判定依赖 `useSessionStatus` 给的 `running` / `pendingInteraction`；如果槽位不提供这个 hook，插件**降级为不响**而不是崩溃。