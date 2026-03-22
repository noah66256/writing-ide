import fs from "node:fs/promises";
import path from "node:path";

const STATE_FILE = "mcp-lifecycle.v1.json";

function nowIso() {
  return new Date().toISOString();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createEmptyState() {
  return {
    version: 1,
    pendingRequests: {},
    managedServers: {},
    updatedAt: nowIso(),
  };
}

function normalizeRequestId(value) {
  return String(value ?? "").trim();
}

function normalizeServerId(value) {
  return String(value ?? "").trim();
}

export class McpLifecycleStore {
  constructor(userDataPath) {
    this._userDataPath = String(userDataPath ?? "").trim();
    this._statePath = path.join(this._userDataPath, STATE_FILE);
    this._state = null;
  }

  async load() {
    if (this._state) return deepClone(this._state);
    try {
      const raw = await fs.readFile(this._statePath, "utf-8");
      const parsed = JSON.parse(raw);
      this._state = {
        ...createEmptyState(),
        ...(parsed && typeof parsed === "object" ? parsed : {}),
        pendingRequests: parsed?.pendingRequests && typeof parsed.pendingRequests === "object" ? parsed.pendingRequests : {},
        managedServers: parsed?.managedServers && typeof parsed.managedServers === "object" ? parsed.managedServers : {},
      };
    } catch {
      this._state = createEmptyState();
    }
    return deepClone(this._state);
  }

  async save(nextState) {
    const normalized = {
      ...createEmptyState(),
      ...(nextState && typeof nextState === "object" ? nextState : {}),
      pendingRequests: nextState?.pendingRequests && typeof nextState.pendingRequests === "object" ? nextState.pendingRequests : {},
      managedServers: nextState?.managedServers && typeof nextState.managedServers === "object" ? nextState.managedServers : {},
      updatedAt: nowIso(),
    };
    await fs.mkdir(path.dirname(this._statePath), { recursive: true });
    await fs.writeFile(this._statePath, JSON.stringify(normalized, null, 2), "utf-8");
    this._state = normalized;
    return deepClone(this._state);
  }

  async _update(mutator) {
    const current = await this.load();
    const draft = deepClone(current);
    const next = await mutator(draft);
    return this.save(next ?? draft);
  }

  async getPendingRequest(requestId) {
    const state = await this.load();
    const key = normalizeRequestId(requestId);
    if (!key) return null;
    return state.pendingRequests[key] ? deepClone(state.pendingRequests[key]) : null;
  }

  async listPendingRequests() {
    const state = await this.load();
    return Object.values(state.pendingRequests ?? {})
      .filter((item) => item && typeof item === "object")
      .sort((a, b) => String(b?.updatedAt ?? "").localeCompare(String(a?.updatedAt ?? "")))
      .map((item) => deepClone(item));
  }

  async upsertPendingRequest(record) {
    const requestId = normalizeRequestId(record?.requestId);
    if (!requestId) throw new Error("REQUEST_ID_REQUIRED");
    await this._update((state) => {
      state.pendingRequests[requestId] = {
        ...(state.pendingRequests[requestId] && typeof state.pendingRequests[requestId] === "object"
          ? state.pendingRequests[requestId]
          : {}),
        ...(record && typeof record === "object" ? deepClone(record) : {}),
        requestId,
        updatedAt: nowIso(),
      };
      return state;
    });
    return this.getPendingRequest(requestId);
  }

  async resolvePendingRequest(requestId, resolution = {}) {
    const key = normalizeRequestId(requestId);
    if (!key) throw new Error("REQUEST_ID_REQUIRED");
    await this._update((state) => {
      const prev = state.pendingRequests[key];
      if (!prev || typeof prev !== "object") return state;
      state.pendingRequests[key] = {
        ...prev,
        ...(resolution && typeof resolution === "object" ? deepClone(resolution) : {}),
        updatedAt: nowIso(),
      };
      return state;
    });
    return this.getPendingRequest(key);
  }

  async removePendingRequest(requestId) {
    const key = normalizeRequestId(requestId);
    if (!key) return;
    await this._update((state) => {
      delete state.pendingRequests[key];
      return state;
    });
  }

  async getManagedServer(serverId) {
    const state = await this.load();
    const key = normalizeServerId(serverId);
    if (!key) return null;
    return state.managedServers[key] ? deepClone(state.managedServers[key]) : null;
  }

  async listManagedServers() {
    const state = await this.load();
    return Object.values(state.managedServers ?? {})
      .filter((item) => item && typeof item === "object")
      .sort((a, b) => String(a?.serverId ?? "").localeCompare(String(b?.serverId ?? "")))
      .map((item) => deepClone(item));
  }

  async upsertManagedServer(record) {
    const serverId = normalizeServerId(record?.serverId);
    if (!serverId) throw new Error("SERVER_ID_REQUIRED");
    await this._update((state) => {
      state.managedServers[serverId] = {
        ...(state.managedServers[serverId] && typeof state.managedServers[serverId] === "object"
          ? state.managedServers[serverId]
          : {}),
        ...(record && typeof record === "object" ? deepClone(record) : {}),
        serverId,
      };
      return state;
    });
    return this.getManagedServer(serverId);
  }

  async markServerVerified(serverId, summary = {}) {
    const key = normalizeServerId(serverId);
    if (!key) throw new Error("SERVER_ID_REQUIRED");
    return this.upsertManagedServer({
      serverId: key,
      installState: "verified",
      authState: summary?.authState ?? "ready",
      lastVerifiedAt: nowIso(),
      lastHealthyAt: nowIso(),
      lastError: null,
      ...(summary && typeof summary === "object" ? deepClone(summary) : {}),
    });
  }

  async markServerDegraded(serverId, reason) {
    const key = normalizeServerId(serverId);
    if (!key) throw new Error("SERVER_ID_REQUIRED");
    return this.upsertManagedServer({
      serverId: key,
      installState: "degraded",
      lastError: String(reason ?? "").trim() || "UNKNOWN_ERROR",
    });
  }

  async markServerUninstalled(serverId) {
    const key = normalizeServerId(serverId);
    if (!key) throw new Error("SERVER_ID_REQUIRED");
    return this.upsertManagedServer({
      serverId: key,
      installState: "uninstalled",
      pendingRequestId: null,
      lastError: null,
    });
  }

  async removeManagedServer(serverId) {
    const key = normalizeServerId(serverId);
    if (!key) return;
    await this._update((state) => {
      delete state.managedServers[key];
      return state;
    });
  }
}
