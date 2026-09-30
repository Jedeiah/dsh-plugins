# @local/chrome-devtools-mcp

A **configuration-only dsh bundle** that connects the
[`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp) server to this
Harness profile through the shipped `@deepseek-ai/dsh-mcp-client` bridge.

It exists so the MCP connection is a managed bundle (installed / enabled / removed from the
**Plugins** page) instead of a hand-written row in the profile's `cordis.patch.yml`.

## Files

| File | Role |
|---|---|
| `package.json` | Bundle manifest; `dsh.bundle.patch` points at the patch below |
| `cordis.patch.yml` | Inserts one `dsh-mcp-client` row (`serverName: chrome-devtools`) |
| `locale/{en,zh}.json` | Title and description shown on the Plugins card |
| `icon.svg` | Card artwork |

There is no `index.js`: the bundle carries configuration only, so it has no Host code.

## How it connects

```yaml
serverName: chrome-devtools
transport: stdio
command: npx
args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect', '--no-usage-statistics', '--no-performance-crux']
```

`npx` is resolved from the host `PATH`, so this needs node/npm installed and npm registry
access on first run. The package is cached under `~/.npm/_npx/`, so later starts reuse it.
Tools appear to the model as `mcp__chrome-devtools__<tool>`.

## Install / remove

Install through the Plugins page, or with the `plugin_manager` tool:

- install: `action: install_bundle`, `target: <absolute path of this directory>`
- remove: `action: remove_bundle`, `target: @local/chrome-devtools-mcp`

**Keep this directory in place.** `install_bundle` links the profile to this path rather than
copying it, so moving or deleting the directory breaks the bundle.

## Changing the settings

Edit `cordis.patch.yml` here, then toggle the bundle off/on (or restart Harness) to
recompose. The file lives outside the profile, so it is not watched by HMR.
