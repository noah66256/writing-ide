/**
 * MCP Client Manager — Desktop Electron main process
 *
 * 管理 MCP Server 连接、工具发现和调用。
 * 支持 stdio / streamable-http / sse 三种传输。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** @typedef {"disconnected"|"connecting"|"connected"|"error"} McpStatus */

/**
 * @typedef {Object} McpServerConfig
 * @property {string} id
 * @property {string} name
 * @property {"stdio"|"streamable-http"|"sse"} transport
 * @property {boolean} enabled
 * @property {string} [command]     - stdio 专用
 * @property {string[]} [args]      - stdio 专用
 * @property {Record<string,string>} [env] - stdio 专用
 * @property {string} [endpoint]    - http/sse 专用
 * @property {Record<string,string>} [headers] - http/sse 专用
 */

export class McpManager {
  /** @param {string} userDataPath - app.getPath('userData') */
  constructor(userDataPath) {
    /** @type {string} */
    this._configPath = path.join(userDataPath, "mcp-servers.json");
    /** @type {Map<string, {config: McpServerConfig, client: Client|null, transport: any, status: McpStatus, tools: any[], error: string|null}>} */
    this._servers = new Map();
    /** @type {Set<(payload: any) => void>} */
    this._listeners = new Set();
    /** @type {Record<string, string>} 全局环境变量，自动注入到所有 stdio MCP Server */
    this._globalEnv = {};
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
    try {
      const raw = await fs.readFile(this._configPath, "utf-8");
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
    } catch {
      // 文件不存在或解析失败，使用空配置
    }
  }

  async _saveConfig() {
    const list = [...this._servers.values()].map((s) => s.config);
    const tmp = this._configPath + `.tmp.${Date.now()}`;
    await fs.mkdir(path.dirname(this._configPath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(list, null, 2), "utf-8");
    await fs.rename(tmp, this._configPath);
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
      const command = String(config.command ?? "").trim();
      if (!command) throw new Error("STDIO_COMMAND_REQUIRED");
      const args = Array.isArray(config.args) ? config.args.map(String) : [];
      // 构建环境变量：process.env → 全局注入（浏览器等） → 用户显式配置（优先级最高）
      const baseEnv = { ...process.env };
      // 注入全局浏览器路径等环境变量
      const browserPath = this._globalEnv?.BROWSER_PATH || "";
      if (browserPath) {
        baseEnv.KINDLY_BROWSER_EXECUTABLE_PATH ??= browserPath;
        baseEnv.CHROME_PATH ??= browserPath;
        baseEnv.BROWSER_PATH ??= browserPath;
      }
      const userEnv = config.env && typeof config.env === "object" ? config.env : {};
      const env = { ...baseEnv, ...userEnv };
      return new StdioClientTransport({ command, args, env });
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

  // ── 工具操作 ──────────────────────────

  async getTools(serverId) {
    const entry = this._servers.get(serverId);
    if (!entry) return [];
    return entry.tools;
  }

  async callTool(serverId, toolName, args) {
    const entry = this._servers.get(serverId);
    if (!entry?.client) {
      return { ok: false, error: `MCP_NOT_CONNECTED:${serverId}` };
    }
    try {
      const result = await entry.client.callTool({
        name: toolName,
        arguments: args ?? {},
      });
      // MCP 工具返回 content 数组
      const textParts = (result?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text);
      const output = textParts.join("\n") || JSON.stringify(result?.content ?? []);
      const isError = result?.isError === true;
      return { ok: !isError, output, raw: result };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  // ── Server 管理 CRUD ──────────────────────────

  async addServer(config) {
    const id = config?.id || crypto.randomUUID();
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

  async updateServer(id, config) {
    const entry = this._servers.get(id);
    if (!entry) return { ok: false, error: "NOT_FOUND" };
    // 断开旧连接
    await this.disconnect(id);
    entry.config = { ...entry.config, ...config, id };
    await this._saveConfig();
    if (entry.config.enabled) {
      this.connect(id).catch(() => void 0);
    }
    this._notify();
    return { ok: true };
  }

  async removeServer(id) {
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
      status: entry.status,
      tools: entry.tools,
      error: entry.error,
      config: {
        command: entry.config.command,
        args: entry.config.args,
        endpoint: entry.config.endpoint,
        headers: entry.config.headers,
        env: entry.config.env ?? {},
      },
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
