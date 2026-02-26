import { create } from "zustand";

export type McpToolInfo = {
  name: string;
  description: string;
  inputSchema?: any;
};

export type McpConfigField = {
  envKey: string;
  label: string;
  placeholder?: string;
  helpUrl?: string;
  helpText?: string;
  required?: boolean;
};

export type McpServerState = {
  id: string;
  name: string;
  transport: "stdio" | "streamable-http" | "sse";
  status: "disconnected" | "connecting" | "connected" | "error";
  enabled: boolean;
  bundled?: boolean;
  builtin?: boolean;
  tools: McpToolInfo[];
  error?: string | null;
  configFields?: McpConfigField[];
  config?: {
    command?: string;
    args?: string[];
    modulePath?: string;
    endpoint?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  };
};

type McpState = {
  servers: McpServerState[];
  /** 是否已初始化（从 main process 加载过一次） */
  inited: boolean;
  refresh: () => Promise<void>;
  addServer: (config: any) => Promise<{ ok: boolean; id?: string; error?: string }>;
  updateServer: (id: string, config: any) => Promise<{ ok: boolean; error?: string }>;
  removeServer: (id: string) => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  callTool: (serverId: string, toolName: string, args?: any) => Promise<any>;
};

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  inited: false,

  async refresh() {
    const api = (window as any).desktop?.mcp;
    if (!api) return;
    try {
      const servers = await api.getServers();
      set({ servers: Array.isArray(servers) ? servers : [], inited: true });
    } catch {
      // ignore
    }
  },

  async addServer(config) {
    const api = (window as any).desktop?.mcp;
    if (!api) return { ok: false, error: "NO_API" };
    const res = await api.addServer(config);
    await get().refresh();
    return res;
  },

  async updateServer(id, config) {
    const api = (window as any).desktop?.mcp;
    if (!api) return { ok: false, error: "NO_API" };
    const res = await api.updateServer(id, config);
    await get().refresh();
    return res;
  },

  async removeServer(id) {
    const api = (window as any).desktop?.mcp;
    if (!api) return;
    // builtin server 不可删除（后端也会拒绝）
    const target = get().servers.find((s) => s.id === id);
    if (target?.builtin) return;
    await api.removeServer(id);
    await get().refresh();
  },

  async connect(id) {
    const api = (window as any).desktop?.mcp;
    if (!api) return;
    await api.connect(id);
    await get().refresh();
  },

  async disconnect(id) {
    const api = (window as any).desktop?.mcp;
    if (!api) return;
    await api.disconnect(id);
    await get().refresh();
  },

  async callTool(serverId, toolName, args) {
    const api = (window as any).desktop?.mcp;
    if (!api) return { ok: false, error: "NO_API" };
    return api.callTool(serverId, toolName, args);
  },
}));

// 初始化：从 main process 加载 + 监听状态变更
if (typeof window !== "undefined") {
  const api = (window as any).desktop?.mcp;
  if (api) {
    // 首次加载
    api.getServers().then((servers: any) => {
      useMcpStore.setState({ servers: Array.isArray(servers) ? servers : [], inited: true });
    }).catch(() => void 0);

    // 监听实时状态变更
    api.onStatusChange((payload: any) => {
      useMcpStore.setState({ servers: Array.isArray(payload) ? payload : [] });
    });
  }
}
