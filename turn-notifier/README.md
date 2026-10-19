# 提示铃（Chime）

一个 dsh 组合包插件：**智能体需要你注意时响铃提醒**。

- 你不动鼠标键盘的话，会按设定间隔**重复响**（默认 5 秒一次，共 3 次）——避免你切去做别的事就错过。
- 你一动鼠标/键盘/滚轮，**剩余的次数立刻取消**。
- 点"停止/继续"、回答提问这类**需要你操作**的时候，响的是另一套音（三音交替），和"答完"区分得开。

**一个包就够了**：响铃和 Plugins 页面里的配置页都由本包提供。

## 什么时候响

| 触发 | 条件 |
|---|---|
| **答完一轮** | **任一会话**的 `running` 由 `true` 变 `false`（子 agent 的除外：它答完只是父会话这一轮里的一步） |
| **需要你操作** | **任一会话**（含子 agent）的 `pendingInteraction` 由"没有"变成"有"——审批提示或提问 |

**不只是你正在看的那个会话**：切到别的会话、或者打开 Plugins / 设置页时，后台会话答完或停下来等你，照样会响。范围是"本窗口知道的所有会话"（dsh 的会话状态表，见下文《工作原理》）。

每次提醒**立刻响一声**，然后按间隔重复，直到响满设定的次数。任何鼠标移动、点击、按键、滚轮都会取消剩余次数。响铃的理由没了也会停：答完的那个会话又开始了新一轮，或者那个提问 / 审批已经被回答。

### 几个会话一起需要你

同一时刻只有**一个**提醒在响，不会叠着轰炸：

- 提醒**还有没响完的次数**，或者**上一声在 2 秒内**时，又来一个**同样急或没那么急**的触发（比如又有会话答完）→ **并进**正在响的这一个，不另起一声（2 秒内算"同一时刻"：各会话是分别上报的，同时结束的两个会话会相差几帧到达）。
- "需要你操作"比"答完一轮"更急：正在响"答完"时有会话停下来等你 → **立刻改响**"需要你操作"那套音并重新计次；反过来则并进去。
- 一个提醒已经响满次数、最后一声也过了 2 秒，你还没回来，这时又有会话答完 → 当作新的提醒，再响一轮。
- 提醒为哪些会话而响，就等这些会话**全部**不再需要你（或你一动鼠标键盘）才停；别的会话开始干活不会把它掐掉。

## 两种声音，十套铃声

每套铃声 = **一种音色** + **两段旋律**：「答完一轮」落在和弦的主音上，听起来是"结束了"；「需要你操作」停在和弦外的一个音上，听起来像在"问你"。所有音都取自大调五声音阶或其三和弦，前一个音还在余响时下一个音进来也不打架。

| 铃声 | 音色 | 答完一轮 | 需要你操作 |
|---|---|---|---|
| 音乐盒 | 音乐盒 | C6 E6 G6 C7 上行琶音 | G6 E6 G6 A6 |
| 马林巴 | 马林巴 | C5 E5 G5 C6 | C6 A5 C6 D6 |
| 拇指琴 | 拇指琴 | D5 F♯5 A5 D6 | A5 F♯5 A5 B5 |
| 电钢琴 | 电钢琴 | Cmaj7 分解和弦 | G5 A5 C6 D6 |
| 门铃 | 钟 | G5 → C5（叮—咚） | E5 G5 A5 |
| 颂钵 | 颂钵 | A4 一击长鸣 | D5 两击 |
| 经典 · 清脆（默认） | 经典 | `880:170, 1318.5:300` | `1046.5:140, 1318.5:140, 1046.5:200` |
| 经典 · 柔和 / 沉稳 / 单音 | 经典 | 见 `client.js` 的 `TONE_SETS` | |

默认仍是「经典 · 清脆」，**升级后听到的和以前一模一样**；在配置页换一套就能听到新的。

**音色是怎么做出来的**（`client.js` 的 `VOICES`）：「经典」是原来那种单个振荡器、音符一结束就截断的电子音。其余音色都是**加法合成**——按乐器实测的振动模式叠几个正弦分音，每个分音有自己的音量和衰减时间，所以音会自然延续到下一个音之后，像真的敲了一下：马林巴的第二模式在约 3.93 倍、拇指琴的金属簧片在约 6.3 倍、管钟有低八度的"嗡"声加小三度（1.19 倍）和五度、颂钵是两个几乎相同的模式互相"拍"出起伏；电钢琴另加一路衰减的调频，模仿音叉被敲击时那一下明亮的起音。乐器音色都送进一个生成的短混响（1.8 秒），听起来有空间感而不是干巴巴的"哔"。全部在浏览器里实时合成，**没有音频文件**。

