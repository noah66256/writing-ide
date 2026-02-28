/**
 * Skill 扩展包加载器（Desktop Electron main process）
 *
 * 职责：
 * 1) 扫描 <userData>/skills/ 下的子文件夹
 * 2) 解析 skill.json manifest + 可选 system-prompt.md / context-prompt.md
 * 3) 校验合法性（含 mcp 字段路径安全检查）
 * 4) fs.watch 热更新（root + 子目录双层 watcher + debounce）
 *
 * 对外输出：
 * - SkillLoader class（start/reload/dispose/onDidChange）
 * - toMcpServerConfig() 转换函数（供 main.cjs 桥接 McpManager）
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ── 常量 ─────────────────────────────────────────

const SKILLS_DIR = "skills";
const MANIFEST_FILE = "skill.json";
const SYSTEM_PROMPT_FILE = "system-prompt.md";
const CONTEXT_PROMPT_FILE = "context-prompt.md";

const VALID_TRIGGER_WHEN = new Set(["has_style_library", "run_intent_in", "mode_in", "text_regex"]);
const VALID_MCP_TRANSPORT = new Set(["stdio", "streamable-http", "sse"]);

/** debounce 延迟（ms），避免批量文件操作触发大量重载 */
const RELOAD_DEBOUNCE_MS = 200;

// ── 工具函数 ─────────────────────────────────────

function norm(v) {
  return String(v ?? "").trim();
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normArr(v, max = 200) {
  return Array.isArray(v) ? v.map(norm).filter(Boolean).slice(0, max) : [];
}

function finiteNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function deepClone(v) {
  if (v == null) return v;
  return JSON.parse(JSON.stringify(v));
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function readText(p) {
  try { return await fsp.readFile(p, "utf-8"); } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * 安全地将相对路径解析为绝对路径，禁止路径穿越。
 * @param {string} base - skill 目录
 * @param {string} rel - 相对路径
 * @param {string} errCode - 错误码
 * @returns {string} 绝对路径
 */
function safeResolve(base, rel, errCode) {
  const raw = norm(rel).replaceAll("\\", "/");
  if (!raw || raw.includes("\0")) throw new Error(errCode);
  if (path.isAbsolute(raw)) throw new Error(errCode);

  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized === "..") throw new Error(errCode);
  if (normalized.startsWith("../") || normalized.includes("/../")) throw new Error(errCode);

  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === "..")) throw new Error(errCode);
  return path.join(base, ...parts);
}

// ── Manifest 校验 ────────────────────────────────

/**
 * 校验并规范化 skill.json 的 mcp 字段。
 * @returns {object|undefined}
 */
function validateMcp(raw, skillDir, skillId) {
  if (raw == null) return undefined;
  if (!isObj(raw)) throw new Error(`SKILL_MCP_INVALID:${skillId}`);

  const serverId = norm(raw.serverId);
  if (!serverId) throw new Error(`SKILL_MCP_SERVER_ID_REQUIRED:${skillId}`);

  const transport = norm(raw.transport);
  if (!VALID_MCP_TRANSPORT.has(transport)) {
    throw new Error(`SKILL_MCP_TRANSPORT_INVALID:${skillId}:${transport || "EMPTY"}`);
  }

  const name = norm(raw.name) || undefined;
  const env = raw.env != null ? validateEnv(raw.env, skillId) : undefined;

  if (transport === "stdio") {
    const entry = norm(raw.entry);
    if (!entry) throw new Error(`SKILL_MCP_ENTRY_REQUIRED:${skillId}`);
    // 路径安全校验（文件存在性在 load 阶段异步检查）
    safeResolve(skillDir, entry, `SKILL_MCP_ENTRY_ESCAPE:${skillId}`);
    return { serverId, name, transport, entry, ...(env ? { env } : {}) };
  }

  // streamable-http / sse
  const endpoint = norm(raw.endpoint);
  if (!endpoint) throw new Error(`SKILL_MCP_ENDPOINT_REQUIRED:${skillId}`);
  try { new URL(endpoint); } catch {
    throw new Error(`SKILL_MCP_ENDPOINT_INVALID:${skillId}`);
  }
  return { serverId, name, transport, endpoint, ...(env ? { env } : {}) };
}

