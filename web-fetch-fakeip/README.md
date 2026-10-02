# @jedeiah/web-fetch-fakeip

**开着本地 TUN 代理时，让 dsh 的 `web_fetch` 继续可用。**

## 它解决什么

dsh 的 `web_fetch` 要求域名解析结果必须是**全球可达的单播地址**，否则拒绝：

```
URL hostname "api.github.com" resolves to a non-public IP address
```

而 Clash / Shadowrocket 在 TUN 模式下用 **fake-ip**：所有域名都被解析成
`198.18.0.0/15`（RFC 2544 基准测试保留段）里的虚拟地址，应用连这些假 IP 时再由代理拦截、
按域名转发。于是**开着代理时每一次抓取都被拒**，关掉代理才正常。

## 它怎么解决（不重写、不抄逻辑）

内置提供方的构造函数**第二个参数就是它的地址解析器**：

```js
constructor(limits, resolveAddresses = publicHttpNetwork.resolve) { … }
```

所以本插件只替换这一个协作者，**判定权完全留在官方那边**：

```
官方解析器先判 → 通过 ⇒ 直接用（官方永远权威）
              → 拒绝 ⇒ 仅当拒绝码是 WEB_BLOCKED_URL
                        且解析结果**每一个地址都落在 allowRanges 内** ⇒ 放行
                        否则 ⇒ 原样抛出官方错误（fail closed）
```

插件里**没有任何一行上游策略**——"哪些地址算公网"这件事一行都没抄。插件只贡献一条
**属于它自己配置**的语义：这些地址是我本地代理发的。

下列行为**全部是官方实现**，一行没改：URL 策略、**只跟随同源重定向**、错误码、字节/字符/
超时上限、**按 charset 解码**、连接固定（防 DNS rebinding）、代理路由（`proxyRouteFor`）。

## 官方改了判定怎么办？——这次有答案

这是本方案最重要的性质。三层保障：

| 上游变化 | 后果 |
|---|---|
| **改了"哪些地址算公网"的策略**（新增拦截段、改 NAT64 规则…） | **自动生效** ✅ 因为判定是官方解析器做的，插件不参与 |
| **改了构造签名**（不再接受注入解析器） | **启动即报错**，不是静默失效 ✅ 插件在注册前自检：<br>`if (provider.resolveAddresses !== resolver) throw new Error('HttpFetchProvider 不再接受注入解析器 — 本插件需要更新')` |
| **改了拒绝的错误码**（不再叫 `WEB_BLOCKED_URL`） | **fail closed**：回退不触发 → 抓取被拒（**响亮失败**），绝不静默放行 ✅ |

也就是说：**能自动跟上的自动跟上；跟不上的会报错，不会偷偷把防护改回旧版。**

## 防护有没有被削弱？—— 四条性质已实测

拿**官方解析器**（`new HttpFetchProvider(limits).resolveAddresses`）当基准，对 40 个地址
字面量（含 v4-mapped / NAT64 / 6to4 / v4-compatible 等历史坑）逐条对比：

| 性质 | 结果 |
|---|---|
| ① `allowRanges` 为空时，判定与官方**逐条一致** | **40/40 一致** ✅ |
| ② 放行模式下，被放行的**恰好只有**配置段内的地址 | 仅 `198.18.0.18`、`198.19.5.5`、`[198.18.0.18]`、`::ffff:198.18.0.18` ✅ |
| ③ **有界性**：凡是我放行而官方拒绝的，地址必落在配置段内 | 放大路径共 4 个地址，全部在 `198.18.0.0/15` 内 ✅ |
| ④ 其余拒绝场景**原样抛出官方错误** | `127.0.0.1`、`::ffff:7f00:1`、`64:ff9b::c0a8:101`、`2002:7f00:1::`、`169.254.169.254`、`2001:db8::1` 全部 `WEB_BLOCKED_URL` ✅ |

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `allowRanges` | `198.18.0.0/15` | 额外接受的地址段（逗号/空格分隔的 CIDR）；**空串 = 完全等于内置策略** |
| `maxResponseBytes` | `5000000` | 响应主体字节上限 |
| `maxBodyChars` | `100000` | 解码后字符上限 |
| `timeoutMs` | `30000` | 抓取超时（构造时校验，非法值直接报错） |
| `maxRedirects` | `5` | 同源重定向跳数上限 |
| `userAgent` | `deepseek-harness/…` | 请求头 |

```yaml
- id: web-fetch-fakeip
  config:
    allowRanges: '198.18.0.0/15, 198.19.0.0/16'
```

**改配置会重新加载本插件**（这些字段刻意**没有**声明 `.volatile()`）：上限是在构造提供方时一次性捕获的，
若声明成 volatile 就变成"改配置不重启插件"，于是**改动看起来生效、实际无效**。保持普通字段，改动会
重启 fiber → 新上限一定生效。

**写错 `allowRanges` 不会被静默忽略，而是加载时直接报错并指名 token：**

```
web-fetch-fakeip: allowRanges entries must be IPv4 CIDRs; got "abc"
```

这一点很关键：静默丢弃笔误会让抓取继续被拒，看起来就像"插件根本没起作用"。

