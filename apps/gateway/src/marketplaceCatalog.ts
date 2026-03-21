export type MarketplaceItemType = "skill" | "mcp_server";
export type MarketplaceSource = "official" | "reviewed";

export type MarketplaceCatalogItem = {
  id: string;
  type: MarketplaceItemType;
  name: string;
  version: string;
  publisher: string;
  source: MarketplaceSource;
  description: string;
  minAppVersion: string;
  platforms: string[];
  tags: string[];
};

export type MarketplaceManifest = MarketplaceCatalogItem & {
  permissions?: {
    network?: string[];
    fs?: string[];
    exec?: string[];
  };
  changelog?: string[];
  install: {
    kind: MarketplaceItemType;
  };
};

export type MarketplaceSkillPayload = {
  kind: "skill";
  skillId?: string;
  files: Array<{
    path: string;
    encoding?: "utf8" | "base64";
    content: string;
  }> | Record<string, string>;
};

export type MarketplaceMcpPayload = {
  kind: "mcp_server";
  serverId?: string;
  config: {
    name: string;
    transport: "stdio" | "streamable-http" | "sse";
    enabled?: boolean;
    command?: string;
    args?: string[];
    endpoint?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    configFields?: Array<{
      envKey: string;
      label: string;
      placeholder?: string;
      helpUrl?: string;
      helpText?: string;
      required?: boolean;
    }>;
  };
};

export type MarketplaceDownloadPayload =
  | MarketplaceSkillPayload
  | MarketplaceMcpPayload;

export type MarketplaceRecord = {
  manifest: MarketplaceManifest;
  payload: MarketplaceDownloadPayload;
};

const RECORDS: MarketplaceRecord[] = [
  {
    manifest: {
      id: "official.github-mcp-template",
      type: "mcp_server",
      name: "GitHub MCP（模板）",
      version: "0.1.0",
      publisher: "Friday Official",
      source: "official",
      description: "预置 GitHub MCP 配置模板，填入 Token 后即可启用。",
      minAppVersion: "0.1.0",
      platforms: ["darwin-arm64", "darwin-x64", "win32-x64"],
      tags: ["mcp", "github", "template"],
      install: { kind: "mcp_server" },
      permissions: {
        exec: ["npx"],
        network: ["api.github.com"],
      },
      changelog: [
        "内置 GitHub MCP stdio 模板。",
        "支持配置字段提示（PAT）。",
      ],
    },
    payload: {
      kind: "mcp_server",
      serverId: "marketplace-github-mcp",
      config: {
        name: "GitHub MCP（Marketplace）",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        enabled: false,
        env: {},
        configFields: [
          {
            envKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
            label: "GitHub PAT",
            placeholder: "ghp_***",
            helpUrl: "https://github.com/settings/tokens",
            helpText: "需要 repo/read 权限，保存后再启用。",
            required: true,
          },
        ],
      },
    },
  },
  {
    manifest: {
      id: "reviewed.lark-openapi-mcp",
      type: "mcp_server",
      name: "Lark/飞书 OpenAPI MCP",
      version: "0.1.0",
      publisher: "Community",
      source: "reviewed",
      description:
        "将 Lark/飞书 OpenAPI 暴露为 MCP 工具，用于日程、群聊、文档等自动化操作。建议先在终端运行 npx -y @larksuiteoapi/lark-mcp --help 确认包可正常下载。",
      minAppVersion: "0.1.0",
      platforms: ["darwin-arm64", "darwin-x64", "win32-x64"],
      tags: ["mcp", "lark", "feishu", "calendar", "docs"],
      install: { kind: "mcp_server" },
      permissions: {
        exec: ["npx"],
        network: ["open.feishu.cn", "open.larksuite.com"],
      },
      changelog: [
        "预置 Lark/飞书 OpenAPI MCP stdio 配置模板。",
        "支持在设置页填写 App ID / App Secret 后启用。",
      ],
    },
    payload: {
      kind: "mcp_server",
      serverId: "marketplace-lark-openapi-mcp",
      config: {
        name: "Lark/飞书 OpenAPI MCP",
        transport: "stdio",
        command: "npx",
        // 官方推荐用法：npx -y @larksuiteoapi/lark-mcp mcp
        // 凭证通过环境变量 LARK_APP_ID / LARK_APP_SECRET 传入。
        args: ["-y", "@larksuiteoapi/lark-mcp", "mcp"],
        enabled: false,
        env: {},
        configFields: [
          {
            envKey: "LARK_APP_ID",
            label: "Lark/飞书 App ID",
            placeholder: "cli_***",
            helpUrl: "https://open.feishu.cn/app",
            helpText: "在飞书开放平台创建企业自建应用后，可在「凭证与基础信息」中找到 App ID。",
            required: true,
          },
          {
            envKey: "LARK_APP_SECRET",
            label: "Lark/飞书 App Secret",
            placeholder: "appsec_***",
            helpUrl: "https://open.feishu.cn/app",
            helpText: "在同一页面下方获取 App Secret，注意不要泄露。",
            required: true,
          },
        ],
      },
    },
  },
];

function buildRecordIndex(records: MarketplaceRecord[]) {
  return new Map<string, MarketplaceRecord>(
    records.map((r) => [`${r.manifest.id}@${r.manifest.version}`, r]),
  );
}

function cloneRecords<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function getDefaultMarketplaceRecords(): MarketplaceRecord[] {
  return cloneRecords(RECORDS);
}

export function listMarketplaceCatalogItems(records: MarketplaceRecord[] = RECORDS): MarketplaceCatalogItem[] {
  return records.map((r) => ({
    id: r.manifest.id,
    type: r.manifest.type,
    name: r.manifest.name,
    version: r.manifest.version,
    publisher: r.manifest.publisher,
    source: r.manifest.source,
    description: r.manifest.description,
    minAppVersion: r.manifest.minAppVersion,
    platforms: [...r.manifest.platforms],
    tags: [...r.manifest.tags],
  }));
}

export function getMarketplaceManifest(id: string, version: string, records: MarketplaceRecord[] = RECORDS): MarketplaceManifest | null {
  const key = `${String(id ?? "").trim()}@${String(version ?? "").trim()}`;
  const hit = buildRecordIndex(records).get(key);
  return hit ? { ...hit.manifest } : null;
}

export function getMarketplacePayload(id: string, version: string, records: MarketplaceRecord[] = RECORDS): MarketplaceDownloadPayload | null {
  const key = `${String(id ?? "").trim()}@${String(version ?? "").trim()}`;
  const hit = buildRecordIndex(records).get(key);
  if (!hit) return null;
  return cloneRecords(hit.payload) as MarketplaceDownloadPayload;
}