音调写法是 **`频率Hz:时长ms`**，用逗号分隔，**按顺序依次播放**（前一个放完接下一个）。时长可以省略（默认 200ms）。对乐器音色，"时长"只决定下一个音什么时候敲，每个音按自己的音色自然衰减。

## 配置

十项都在宿主侧的 `Config` 里声明（`index.js`），所以**改完立即生效，不用重载模块**。

| 字段 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `muted` | `false` | 真/假 | 静音。**临时安静请用它**：只让铃不响，其它设置不受影响 |
| `notifyOnTurnEnd` | `true` | 真/假 | 智能体答完一轮时响 |
| `notifyOnWaiting` | `true` | 真/假 | 停下来等你操作（审批 / 提问）时响 |
| `repeatCount` | `3` | 1–10 | 每次提醒响几声（含第一次） |
| `intervalMs` | `5000` | 1000–60000 | 两次之间的毫秒数（界面上按**秒**显示） |
| `volume` | `1` | 0–2 | 音量。超过 1 的部分由输出限幅器兜住，不会削波 |
| `voice` | `classic` | `classic` / `musicBox` / `marimba` / `kalimba` / `electricPiano` / `bell` / `bowl` | 音色：经典 / 音乐盒 / 马林巴 / 拇指琴 / 电钢琴 / 钟 / 颂钵 |
| `waveform` | `sine` | `sine` / `square` / `triangle` | 「经典」音色的波形：正弦 / 方波 / 三角 |
| `finishedPattern` | `880:170, 1318.5:300` | — | "答完"的音调 |
| `interactionPattern` | `1046.5:140, 1318.5:140, 1046.5:200` | — | "需要你操作"的音调 |

### 在 Plugins 页改（推荐）

打开 **Plugins（插件）页 → 展开本插件卡片 → 点开 `提示铃` 那一行（右侧 `›`）**，页面分三组，按使用顺序排：

| 分组 | 内容 |
|---|---|
| **什么时候响** | 三个开关：答完一轮 / 停下来等你操作 / 静音 |
| **铃声** | 唯一的主选择：「提示音」下拉（音乐盒 / 马林巴 / 拇指琴 / 电钢琴 / 门铃 / 颂钵 / 经典 · 清脆 / 柔和 / 沉稳 / 单音 / 自定义…），旁边「试听」把两段依次播一遍。选「自定义…」才展开一个面板：音色、波形、两段音调（各带「试听」） |
| **音量与重复** | 音量滑杆、响几声、间隔秒数 |

交互规则：

- **一套铃声就是一个完整的声音**：选一套 = 一次原子写入（音色 + 两段音调；经典的几套还把波形定为正弦）。所以下拉框显示的名字总是名副其实——比如「经典 · 清脆」配方波就不再算「经典 · 清脆」，而显示「自定义…」。
- **音色、波形、音调只在「自定义」面板里**：在面板里怎么改，上面的下拉框都显示「自定义…」，面板不会收起、布局不会跳；在上面选回任意一套，面板收起并覆盖面板里的值。选「自定义…」本身不写任何东西。
- **波形控件一直在面板里**：非「经典」音色时置灰并注明「只有经典音色用到波形」，而不是消失（消失会让下面的内容上下跳）。
- **试听按真实时长排**：第二段等第一段余音结束再响（乐器音色能响好几秒，不是固定的半秒）；试听期间按钮变成「停止」，再点就停；再开一次试听会先掐掉上一次；离开页面会停掉正在播的试听。
- **音量滑杆松手才提交**：拖动过程只更新数字，松手（或键盘调完、失焦）时写入一次并用新音量试听一声——拖一下不会把配置文件改几十次。
- **数字框和音调框失焦或回车才提交**；音调框写错格式会当场标红并禁用试听，草稿保留。
- **两段音调各有「恢复默认」**：只把那一段改回出厂旋律（答完 `880:170, 1318.5:300`、等待 `1046.5:140, 1318.5:140, 1046.5:200`），写错的草稿一并丢掉，然后试听一声；已经是默认值时按钮置灰。

