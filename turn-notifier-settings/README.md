# 回合提醒·设置页（Turn Notifier Settings）

`@jedeiah/turn-notifier` 的**设置页**，单独装成一个 bundle：把"提醒那一行的配置页"从可停用的行里挪出来，这样**停用→启用提醒行之后，右侧 `›` 不会跟着消失**。

> 这是**配对包**：不是独立功能。单独装它没有意义（见下《配对关系》）。

## 它做什么

| 半边 | 内容 |
|---|---|
| 宿主（`index.js`） | **空操作**。本 bundle 没有自己的可调项，也不导出 `Config`——所以设置服务不会为这一行生成任何表单 |
| 客户端（`client.js`） | 在 `plugins.row.config` 注册**提醒那一行**的配置页：键 `@jedeiah/turn-notifier#turn-notifier`（该槽位是 keyed 的，键 = `<包名>#<行 id>`），所以 `›` 出现在 **turn-notifier** 那行右侧，而不是本 bundle 自己的行上 |

页面读写的仍然是提醒的宿主命名空间 `turn-notifier`（`turn-notifier/index.js` 里九个 `.volatile()` 字段），由 Plugins 页通过全局的 `configForms` 服务把 `{ state, mutate }` 交给页面——**两个 bundle 之间没有任何代码导入**，各自独立。文案、排版、音调校验、试听都是原来那一套（三组：什么时候响 / 怎么响 / 重复与停止）。

`dsh.client` 里**不声明 `immediately`**（理由同 turn-notifier：bootstrap 条目无法动态增删），也**不注入 `@deepseek-ai/dsh-client-ui-conversation`**——这一半只画页面，不观察会话状态。

## 为什么拆

带客户端半边的行被停用后，浏览器半边会被拆掉，而重新启用**不会重新挂载**它（dsh 已知问题 [deepseek-harness#8452](https://github.com/deepseek-ai/deepseek-harness/discussions/8452)：模块表认为这个包已经加载过，于是不再执行它的 `apply`）。原来的设置页挂在这一行自己身上，于是"停用→启用"之后行页（`›`）一起消失——而 `@jedeiah/session-purge` 在同样操作下能保住行页，差别只在**它的页面注册时用的是哪个 bundle 的行**。

设置页要活下来，只能由**另一个不会被停用的 bundle**来提供：本 bundle 的行是空操作，没有理由被关掉，页面因此不受提醒行开关的影响。

## 配对关系

| 装了什么 | 结果 |
|---|---|
| 只有 `@jedeiah/turn-notifier` | 会响，但 Plugins 页里那一行**没有 `›`**（没有人注册行页） |
| 只有 `@jedeiah/turn-notifier-settings` | 有设置入口（`›` 在，因为键在槽位里）；但 Plugins 页不会把 form 交给页面（`configForms` 里没有 `turn-notifier` 这个命名空间），页面渲染为空，不会崩 |
| 两个都在 | **完整**：响铃行为在提醒包里，设置页在设置包里，读写同一个命名空间 |

两个包版本各自独立。与本包配对的是 **1.6.6 起的 `@jedeiah/turn-notifier`**：更早的版本自己也注册同一个键（同一个 keyed 槽位重复注册时后者顶替前者，页面还是同一套），但那时的页面仍然随那一行的开关生死——拆分的意义也就没有了。**别停用 `turn-notifier-settings` 那一行**——它是设置页的载体；停了以后同样要重载界面（⌘R）才能把页面找回来。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 组合包清单：`dsh.bundle.patch` 与 `dsh.client` 声明 |
| `cordis.patch.yml` | 插入 `turn-notifier-settings` 那一行（空操作宿主半边） |
| `index.js` | 宿主半边：只有注释与空 `apply`，说明这个 bundle 为什么存在 |
| `client.js` | 客户端半边：`plugins.row.config` 的注册 + 三组设置页面（含试听） |
| `locale/{en,zh}.json`、`icon.svg` | 本行卡片的文案与图标（铃铛 + 滑杆） |

## 验证情况

- 语法：`client.js` 用与浏览器同口径的 `new vm.Script(source)` 解析，`index.js` 用 `node --check`。
- 启动路径：物化两个 bundle 的客户端半边 → `apply`（stub ctx）→ 断言本包**只**注册 `plugins.row.config`、键为 `@jedeiah/turn-notifier#turn-notifier`；turn-notifier **只**注册 `conversation.composer.dock` 的 `turn-notifier-alert`、**不再**注册 `plugins.row.config`；再用 stub `{ state, mutate }` 渲染本包的行页，断言树非空且三组标题齐全。
- 字典：`t('…')` 用到的键与内联 zh/en 字典逐键比对，零缺失、零冗余。
- 探针不随包提供（与仓库其它插件一致，包内不放测试代码）。
