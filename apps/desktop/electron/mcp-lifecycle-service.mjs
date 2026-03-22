import crypto from "node:crypto";
import { McpLifecycleStore } from "./mcp-lifecycle-store.mjs";

const HEALTH_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_REPAIRABLE_COMMANDS = new Set(["uv", "uvx", "node", "npm", "npx", "python", "python3", "pip", "pip3"]);

function nowIso() {
  return new Date().toISOString();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function trimString(value) {
  return String(value ?? "").trim();
}

function toSafeSlug(value) {
  return trimString(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "mcp";
}

function isNonEmptyObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBaseUrl(raw) {
  return trimString(raw).replace(/\/+$/g, "");
}

function buildApiUrl(baseUrl, pathname) {
  const base = normalizeBaseUrl(baseUrl);
  const path = trimString(pathname);
  if (!path) return base;
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function tokenizeCommandLine(line) {
  const src = trimString(line);
  if (!src) return [];
  return (src.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [])
    .map((item) => item.replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
}

function extractCommandHead(line) {
  return trimString(tokenizeCommandLine(line)[0]);
}

function parseGithubRepoUrl(input) {
  const raw = trimString(input);
  if (!raw) return null;
  const noHash = raw.split("#")[0] ?? raw;
  const noQuery = noHash.split("?")[0] ?? noHash;
  const matched = noQuery.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/i);
  if (!matched?.[1] || !matched?.[2]) return null;
  return { owner: matched[1], repo: matched[2] };
}

function decodeGithubBase64(content) {
  return Buffer.from(String(content ?? "").replace(/\s+/g, ""), "base64").toString("utf-8");
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

async function fetchMarketplaceJson(baseUrl, pathname) {
  const finalUrl = buildApiUrl(baseUrl, pathname);
  if (!finalUrl) throw new Error("MARKETPLACE_BASE_URL_REQUIRED");
  const res = await fetch(finalUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

async function fetchGithubRepoJson(owner, repo) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return fetchJson(url);
}

async function fetchGithubRepoText(owner, repo, branch, filePath) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const payload = await res.json().catch(() => null);
  const content = trimString(payload?.content);
  if (!content) return null;
  try {
    return decodeGithubBase64(content);
  } catch {
    return null;
  }
}

function pickCommandFromReadme(readme) {
  const lines = String(readme ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const candidates = lines.filter((line) => /^(npx|uvx|python\s+-m|node|docker\s+run)\s+.+$/i.test(line));
  if (!candidates.length) return null;
  const picked = [...candidates]
    .map((line) => {
      const lower = line.toLowerCase();
      let score = 0;
      if (lower.includes("mcp")) score += 3;
      if (lower.includes("server")) score += 1;
      if (lower.includes("install")) score -= 1;
      return { line, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.line;
  return picked ? { command: picked, reason: "README 命令推断" } : null;
}

function detectReadmeCommandForPackage(readme, pkgName) {
  const text = String(readme ?? "");
  const pkg = trimString(pkgName);
  if (!text.trim() || !pkg) return null;
  const lines = text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const escapedPkg = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`^uvx\\s+${escapedPkg}(?:\\s+(.+))?$`, "i"),
    new RegExp(`^npx(?:\\s+-y)?\\s+${escapedPkg}(?:\\s+(.+))?$`, "i"),
    new RegExp(`^python\\s+-m\\s+${escapedPkg}(?:\\s+(.+))?$`, "i"),
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      const matched = line.match(pattern);
      if (!matched) continue;
      const rest = trimString(matched[1]);
      return {
        command: line,
        hasModeArg: /\b(stdio|sse|http|streamable-http)\b/i.test(rest),
      };
    }
  }
  return null;
}

function extractEnvKeysFromText(text) {
  return Array.from(new Set(String(text ?? "").match(/\b[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET)\b/g) ?? [])).slice(0, 8);
}

function looksSensitiveKey(key) {
  return /(token|secret|password|key|pat|cookie|authorization)/i.test(trimString(key));
}

function maskValue(value) {
  const raw = String(value ?? "");
  if (!raw) return "";
  if (raw.length <= 6) return "*".repeat(raw.length);
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
}

function redactRecord(record) {
  const output = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    output[key] = value ? maskValue(value) : "";
  }
  return output;
}

function normalizeCatalogSearchItems(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.filter((item) => trimString(item?.type) === "mcp_server");
}

function compareVersionLike(aRaw, bRaw) {
  const toParts = (raw) =>
    trimString(raw)
      .split(/[^\d]+/g)
      .filter(Boolean)
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isFinite(item));
  const a = toParts(aRaw);
  const b = toParts(bRaw);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function normalizeConfigFields(configFields, config = {}) {
  const fields = [];
  const sourceFields = Array.isArray(configFields) ? configFields : [];
  for (const field of sourceFields) {
    const key = trimString(field?.envKey ?? field?.key);
    if (!key) continue;
    fields.push({
      key,
      label: trimString(field?.label ?? key) || key,
      secret: field?.secret !== undefined ? field.secret === true : looksSensitiveKey(key),
      required: field?.required !== false,
      helpUrl: trimString(field?.helpUrl) || undefined,
      helpText: trimString(field?.helpText) || undefined,
      source: "env",
    });
  }
  if ((config.transport === "streamable-http" || config.transport === "sse") && !trimString(config.endpoint)) {
    fields.push({
      key: "endpoint",
      label: "Endpoint",
      required: true,
      secret: false,
      source: "endpoint",
    });
  }
  return fields;
}

function runtimeNeedsForCommand(command) {
  const head = extractCommandHead(command);
  return {
    commands: head ? [head] : [],
    autoRepairableCommands: head && AUTO_REPAIRABLE_COMMANDS.has(head.toLowerCase()) ? [head] : [],
  };
}

function buildCandidateFromMarketplaceRecord({ source, manifest, payload }) {
  const config = isNonEmptyObject(payload?.config) ? payload.config : {};
  const command = trimString(config.command);
  const transport = trimString(config.transport) || "stdio";
  const installKind = transport === "stdio" ? "marketplace_payload" : "http_endpoint";
  return {
    candidateId: "catalog-default",
    title: trimString(manifest?.name ?? config?.name ?? source?.itemId) || "Marketplace MCP",
    sourceKind: "catalog_item",
    installKind,
    confidence: "high",
    serverDraft: {
      idHint: trimString(payload?.serverId) || trimString(source?.itemId),
      name: trimString(config.name ?? manifest?.name ?? payload?.serverId) || trimString(source?.itemId) || "Marketplace MCP",
      transport,
      command: command || undefined,
      args: Array.isArray(config.args) ? config.args.map((item) => String(item ?? "")).filter(Boolean) : undefined,
      endpoint: trimString(config.endpoint) || undefined,
      familyHint: trimString(config.familyHint) || undefined,
      toolProfile: trimString(config.toolProfile) || undefined,
      configFields: normalizeConfigFields(config.configFields, config),
    },
    runtimeNeeds: runtimeNeedsForCommand(command),
    warnings: [],
    sourceMeta: {
      version: trimString(manifest?.version),
      manifest: deepClone(manifest),
      payload: deepClone(payload),
    },
  };
}

async function planGithubInstall(source) {
  const parsed = parseGithubRepoUrl(source?.url);
  if (!parsed) throw new Error("INVALID_GITHUB_REPO_URL");
  const { owner, repo } = parsed;
  const repoInfo = await fetchGithubRepoJson(owner, repo);
  const branch = trimString(repoInfo?.default_branch) || "main";
  const prettyName = trimString(repoInfo?.name) || repo;
  const sourceRepo = `https://github.com/${owner}/${repo}`;
  const [pkgText, pyText, readmeText, readmeAltText] = await Promise.all([
    fetchGithubRepoText(owner, repo, branch, "package.json"),
    fetchGithubRepoText(owner, repo, branch, "pyproject.toml"),
    fetchGithubRepoText(owner, repo, branch, "README.md"),
    fetchGithubRepoText(owner, repo, branch, "readme.md"),
  ]);
  const readme = readmeText || readmeAltText || "";
  const warnings = [];
  let confidence = "low";
  let command = "";
  let args = [];
  let notes = [];

  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      const pkgName = trimString(pkg?.name);
      if (pkgName) {
        const readmeCmd = detectReadmeCommandForPackage(readme, pkgName);
        const preferred = readmeCmd?.command ? tokenizeCommandLine(readmeCmd.command) : ["npx", "-y", pkgName];
        command = trimString(preferred[0]) || "npx";
        args = preferred.slice(1);
        notes = [`根据 package.json 推断 npm 包：${pkgName}`];
        if (readmeCmd?.command) notes.push(`已按 README 命令补全：${readmeCmd.command}`);
        confidence = readmeCmd?.hasModeArg ? "high" : "medium";
      }
    } catch {
      // ignore
    }
  }

  if (!command && pyText) {
    const matched =
      pyText.match(/\[project\][\s\S]*?\nname\s*=\s*["']([^"']+)["']/i) ||
      pyText.match(/\nname\s*=\s*["']([^"']+)["']/i);
    const pyName = trimString(matched?.[1]);
    if (pyName) {
      const readmeCmd = detectReadmeCommandForPackage(readme, pyName);
      const preferred = readmeCmd?.command ? tokenizeCommandLine(readmeCmd.command) : ["uvx", pyName];
      command = trimString(preferred[0]) || "uvx";
      args = preferred.slice(1);
      notes = [`根据 pyproject.toml 推断 Python 包：${pyName}`];
      if (readmeCmd?.command) notes.push(`已按 README 命令补全：${readmeCmd.command}`);
      confidence = readmeCmd?.hasModeArg ? "high" : "medium";
    }
  }

  if (!command && readme) {
    const picked = pickCommandFromReadme(readme);
    if (picked?.command) {
      const parts = tokenizeCommandLine(picked.command);
      command = trimString(parts[0]);
      args = parts.slice(1);
      notes = [picked.reason, "请在保存前确认命令参数与环境变量"];
      confidence = picked.command.toLowerCase().includes("mcp") ? "medium" : "low";
    }
  }

  if (!command) {
    throw new Error("GITHUB_REPO_PLAN_NOT_FOUND");
  }

  const envKeys = extractEnvKeysFromText(readme);
  if (envKeys.length > 0) {
    warnings.push(`从 README 提取到 ${envKeys.length} 个可能的密钥变量`);
  }

  return {
    ok: true,
    source: deepClone(source),
    candidates: [
      {
        candidateId: "github-default",
        title: prettyName,
        sourceKind: "github_repo",
        installKind: "stdio_package",
        confidence,
        serverDraft: {
          idHint: `github-${toSafeSlug(repo)}`,
          name: prettyName,
          transport: "stdio",
          command,
          args,
          configFields: envKeys.map((key) => ({
            key,
            label: key,
            secret: true,
            required: true,
            source: "env",
          })),
        },
        runtimeNeeds: runtimeNeedsForCommand(command),
        warnings: notes,
        sourceMeta: {
          repo: sourceRepo,
          defaultBranch: branch,
        },
      },
    ],
    warnings,
  };
}

function mergeConfigValue(configValues, field) {
  const values = isNonEmptyObject(configValues) ? configValues : {};
  const key = trimString(field?.key);
  if (!key) return "";
  if (field?.source === "endpoint") {
    return trimString(values[key] ?? values.endpoint);
  }
  if (field?.source === "header") {
    return trimString(values[key] ?? values.headers?.[key]);
  }
  return trimString(values[key] ?? values.env?.[key]);
}

function existingConfigValue(existingConfig, field) {
  const cfg = isNonEmptyObject(existingConfig) ? existingConfig : {};
  const key = trimString(field?.key);
  if (!key) return "";
  if (field?.source === "endpoint") return trimString(cfg.endpoint);
  if (field?.source === "header") return trimString(cfg.headers?.[key]);
  return trimString(cfg.env?.[key]);
}

function sanitizeServerForModel(server, managedRecord) {
  const config = isNonEmptyObject(server?.config) ? server.config : {};
  return {
    id: trimString(server?.id),
    name: trimString(server?.name),
    transport: trimString(server?.transport),
    enabled: server?.enabled !== false,
    status: trimString(server?.status),
    error: trimString(server?.error) || null,
    bundled: server?.bundled === true,
    builtin: server?.builtin === true,
    skillManaged: server?.skillManaged === true,
    toolCount: Array.isArray(server?.tools) ? server.tools.length : 0,
    agentToolCount:
      typeof server?.agentToolCount === "number" && Number.isFinite(server.agentToolCount)
        ? Math.max(0, Math.floor(server.agentToolCount))
        : Array.isArray(server?.agentTools)
          ? server.agentTools.length
          : 0,
    resolvedFamily: trimString(server?.resolvedFamily) || undefined,
    resolvedToolProfile: trimString(server?.resolvedToolProfile) || undefined,
    config: {
      command: trimString(config.command) || undefined,
      args: Array.isArray(config.args) ? config.args.map((item) => String(item ?? "")).filter(Boolean) : undefined,
      endpoint: trimString(config.endpoint) || undefined,
      headers: redactRecord(config.headers ?? {}),
      env: redactRecord(config.env ?? {}),
      enabledTools: Array.isArray(config.enabledTools) ? config.enabledTools : [],
      disabledTools: Array.isArray(config.disabledTools) ? config.disabledTools : [],
      toolProfile: trimString(config.toolProfile) || undefined,
      familyHint: trimString(config.familyHint) || undefined,
    },
    configFields: Array.isArray(server?.configFields) ? deepClone(server.configFields) : [],
    lifecycle: managedRecord ? deepClone(managedRecord) : null,
  };
}

export class McpLifecycleService {
  constructor(args = {}) {
    this._userDataPath = trimString(args?.userDataPath);
    this._getMcpManager =
      typeof args?.getMcpManager === "function"
        ? args.getMcpManager
        : () => args?.mcpManager ?? null;
    this._getMarketplaceManager =
      typeof args?.getMarketplaceManager === "function"
        ? args.getMarketplaceManager
        : () => args?.marketplaceManager ?? null;
    this._store = new McpLifecycleStore(this._userDataPath);
    this._healthSweepTimer = null;
  }

  _getManager() {
    const manager = this._getMcpManager?.();
    if (!manager) throw new Error("MCP_NOT_READY");
    return manager;
  }

  async startHealthSweep(args = {}) {
    const intervalMs = Math.max(60_000, Number(args?.intervalMs ?? HEALTH_SWEEP_INTERVAL_MS));
    if (this._healthSweepTimer) clearInterval(this._healthSweepTimer);
    this._healthSweepTimer = setInterval(() => {
      this.runHealthSweep().catch((error) => {
        console.warn("[McpLifecycleService] health sweep failed:", error?.message ?? error);
      });
    }, intervalMs);
    this._healthSweepTimer.unref?.();
    return { ok: true, intervalMs };
  }

  dispose() {
    if (this._healthSweepTimer) {
      clearInterval(this._healthSweepTimer);
      this._healthSweepTimer = null;
    }
  }

  async searchCatalog(args = {}) {
    const query = trimString(args?.query).toLowerCase();
    const payload = await fetchMarketplaceJson(args?.baseUrl, "/api/marketplace/catalog");
    const items = normalizeCatalogSearchItems(payload)
      .filter((item) => {
        if (!query) return true;
        const haystack = [
          item?.name,
          item?.description,
          ...(Array.isArray(item?.tags) ? item.tags : []),
          item?.publisher,
          item?.id,
        ]
          .map((entry) => String(entry ?? "").toLowerCase())
          .join(" ");
        return haystack.includes(query);
      })
      .slice(0, 20)
      .map((item) => ({
        id: trimString(item?.id),
        name: trimString(item?.name),
        version: trimString(item?.version),
        publisher: trimString(item?.publisher),
        source: trimString(item?.source) || "official",
        description: trimString(item?.description),
        tags: Array.isArray(item?.tags) ? item.tags.map((tag) => String(tag ?? "")).filter(Boolean) : [],
        type: trimString(item?.type),
      }));
    return { ok: true, items };
  }

  async _loadCatalogRecord(source, args = {}) {
    if (args?.catalogRecord?.manifest && args?.catalogRecord?.payload) {
      return {
        manifest: deepClone(args.catalogRecord.manifest),
        payload: deepClone(args.catalogRecord.payload),
      };
    }
    const itemId = trimString(source?.itemId);
    if (!itemId) throw new Error("CATALOG_ITEM_ID_REQUIRED");
    let version = trimString(source?.version);
    if (!version) {
      const catalog = await this.searchCatalog({ query: itemId, baseUrl: args?.baseUrl });
      const exact = (catalog.items ?? []).find((item) => trimString(item?.id) === itemId);
      version = trimString(exact?.version);
    }
    if (!version) throw new Error("CATALOG_ITEM_VERSION_REQUIRED");
    const idEncoded = encodeURIComponent(itemId);
    const versionEncoded = encodeURIComponent(version);
    const manifest = await fetchMarketplaceJson(args?.baseUrl, `/api/marketplace/items/${idEncoded}/versions/${versionEncoded}/manifest`);
    const payload = await fetchMarketplaceJson(args?.baseUrl, `/api/marketplace/items/${idEncoded}/versions/${versionEncoded}/download`);
    return { manifest, payload };
  }

  async planInstall(args = {}) {
    const source = isNonEmptyObject(args?.source) ? args.source : null;
    if (!source) return { ok: false, error: "SOURCE_REQUIRED" };
    const kind = trimString(source.kind);
    try {
      if (kind === "github_repo") {
        return planGithubInstall(source);
      }
      if (kind === "catalog_item") {
        const { manifest, payload } = await this._loadCatalogRecord(source, args);
        return {
          ok: true,
          source: deepClone(source),
          candidates: [buildCandidateFromMarketplaceRecord({ source, manifest, payload })],
          warnings: [],
        };
      }
      return { ok: false, error: "UNSUPPORTED_SOURCE_KIND" };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  _findServer(serverId) {
    const manager = this._getManager();
    return (manager.getServers?.() ?? []).find((item) => trimString(item?.id) === trimString(serverId)) ?? null;
  }

  _buildConfigFromCandidate(args = {}) {
    const candidate = args?.candidate ?? {};
    const existingServer = args?.existingServer ?? null;
    const existingConfig = isNonEmptyObject(existingServer?.config) ? existingServer.config : {};
    const serverDraft = isNonEmptyObject(candidate?.serverDraft) ? candidate.serverDraft : {};
    const config = {
      id: trimString(existingServer?.id) || trimString(serverDraft.idHint) || `assistant-${toSafeSlug(serverDraft.name ?? candidate?.title ?? "mcp")}`,
      name: trimString(serverDraft.name ?? existingServer?.name ?? "MCP Server") || "MCP Server",
      transport: trimString(serverDraft.transport ?? existingServer?.transport ?? existingConfig.transport ?? "stdio") || "stdio",
      enabled: existingServer?.enabled !== false,
      command: trimString(serverDraft.command ?? existingConfig.command) || undefined,
      args: Array.isArray(serverDraft.args)
        ? serverDraft.args.map((item) => String(item ?? "")).filter(Boolean)
        : Array.isArray(existingConfig.args)
          ? existingConfig.args.map((item) => String(item ?? "")).filter(Boolean)
          : undefined,
      endpoint: trimString(serverDraft.endpoint ?? existingConfig.endpoint) || undefined,
      headers: isNonEmptyObject(existingConfig.headers) ? deepClone(existingConfig.headers) : {},
      env: isNonEmptyObject(existingConfig.env) ? deepClone(existingConfig.env) : {},
      enabledTools: Array.isArray(existingConfig.enabledTools) ? [...existingConfig.enabledTools] : [],
      disabledTools: Array.isArray(existingConfig.disabledTools) ? [...existingConfig.disabledTools] : [],
      toolProfile: trimString(serverDraft.toolProfile ?? existingConfig.toolProfile) || undefined,
      familyHint: trimString(serverDraft.familyHint ?? existingConfig.familyHint) || undefined,
    };
    const fields = Array.isArray(serverDraft.configFields) ? serverDraft.configFields : [];
    const missingFields = [];
    const maskedConfigKeys = [];
    for (const field of fields) {
      const key = trimString(field?.key);
      if (!key) continue;
      const provided = mergeConfigValue(args?.configValues, field);
      const fallback = existingConfigValue(existingConfig, field);
      const resolved = trimString(provided || fallback);
      if (!resolved && field?.required !== false) {
        missingFields.push({
          key,
          label: trimString(field?.label) || key,
          secret: field?.secret === true,
          required: field?.required !== false,
          helpUrl: trimString(field?.helpUrl) || undefined,
          helpText: trimString(field?.helpText) || undefined,
          source: field?.source === "endpoint" ? "endpoint" : field?.source === "header" ? "header" : "env",
        });
        continue;
      }
      if (!resolved) continue;
      maskedConfigKeys.push(key);
      if (field?.source === "endpoint") config.endpoint = resolved;
      else if (field?.source === "header") config.headers[key] = resolved;
      else config.env[key] = resolved;
    }
    if (config.transport === "stdio" && !config.command) {
      throw new Error("MCP_STDIO_COMMAND_REQUIRED");
    }
    if ((config.transport === "streamable-http" || config.transport === "sse") && !trimString(config.endpoint)) {
      missingFields.push({
        key: "endpoint",
        label: "Endpoint",
        required: true,
        secret: false,
        source: "endpoint",
      });
    }
    if (Object.keys(config.headers).length === 0) delete config.headers;
    if (Object.keys(config.env).length === 0) delete config.env;
    return { config, missingFields, maskedConfigKeys };
  }

  _toNeedsInput(args = {}) {
    const missingFields = Array.isArray(args?.missingFields) ? args.missingFields : [];
    if (!missingFields.length) return null;
    return {
      mode: "form",
      message: trimString(args?.message) || "还缺少一些配置，补齐后我就继续安装/验证。",
      fields: missingFields.map((field) => ({
        key: trimString(field?.key),
        label: trimString(field?.label ?? field?.key),
        secret: field?.secret === true,
        required: field?.required !== false,
        helpUrl: trimString(field?.helpUrl) || undefined,
        helpText: trimString(field?.helpText) || undefined,
        source: field?.source === "endpoint" ? "endpoint" : field?.source === "header" ? "header" : "env",
      })),
    };
  }

  async _createPendingRequest(args = {}) {
    const requestId = crypto.randomUUID();
    const request = this._toNeedsInput(args);
    const record = {
      requestId,
      threadId: trimString(args?.threadId) || null,
      serverId: trimString(args?.serverId) || null,
      candidateId: trimString(args?.candidateId) || null,
      intent: trimString(args?.intent) || "install",
      mode: request?.mode ?? "form",
      request,
      status: "pending",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      resumeContext: deepClone(args?.resumeContext ?? {}),
    };
    await this._store.upsertPendingRequest(record);
    if (trimString(args?.serverId)) {
      await this._store.upsertManagedServer({
        serverId: trimString(args.serverId),
        pendingRequestId: requestId,
        installState: "needs_input",
        authState: "needs_auth",
      });
    }
    return record;
  }

  async _applyServerConfig(serverId, nextConfig, previousServer, managedBy) {
    const manager = this._getManager();
    let applied = false;
    try {
      if (previousServer) {
        const updated = await manager.updateServer(serverId, nextConfig);
        if (!updated?.ok) throw new Error(String(updated?.error ?? "MCP_UPDATE_FAILED"));
      } else {
        const added = await manager.addServer(nextConfig);
        if (!added?.ok) throw new Error(String(added?.error ?? "MCP_ADD_FAILED"));
      }
      applied = true;
      if (nextConfig.enabled !== false) {
        await manager.connect(serverId).catch(() => void 0);
      }
      return { ok: true };
    } catch (error) {
      if (applied && previousServer) {
        await manager.updateServer(serverId, previousServer.config ?? {}).catch(() => void 0);
      } else if (applied && !previousServer) {
        await manager.removeServer(serverId).catch(() => void 0);
      }
      if (!applied && previousServer) {
        await manager.updateServer(serverId, previousServer.config ?? {}).catch(() => void 0);
      }
      throw new Error(String(error?.message ?? error ?? `MCP_${managedBy?.toUpperCase?.() ?? "APPLY"}_FAILED`));
    }
  }

  async _verifyServerState(serverId, managedRecord = null) {
    const server = this._findServer(serverId);
    if (!server) return { ok: false, error: "SERVER_NOT_FOUND" };
    const sanitized = sanitizeServerForModel(server, managedRecord);
    const connected = trimString(server?.status) === "connected";
    return {
      ok: true,
      serverId,
      status: connected ? "connected" : "error",
      connected,
      toolCount: sanitized.toolCount,
      agentToolCount: sanitized.agentToolCount,
      server: sanitized,
      warnings: connected ? [] : [trimString(server?.error) || "MCP 连接未成功"],
    };
  }

  async applyInstall(args = {}) {
    if (args?.confirm !== true) return { ok: false, error: "CONFIRM_REQUIRED" };
    const source = isNonEmptyObject(args?.source) ? args.source : null;
    if (!source) return { ok: false, error: "SOURCE_REQUIRED" };
    const plan = await this.planInstall(args);
    if (!plan?.ok) return plan;
    const candidates = Array.isArray(plan?.candidates) ? plan.candidates : [];
    const requestedCandidateId = trimString(args?.candidateId);
    const candidate =
      candidates.find((item) => trimString(item?.candidateId) === requestedCandidateId) ??
      candidates[0] ??
      null;
    if (!candidate) return { ok: false, error: "CANDIDATE_NOT_FOUND" };

    const previousServer = this._findServer(candidate?.serverDraft?.idHint) || this._findServer(args?.serverId);
    let configBuilt;
    try {
      configBuilt = this._buildConfigFromCandidate({
        candidate,
        existingServer: previousServer,
        configValues: args?.configValues,
      });
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }

    const serverId = trimString(configBuilt?.config?.id);
    if (configBuilt.missingFields.length > 0) {
      const pending = await this._createPendingRequest({
        threadId: args?.threadId,
        serverId,
        candidateId: trimString(candidate?.candidateId),
        intent: trimString(args?.intent) || "install",
        missingFields: configBuilt.missingFields,
        message: "还缺少一些 MCP 配置，补齐后我就继续。",
        resumeContext: {
          source: deepClone(source),
          candidateId: trimString(candidate?.candidateId),
          configValues: deepClone(args?.configValues ?? {}),
          baseUrl: normalizeBaseUrl(args?.baseUrl),
          managedBy: trimString(args?.managedBy) || "assistant",
          intent: trimString(args?.intent) || "install",
          catalogRecord: args?.catalogRecord ? deepClone(args.catalogRecord) : undefined,
        },
      });
      return {
        ok: true,
        requestId: pending.requestId,
        serverId,
        status: "needs_input",
        connected: false,
        warnings: plan?.warnings ?? [],
        nextTurnVisible: false,
        needsInput: pending.request,
        maskedConfigKeys: configBuilt.maskedConfigKeys,
      };
    }

    try {
      await this._applyServerConfig(serverId, configBuilt.config, previousServer, args?.managedBy);
      const managedRecord = await this._store.upsertManagedServer({
        serverId,
        managedBy: trimString(args?.managedBy) || "assistant",
        source: deepClone(source),
        installState: "installed",
        authState: "unknown",
        pendingRequestId: null,
        currentVersion: trimString(candidate?.sourceMeta?.version),
        sourceMeta: {
          baseUrl: normalizeBaseUrl(args?.baseUrl),
          repo: trimString(candidate?.sourceMeta?.repo) || undefined,
          defaultBranch: trimString(candidate?.sourceMeta?.defaultBranch) || undefined,
        },
      });
      const verified = await this.testServer({ serverId, threadId: args?.threadId });
      const nextState = verified?.connected ? "active" : "degraded";
      await this._store.upsertManagedServer({
        ...managedRecord,
        serverId,
        installState: nextState,
        authState: verified?.connected ? "ready" : trimString(verified?.status) === "needs_input" ? "needs_auth" : "error",
        lastVerifiedAt: nowIso(),
        lastHealthyAt: verified?.connected ? nowIso() : managedRecord?.lastHealthyAt,
        lastError: verified?.connected ? null : trimString(verified?.warnings?.[0]) || null,
      });
      if (trimString(args?.pendingRequestId)) {
        await this._store.resolvePendingRequest(args.pendingRequestId, { status: "accepted" });
        await this._store.removePendingRequest(args.pendingRequestId);
      }
      return {
        ok: true,
        serverId,
        status: verified?.status ?? (verified?.connected ? "connected" : "error"),
        connected: verified?.connected === true,
        toolCount: verified?.toolCount ?? 0,
        agentToolCount: verified?.agentToolCount ?? 0,
        warnings: Array.from(new Set([...(plan?.warnings ?? []), ...(verified?.warnings ?? [])])),
        nextTurnVisible: verified?.connected === true,
        maskedConfigKeys: configBuilt.maskedConfigKeys,
        ...(verified?.status === "needs_input" ? { needsInput: verified?.needsInput ?? null, requestId: verified?.requestId } : {}),
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async resolvePendingRequest(args = {}) {
    const requestId = trimString(args?.requestId);
    if (!requestId) return { ok: false, error: "REQUEST_ID_REQUIRED" };
    const action = trimString(args?.action).toLowerCase() || "submit";
    const pending = await this._store.getPendingRequest(requestId);
    if (!pending) return { ok: false, error: "REQUEST_NOT_FOUND" };
    if (action === "cancel" || action === "decline") {
      await this._store.resolvePendingRequest(requestId, { status: "cancelled" });
      return { ok: true, requestId, status: "cancelled" };
    }
    const resumeContext = isNonEmptyObject(pending?.resumeContext) ? pending.resumeContext : {};
    const mergedValues = {
      ...(isNonEmptyObject(resumeContext.configValues) ? deepClone(resumeContext.configValues) : {}),
      ...(isNonEmptyObject(args?.values) ? deepClone(args.values) : {}),
    };
    return this.applyInstall({
      source: resumeContext.source,
      candidateId: resumeContext.candidateId,
      configValues: mergedValues,
      baseUrl: resumeContext.baseUrl,
      managedBy: resumeContext.managedBy,
      confirm: true,
      threadId: pending.threadId ?? null,
      pendingRequestId: requestId,
      intent: resumeContext.intent ?? pending.intent,
      ...(resumeContext.catalogRecord ? { catalogRecord: resumeContext.catalogRecord } : {}),
    });
  }

  async listServers(args = {}) {
    const manager = this._getManager();
    const servers = manager.getServers?.() ?? [];
    const managedServers = await this._store.listManagedServers();
    const managedMap = new Map(managedServers.map((item) => [trimString(item?.serverId), item]));
    return {
      ok: true,
      servers: servers.map((server) => sanitizeServerForModel(server, managedMap.get(trimString(server?.id)) ?? null)),
      redactSecrets: args?.redactSecrets !== false,
    };
  }

  async updateConfig(args = {}) {
    const serverId = trimString(args?.serverId);
    if (!serverId) return { ok: false, error: "SERVER_ID_REQUIRED" };
    const manager = this._getManager();
    const existing = this._findServer(serverId);
    if (!existing) return { ok: false, error: "SERVER_NOT_FOUND" };
    const nextConfig = deepClone(existing.config ?? {});
    const values = isNonEmptyObject(args?.configValues) ? args.configValues : {};
    if (trimString(values.endpoint)) nextConfig.endpoint = trimString(values.endpoint);
    if (isNonEmptyObject(values.env)) nextConfig.env = { ...(nextConfig.env ?? {}), ...values.env };
    if (isNonEmptyObject(values.headers)) nextConfig.headers = { ...(nextConfig.headers ?? {}), ...values.headers };
    if (trimString(values.toolProfile)) nextConfig.toolProfile = trimString(values.toolProfile);
    if (trimString(values.familyHint)) nextConfig.familyHint = trimString(values.familyHint);
    const result = await manager.updateServer(serverId, nextConfig);
    if (!result?.ok) return { ok: false, error: String(result?.error ?? "MCP_UPDATE_FAILED") };
    return this.testServer({ serverId, threadId: args?.threadId });
  }

  async enableServer(args = {}) {
    const serverId = trimString(args?.serverId);
    if (!serverId) return { ok: false, error: "SERVER_ID_REQUIRED" };
    const manager = this._getManager();
    const existing = this._findServer(serverId);
    if (!existing) return { ok: false, error: "SERVER_NOT_FOUND" };
    const updated = await manager.updateServer(serverId, { enabled: true });
    if (!updated?.ok) return { ok: false, error: String(updated?.error ?? "MCP_ENABLE_FAILED") };
    await manager.connect(serverId).catch(() => void 0);
    return this.testServer({ serverId, threadId: args?.threadId });
  }

  async disableServer(args = {}) {
    const serverId = trimString(args?.serverId);
    if (!serverId) return { ok: false, error: "SERVER_ID_REQUIRED" };
    const manager = this._getManager();
    const existing = this._findServer(serverId);
    if (!existing) return { ok: false, error: "SERVER_NOT_FOUND" };
    const updated = await manager.updateServer(serverId, { enabled: false });
    if (!updated?.ok) return { ok: false, error: String(updated?.error ?? "MCP_DISABLE_FAILED") };
    await manager.disconnect(serverId).catch(() => void 0);
    return { ok: true, serverId, status: "disabled", connected: false };
  }

  async repairRuntime(args = {}) {
    const serverId = trimString(args?.serverId);
    if (!serverId) return { ok: false, error: "SERVER_ID_REQUIRED" };
    const server = this._findServer(serverId);
    if (!server) return { ok: false, error: "SERVER_NOT_FOUND" };
    const command = trimString(server?.config?.command);
    const manager = this._getManager();
    const health = await manager.repairRuntime({ commands: command ? [command] : [] });
    const verified = await this.testServer({ serverId, threadId: args?.threadId });
    return {
      ok: true,
      serverId,
      runtime: health,
      verify: verified,
    };
  }

  async testServer(args = {}) {
    const serverId = trimString(args?.serverId);
    if (!serverId) return { ok: false, error: "SERVER_ID_REQUIRED" };
    const managed = await this._store.getManagedServer(serverId);
    let server = this._findServer(serverId);
    if (!server) return { ok: false, error: "SERVER_NOT_FOUND" };
    const missingFields = normalizeConfigFields(server?.configFields, server?.config).filter((field) => {
      return !trimString(existingConfigValue(server?.config, field)) && field?.required !== false;
    });
    if (missingFields.length > 0) {
      const pending = await this._createPendingRequest({
        threadId: args?.threadId,
        serverId,
        intent: "repair",
        missingFields,
        message: "这个 MCP 还缺配置，补齐后我就继续验证。",
        resumeContext: {
          source: managed?.source ?? null,
          candidateId: null,
          configValues: {},
          baseUrl: trimString(managed?.sourceMeta?.baseUrl),
          managedBy: managed?.managedBy ?? "assistant",
          intent: "repair",
        },
      });
      await this._store.upsertManagedServer({
        ...(managed ?? { serverId, managedBy: "assistant", source: null }),
        serverId,
        installState: "needs_input",
        authState: "needs_auth",
        pendingRequestId: pending.requestId,
      });
      return {
        ok: true,
        requestId: pending.requestId,
        serverId,
        status: "needs_input",
        connected: false,
        toolCount: Array.isArray(server?.tools) ? server.tools.length : 0,
        agentToolCount:
          typeof server?.agentToolCount === "number" && Number.isFinite(server.agentToolCount)
            ? Math.max(0, Math.floor(server.agentToolCount))
            : Array.isArray(server?.agentTools)
              ? server.agentTools.length
              : 0,
        warnings: ["MCP 配置尚未补齐"],
        needsInput: pending.request,
      };
    }
    if (server?.enabled !== false && trimString(server?.status) !== "connected") {
      await this._getManager().connect(serverId).catch(() => void 0);
      server = this._findServer(serverId) ?? server;
    }
    const verified = await this._verifyServerState(serverId, managed);
    if (verified?.connected) {
      await this._store.upsertManagedServer({
        ...(managed ?? { serverId, managedBy: "assistant", source: null }),
        serverId,
        installState: "verified",
        authState: "ready",
        pendingRequestId: null,
        lastVerifiedAt: nowIso(),
        lastHealthyAt: nowIso(),
        lastError: null,
      });
    } else if (managed) {
      await this._store.upsertManagedServer({
        ...managed,
        serverId,
        installState: "degraded",
        authState: "error",
        lastVerifiedAt: nowIso(),
        lastError: trimString(verified?.warnings?.[0]) || trimString(server?.error) || "VERIFY_FAILED",
      });
    }
    return verified;
  }

  async planUpgrade(args = {}) {
    const serverId = trimString(args?.serverId);
    if (!serverId) return { ok: false, error: "SERVER_ID_REQUIRED" };
    const managed = await this._store.getManagedServer(serverId);
    if (!managed) return { ok: false, error: "MANAGED_SERVER_NOT_FOUND" };
    const source = managed?.source ?? null;
    if (trimString(source?.kind) !== "catalog_item") {
      return {
        ok: true,
        serverId,
        currentVersion: trimString(managed?.currentVersion),
        targetVersion: trimString(managed?.currentVersion) || undefined,
        sourceKind: trimString(source?.kind) || "unknown",
        breakingRisk: "medium",
        warnings: ["当前只对 catalog_item 形态提供结构化升级计划。"],
      };
    }
    const { manifest } = await this._loadCatalogRecord(source, { baseUrl: args?.baseUrl || managed?.sourceMeta?.baseUrl });
    const currentVersion = trimString(managed?.currentVersion || source?.version);
    const targetVersion = trimString(manifest?.version);
    return {
      ok: true,
      serverId,
      currentVersion: currentVersion || undefined,
      targetVersion: targetVersion || undefined,
      sourceKind: "catalog_item",
      breakingRisk: compareVersionLike(targetVersion, currentVersion) > 0 ? "low" : "low",
      warnings: compareVersionLike(targetVersion, currentVersion) > 0 ? [] : ["当前已是最新版本或无法判断新版本。"],
      requiresInput: false,
    };
  }

  async applyUpgrade(args = {}) {
    const serverId = trimString(args?.serverId);
    if (!serverId) return { ok: false, error: "SERVER_ID_REQUIRED" };
    if (args?.confirm !== true) return { ok: false, error: "CONFIRM_REQUIRED" };
    const managed = await this._store.getManagedServer(serverId);
    if (!managed) return { ok: false, error: "MANAGED_SERVER_NOT_FOUND" };
    const upgradePlan = await this.planUpgrade({ serverId, baseUrl: args?.baseUrl });
    if (!upgradePlan?.ok) return upgradePlan;
    const source = isNonEmptyObject(managed?.source) ? deepClone(managed.source) : null;
    if (!source) return { ok: false, error: "MANAGED_SOURCE_REQUIRED" };
    if (trimString(upgradePlan?.targetVersion)) source.version = trimString(upgradePlan.targetVersion);
    const existing = this._findServer(serverId);
    return this.applyInstall({
      source,
      candidateId: "catalog-default",
      configValues: {
        env: deepClone(existing?.config?.env ?? {}),
        headers: deepClone(existing?.config?.headers ?? {}),
        endpoint: trimString(existing?.config?.endpoint) || undefined,
      },
      baseUrl: args?.baseUrl || managed?.sourceMeta?.baseUrl,
      managedBy: managed?.managedBy ?? "assistant",
      confirm: true,
      threadId: args?.threadId,
      intent: "upgrade",
    });
  }

  async uninstallServer(args = {}) {
    const serverId = trimString(args?.serverId);
    if (!serverId) return { ok: false, error: "SERVER_ID_REQUIRED" };
    if (args?.confirm !== true) return { ok: false, error: "CONFIRM_REQUIRED" };
    const manager = this._getManager();
    const existing = this._findServer(serverId);
    if (!existing) return { ok: true, serverId, removed: false };
    const removed = await manager.removeServer(serverId);
    if (removed?.ok === false) return { ok: false, error: String(removed?.error ?? "MCP_REMOVE_FAILED") };
    const pendingRequests = await this._store.listPendingRequests();
    for (const request of pendingRequests) {
      if (trimString(request?.serverId) === serverId) {
        await this._store.removePendingRequest(request.requestId);
      }
    }
    await this._store.markServerUninstalled(serverId);
    return { ok: true, serverId, removed: true };
  }

  async runHealthSweep() {
    const manager = this._getManager();
    const servers = manager.getServers?.() ?? [];
    const managedServers = await this._store.listManagedServers();
    const serverMap = new Map(servers.map((server) => [trimString(server?.id), server]));
    let checked = 0;
    let degraded = 0;
    for (const managed of managedServers) {
      const serverId = trimString(managed?.serverId);
      if (!serverId) continue;
      checked += 1;
      const server = serverMap.get(serverId) ?? null;
      if (!server) {
        degraded += 1;
        await this._store.markServerDegraded(serverId, "SERVER_NOT_FOUND");
        continue;
      }
      const missingFields = normalizeConfigFields(server?.configFields, server?.config).filter((field) => {
        return !trimString(existingConfigValue(server?.config, field)) && field?.required !== false;
      });
      if (missingFields.length > 0) {
        degraded += 1;
        await this._store.upsertManagedServer({
          ...managed,
          serverId,
          installState: "degraded",
          authState: "needs_auth",
          lastVerifiedAt: nowIso(),
          lastError: "MISSING_REQUIRED_CONFIG",
        });
        continue;
      }
      if (trimString(server?.status) === "connected") {
        await this._store.upsertManagedServer({
          ...managed,
          serverId,
          installState: "active",
          authState: "ready",
          lastVerifiedAt: nowIso(),
          lastHealthyAt: nowIso(),
          lastError: null,
        });
      } else {
        degraded += 1;
        await this._store.upsertManagedServer({
          ...managed,
          serverId,
          installState: "degraded",
          authState: "error",
          lastVerifiedAt: nowIso(),
          lastError: trimString(server?.error) || "MCP_HEALTH_DEGRADED",
        });
      }
    }
    return { ok: true, checked, degraded, at: nowIso() };
  }
}