function validateEnv(raw, skillId) {
  if (!isObj(raw)) throw new Error(`SKILL_MCP_ENV_INVALID:${skillId}`);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") throw new Error(`SKILL_MCP_ENV_INVALID:${skillId}`);
    out[norm(k)] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 解析并规范化 skill.json 内容。
 * @param {object} raw - JSON.parse 的结果
 * @param {string} skillDir - skill 文件夹绝对路径
 * @param {string} fallbackId - 文件夹名（作为 id 降级）
 * @returns {object} 规范化的 SkillManifest
 */
function parseManifest(raw, skillDir, fallbackId) {
  if (!isObj(raw)) throw new Error("SKILL_MANIFEST_OBJECT_REQUIRED");

  const id = norm(raw.id) || norm(fallbackId);
  if (!id) throw new Error("SKILL_ID_REQUIRED");

  const name = norm(raw.name);
  if (!name) throw new Error(`SKILL_NAME_REQUIRED:${id}`);

  const description = norm(raw.description) || name;
  const priority = finiteNum(raw.priority, 50);
  const stageKey = norm(raw.stageKey) || `agent.skill.user.${id}`;
  const autoEnable = typeof raw.autoEnable === "boolean" ? raw.autoEnable : true;

  // triggers
  if (raw.triggers != null && !Array.isArray(raw.triggers)) {
    throw new Error(`SKILL_TRIGGERS_INVALID:${id}`);
  }
  const triggers = Array.isArray(raw.triggers)
    ? raw.triggers.map((r, i) => {
        if (!isObj(r)) throw new Error(`SKILL_TRIGGER_INVALID:${id}:${i}`);
        const when = norm(r.when);
        if (!VALID_TRIGGER_WHEN.has(when)) throw new Error(`SKILL_TRIGGER_WHEN_INVALID:${id}:${i}`);
        return { when, args: isObj(r.args) ? r.args : {} };
      })
    : [];

  // promptFragments（初始值，后续被 md 文件覆盖）
  const pf = isObj(raw.promptFragments) ? raw.promptFragments : {};
  const promptFragments = {
    system: norm(pf.system) || undefined,
    context: norm(pf.context) || undefined,
  };

  const policies = normArr(raw.policies);

  // toolCaps
  let toolCaps;
  if (raw.toolCaps != null) {
    if (!isObj(raw.toolCaps)) throw new Error(`SKILL_TOOL_CAPS_INVALID:${id}`);
    const allow = normArr(raw.toolCaps.allowTools);
    const deny = normArr(raw.toolCaps.denyTools);
    if (allow.length || deny.length) {
      toolCaps = {};
      if (allow.length) toolCaps.allowTools = allow;
      if (deny.length) toolCaps.denyTools = deny;
    }
  }

  const version = norm(raw.version) || "1.0.0";
  const conflicts = normArr(raw.conflicts);
  const requires = normArr(raw.requires);
  const mcp = validateMcp(raw.mcp, skillDir, id);

  // UI
  const uiRaw = isObj(raw.ui) ? raw.ui : {};
  const badge = norm(uiRaw.badge) || id.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10) || "SKILL";
  const color = norm(uiRaw.color) || undefined;

  return {
    id, name, description, priority, stageKey, autoEnable,
    triggers, promptFragments, policies,
    ...(toolCaps ? { toolCaps } : {}),
    version,
    ...(conflicts.length ? { conflicts } : {}),
    ...(requires.length ? { requires } : {}),
    source: "user",   // 外部扩展强制标记为 user
    ...(typeof raw.builtin === "boolean" ? { builtin: raw.builtin } : {}),
    ...(mcp ? { mcp } : {}),
    ui: { badge, ...(color ? { color } : {}) },
  };
}

// ── 单个 Skill 加载 ─────────────────────────────

/**
 * 从子目录加载一个 skill。
 * @param {string} rootDir - skills 根目录
 * @param {string} dirName - 子目录名
 * @returns {Promise<LoadedSkill|null>} null 表示目录下无 skill.json
 *
 * @typedef {Object} LoadedSkill
 * @property {string} id
 * @property {string} dir - 绝对路径
 * @property {object} manifest - 规范化的 SkillManifest
 * @property {string} digest - 内容哈希（用于变更检测）
 * @property {object|null} mcpConfig - 转换后的 McpManager 兼容配置
 */
