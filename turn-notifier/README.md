# 提示铃（Chime）

一个 dsh 组合包插件：**智能体需要你注意时响铃提醒**。

- 你不动鼠标键盘的话，会按设定间隔**重复响**（默认 5 秒一次，共 3 次）——避免你切去做别的事就错过。
- 你一动鼠标/键盘/滚轮，**剩余的次数立刻取消**。
- 点"停止/继续"、回答提问这类**需要你操作**的时候，响的是另一套音（三音交替），和"答完"区分得开。

**一个包就够了**：响铃和 Plugins 页面里的配置页都由本包提供。

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
| `muted` | `false` | 真/假 | 静音。**临时安静请用它**：只让铃不响，其它设置不受影响 |
| `notifyOnTurnEnd` | `true` | 真/假 | 智能体答完一轮时响 |
| `notifyOnWaiting` | `true` | 真/假 | 停下来等你操作（审批 / 提问）时响 |
| `repeatCount` | `3` | 1–10 | 每次提醒响几声（含第一次） |
| `intervalMs` | `5000` | 1000–60000 | 两次之间的毫秒数（界面上按**秒**显示） |
| `volume` | `1` | 0–2 | 音量。超过 1 的部分由输出限幅器兜住，不会削波 |
| `waveform` | `sine` | `sine` / `square` / `triangle` | 波形：正弦 / 方波 / 三角 |
| `finishedPattern` | `880:170, 1318.5:300` | — | "答完"的音调 |
| `interactionPattern` | `1046.5:140, 1318.5:140, 1046.5:200` | — | "需要你操作"的音调 |

### 在 Plugins 页改（推荐）

打开 **Plugins（插件）页 → 展开本插件卡片 → 点开 `提示铃` 那一行（右侧 `›`）**，页面分四组：

| 分组 | 内容 |
|---|---|
| **什么时候响** | 三个开关：答完一轮 / 停下来等你操作 / 静音 |
| **怎么响** | 音量滑杆、波形分段控件（正弦 / 方波 / 三角） |
| **音调** | 「提示音」下拉（清脆 / 柔和 / 沉稳 / 单音 / 自定义…），右侧「试听」会把这一套的两个音依次播一遍；选「自定义…」才展开两个音调输入框，各带「试听」 |
| **重复** | 响几声、间隔秒数 |

- **开关、滑杆、波形即时提交**（切波形会立刻用新波形试听一声）；**数字框和音调框失焦或回车才提交**，边打字边写库不会发生。
- 选一套提示音是**一次原子写入**（两个音调一起提交），不会写一半。
- 音调框写错格式会**当场标红**并禁用试听，草稿保留供你继续改。
- 试听按钮在播放期间显示「播放中」；离开页面时会清掉待播的计时器，不会多响一声。

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

同一个 `conversation.composer.dock` 槽位上还有一条 id 为 `turn-notifier-alert` 的条目，它渲染 `null`：只订阅 `useSessionStatus`，与配置页互不影响。设置数据来自 `ctx.configForms`，在浏览器里读取，所以改完立即生效。

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