### 在 patch 里改

界面写入和手写写入的是**同一份** profile 补丁文件（`~/.dsh/profiles/<profile>/cordis.patch.yml`），所以两者永远一致：

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

### 改了代码之后必须重开 App

**改了本插件的客户端半边（`client.js`）之后，必须完全退出并重开 App**：宿主在启动时把 bundle 字节快照进内存，并按 `mtime/ctime/size` 生成带 `rev` 的资源 URL，响应头又是 `immutable` 一年缓存——只重载页面拿到的仍是启动时那一份。判定方法：插件卡片上的版本号。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 组合包清单：`dsh.bundle.patch` 与 `dsh.client` 声明 |
| `cordis.patch.yml` | 插入 `turn-notifier` 那一行 |
| `index.js` | 宿主半边：`Config` schema（九个可调项）+ `turnNotifier` 服务 |
| `typert.js` | 手写 Typert 宿主 manifest，声明 `turnNotifier/introspect` |
| `client.js` | 客户端半边：状态监听、合成提示音、重复/取消逻辑，以及 Plugins 页里的配置页 |
| `locale/{en,zh}.json`、`icon.svg` | 插件卡片的文案与图标 |

## 为什么 `peerDependencies` 里要写 schemastery

宿主半边需要 `import z from '@deepseek-ai/schemastery'` 来描述 `Config`——这是官方文档的写法。但本插件装在 dsh 安装目录**之外**，裸导入本来解析不到，那一行会以 `failed to import` / `ERR_MODULE_NOT_FOUND` 激活失败。

dsh 的解析器专门处理了这种情况：对 **linked 包**，只要导入方自己的 `peerDependencies` 里点了名，就把裸导入路由到安装里的那份。判定发生在 `routeLinked()` 里，读的是"拥有最近一级 `node_modules` 的那个目录"的清单——所以必须写在 **peer** 里。

范围写 `*` 是故意的：这里**只匹配名字**，而且兼容性门只校验 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 开头的 peer。

`devDependencies` 里同样列了一份，这是官方文档要求的另一半（"与宿主共享实例的 dsh 包同时声明在 `peerDependencies` 与 `devDependencies` 中"），供类型检查和独立测试使用。本包是纯 JS、不做类型检查，所以它只起"照文档补齐"的作用。

以后**再往宿主半边加任何来自 dsh 安装的导入，都要在这里一起声明**。

## 工作原理

### 响铃是独立的隐形条目

响铃是 `shell.overlay` 槽位上一条 id 为 `turn-notifier-alert` 的条目，它渲染 `null`，与配置页互不影响。它读两个**根级标准 prop**：

- `useSessionStatus`：**一张表**，键是本窗口知道的每个会话 id，值是 `{ running, pendingInteraction, completionUnread }`。条目拿整张表、和上一张逐个会话比较。
- `useSessions`：会话行；行上 `origin === 'subagent'` 的是子 agent，它"答完一轮"不响。

设置数据来自 `ctx.configForms`，在浏览器里读取，所以改完立即生效。

**为什么是 `shell.overlay`。** 1.7.x 把条目挂在 `conversation.composer.dock`，并且只取 `snapshot.get(sessionId)`——于是**只有正在看的那个会话会响**。依据（行号对应 dsh 0.2.1-rc.2）：

| 事实 | 出处 |
|---|---|
| `useSessionStatus` 是**每个 scope 都有**的标准 prop，由 ui-session 提供 | 文档 reference/subsystems/slots《Framework-provided hooks》表 |
| 它背后是**一张覆盖所有会话**的表：会话列表里的每个 id，加上 `api-session/status` 事件报来的任何 id | `dsh-client-ui-session/lib/client.js` 的 `sessionStatus` / `observeRunning` / `publishStatus`（约 782–990 行） |
| 后台会话的审批同样进这张表：Gateway 对任何 `agentId` 都 `retainAgentScope`，审批插件据此按会话发布 `pendingInteraction` | `dsh-api-session-controller/lib/client.js` 约 4297 行；`dsh-client-ui-approval/lib/client.js` 约 284–356 行 |
| `conversation.composer.dock` 是 `scope: "session"`，而且只在**屏幕上那个会话的输入框**里、`sessionId !== undefined` 时才渲染 | `dsh-client-ui-conversation/lib/client.js` 约 19221、19973 行；文档 slots 的层级图里它在 `Factory: conversation.content` 之下 |
| `shell.overlay` 是 `root` 范围的 list 槽位，`AppFrame` 无条件渲染 | `dsh-client-ui-layout/lib/client.js` 约 313、352、643 行；dsh 自己的重命名/归档对话框、快捷键面板也挂在这里 |
| 子 agent 的运行状态也会进表（`agent/status` 对每个 agent 都发），会话行用 `origin: 'subagent'` 标出它 | `dsh-api-session-controller/lib/index.js` 约 2990 行；同包 `client.js` 的 `projectList` |