async function loadOne(rootDir, dirName) {
  const skillDir = path.join(rootDir, dirName);
  const manifestPath = path.join(skillDir, MANIFEST_FILE);

  if (!(await exists(manifestPath))) return null;

  const jsonText = await fsp.readFile(manifestPath, "utf-8");
  let raw;
  try { raw = JSON.parse(jsonText); } catch {
    throw new Error(`SKILL_JSON_PARSE_ERROR:${dirName}`);
  }

  const manifest = parseManifest(raw, skillDir, dirName);

  // 读取可选的 md 提示词文件（覆盖 json 中的 promptFragments）
  const sysMd = await readText(path.join(skillDir, SYSTEM_PROMPT_FILE));
  const ctxMd = await readText(path.join(skillDir, CONTEXT_PROMPT_FILE));
  if (sysMd != null) manifest.promptFragments.system = sysMd;
  if (ctxMd != null) manifest.promptFragments.context = ctxMd;

  // stdio 入口文件存在性校验
  if (manifest.mcp?.transport === "stdio") {
    const abs = safeResolve(skillDir, manifest.mcp.entry, `SKILL_MCP_ENTRY_ESCAPE:${manifest.id}`);
    if (!(await exists(abs))) throw new Error(`SKILL_MCP_ENTRY_NOT_FOUND:${manifest.id}`);
  }

  const digest = crypto.createHash("sha1").update(JSON.stringify(manifest)).digest("hex");
  const mcpConfig = buildMcpConfig(manifest, skillDir);

  return { id: manifest.id, dir: skillDir, manifest, digest, mcpConfig };
}

// ── MCP 配置转换 ─────────────────────────────────

/**
 * 将 skill manifest 的 mcp 声明转换为 McpManager 兼容的 server config。
 * 标记 `skillManaged: true`，供 main.cjs 识别并区分于用户手动添加的 server。
 */
function buildMcpConfig(manifest, skillDir) {
  const mcp = manifest?.mcp;
  if (!mcp) return null;

  const base = {
    id: mcp.serverId,
    name: mcp.name || `${manifest.name} MCP`,
    transport: mcp.transport,
    enabled: true,
    skillManaged: true,     // 标记：由 SkillLoader 管理，不持久化到 mcp-servers.json
    skillId: manifest.id,   // 关联 skill id
  };

  if (mcp.transport === "stdio") {
    const modulePath = safeResolve(skillDir, mcp.entry, `MCP_ENTRY_INVALID:${manifest.id}`);
    return { ...base, bundled: true, modulePath, args: [], ...(mcp.env ? { env: mcp.env } : {}) };
  }

  // streamable-http / sse
  return { ...base, endpoint: mcp.endpoint };
}

// ── SkillLoader 主类 ─────────────────────────────

export class SkillLoader {
  /**
   * @param {string} userDataPath - app.getPath('userData')
   */
  constructor(userDataPath) {
    this.rootDir = path.join(String(userDataPath), SKILLS_DIR);
    /** @type {LoadedSkill[]} */
    this._skills = [];
    /** @type {Array<{dirName:string, error:string, ts:number}>} */
    this._errors = [];
    /** @type {Set<(event:any)=>void>} */
    this._listeners = new Set();
    /** @type {import("node:fs").FSWatcher|null} */
    this._rootWatcher = null;
    /** @type {Map<string, import("node:fs").FSWatcher>} */
    this._dirWatchers = new Map();
    this._reloadTimer = null;
    this._watching = false;
    this._disposed = false;
  }

  /**
   * 启动热加载（先 reload 一次 + 建立 watcher）。
   * @returns {Promise<LoadedSkill[]>}
   */
  async start() {
    if (this._disposed) return this.getSkills();
    this._watching = true;
    const skills = await this.reload();
    this._startRootWatcher();
    return skills;
  }

