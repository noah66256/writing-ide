import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const STATE_FILE = "marketplace.v1.json";
const MAX_LOGS = 200;

function nowIso() {
  return new Date().toISOString();
}

function normalizeItemId(id) {
  return String(id ?? "").trim();
}

function toSafeSlug(v) {
  const raw = String(v ?? "").trim().toLowerCase();
  return raw.replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "item";
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function createEmptyState() {
  return {
    version: 1,
    installed: {},
    logs: [],
  };
}

export class MarketplaceManager {
  /**
   * @param {{
   *   userDataPath: string;
   *   getMcpManager: ()=>any;
   *   getSkillLoader: ()=>any;
   *   reloadSkillsAndBroadcast: ()=>Promise<void>;
   * }} args
   */
  constructor(args) {
    this._userDataPath = String(args?.userDataPath ?? "");
    this._statePath = path.join(this._userDataPath, STATE_FILE);
    this._getMcpManager = args?.getMcpManager ?? (() => null);
    this._getSkillLoader = args?.getSkillLoader ?? (() => null);
    this._reloadSkillsAndBroadcast = args?.reloadSkillsAndBroadcast ?? (async () => void 0);
  }

  async getInstalled() {
    const state = await this._loadState();
    const list = Object.values(state.installed ?? {})
      .sort((a, b) => String(b?.installedAt ?? "").localeCompare(String(a?.installedAt ?? "")));
    return { ok: true, installed: list };
  }

  async getLogs() {
    const state = await this._loadState();
    const logs = Array.isArray(state.logs) ? state.logs : [];
    return { ok: true, logs: logs.slice(0, MAX_LOGS) };
  }

  async install(pkg) {
    const startedAt = Date.now();
    const manifest = pkg?.manifest && typeof pkg.manifest === "object" ? pkg.manifest : null;
    const payload = pkg?.payload;
    if (!manifest) return { ok: false, error: "MANIFEST_REQUIRED" };
    const itemId = normalizeItemId(manifest.id);
    const itemType = String(manifest.type ?? "").trim();
    const version = String(manifest.version ?? "").trim();
    if (!itemId || !itemType || !version) return { ok: false, error: "MANIFEST_INVALID" };

    const state = await this._loadState();
    try {
      let meta = {};
      if (itemType === "skill") {
        meta = await this._installSkill(manifest, payload);
      } else if (itemType === "mcp_server") {
        meta = await this._installMcpServer(manifest, payload);
      } else if (itemType === "sub_agent") {
        meta = await this._installSubAgent(manifest, payload);
      } else {
        throw new Error(`UNSUPPORTED_ITEM_TYPE:${itemType}`);
      }
      const installed = {
        itemId,
        type: itemType,
        name: String(manifest.name ?? itemId),
        version,
        source: String(manifest.source ?? "official"),
        installedAt: nowIso(),
        meta,
      };
      state.installed[itemId] = installed;
      this._appendLog(state, {
        action: "install",
        itemId,
        type: itemType,
        version,
        ok: true,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      await this._saveState(state);
      return { ok: true, installed };
    } catch (e) {
      this._appendLog(state, {
        action: "install",
        itemId,
        type: itemType,
        version,
        ok: false,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: String(e?.message ?? e),
      });
      await this._saveState(state).catch(() => void 0);
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  async uninstall(itemIdRaw) {
    const startedAt = Date.now();
    const itemId = normalizeItemId(itemIdRaw);
    if (!itemId) return { ok: false, error: "ITEM_ID_REQUIRED" };
    const state = await this._loadState();
    const installed = state.installed?.[itemId];
    if (!installed) return { ok: true, removed: false };
    try {
      if (installed.type === "skill") {
        await this._uninstallSkill(installed);
      } else if (installed.type === "mcp_server") {
        await this._uninstallMcpServer(installed);
      } else if (installed.type === "sub_agent") {
        await this._uninstallSubAgent(installed);
      }
      delete state.installed[itemId];
      this._appendLog(state, {
        action: "uninstall",
        itemId,
        type: String(installed.type ?? ""),
        version: String(installed.version ?? ""),
        ok: true,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      await this._saveState(state);
      return { ok: true, removed: true };
    } catch (e) {
      this._appendLog(state, {
        action: "uninstall",
        itemId,
        type: String(installed.type ?? ""),
        version: String(installed.version ?? ""),
        ok: false,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: String(e?.message ?? e),
      });
      await this._saveState(state).catch(() => void 0);
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  async _installSkill(manifest, payload) {
    const p = payload && typeof payload === "object" ? payload : null;
    if (!p || p.kind !== "skill") throw new Error("SKILL_PAYLOAD_INVALID");
    const files = p.files && typeof p.files === "object" ? p.files : null;
    const entries = files ? Object.entries(files) : [];
    if (entries.length === 0) throw new Error("SKILL_FILES_EMPTY");

    const loader = this._getSkillLoader();
    const rootDir = loader?.rootDir ? String(loader.rootDir) : path.join(this._userDataPath, "skills");
    await fs.mkdir(rootDir, { recursive: true });

    const skillId = String(p.skillId ?? manifest.id ?? "").trim() || String(manifest.id ?? "");
    const skillDirName = toSafeSlug(skillId);
    const targetDir = path.join(rootDir, skillDirName);
    const tmpDir = path.join(rootDir, `.${skillDirName}.tmp-${Date.now()}`);
    const backupDir = path.join(rootDir, `.${skillDirName}.bak-${Date.now()}`);
    let movedBackup = false;
    let movedTmp = false;
    try {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => void 0);
      await fs.mkdir(tmpDir, { recursive: true });
      for (const [rawRel, rawContent] of entries) {
        const rel = this._normalizeSkillRelativePath(rawRel);
        const abs = path.join(tmpDir, ...rel.split("/"));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, String(rawContent ?? ""), "utf-8");
      }

      if (await this._exists(targetDir)) {
        await fs.rm(backupDir, { recursive: true, force: true }).catch(() => void 0);
        await fs.rename(targetDir, backupDir);
        movedBackup = true;
      }

      await fs.rename(tmpDir, targetDir);
      movedTmp = true;
      await this._reloadSkillsAndBroadcast();
      if (movedBackup) await fs.rm(backupDir, { recursive: true, force: true }).catch(() => void 0);
      return { skillId, skillDirName };
    } catch (e) {
      if (!movedTmp) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => void 0);
      if (movedTmp) await fs.rm(targetDir, { recursive: true, force: true }).catch(() => void 0);
      if (movedBackup) await fs.rename(backupDir, targetDir).catch(() => void 0);
      throw e;
    }
  }

  async _uninstallSkill(installed) {
    const loader = this._getSkillLoader();
    const rootDir = loader?.rootDir ? String(loader.rootDir) : path.join(this._userDataPath, "skills");
    const skillDirName = String(installed?.meta?.skillDirName ?? "").trim();
    if (!skillDirName) throw new Error("SKILL_DIR_MISSING");
    const targetDir = path.join(rootDir, skillDirName);
    await fs.rm(targetDir, { recursive: true, force: true });
    await this._reloadSkillsAndBroadcast();
  }

  async _installMcpServer(manifest, payload) {
    const p = payload && typeof payload === "object" ? payload : null;
    if (!p || p.kind !== "mcp_server" || !p.config || typeof p.config !== "object") {
      throw new Error("MCP_PAYLOAD_INVALID");
    }
    const mgr = this._getMcpManager();
    if (!mgr) throw new Error("MCP_NOT_READY");

    const serverId = String(p.serverId ?? `market.${toSafeSlug(manifest.id)}`).trim();
    const prev = (mgr.getServers?.() ?? []).find((x) => String(x?.id ?? "") === serverId) ?? null;
    const prevCfg = prev ? this._serverStateToConfig(prev) : null;
    const cfg = deepClone(p.config);
    cfg.id = serverId;
    cfg.name = String(cfg.name ?? manifest.name ?? serverId).trim() || serverId;
    cfg.transport = String(cfg.transport ?? "stdio").trim() || "stdio";
    if (cfg.enabled === undefined) cfg.enabled = true;

    const isStdio = cfg.transport === "stdio";
    if (isStdio && !cfg.command && !(cfg.bundled && cfg.modulePath)) {
      throw new Error("MCP_STDIO_COMMAND_REQUIRED");
    }
    if ((cfg.transport === "sse" || cfg.transport === "streamable-http") && !cfg.endpoint) {
      throw new Error("MCP_ENDPOINT_REQUIRED");
    }

    let applied = false;
    try {
      if (prevCfg) {
        const ret = await mgr.updateServer(serverId, cfg);
        if (!ret?.ok) throw new Error(String(ret?.error ?? "MCP_UPDATE_FAILED"));
      } else {
        const ret = await mgr.addServer(cfg);
        if (!ret?.ok) throw new Error(String(ret?.error ?? "MCP_ADD_FAILED"));
      }
      applied = true;
      return { serverId };
    } catch (e) {
      if (applied) {
        // no-op
      } else if (prevCfg) {
        await mgr.updateServer(serverId, prevCfg).catch(() => void 0);
      } else {
        await mgr.removeServer(serverId).catch(() => void 0);
      }
      throw e;
    }
  }

  async _uninstallMcpServer(installed) {
    const serverId = String(installed?.meta?.serverId ?? "").trim();
    if (!serverId) throw new Error("MCP_SERVER_ID_MISSING");
    const mgr = this._getMcpManager();
    if (!mgr) throw new Error("MCP_NOT_READY");
    const ret = await mgr.removeServer(serverId);
    if (ret?.ok === false) throw new Error(String(ret.error ?? "MCP_REMOVE_FAILED"));
  }

  async _installSubAgent(manifest, payload) {
    const p = payload && typeof payload === "object" ? payload : null;
    if (!p || p.kind !== "sub_agent" || !p.agent || typeof p.agent !== "object") {
      throw new Error("SUB_AGENT_PAYLOAD_INVALID");
    }
    const raw = p.agent;
    const rawId = String(raw.id ?? "").trim();
    const agentId = rawId || `custom_market_${toSafeSlug(manifest.id)}`;
    const agentDef = {
      ...deepClone(raw),
      id: agentId,
      name: String(raw.name ?? manifest.name ?? agentId).trim() || agentId,
      description: String(raw.description ?? "").trim() || `${String(raw.name ?? manifest.name ?? "市场子 Agent")}（由 Marketplace 安装）`,
      systemPrompt:
        String(raw.systemPrompt ?? "").trim() ||
        `你是「${String(raw.name ?? manifest.name ?? "子 Agent")}」，请在你的职责范围内完成任务，并严格基于可用工具执行。`,
      tools: Array.isArray(raw.tools) ? raw.tools.map((x) => String(x ?? "").trim()).filter(Boolean) : [],
      skills: Array.isArray(raw.skills) ? raw.skills.map((x) => String(x ?? "").trim()).filter(Boolean) : [],
      mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers.map((x) => String(x ?? "").trim()).filter(Boolean) : [],
      model: String(raw.model ?? "").trim() || "haiku",
      fallbackModels: Array.isArray(raw.fallbackModels)
        ? raw.fallbackModels.map((x) => String(x ?? "").trim()).filter(Boolean)
        : [],
      toolPolicy: ["readonly", "proposal_first", "auto_apply"].includes(String(raw.toolPolicy ?? ""))
        ? String(raw.toolPolicy)
        : "readonly",
      budget: raw.budget && typeof raw.budget === "object"
        ? {
            maxTurns: Number.isFinite(Number(raw.budget.maxTurns))
              ? Math.max(1, Math.min(30, Math.floor(Number(raw.budget.maxTurns))))
              : 8,
            maxToolCalls: Number.isFinite(Number(raw.budget.maxToolCalls))
              ? Math.max(1, Math.min(100, Math.floor(Number(raw.budget.maxToolCalls))))
              : 16,
            timeoutMs: Number.isFinite(Number(raw.budget.timeoutMs))
              ? Math.max(5000, Math.min(300000, Math.floor(Number(raw.budget.timeoutMs))))
              : 180000,
          }
        : { maxTurns: 8, maxToolCalls: 16, timeoutMs: 180000 },
      triggerPatterns: Array.isArray(raw.triggerPatterns)
        ? raw.triggerPatterns.map((x) => String(x ?? "").trim()).filter(Boolean)
        : [],
      priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 50,
      enabled: Boolean(raw.enabled ?? true),
      version: String(raw.version ?? manifest.version ?? "1.0.0"),
    };
    return { agentId, agentDef };
  }

  async _uninstallSubAgent(_installed) {
    return;
  }

  _serverStateToConfig(server) {
    return {
      id: String(server?.id ?? ""),
      name: String(server?.name ?? ""),
      transport: String(server?.transport ?? "stdio"),
      enabled: Boolean(server?.enabled),
      bundled: Boolean(server?.bundled),
      command: server?.config?.command,
      args: Array.isArray(server?.config?.args) ? [...server.config.args] : [],
      modulePath: server?.config?.modulePath,
      endpoint: server?.config?.endpoint,
      headers: server?.config?.headers && typeof server.config.headers === "object" ? deepClone(server.config.headers) : undefined,
      env: server?.config?.env && typeof server.config.env === "object" ? deepClone(server.config.env) : undefined,
      configFields: Array.isArray(server?.configFields) ? deepClone(server.configFields) : undefined,
    };
  }

  _normalizeSkillRelativePath(raw) {
    const s = String(raw ?? "")
      .replace(/\\/g, "/")
      .trim();
    if (!s || s.startsWith("/") || s.includes("\0")) throw new Error("SKILL_FILE_PATH_INVALID");
    const norm = path.posix.normalize(s);
    if (!norm || norm === "." || norm.startsWith("../") || norm.includes("/../")) {
      throw new Error("SKILL_FILE_PATH_ESCAPE");
    }
    return norm;
  }

  _appendLog(state, log) {
    if (!Array.isArray(state.logs)) state.logs = [];
    state.logs.unshift({
      id: crypto.randomUUID(),
      at: nowIso(),
      ...log,
    });
    if (state.logs.length > MAX_LOGS) state.logs = state.logs.slice(0, MAX_LOGS);
  }

  async _exists(p) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async _loadState() {
    try {
      const raw = await fs.readFile(this._statePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return createEmptyState();
      const state = createEmptyState();
      state.installed = parsed.installed && typeof parsed.installed === "object" ? parsed.installed : {};
      state.logs = Array.isArray(parsed.logs) ? parsed.logs : [];
      return state;
    } catch {
      return createEmptyState();
    }
  }

  async _saveState(state) {
    const data = state && typeof state === "object" ? state : createEmptyState();
    const tmpPath = `${this._statePath}.tmp.${Date.now()}`;
    await fs.mkdir(path.dirname(this._statePath), { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmpPath, this._statePath);
  }
}
