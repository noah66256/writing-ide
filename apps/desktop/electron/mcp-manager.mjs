/**
 * MCP Client Manager — Desktop Electron main process
 *
 * 管理 MCP Server 连接、工具发现和调用。
 * 支持 stdio / streamable-http / sse 三种传输。
 * 支持 bundled server（随应用打包，通过 ELECTRON_RUN_AS_NODE 启动）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

/** @typedef {"disconnected"|"connecting"|"connected"|"error"} McpStatus */

/**
 * @typedef {Object} McpServerConfig
 * @property {string} id
 * @property {string} name
 * @property {"stdio"|"streamable-http"|"sse"} transport
 * @property {boolean} enabled
 * @property {string} [command]      - stdio 专用（非 bundled 时必填）
 * @property {string[]} [args]       - stdio 专用
 * @property {boolean} [bundled]     - stdio 专用：是否为内置 server（通过 ELECTRON_RUN_AS_NODE 启动）
 * @property {string} [modulePath]   - stdio 专用：bundled=true 时的入口脚本（相对 app root）
 * @property {boolean} [builtin]     - 是否为不可删除的预置 server
 * @property {Record<string,string>} [env] - stdio 专用
 * @property {string} [endpoint]     - http/sse 专用
 * @property {Record<string,string>} [headers] - http/sse 专用
 */

/** 内置 MCP Server 清单 */
const BUILTIN_SERVERS = [
  {
    id: "playwright",
    name: "Playwright 浏览器自动化",
    transport: "stdio",
    bundled: true,
    builtin: true,
    modulePath: "node_modules/@playwright/mcp/cli.js",
    args: ["--browser", "chrome"],
    enabled: true,
  },
  {
    id: "bocha-search",
    name: "博查搜索（国内）",
    transport: "stdio",
    bundled: true,
    builtin: true,
    modulePath: "electron/mcp-servers/bocha-search.mjs",
    args: [],
    enabled: false,
    configFields: [
      {
        envKey: "BOCHA_API_KEY",
        label: "博查 API Key",
        placeholder: "sk-...",
        helpUrl: "https://open.bochaai.com",
        helpText: "前往博查AI开放平台获取",
        required: true,
      },
    ],
  },
  {
    id: "web-search",
    name: "Web Search（国际）",
    transport: "stdio",
    bundled: true,
    builtin: true,
    modulePath: "electron/mcp-servers/web-search.mjs",
    args: [],
    enabled: false,
    configFields: [
      {
        envKey: "SERPER_API_KEY",
        label: "Serper API Key",
        placeholder: "串号...",
        helpUrl: "https://serper.dev",
        helpText: "推荐，Google 搜索结果",
        required: false,
      },
      {
        envKey: "TAVILY_API_KEY",
        label: "Tavily API Key",
        placeholder: "tvly-...",
        helpUrl: "https://tavily.com",
        helpText: "备选搜索服务",
        required: false,
      },
    ],
  },
];

/** 参数别名组（按规范名聚类，运行时用于 MCP 工具参数兜底映射） */
const ARG_ALIAS_GROUPS = [
  ["filename", "file_name", "fileName", "path", "filepath", "filePath", "file"],
  ["query", "q", "keyword", "keywords"],
  ["url", "uri", "link", "href"],
];

const RUNTIME_INSTALL_PLAN_BY_COMMAND = {
  uv: { id: "uv", label: "uv/uvx", commands: ["uv", "uvx"] },
  uvx: { id: "uv", label: "uv/uvx", commands: ["uv", "uvx"] },
};

/**
 * 归一化参数键名：仅用于匹配，不改变原始键名。
 * @param {string} key
 * @returns {string}
 */