  /**
   * 执行一次扫描加载。
   * @returns {Promise<LoadedSkill[]>}
   */
  async reload() {
    if (this._disposed) return this.getSkills();

    // 确保 skills 目录存在
    await fsp.mkdir(this.rootDir, { recursive: true });

    const dirNames = await this._listDirs();
    const nextSkills = [];
    const nextErrors = [];

    for (const dirName of dirNames) {
      try {
        const loaded = await loadOne(this.rootDir, dirName);
        if (loaded) nextSkills.push(loaded);
      } catch (e) {
        nextErrors.push({ dirName, error: String(e?.message ?? e), ts: Date.now() });
        console.warn(`[SkillLoader] load failed: ${dirName} — ${e?.message ?? e}`);
      }
    }

    // id 去重：同 id 只保留第一个
    const seen = new Set();
    const deduped = [];
    for (const s of nextSkills) {
      if (seen.has(s.id)) {
        nextErrors.push({ dirName: path.basename(s.dir), error: `SKILL_ID_DUPLICATE:${s.id}`, ts: Date.now() });
        continue;
      }
      seen.add(s.id);
      deduped.push(s);
    }

    this._skills = deduped;
    this._errors = nextErrors;

    // 同步子目录 watcher
    if (this._watching) this._syncDirWatchers(dirNames);

    this._emit();
    return this.getSkills();
  }

  /** 获取已加载的 skill 列表（深拷贝） */
  getSkills() {
    return deepClone(this._skills) ?? [];
  }

  /** 获取加载错误列表 */
  getErrors() {
    return deepClone(this._errors) ?? [];
  }

  /**
   * 注册变更监听器。
   * @param {(event:{skills:LoadedSkill[], errors:any[], ts:number}) => void} fn
   * @returns {() => void} 取消监听
   */
  onDidChange(fn) {
    if (typeof fn !== "function") return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** 释放所有资源 */
  dispose() {
    this._disposed = true;
    this._watching = false;
    if (this._reloadTimer) {
      clearTimeout(this._reloadTimer);
      this._reloadTimer = null;
    }
    try { this._rootWatcher?.close(); } catch { /* */ }
    this._rootWatcher = null;
    for (const w of this._dirWatchers.values()) {
      try { w.close(); } catch { /* */ }
    }
    this._dirWatchers.clear();
    this._listeners.clear();
  }

  // ── 内部方法 ──────────────────────────

  _emit() {
    const event = { skills: this.getSkills(), errors: this.getErrors(), ts: Date.now() };
    for (const fn of this._listeners) {
      try { fn(event); } catch { /* */ }
    }
  }

  async _listDirs() {
    let entries;
    try {
      entries = await fsp.readdir(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && e.name && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  }

  _startRootWatcher() {
    if (this._rootWatcher) return;
    try {
      this._rootWatcher = fs.watch(this.rootDir, () => this._scheduleReload());
    } catch (e) {
      console.warn(`[SkillLoader] root watcher failed: ${e?.message}`);
    }
  }

  _syncDirWatchers(dirNames) {
    const next = new Set(dirNames);
    // 移除不再存在的
    for (const [name, w] of this._dirWatchers) {
      if (!next.has(name)) {
        try { w.close(); } catch { /* */ }
        this._dirWatchers.delete(name);
      }
    }
    // 添加新的
    for (const name of next) {
      if (this._dirWatchers.has(name)) continue;
      try {
        const w = fs.watch(path.join(this.rootDir, name), () => this._scheduleReload());
        this._dirWatchers.set(name, w);
      } catch (e) {
        console.warn(`[SkillLoader] dir watcher failed: ${name} — ${e?.message}`);
      }
    }
  }

  _scheduleReload() {
    if (this._disposed || !this._watching) return;
    if (this._reloadTimer) clearTimeout(this._reloadTimer);
    this._reloadTimer = setTimeout(() => {
      this._reloadTimer = null;
      this.reload().catch((e) => console.error("[SkillLoader] reload error:", e));
    }, RELOAD_DEBOUNCE_MS);
  }
}

/**
 * 从 LoadedSkill 提取 McpManager 兼容配置。
 * @param {LoadedSkill} loaded
 * @returns {object|null}
 */
export function toMcpServerConfig(loaded) {
  return loaded?.mcpConfig ? deepClone(loaded.mcpConfig) : null;
}
