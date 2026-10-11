# bundle 写作要点：路径、默认值、安装形态

**日期**：2026-10-11

写 dsh 组合包时几个**反直觉且静默失败**的地方。都是在真机上验证过的，不是推断。

## 1. `ctx.baseUrl` 指向 **profile 目录**，不是 bundle 目录

在 patch 里用 `!!js` 推导自身路径时，最容易犯的错就是往 `ctx.baseUrl` 上直接拼：

```yaml
# ❌ 指向一个不存在的空目录，技能静默消失，没有任何报错
customSkillDirs:
  - !!js |- 
    process.getBuiltinModule('node:path').join(new URL(ctx.baseUrl).pathname, 'skills')
```

实测（dsh 0.2.0-rc.2，patch 由本地 link 的 bundle 提供）：

```
ctx.baseUrl = file://<DSH_HOME>/profiles/desktop/     ← profile 目录！
Object.keys(ctx) === ['fiber']                        ← ctx 上只有 fiber
```

**正确做法**：以 profile 为锚点解析出本包的真实安装位置 —— 与 dsh 自己的 preset patch 同一手法：

```js
const pkgDir = path.dirname(
  createRequire(String(ctx.baseUrl ?? '')).resolve('@jedeiah/<包名>/package.json'),
);
```

### 为什么裸 `baseUrl` 和 `ctx.baseUrl` 都能用

官方 preset 里写的是裸 `baseUrl`（不带 `ctx.`）。**两者等价**，不是巧合：

`!!js` 由 `new Function("ctx", "expr", "with (ctx) { return eval(expr) }")` 求值。
`with` 的 `has` 陷阱对未知属性返回 `false`，于是标识符 `ctx` 落回**函数参数**（Context 实例）。
所以 `baseUrl` 和 `ctx.baseUrl` 指的是同一个东西。**但推荐写 `ctx.baseUrl`**，意图更清楚。

`!!js` 里可用的东西：`process`、`process.getBuiltinModule('node:fs' | 'node:path' | 'node:module' | 'node:os')`、`fetch`、`globalThis`、`ctx`。
**ESM 下不要用 `require`**，用 `process.getBuiltinModule`。

## 2. schemastery 的默认值可以从 schema 自己读出来

想避免"默认值写两份"（schema 的 `.default()` 和代码里的兜底表各写一遍、改一处漏一处）时，
可以从 schema 自取 —— 但要**知道 `toJSON()` 的真实形状**：

```js
const json = schema.toJSON();
// ❗ dict 挂在【根节点】上，顶层没有 dict
const root = json?.refs?.[json?.uid] ?? json;
for (const [field, uid] of Object.entries(root?.dict ?? {})) {
  const node = json?.refs?.[uid];
  if (node?.meta !== undefined && 'default' in node.meta) out[field] = node.meta.default;
}
```

实测 `S.object({ skills: S.boolean().default(false).volatile() }).toJSON()`：

```json
{"uid": 3,
 "refs": {"2": {"type": "boolean", "meta": {"default": false, "volatile": true}},
          "3": {"type": "object",  "meta": {"default": {}}, "dict": {"skills": 2}}}}
```

三个要点：

- **`dict` 在 `refs[uid]` 那个节点上，顶层没有。** 第一版实现写了 `json?.dict`，结果**返回空表、
  默认值静默全丢**。靠函数里的"读不到就 `console.warn`"当场发现的 —— **这种自取默认值的函数
  一定要带空结果告警**。
- **`.volatile()` 字段不能靠校验 `{}` 取默认值**：`schema({})` 给的是**活句柄**（`{}`），不是值。
  只能走 `meta.default`。
- 校验会填默认，但 volatile 字段仍是句柄，要解包：
  ```js
  const plain = (v) => (typeof v?.get === 'function' ? v.get() : v);
  ```
- `dsh-settings` 投影行表单用的就是同一个序列化（`form.toJSON()`），所以这是**公开形状**。

**为什么必须有 `readConfigValue`**：volatile 字段直接读会拿到**句柄对象**（永远为真），
不是配置值。要 `.get()` 解包，且失败时不能静默装作是默认值 —— 传 `onError` 出去报警。

## 3. 安装 spec 的形态（`dsh-plugin-manager` 的 `parseInstallSpec`）

| 形式 | 例子 | 装出来是什么 |
|---|---|---|
| **GitHub 子目录** | `github:Jedeiah/dsh-plugins#path:turn-notifier` | git 依赖（克隆整仓取子目录），**锁定到当时 commit** |
| git URL | `git+https://github.com/u/r.git#path:X` | 同上 |
| 本地路径 | `/abs/path`、`link:/abs/path`、`file:/abs/path` | `link:` 软链（**不能移动目录**） |
| 压缩包 | `./pkg.tgz`、`https://…/pkg.tgz` | 解压副本 |
| npm 包名 | `@scope/name@1.2.3` | registry 安装 |

实测：`github:Jedeiah/dsh-plugins#path:chrome-devtools-mcp` 在 pnpm 12.11.2 上正确解析，
lockfile 记 `path: chrome-devtools-mcp`、`version: 1.2.0`。
**`#path:` 后不带前导斜杠**最稳。

**前置检查**：安装前会 `git ls-remote` 查 GitHub 可达性（默认 5s 超时），并在 pnpm 之前做
**DSH peer 兼容性检查** —— 本地路径/registry spec 能提前判定，**git/tarball spec 必须先抓取，
所以只在安装后判定**（不兼容则恢复 manifest + lockfile 并重装）。

## 4. `dsh plugin` CLI

```bash
dsh plugin --profile <名字> add "<spec>"      # 剩余参数原样转发给 pnpm
dsh plugin --profile <名字> remove @scope/name
```

参数在 profile 目录里转发给 pnpm，`add` / `remove` / `why` / `ls` 都能用。**会真的改 profile。**

坑（本机）：
- `/usr/local/bin/dsh` **缺少可执行位**（`-rw-r--r--`），直接调报 `Permission denied`。
  用 `sh /usr/local/bin/dsh plugin --profile <名字> add "<spec>"` 绕过。
- 它需要**有效的 cwd**（内部调 `process.cwd()`），删掉当前目录会报 `ENOENT: uv_cwd`。

## 5. 其它

- **`locale/{zh,en}.json`** 的结构必须是 `{"meta": {"title", "description"}}`。
- **从 dsh 安装目录 import 的包必须写进 `peerDependencies`**，否则裸导入 `ERR_MODULE_NOT_FOUND`。
- **客户端半边别写 `immediately: true`**，除非真的需要启动期预取 —— 它会把这一行划进 bootstrap
  阶段，而 bootstrap 条目无法被动态移除/替换。
- **停用再启用带客户端半边的插件，`apply` 不保证重跑**（[deepseek-harness#8452](https://github.com/deepseek-ai/deepseek-harness/discussions/8452)）。
  规避：把配置页注册放进 `ctx.inject(['remote.<本插件自己的服务>', …], cb)` 依赖门里 ——
  Host 半边重建会让依赖消失又出现，门于是重开、页面重新挂上。
