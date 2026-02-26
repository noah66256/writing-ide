# Bundled MCP Server 路径解析调试指南

## 常见错误

```
STDIO_BUNDLED_MODULE_NOT_FOUND:electron/mcp-servers/web-search.mjs
(tried: /Users/.../apps/desktop/electron/electron/mcp-servers/web-search.mjs)
```

## 根因

**`app.getAppPath()` 在 dev 模式下返回的不是项目根目录。**

当通过 `electron /absolute/path/to/main.cjs` 启动时（见 `scripts/dev-electron.cjs`），
Electron 的 `app.getAppPath()` 返回 **入口脚本所在目录**（即 `electron/`），而非 `package.json` 所在的项目根（`apps/desktop/`）。

这导致：
```
appBasePath = ".../apps/desktop/electron/"
modulePath  = "electron/mcp-servers/web-search.mjs"
resolved    = ".../apps/desktop/electron/electron/mcp-servers/web-search.mjs"  ← 双重 electron!
```

### 为什么 Playwright 没问题？

Playwright 的 `modulePath` 是 `"node_modules/@playwright/mcp/cli.js"`，以 `node_modules/` 开头，
会触发 `createRequire` fallback，通过 Node.js 模块解析算法向上搜索 `node_modules` 目录，
因此能正确找到 monorepo 提升后的依赖位置。

自定义路径（如 `electron/mcp-servers/...`）没有这个 fallback，只有一个候选路径，所以直接失败。

## 修复方案

在 `_resolveBundledModulePath` 的 dev 分支中，对非 `node_modules/` 路径添加多组候选：

| 候选 | 说明 |
|------|------|
| `resolve(appBase, raw)` | 原始逻辑，appBase 正确时直接命中 |
| `resolve(appBase, '..', raw)` | 父目录回退，覆盖 appBase 多了一层子目录 |
| `resolve(appBase, raw.slice('electron/'))` | 当 appBase 本身已是 `electron/` 且 raw 以 `electron/` 开头时去重 |

对 `node_modules/` 路径也扩展了 `createRequire` 的搜索根目录（appBase + 其父目录）。

## 调试日志

修复后 `_resolveBundledModulePath` 会在 Electron 主进程 console 输出：

```
[McpManager] resolving bundled module {
  raw: 'electron/mcp-servers/web-search.mjs',
  isPackaged: false,
  appBase: '/Users/.../apps/desktop/electron',
  candidates: [
    '/Users/.../apps/desktop/electron/electron/mcp-servers/web-search.mjs',
    '/Users/.../apps/desktop/electron/mcp-servers/web-search.mjs',   ← 去重后命中
    ...
  ]
}
[McpManager] bundled module resolved → /Users/.../apps/desktop/electron/mcp-servers/web-search.mjs
```

失败时会额外输出 `console.error` 并包含 `cwd` 信息。

## 新增 Bundled Server 的注意事项

1. **modulePath 格式**：使用相对于 `apps/desktop/` 的路径（如 `electron/mcp-servers/xxx.mjs`），
   不要用绝对路径。路径解析会自动处理 dev/packaged 两种模式的差异。

2. **打包配置**：打包模式下 `_resolveBundledModulePath` 只查找 `app.asar.unpacked` 路径
   （spawn 无法直接访问 asar 内的文件），因此所有 bundled server 脚本**必须**在
   `package.json` 的 `build.asarUnpack` 中声明。当前已配置 `"electron/mcp-servers/**"`。

3. **环境变量**：通过 `config.env` 传入的变量优先级最高（直接 spread 合并），
   `McpManager._globalEnv` 次之，`process.env` 最低。
   注意：UI 层（SettingsModal）在保存时会过滤空字符串值，但 `mcp-manager.mjs` 本身
   不做此过滤——如果通过其他途径（如手动编辑配置文件）写入空字符串，仍会覆盖系统变量。