换槽位后，切换会话不会让条目重挂、丢掉基线，打开不显示会话的页面时它也还在。`useSessionStatus` / `useSessions` 缺席时条目不崩，各在控制台点名一次：前者意味着铃永远不响，后者意味着子 agent 答完也会响。

设置页的开关、波形选择、试听按钮走官方 `@deepseek-ai/dsh-client-ui-primitives`（`Switch`、`SegmentedControl`、`Button`），滑杆和数字框是原生 `input`（官方没有对应控件），配色统一取 `--dsw-alias-*` 令牌，因此随主题自动适配。

### 配置页挂在"本插件自己的 Host 服务"上

配置页在 `apply` 里的这道门内注册：

```js
ctx.inject(['remote.turnNotifier', 'slots', 'locale'], (child) => {
  child.effect(() => childForms.whileServed([ENTRY_ID], () => child.slots.register({…}, TurnNotifierRowConfig)));
});
```

**门的依赖必须是本插件自己的服务**（`remote.turnNotifier`），不能是全局服务：`ctx.inject` 会在依赖**重新出现**时重跑回调，而全局服务从不消失，门就永远不会重开。这一点是从 `session-purge` 的行页学来的——它同样把自己的 `remote.sessionPurge` 当作门的依赖。

**为什么需要这道门。** 停用再启用带客户端半边的行时，dsh 的模块表认为这个包已经加载过（[deepseek-harness#8452](https://github.com/deepseek-ai/deepseek-harness/discussions/8452)），`apply` 不一定重跑；而把页面注册在不依赖任何东西的代码里，它就只能在 `apply` 跑的时候挂上一次。改成依赖门之后，**Host 半边重建 → `remote.turnNotifier` 消失又出现 → 门重跑 → 页面重新挂上**，页面于是跟着"本插件自己的服务"生死，而不是跟着某一次 `apply` 生死。实测：停用 → 启用之后，`›` 和页面内容都在。

### `turnNotifier` 服务

`index.js` 里注册了 `turnNotifier` 服务，提供 `introspect()`，返回 Host 侧实际生效的配置（schema 默认值已合并）。它目前有两个作用：

1. **作为配置页那道门的依赖锚点**（见上）——这是它能自愈的关键。
2. 为将来把浏览器半边的 `FALLBACK_SNAPSHOT` 换成真实 Host 值留出接口。那条兜底路径只在 `configForms` 服务缺失时才会走到（罕见组合），**尚未接入**。

### 不再有"卡片配置区"

1.6.0 曾在 `plugins.bundle.config` 另放一份，导致同一个卡片里出现"配置区 + 组件行页"两份入口（1.6.1 已删）。行页注册在 `plugins.row.config`（key = `<包名>#<行 id>`，即 `@jedeiah/turn-notifier#turn-notifier`），是本插件唯一可点开的页面。

**注意不要在宿主半边调 `settings.configure({ auto: false })`。** 它会把本行从 `configForms` 的命名空间列表里摘掉，而 Plugins 页只在列表里存在该行 id 时才把 form 交给页面（`configForm(rowId)`）——页面会拿到 `undefined` 并渲染成空白。行页与 bundle 级的自动表单是两个不同的槽位，留着 schema 对外暴露并无副作用。

### `dsh.client` 里绝不能写 `immediately`

该字段把这一行划入 **bootstrap** 阶段，而客户端模块系统有一条明文限制：**"移除或替换 bootstrap 需要刷新页面"**。带它的行会出现"点停用移不掉、点启用加不回来、只有重载页面（重启桌面端）才生效"的现象。本插件不向其他插件提供任何东西，不需要启动期预取，因此不声明它——本行就是**可动态增删的普通条目**。