## 安装 / 卸载

- 安装：Plugins 页 → Add plugin，或用 `plugin_manager`：`action: install_bundle`，`target: <本目录绝对路径>`
- 卸载：`action: remove_bundle`，`target: @jedeiah/web-fetch-fakeip`

**保持本目录在原位**：`install_bundle` 是软链，移动目录会失效。

⚠️ 本插件的补丁会**同时禁用内置的 `web-fetch-http` 行**。这是必须的——两个抓取提供方同时
注册、又没有配置指定 id 时，web 服务会判定 `WEB_PROVIDER_AMBIGUOUS`，`web_fetch` 会**整体
不可用**。卸载本插件后内置行自动恢复。

## 为什么不打补丁改 dsh 安装包

| | 本插件 | 改 `app/…/dsh-web-fetch-http/lib/index.js` |
|---|---|---|
| 动安装目录 | 不动 | 要动（**破坏 `.app` 代码签名**） |
| dsh 更新 | 不影响 | **被覆盖**，需重打 |
| 判定逻辑 | 官方做，插件不抄 | 手改函数体 |
| 回滚 | 卸载，或 `allowRanges` 清空 | 需要 `.bak` |

## 安全边界（诚实说明）

放行 fake-ip 段的代价是：**基于主机名的内网访问不再被本机拦下**。

fake-ip 模式下，本机看到的所有域名都解析成 `198.18.x.x`，"这个域名会不会指向内网"在本机
已经无法判断——判断权交给了你的代理及其 DNS。

- URL 里**写死的 IP**（`http://192.168.1.1/`、`http://[::ffff:7f00:1]/`、`http://169.254.169.254/`）
  **仍然被拒** ✅（性质 ④ 实测）
- 但 `http://某内网主机名/` 会被放行，由代理去解析 —— 这是**新增的暴露面**

比"全局关掉检查"安全得多，但**不等于零风险**。在意就把 `allowRanges` 清空，回到内置策略。

## 实现注记：为什么用动态导入

`index.js` 对官方提供方用的是 `await import(...)`，**不是**静态 `import`：

```js
let HttpFetchProvider;
try {
  ({ HttpFetchProvider } = await import('@deepseek-ai/dsh-web-fetch-http'));
} catch (error) {
  throw new Error('web-fetch-fakeip: could not import @deepseek-ai/dsh-web-fetch-http', { cause: error });
}
```

**实测（dsh 0.2.0-rc.2）**：在 profile 里以 `link:` 安装的 bundle 中，静态
`import … from '@deepseek-ai/dsh-web-fetch-http'` 会让整个条目**连 fiber 都建不起来**，
诊断只输出一句 `failed to import`（真实原因不打印）；把同一个 specifier 换成模块作用域的
`import()` 就正常。两者之间没有任何其它差异 —— **改回静态导入会立刻复发**。

`schemastery`（`z`）用静态导入没问题（`turn-notifier` 已验证），所以不必一并改。

## 实测结果

| 检查 | 结果 |
|---|---|
| `web_fetch https://example.com/` | **HTTP 200** ✅ |
| `web_fetch https://api.github.com/repos/deepseek-ai/deepseek-harness` | **HTTP 200** ✅ —— 当初报告里**必被拒**的那条 URL |
| `web_fetch http://127.0.0.1:8080/` | **仍被拒** ✅ `resolves to a non-public IP address` |
| 同一时刻 `nslookup example.com` | `198.18.0.79` —— 代理 fake-ip **确实开着** ✅ |

即"开着代理能抓公网"与"内网仍被挡住"**同时成立**。

自动化部分（对 40 个地址字面量与官方解析器逐条对照；这套核对是开发期一次性跑的，脚本未随包提供）：严格模式一致 **40/40** ✅；
放行模式只多放行 fake-ip 段；放大地址**全部在配置段内**；其余场景原样抛官方错误；
`apply` 级校验（非法 CIDR 指名 token、非法上限）全部生效。

```bash
# 复跑语法检查（把 $DSH_APP 指向你的 dsh 应用包——macOS 桌面端就是
# "DeepSeek Harness.app" 所在的目录）
ELECTRON_RUN_AS_NODE=1 "$DSH_APP/Contents/MacOS/DeepSeek Harness" \
  --check "<本目录>/index.js"
```

## 平台

宿主半边只用 `node:dns` / `node:net`，没有平台判断；`web_fetch` 走的是官方抓取提供方的整条流水线，因此三平台行为一致。README 里的复跑命令用 `$DSH_APP` 占位，macOS / Windows / Linux 各自替换成自己的应用路径即可。

## 已知限制

- **只处理 IPv4 fake-ip**。若代理返回 IPv6 fake-ip（罕见），需要把对应段配进 `allowRanges`。
- 抓取仍然**不发送任何凭据**，与内置提供方一致。
- 只跟随同源重定向（继承自内置实现）：跨源跳转需要模型再次调用工具。
- 放行路径会**多解析一次**（官方先解析并拒绝，插件再解析一次确认地址在放行段内）；
  未命中放行段的正常抓取不受影响。
