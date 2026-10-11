# 给 bundle 写离线自测

**日期**：2026-10-11
**参考**：`session-purge/selftest.mjs`（这个仓库里最早的样板）

## 要解决什么

bundle 的 `index.js` 顶部常有裸导入，而 **clone 出来的仓库没有自己的 `node_modules`**
（profile 是 `link:` 过来的，dsh 自带包由应用自己的解析器路由；profile 的 `node_modules` 里
也只有 `@jedeiah` 和 `dsh-purge`，没有 `@deepseek-ai`）。

于是 `node selftest.mjs` 里直接 `import('./index.js')` 会：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-typert-protocol'
```

**不能**为了跑测试去装 node_modules —— 那太荒谬了。

## 解法：`module.register` 把裸导入锚到安装目录

Node 的模块定制钩子可以**只改解析、不动文件系统**：

```js
import { register } from 'node:module';

const app = '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return next(specifier, { ...context, parentURL: ${JSON.stringify(`file://${app}/`)} });
  }
  return next(specifier, context);
}
`), import.meta.url);

const host = await import(join(here, 'index.js'));   // 现在能解析了
```

loader 用 `data:` URL 内联，**不落任何文件**。`parentURL` 指向安装目录后，
`next()` 会从那里向上找 `node_modules`，命中 `@deepseek-ai/*`。

配合 `--app <path>` 参数（默认就是上面那个路径）让别的机器能改；目录不存在时打印 `skip`
并**以 0 退出**（不是失败）。

## 仓库惯例（照 `session-purge/selftest.mjs`）

```js
let failures = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

const root = mkdtempSync(join(tmpdir(), '<包名>-selftest-'));
try { /* ... */ } finally { rmSync(root, { recursive: true, force: true }); }

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
```

- **只写临时目录**，不碰仓库里任何东西（尤其**不要碰 bundle 真正的 `skills-live/`**）。
- **`package.json` 不写 `scripts`** —— 直接手跑：
  ```bash
  ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" <插件>/selftest.mjs
  ```

## 让纯函数可测：给它注入点

要让测试驱动 `syncLiveSkills` 而不动 bundle 自己的目录，它得接受可选的目录覆盖：

```js
function syncLiveSkills(enabled, { liveDir = SKILLS_LIVE_DIR, sourceDir = SKILLS_SOURCE_DIR } = {}) {
  ...
}
```

生产调用不带第二参，测试传 `mkdtempSync` 出来的临时目录。同时把它从 `index.js` **导出**。

## 可以拿官方包做真校验

组合包的手写 Typert manifest 能直接过安装自带的校验器：

```js
const { validateTypertManifest } = await import(join(app, 'dsh-typert-loader', 'lib', 'index.js'));
validateTypertManifest('@jedeiah/<包名>', TYPERT);
```

## 值得覆盖的几条（都是实际踩过的坑）

以 `chrome-devtools-mcp` / `rea-dsh` 的 `selftest.mjs` 为例（各 14 项）：

1. **`CONFIG_DEFAULTS` 确实是从 schema 读出来的**，不是手抄的 —— 直接断言它的值。
2. **schema 自己的默认与 `CONFIG_DEFAULTS` 一致**：
   ```js
   const validated = host.Config['~standard'].validate({});
   const plain = (v) => (typeof v?.get === 'function' ? v.get() : v);
   check('…', plain(validated.value.skills) === host.CONFIG_DEFAULTS.skills);
   ```
3. **`.volatile()` 确实是活句柄** —— `typeof validated.value.skills?.get === 'function'`。
   这条守着 `readConfigValue` 存在的理由，防止有人"简化"掉它。
4. **`syncLiveSkills` 的开关往返**：关 → 目录**存在且为空**；开 → **是软链**；重复调用不变。
5. **源目录缺失不是错误**（返回空失败列表）。
6. **TYPERT 过官方校验器**。

第 1 条尤其值钱：它守着一个**静默失效**的坑 —— 如果 `schemaDefaults` 读不出默认值，
`CONFIG_DEFAULTS` 会变成空表，默认值全丢而没有任何症状。