function normalizeArgKey(key) {
  return String(key ?? "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/**
 * 从参数校验错误文本中提取“缺失参数/未知参数”线索。
 * 兼容常见 pydantic 文本格式。
 * @param {string} text
 * @returns {{missing:string[], unexpected:string[]}}
 */
function extractArgValidationSignals(text) {
  const raw = String(text ?? "");
  const missing = [];
  const unexpected = [];
  const missRe = /(?:^|\n)([A-Za-z_][A-Za-z0-9_]*)\n\s+Missing required argument/gi;
  const unexpRe = /(?:^|\n)([A-Za-z_][A-Za-z0-9_]*)\n\s+Unexpected keyword argument/gi;
  let m = null;
  while ((m = missRe.exec(raw)) !== null) missing.push(String(m[1] ?? ""));
  while ((m = unexpRe.exec(raw)) !== null) unexpected.push(String(m[1] ?? ""));
  return {
    missing: [...new Set(missing.filter(Boolean))],
    unexpected: [...new Set(unexpected.filter(Boolean))],
  };
}

export class McpManager {
  /**
   * @param {string} userDataPath - app.getPath('userData')
   * @param {string} [appBasePath] - app.getAppPath()
   * @param {boolean} [isPackaged] - app.isPackaged
   * @param {string} [appDataPath] - app.getPath('appData')，用于跨版本迁移旧配置
   */
  constructor(userDataPath, appBasePath = process.cwd(), isPackaged = false, appDataPath = null) {
    /** @type {string} */
    this._configPath = path.join(userDataPath, "mcp-servers.json");
    this._userDataPath = String(userDataPath || "");
    this._appBasePath = String(appBasePath || process.cwd());
    this._isPackaged = Boolean(isPackaged);
    /** @type {string|null} app.getPath('appData') 父目录，用于迁移 */
    this._appDataPath = appDataPath ? String(appDataPath) : null;
    /** @type {Map<string, {config: McpServerConfig, client: Client|null, transport: any, status: McpStatus, tools: any[], error: string|null}>} */
    this._servers = new Map();
    /** @type {Set<(payload: any) => void>} */
    this._listeners = new Set();
    /** @type {Record<string, string>} 全局环境变量，自动注入到所有 stdio MCP Server */
    this._globalEnv = {};
  }

  _isWindows() {
    return process.platform === "win32";
  }

  _runtimePlatformArchKey() {
    return `${process.platform}-${process.arch}`;
  }

  _runtimeBinDirs() {
    const key = this._runtimePlatformArchKey();
    const dirs = [];

    // 用户可写 runtime（用于一键修复脚本落盘）
    if (this._userDataPath) {
      dirs.push(path.join(this._userDataPath, "mcp-runtime", "bin"));
    }

    // 开发模式：项目内 runtime
    dirs.push(path.join(this._appBasePath, "electron", "mcp-runtime", key, "bin"));

    // 打包模式：app.asar.unpacked runtime
    const unpackedBase = this._replaceAsarWithUnpacked(this._appBasePath);
    dirs.push(path.join(unpackedBase, "electron", "mcp-runtime", key, "bin"));

    // 打包模式兜底（某些场景 appBase 在 Resources/app.asar）
    const resourcesDir = path.resolve(this._appBasePath, "..");
    const resourcesUnpacked = this._replaceAsarWithUnpacked(resourcesDir);
    dirs.push(path.join(resourcesUnpacked, "electron", "mcp-runtime", key, "bin"));

    return [...new Set(dirs.map((d) => path.normalize(String(d || ""))).filter(Boolean))];
  }

  _knownUserBinDirs() {
    const home = String(process.env.HOME || process.env.USERPROFILE || "").trim();
    const out = [];
    if (home) {
      out.push(path.join(home, ".local", "bin"));
      out.push(path.join(home, ".cargo", "bin"));
    }
    return [...new Set(out.map((d) => path.normalize(String(d || ""))).filter(Boolean))];
  }

  _managedPathDirs() {
    return [...new Set([...this._runtimeBinDirs(), ...this._knownUserBinDirs()])];
  }

  _splitPathList(rawPath) {
    return String(rawPath ?? "")
      .split(path.delimiter)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  async _resolveCommandInDirs(command, dirs) {
    const cmd = String(command ?? "").trim();
    if (!cmd) return null;

    const extCandidates = this._isWindows()
      ? (() => {
          const pathext = String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD");
          const list = pathext
            .split(";")
            .map((x) => x.trim())
            .filter(Boolean);
          return ["", ...list];
        })()
      : [""];

    for (const dir of dirs) {
      const base = String(dir ?? "").trim();
      if (!base) continue;
      for (const ext of extCandidates) {
        const candidate = path.join(base, `${cmd}${ext}`);
        if (await this._pathExists(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  }

  async _resolveStdioCommand(command, extraPathDirs, systemPathRaw = process.env.PATH ?? "") {
    const raw = String(command ?? "").trim();
    if (!raw) return null;

    // 绝对/相对路径直接按文件判断
    const looksLikePath = raw.includes(path.sep) || raw.includes("/") || raw.includes("\\");
    if (looksLikePath) {
      const abs = path.resolve(raw);
      if (await this._pathExists(abs)) return { resolved: abs, source: "explicit" };
      if (await this._pathExists(raw)) return { resolved: raw, source: "explicit" };
      return null;
    }

    // 优先：内置/用户 runtime bin
    const runtimeResolved = await this._resolveCommandInDirs(raw, extraPathDirs);
    if (runtimeResolved) return { resolved: runtimeResolved, source: "bundled" };

    // 次选：系统 PATH
    const systemDirs = this._splitPathList(systemPathRaw);
    const systemResolved = await this._resolveCommandInDirs(raw, systemDirs);
    if (systemResolved) return { resolved: systemResolved, source: "system" };

    return null;
  }

  _composePathWithRuntime(basePath, runtimeDirs) {
    const exists = new Set();
    const merged = [];
    const push = (p) => {
      const v = String(p ?? "").trim();
      if (!v) return;
      if (exists.has(v)) return;
      exists.add(v);
      merged.push(v);
    };
    for (const d of runtimeDirs) push(d);
    for (const d of this._splitPathList(basePath)) push(d);
    return merged.join(path.delimiter);
  }

  _extractCommandHead(command) {
    const raw = String(command ?? "").trim();
    if (!raw) return "";
    const m = raw.match(/"[^"]*"|'[^']*'|[^\s]+/);
    if (!m?.[0]) return "";
    return m[0].replace(/^['"]|['"]$/g, "").trim();
  }

  async getRuntimeHealth(opts = {}) {
    const runtimeDirs = this._runtimeBinDirs();
    const managedPath = this._composePathWithRuntime(process.env.PATH ?? "", this._managedPathDirs());
    const requested = Array.isArray(opts?.commands)
      ? opts.commands.map((x) => this._extractCommandHead(String(x ?? ""))).filter(Boolean)
      : [];
    const stdioCommands = [...new Set(
      [...this._servers.values()]
        .map((entry) => entry?.config)
        .filter((cfg) => cfg?.transport === "stdio" && cfg?.bundled !== true)
        .map((cfg) => this._extractCommandHead(String(cfg?.command ?? "")))
        .filter(Boolean),
    )];
    const baseline = requested.length > 0 ? [] : ["uv", "uvx", "node", "npm", "npx", "python", "python3"];
    const commands = [...new Set([...requested, ...baseline, ...stdioCommands])];
    const checks = [];
    for (const cmd of commands) {
      const resolved = await this._resolveStdioCommand(cmd, runtimeDirs, managedPath);
      const plan = RUNTIME_INSTALL_PLAN_BY_COMMAND[String(cmd ?? "").toLowerCase()] ?? null;
      checks.push({
        command: cmd,
        ok: Boolean(resolved?.resolved),
        source: resolved?.source ?? "missing",
        path: resolved?.resolved ?? null,
        installable: Boolean(plan),
        planId: plan?.id ?? null,
      });
    }
    return {
      ok: true,
      platform: `${process.platform}-${process.arch}`,
      runtimeDirs,
      managedPathDirs: this._managedPathDirs(),
      checks,
    };
  }

  _installPlanForCommand(command) {
    const key = String(command ?? "").trim().toLowerCase();
    return RUNTIME_INSTALL_PLAN_BY_COMMAND[key] ?? null;
  }

  async _runProcess(command, args, opts = {}) {
    const timeoutMs = Number(opts?.timeoutMs ?? 180000);
    const env = opts?.env && typeof opts.env === "object" ? opts.env : process.env;
    return await new Promise((resolve) => {
      const child = spawn(command, Array.isArray(args) ? args : [], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, Math.max(1000, timeoutMs));
      child.stdout?.on("data", (d) => { stdout += String(d ?? ""); });
      child.stderr?.on("data", (d) => { stderr += String(d ?? ""); });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${String(e?.message ?? e)}`, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ ok: !timedOut && Number(code) === 0, code: Number(code ?? -1), stdout, stderr, timedOut });
      });
    });
  }

  async _installUvRuntime() {
    const userRuntimeRoot = this._userDataPath ? path.join(this._userDataPath, "mcp-runtime") : "";
    if (!userRuntimeRoot) return { ok: false, error: "USER_DATA_PATH_MISSING" };
    await fs.mkdir(userRuntimeRoot, { recursive: true }).catch(() => void 0);
    const baseEnv = { ...process.env, UV_INSTALL_DIR: userRuntimeRoot };

    if (process.platform === "win32") {
      return await this._runProcess(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"],
        { timeoutMs: 180000, env: baseEnv },
      );
    }

    return await this._runProcess(
      "sh",
      ["-lc", "curl -fsSL https://astral.sh/uv/install.sh | sh"],
      { timeoutMs: 180000, env: baseEnv },
    );
  }

  async _installRuntimeByPlan(planId) {
    if (planId === "uv") return this._installUvRuntime();
    return { ok: false, error: `UNSUPPORTED_INSTALL_PLAN:${planId}` };
  }

  async repairRuntime(opts = {}) {
    const ret = {
      ok: true,
      changed: false,
      actions: [],
      installs: [],
      unsupportedMissing: [],
      health: null,
    };
    const requested = Array.isArray(opts?.commands)
      ? opts.commands.map((x) => this._extractCommandHead(String(x ?? ""))).filter(Boolean)
      : [];
    const initial = await this.getRuntimeHealth({ commands: requested });
    const missing = (Array.isArray(initial?.checks) ? initial.checks : []).filter((c) => !c.ok);
    const attemptedPlanIds = new Set();
    for (const miss of missing) {
      const plan = this._installPlanForCommand(miss.command);
      if (!plan) {
        ret.unsupportedMissing.push(miss.command);
        continue;
      }
      if (attemptedPlanIds.has(plan.id)) continue;
      attemptedPlanIds.add(plan.id);
      const startedAt = Date.now();
      const installRet = await this._installRuntimeByPlan(plan.id);
      ret.installs.push({
        planId: plan.id,
        label: plan.label,
        ok: Boolean(installRet?.ok),
        timedOut: Boolean(installRet?.timedOut),
        durationMs: Math.max(0, Date.now() - startedAt),
        error: installRet?.ok ? null : String(installRet?.error ?? installRet?.stderr ?? `exit=${installRet?.code ?? -1}`),
      });
      if (installRet?.ok) {
        ret.changed = true;
        ret.actions.push(`installed_${plan.id}`);
      }
    }

    const userRuntimeDir = this._userDataPath ? path.join(this._userDataPath, "mcp-runtime", "bin") : "";
    if (userRuntimeDir) {
      await fs.mkdir(userRuntimeDir, { recursive: true }).catch(() => void 0);
    }

    // 在 user runtime 下补一个 uvx shim（仅当 uv 可用且 uvx 缺失）
    if (userRuntimeDir) {
      const runtimeDirs = this._runtimeBinDirs();
      const managedPath = this._composePathWithRuntime(process.env.PATH ?? "", this._managedPathDirs());
      const uv = await this._resolveStdioCommand("uv", runtimeDirs, managedPath);
      const uvx = await this._resolveStdioCommand("uvx", runtimeDirs, managedPath);
      if (uv?.resolved && !uvx?.resolved) {
        if (this._isWindows()) {
          const uvxCmd = path.join(userRuntimeDir, "uvx.cmd");
          const content = "@echo off\r\nuv tool run %*\r\n";
          await fs.writeFile(uvxCmd, content, "utf-8");
          ret.changed = true;
          ret.actions.push("created_uvx_cmd_shim");
        } else {
          const uvxSh = path.join(userRuntimeDir, "uvx");
          const content = "#!/usr/bin/env sh\nexec uv tool run \"$@\"\n";
          await fs.writeFile(uvxSh, content, "utf-8");
          await fs.chmod(uvxSh, 0o755).catch(() => void 0);
          ret.changed = true;
          ret.actions.push("created_uvx_shim");
        }
      }
    }

    ret.health = await this.getRuntimeHealth({ commands: requested });
    return ret;
  }

  /**
   * 设置全局环境变量（如浏览器路径），会自动注入到所有 stdio MCP Server 进程。
   * 用户在单个 Server 的 env 中显式设置的值会覆盖全局值。
   * 传 null/空字符串的 value 会删除该 key。
   * @param {Record<string, string | null>} env
   */
  setGlobalEnv(env) {
    for (const [k, v] of Object.entries(env)) {
      if (v === null || v === undefined || v === "") {
        delete this._globalEnv[k];
      } else {
        this._globalEnv[k] = v;
      }
    }
  }

  // ── Config 持久化 ──────────────────────────

  async loadConfig() {
    let fileExists = false;
    try {
      const raw = await fs.readFile(this._configPath, "utf-8");
      fileExists = true;
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : [];
      for (const cfg of list) {
        if (!cfg?.id || !cfg?.name) continue;
        this._servers.set(cfg.id, {
          config: cfg,
          client: null,
          transport: null,
          status: "disconnected",
          tools: [],
          error: null,
        });
      }
    } catch (e) {
      if (fileExists) {
        // JSON 解析失败，记录错误但不覆盖文件
        console.error("[McpManager] 配置文件解析失败，跳过写回:", e?.message);
      }
      // 文件不存在则尝试从旧路径迁移，迁移失败再正常继续（_ensureBuiltinServers 会创建）
      if (!fileExists) await this._tryMigrateLegacyConfig();
    }
    // 加载后注入内置 server（已存在的不覆盖）
    await this._ensureBuiltinServers();
  }

  /**
   * 当 mcp-servers.json 不存在时，尝试从旧 productName 路径迁移配置（一次性）。
   * 覆盖场景：productName 从 "写作IDE" 改为 "WritingIDE" 后 userData 路径变化。
   */
  async _tryMigrateLegacyConfig() {
    if (!this._appDataPath) return;
    // 历史 productName 列表，按优先级排列
    const legacyNames = ["写作IDE", "writing-ide", "Electron"];
    for (const name of legacyNames) {
      const legacyPath = path.join(this._appDataPath, name, "mcp-servers.json");
      try {
        const raw = await fs.readFile(legacyPath, "utf-8");
        JSON.parse(raw); // 验证 JSON 格式，解析失败则跳过
        await fs.mkdir(path.dirname(this._configPath), { recursive: true });
        await fs.writeFile(this._configPath, raw, "utf-8");
        console.log(`[McpManager] 已迁移 MCP 配置：${legacyPath} → ${this._configPath}`);
        // 重新解析迁移过来的文件
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data : [];
        for (const cfg of list) {
          if (!cfg?.id || !cfg?.name) continue;
          this._servers.set(cfg.id, {
            config: cfg, client: null, transport: null,
            status: "disconnected", tools: [], error: null,
          });
        }
        return; // 迁移成功，不再尝试其他路径
      } catch {
        // 路径不存在或格式错误，继续尝试下一个
      }
    }
  }

  async _saveConfig() {
    // skillManaged server 由 SkillLoader 管理，不持久化
    const list = [...this._servers.values()]
      .filter((s) => !s.config.skillManaged)
      .map((s) => s.config);
    const tmp = this._configPath + `.tmp.${Date.now()}`;
    await fs.mkdir(path.dirname(this._configPath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(list, null, 2), "utf-8");
    await fs.rename(tmp, this._configPath);
  }

  // ── 内置 Server 注册 ──────────────────────────

  /** 确保所有内置 server 存在于配置中，并回填/锁定核心字段 */
  async _ensureBuiltinServers() {
    let changed = false;
    for (const builtin of BUILTIN_SERVERS) {
      const existing = this._servers.get(builtin.id);
      if (!existing) {
        // 不存在则注入
        this._servers.set(builtin.id, {
          config: { ...builtin },
          client: null,
          transport: null,
          status: "disconnected",
          tools: [],
          error: null,
        });
        changed = true;
      } else {
        // 已存在：回填/锁定核心字段（防止手改配置文件破坏）
        const cfg = existing.config;
        let patched = false;
        for (const key of ["bundled", "builtin", "modulePath", "transport", "configFields"]) {
          if (JSON.stringify(cfg[key]) !== JSON.stringify(builtin[key])) {
            cfg[key] = builtin[key];
            patched = true;
          }
        }
        if (patched) changed = true;
      }
    }
    if (changed) await this._saveConfig();
  }

  /** 按 BUILTIN_SERVERS 常量判断，不依赖配置文件中的 flag */
  _isBuiltinId(id) {
    return BUILTIN_SERVERS.some((b) => b.id === id);
  }

  // ── 连接管理 ──────────────────────────

  async connectEnabled() {
    const tasks = [];
    for (const [id, entry] of this._servers) {
      if (entry.config.enabled) {
        tasks.push(this.connect(id).catch(() => void 0));
      }
    }
    await Promise.allSettled(tasks);
  }

  /** 重连所有已连接的 stdio 类型 server（全局环境变量变更后调用） */
  async reconnectStdioServers() {
    const tasks = [];
    for (const [id, entry] of this._servers) {
      if (entry.config.transport === "stdio" && entry.status === "connected") {
        tasks.push(
          this.disconnect(id)
            .then(() => this.connect(id))
            .catch(() => void 0),
        );
      }
    }
    await Promise.allSettled(tasks);
  }

  async connect(serverId) {
    const entry = this._servers.get(serverId);
    if (!entry) throw new Error(`MCP_SERVER_NOT_FOUND:${serverId}`);
    if (entry.status === "connected" || entry.status === "connecting") return;

    entry.status = "connecting";
    entry.error = null;
    this._notify();

    try {
      const transport = await this._createTransport(entry.config);
      const client = new Client(
        { name: "writing-ide-desktop", version: "1.0.0" },
        { capabilities: {} },
      );

      await client.connect(transport);

      // 获取工具列表
      let tools = [];
      try {
        const result = await client.listTools();
        tools = (result?.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? null,
        }));
      } catch {
        // 某些 server 不支持 tools/list
      }

      entry.client = client;
      entry.transport = transport;
      entry.status = "connected";
      entry.tools = tools;
      entry.error = null;
      this._notify();
    } catch (e) {
      entry.status = "error";
      entry.error = String(e?.message ?? e);
      entry.client = null;
      entry.transport = null;
      this._notify();
      throw e;
    }
  }

  async disconnect(serverId) {
    const entry = this._servers.get(serverId);
    if (!entry) return;
    try {
      await entry.client?.close?.();
    } catch {
      // ignore
    }
    entry.client = null;
    entry.transport = null;
    entry.status = "disconnected";
    entry.tools = [];
    entry.error = null;
    this._notify();
  }

  async _createTransport(config) {
    const type = config.transport;

    if (type === "stdio") {
      const bundled = config?.bundled === true;
      const args = Array.isArray(config.args) ? config.args.map(String) : [];

      // 构建环境变量：process.env → 全局注入 → 用户显式配置（优先级最高）
      const baseEnv = { ...process.env };
      // 注入全局环境变量（浏览器路径等）
      for (const [k, v] of Object.entries(this._globalEnv ?? {})) {
        if (v) baseEnv[k] ??= v;
      }
      const browserPath = this._globalEnv?.BROWSER_PATH || "";
      if (browserPath) {
        baseEnv.KINDLY_BROWSER_EXECUTABLE_PATH ??= browserPath;
        baseEnv.CHROME_PATH ??= browserPath;
        baseEnv.BROWSER_PATH ??= browserPath;
      }
      const userEnv = config.env && typeof config.env === "object" ? config.env : {};
      const runtimeDirs = this._runtimeBinDirs();
      baseEnv.PATH = this._composePathWithRuntime(baseEnv.PATH ?? "", this._managedPathDirs());
      const env = { ...baseEnv, ...userEnv };

      // ── bundled server：通过 ELECTRON_RUN_AS_NODE 用 Electron 自身的 Node 运行 ──
      if (bundled) {
        const modulePath = String(config.modulePath ?? "").trim();
        if (!modulePath) throw new Error("STDIO_BUNDLED_MODULE_PATH_REQUIRED");
        const resolvedEntry = await this._resolveBundledModulePath(modulePath);
        env.ELECTRON_RUN_AS_NODE = "1";
        return new StdioClientTransport({
          command: process.execPath,
          args: [resolvedEntry, ...args],
          env,
        });
      }

      // ── 普通 stdio server：用户指定 command ──
      const command = String(config.command ?? "").trim();
      if (!command) throw new Error("STDIO_COMMAND_REQUIRED");
      const resolved = await this._resolveStdioCommand(command, runtimeDirs, env.PATH ?? "");
      if (!resolved?.resolved) {
        throw new Error(`STDIO_COMMAND_NOT_FOUND:${command}`);
      }
      return new StdioClientTransport({ command: resolved.resolved, args, env });
    }

    if (type === "streamable-http") {
      const endpoint = String(config.endpoint ?? "").trim();
      if (!endpoint) throw new Error("HTTP_ENDPOINT_REQUIRED");
      const url = new URL(endpoint);
      const headers = config.headers && typeof config.headers === "object" ? config.headers : {};
      return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    }

    if (type === "sse") {
      const endpoint = String(config.endpoint ?? "").trim();
      if (!endpoint) throw new Error("SSE_ENDPOINT_REQUIRED");
      const url = new URL(endpoint);
      return new SSEClientTransport(url);
    }

    throw new Error(`UNKNOWN_TRANSPORT:${type}`);
  }

  // ── Bundled 路径解析 ──────────────────────────

  /**
   * 将 app.asar 路径替换为 app.asar.unpacked（asarUnpack 提取后的真实路径）
   * @param {string} targetPath
   * @returns {string}
   */
  _replaceAsarWithUnpacked(targetPath) {
    const normalized = path.normalize(targetPath);
    const asarSegment = `${path.sep}app.asar${path.sep}`;
    if (normalized.includes(asarSegment)) {
      return normalized.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
    }
    if (normalized.endsWith(`${path.sep}app.asar`)) {
      return `${normalized}.unpacked`;
    }
    return normalized;
  }

  /**
   * 解析 bundled server 的入口脚本真实磁盘路径。
   * 打包模式下优先查找 app.asar.unpacked/，开发模式下直接用 appBasePath。
   * @param {string} modulePath - 相对 app root 的路径，如 "node_modules/@playwright/mcp/cli.js"
   * @returns {Promise<string>}
   */
  async _resolveBundledModulePath(modulePath) {
    const raw = String(modulePath ?? "").trim();
    if (!raw) throw new Error("STDIO_BUNDLED_MODULE_PATH_REQUIRED");

    const appBase = path.resolve(this._appBasePath || process.cwd());
    const candidates = [];

    if (this._isPackaged) {
      // 打包后：app.asar 内的路径不能被 spawn，只尝试 app.asar.unpacked
      const fromAppBase = path.isAbsolute(raw) ? raw : path.resolve(appBase, raw);
      candidates.push(this._replaceAsarWithUnpacked(fromAppBase));
      // 兼顾 process.resourcesPath（Windows/Mac 均可用）
      if (typeof process.resourcesPath === "string") {
        candidates.push(path.resolve(process.resourcesPath, "app.asar.unpacked", raw));
      }
      // 打包模式下不回退到 app.asar（spawn 必定失败），直接用 unpacked 候选
    } else {
      // ── 开发环境 ──
      // app.getAppPath() 在 `electron <file>` 模式下返回入口脚本所在目录，
      // 而非 package.json 所在的项目根。例如 main.cjs 在 electron/ 子目录时，
      // appBase = ".../apps/desktop/electron/"，modulePath = "electron/mcp-servers/..."
      // 会拼出 ".../electron/electron/mcp-servers/..."（双重 electron）。
      // 因此需要多组候选覆盖这种情况。

      if (path.isAbsolute(raw)) {
        candidates.push(raw);
      } else {
        // 候选 1：直接拼接
        candidates.push(path.resolve(appBase, raw));
        // 候选 2：父目录（覆盖 appBase 多了一层子目录的场景）
        candidates.push(path.resolve(appBase, "..", raw));
        // 候选 3：appBase 已是 "electron" 且 raw 以 "electron/" 开头时去重
        if (path.basename(appBase).toLowerCase() === "electron" && raw.startsWith("electron/")) {
          candidates.push(path.resolve(appBase, raw.slice("electron/".length)));
        }
      }

      // monorepo 场景：依赖可能被提升到上层 node_modules，通过模块解析查找
      if (raw.startsWith("node_modules/")) {
        const resolveRoots = [...new Set([appBase, path.resolve(appBase, "..")])];
        const withoutNM = raw.replace(/^node_modules\//, ""); // "@playwright/mcp/cli.js"
        const parts = withoutNM.startsWith("@")
          ? withoutNM.split("/").slice(0, 2) // scoped: ["@playwright", "mcp"]
          : withoutNM.split("/").slice(0, 1); // unscoped: ["some-pkg"]
        const pkgName = parts.join("/");
        const subPath = withoutNM.slice(pkgName.length + 1); // "cli.js"

        for (const root of resolveRoots) {
          try {
            const require = createRequire(path.join(root, "package.json"));
            const pkgEntry = require.resolve(pkgName);
            const pkgDir = path.dirname(pkgEntry);
            candidates.push(subPath ? path.resolve(pkgDir, subPath) : pkgEntry);
          } catch {
            // require.resolve 失败，继续用其他候选
          }
        }
      }
    }

    // 去重后依次验证
    const deduped = [...new Set(candidates.map((p) => path.normalize(p)))];

    console.info("[McpManager] resolving bundled module", {
      raw, isPackaged: this._isPackaged, appBase, candidates: deduped,
    });

    for (const candidate of deduped) {
      if (await this._pathExists(candidate)) {
        console.info("[McpManager] bundled module resolved →", candidate);
        return candidate;
      }
    }

    console.error("[McpManager] bundled module NOT FOUND", {
      raw, isPackaged: this._isPackaged, appBase, cwd: process.cwd(), tried: deduped,
    });
    throw new Error(`STDIO_BUNDLED_MODULE_NOT_FOUND:${raw} (tried: ${deduped.join(", ")})`);
  }

  /** @param {string} filePath */
  async _pathExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // ── 工具操作 ──────────────────────────

  async getTools(serverId) {
    const entry = this._servers.get(serverId);
    if (!entry) return [];
    return entry.tools;
  }

  /**
   * 读取工具 schema 元信息。
   * @param {{tools:any[]}} entry
   * @param {string} toolName
   */
  _getToolSchemaMeta(entry, toolName) {
    const tools = Array.isArray(entry?.tools) ? entry.tools : [];
    const tool = tools.find((t) => String(t?.name ?? "") === String(toolName ?? ""));
    const schema =
      tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : null;
    const required = Array.isArray(schema?.required)
      ? schema.required.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    const properties =
      schema?.properties && typeof schema.properties === "object"
        ? Object.keys(schema.properties).map((x) => String(x ?? "").trim()).filter(Boolean)
        : [];
    const schemaKeys = new Set([...required, ...properties]);
    const orderedTargets = [...required, ...properties.filter((k) => !required.includes(k))];
    return { schemaKeys, orderedTargets };
  }

  /**
   * 依据工具 schema 做参数兜底映射（如 path -> filename）。
   * 默认优先 required；若 required 为空则回退到 properties。
   * @param {{tools:any[]}} entry
   * @param {string} toolName
   * @param {any} rawArgs
   * @param {{preferredTargets?: string[]}} [opts]
   * @returns {{args: Record<string, any>, rewrites: Array<{from:string,to:string,reason:string}>, schemaKeys: Set<string>}}
   */
  _normalizeToolArgs(entry, toolName, rawArgs, opts = {}) {
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? { ...rawArgs }
        : {};
    const rewrites = [];

    const meta = this._getToolSchemaMeta(entry, toolName);
    const targets = (Array.isArray(opts.preferredTargets) ? opts.preferredTargets : [])
      .map((x) => String(x ?? "").trim())
      .filter((x) => meta.schemaKeys.has(x));
    const orderedTargets = targets.length > 0 ? targets : meta.orderedTargets;
    if (!orderedTargets.length) return { args, rewrites, schemaKeys: meta.schemaKeys };

    /** @type {Map<string,string>} */
    const argKeyByNorm = new Map();
    for (const key of Object.keys(args)) argKeyByNorm.set(normalizeArgKey(key), key);

    for (const reqKey of orderedTargets) {
      const hasReq = Object.prototype.hasOwnProperty.call(args, reqKey);
      if (hasReq) continue;

      const reqNorm = normalizeArgKey(reqKey);
      const group = ARG_ALIAS_GROUPS.find((g) =>
        g.map((x) => normalizeArgKey(x)).includes(reqNorm),
      );
      if (!group) continue;

      const aliasNorms = group.map((x) => normalizeArgKey(x));
      const sourceNorm = aliasNorms.find((n) => n !== reqNorm && argKeyByNorm.has(n));
      if (!sourceNorm) continue;

      const sourceKey = argKeyByNorm.get(sourceNorm);
      if (!sourceKey) continue;
      const value = args[sourceKey];
      if (value === undefined || value === null || String(value).trim() === "") continue;

      args[reqKey] = value;
      rewrites.push({ from: sourceKey, to: reqKey, reason: "required_alias_fallback" });
      argKeyByNorm.set(reqNorm, reqKey);

      // 若来源键不在 schema 中，删除以避免 strict server 报 unexpected keyword。
      if (!meta.schemaKeys.has(sourceKey)) {
        delete args[sourceKey];
        rewrites.push({ from: sourceKey, to: reqKey, reason: "drop_non_schema_source" });
        argKeyByNorm.delete(sourceNorm);
      }
    }

    return { args, rewrites, schemaKeys: meta.schemaKeys };
  }

  /**
   * 基于错误文本进行一次性重试参数修复。
   * @param {{tools:any[]}} entry
   * @param {string} toolName
   * @param {Record<string, any>} attemptedArgs
   * @param {string} errorText
   */
  _buildRetryArgsFromError(entry, toolName, attemptedArgs, errorText) {
    const signals = extractArgValidationSignals(errorText);
    if (!signals.missing.length && !signals.unexpected.length) return null;

    const normalized = this._normalizeToolArgs(entry, toolName, attemptedArgs, {
      preferredTargets: signals.missing,
    });
    const args = { ...normalized.args };
    const rewrites = [...normalized.rewrites];

    // 显式删除报错中的未知字段（且确实不在 schema 中）
    for (const key of signals.unexpected) {
      if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
      if (normalized.schemaKeys.has(key)) continue;
      delete args[key];
      rewrites.push({ from: key, to: "", reason: "drop_unexpected_key_on_retry" });
    }

    const before = JSON.stringify(attemptedArgs ?? {});
    const after = JSON.stringify(args ?? {});
    if (before === after) return null;

    return { args, rewrites, signals };
  }

  /**
   * 单次调用 MCP 工具。
   * @param {{client:any}} entry
   * @param {string} toolName
   * @param {Record<string, any>} callArgs
   */
  async _callToolOnce(entry, toolName, callArgs) {
    const result = await entry.client.callTool({
      name: toolName,
      arguments: callArgs ?? {},
    });
    const textParts = (result?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    const output = textParts.join("\n") || JSON.stringify(result?.content ?? []);
    const isError = result?.isError === true;
    return { ok: !isError, output, raw: result };
  }

  async callTool(serverId, toolName, args) {
    const entry = this._servers.get(serverId);
    if (!entry?.client) {
      return { ok: false, error: `MCP_NOT_CONNECTED:${serverId}` };
    }
    try {
      const normalized = this._normalizeToolArgs(entry, toolName, args);
      if (normalized.rewrites.length > 0) {
        console.info("[McpManager] tool args normalized", {
          serverId,
          toolName,
          rewrites: normalized.rewrites,
        });
      }
      const first = await this._callToolOnce(entry, toolName, normalized.args);
      if (first.ok) {
        return {
          ...first,
          ...(normalized.rewrites.length > 0 ? { normalizedArgs: normalized.rewrites } : {}),
        };
      }

      // 单次重试：仅在检测到参数校验问题时触发。
      const retryPlan = this._buildRetryArgsFromError(
        entry,
        toolName,
        normalized.args,
        String(first.output ?? ""),
      );
      if (!retryPlan) {
        return {
          ...first,
          ...(normalized.rewrites.length > 0 ? { normalizedArgs: normalized.rewrites } : {}),
        };
      }

      console.info("[McpManager] tool args retry-normalized", {
        serverId,
        toolName,
        signals: retryPlan.signals,
        rewrites: retryPlan.rewrites,
      });
      const second = await this._callToolOnce(entry, toolName, retryPlan.args);
      const allRewrites = [...normalized.rewrites, ...retryPlan.rewrites];
      return {
        ...second,
        retried: true,
        retrySignals: retryPlan.signals,
        ...(allRewrites.length > 0 ? { normalizedArgs: allRewrites } : {}),
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  // ── Server 管理 CRUD ──────────────────────────

  async addServer(config) {
    const id = config?.id || crypto.randomUUID();
    // 禁止通过 addServer 覆盖内置 server
    if (this._isBuiltinId(id)) {
      return { ok: false, error: "BUILTIN_ID_RESERVED" };
    }
    const name = String(config?.name ?? "").trim() || `Server ${id.slice(0, 6)}`;
    const transport = config?.transport ?? "stdio";
    const enabled = config?.enabled !== false;
    const full = { ...config, id, name, transport, enabled };
    this._servers.set(id, {
      config: full,
      client: null,
      transport: null,
      status: "disconnected",
      tools: [],
      error: null,
    });
    await this._saveConfig();
    if (enabled) {
      this.connect(id).catch(() => void 0);
    }
    this._notify();
    return { ok: true, id };
  }

  // ── Skill-managed Server（由 SkillLoader 管理，不持久化） ──

  /**
   * 注册 skill-managed MCP server。不持久化到 mcp-servers.json。
   * 如果同 id 已存在且也是 skillManaged，先断开再更新。
   * @param {McpServerConfig & {skillManaged:true, skillId:string}} config
   */
  async addSkillServer(config) {
    const id = config?.id;
    if (!id) return { ok: false, error: "ID_REQUIRED" };
    if (this._isBuiltinId(id)) return { ok: false, error: "BUILTIN_ID_RESERVED" };

    const existing = this._servers.get(id);
    if (existing) {
      // 只允许覆盖 skillManaged 的
      if (!existing.config.skillManaged) return { ok: false, error: "ID_CONFLICT_USER_SERVER" };
      await this.disconnect(id);
    }

    const full = { ...config, enabled: true, skillManaged: true };
    this._servers.set(id, {
      config: full,
      client: null,
      transport: null,
      status: "disconnected",
      tools: [],
      error: null,
    });
    // 不调用 _saveConfig()
    // 等待连接完成（而非 fire-and-forget），避免竞态孤儿连接
    await this.connect(id).catch(() => void 0);
    this._notify();
    return { ok: true, id };
  }

  /**
   * 移除 skill-managed MCP server。
   * @param {string} id
   */
  async removeSkillServer(id) {
    const entry = this._servers.get(id);
    if (!entry || !entry.config.skillManaged) return { ok: false, error: "NOT_SKILL_MANAGED" };
    await this.disconnect(id);
    this._servers.delete(id);
    // 不调用 _saveConfig()
    this._notify();
    return { ok: true };
  }

  async updateServer(id, config) {
    const entry = this._servers.get(id);
    if (!entry) return { ok: false, error: "NOT_FOUND" };
    // 断开旧连接
    await this.disconnect(id);
    // builtin server 的核心字段不可修改（按常量判断，不依赖配置 flag）
    if (this._isBuiltinId(id)) {
      delete config.id;
      delete config.bundled;
      delete config.builtin;
      delete config.modulePath;
      delete config.transport;
    }
    entry.config = { ...entry.config, ...config, id };
    await this._saveConfig();
    if (entry.config.enabled) {
      this.connect(id).catch(() => void 0);
    }
    this._notify();
    return { ok: true };
  }

  async removeServer(id) {
    if (this._isBuiltinId(id)) {
      return { ok: false, error: "BUILTIN_SERVER_CANNOT_BE_REMOVED" };
    }
    await this.disconnect(id);
    this._servers.delete(id);
    await this._saveConfig();
    this._notify();
    return { ok: true };
  }

  // ── 状态查询 ──────────────────────────

  getServers() {
    return [...this._servers.values()].map((entry) => ({
      id: entry.config.id,
      name: entry.config.name,
      transport: entry.config.transport,
      enabled: entry.config.enabled,
      bundled: entry.config.bundled === true,
      builtin: entry.config.builtin === true,
      skillManaged: entry.config.skillManaged === true,
      skillId: entry.config.skillId || null,
      status: entry.status,
      tools: entry.tools,
      error: entry.error,
      config: {
        command: entry.config.command,
        args: entry.config.args,
        modulePath: entry.config.modulePath,
        endpoint: entry.config.endpoint,
        headers: entry.config.headers,
        env: entry.config.env ?? {},
        skillDigest: entry.config.skillDigest || null,
      },
      ...(entry.config.configFields ? { configFields: entry.config.configFields } : {}),
    }));
  }

  // ── 事件通知 ──────────────────────────

  onStatusChange(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  _notify() {
    const payload = this.getServers();
    for (const fn of this._listeners) {
      try { fn(payload); } catch { /* ignore */ }
    }
  }

  // ── 清理 ──────────────────────────

  async dispose() {
    for (const [id] of this._servers) {
      await this.disconnect(id).catch(() => void 0);
    }
  }
}
