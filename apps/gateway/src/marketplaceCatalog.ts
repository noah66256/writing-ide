export type MarketplaceItemType = "skill" | "mcp_server" | "sub_agent";
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
  files: Record<string, string>;
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

export type MarketplaceSubAgentPayload = {
  kind: "sub_agent";
  agent: Record<string, unknown>;
};

export type MarketplaceDownloadPayload =
  | MarketplaceSkillPayload
  | MarketplaceMcpPayload
  | MarketplaceSubAgentPayload;

export type MarketplaceRecord = {
  manifest: MarketplaceManifest;
  payload: MarketplaceDownloadPayload;
};

const RECORDS: MarketplaceRecord[] = [
  {
    manifest: {
      id: "official.punchline-polish-skill",
      type: "skill",
      name: "金句打磨助手",
      version: "0.1.0",
      publisher: "Friday Official",
      source: "official",
      description: "补齐标题、开头钩子和结尾金句，适合短文案增强。",
      minAppVersion: "0.1.0",
      platforms: ["darwin-arm64", "darwin-x64", "win32-x64"],
      tags: ["writing", "skill", "copy"],
      install: { kind: "skill" },
      permissions: {
        fs: ["write:userData/skills"],
      },
      changelog: [
        "首个版本，支持标题/开头/结尾三段打磨。",
        "新增触发词规则，可在写作场景自动建议启用。",
      ],
    },
    payload: {
      kind: "skill",
      skillId: "punchline_polish",
      files: {
        "skill.json": JSON.stringify(
          {
            id: "punchline_polish",
            name: "金句打磨助手",
            description: "自动补齐标题、开头钩子和结尾金句。",
            priority: 35,
            stageKey: "agent.skill.user.punchline_polish",
            autoEnable: false,
            triggers: [{ when: "text_regex", args: { pattern: "(金句|开头|标题|结尾|钩子)" } }],
            promptFragments: {
              system:
                "当该技能开启时：\n1) 先确认原文主旨不变；\n2) 强化标题、开头钩子、结尾收束；\n3) 用短句提升节奏；\n4) 禁止编造事实。",
              context: "ACTIVE_SKILL: punchline_polish",
            },
            policies: ["AutoRetryPolicy"],
            version: "0.1.0",
            source: "user",
            ui: { badge: "PUNCH", color: "amber" },
          },
          null,
          2,
        ),
      },
    },
  },
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
      id: "official.live-ops-sub-agent",
      type: "sub_agent",
      name: "直播运营教练",
      version: "0.1.0",
      publisher: "Friday Official",
      source: "official",
      description: "专注直播内容节奏与转化动作拆解，适配口播/直播复盘。",
      minAppVersion: "0.1.0",
      platforms: ["darwin-arm64", "darwin-x64", "win32-x64"],
      tags: ["sub-agent", "live", "growth"],
      install: { kind: "sub_agent" },
      permissions: {},
      changelog: [
        "首个版本：支持直播脚本结构建议与复盘提纲。",
        "内置低成本模型默认配置（haiku）。",
      ],
    },
    payload: {
      kind: "sub_agent",
      agent: {
        id: "custom_live_ops_coach",
        name: "直播运营教练",
        avatar: "🎯",
        description: "负责直播内容节奏、转化节点和复盘建议。",
        systemPrompt: [
          "你是「直播运营教练」，负责直播内容运营与转化节奏设计。",
          "",
          "你的职责：",
          "- 识别直播脚本中的关键转化节点（钩子、案例、行动指令）",
          "- 输出可执行的开场/过渡/收口建议",
          "- 给出复盘提纲（留存、互动、转化）并标注优先级",
          "",
          "规则：",
          "- 优先给短句、可直接口播的建议",
          "- 不编造数据，无法确认时要明确说明",
        ].join("\n"),
        tools: ["kb.search", "project.listFiles", "time.now"],
        skills: [],
        mcpServers: [],
        model: "haiku",
        fallbackModels: ["sonnet"],
        toolPolicy: "readonly",
        budget: {
          maxTurns: 10,
          maxToolCalls: 18,
          timeoutMs: 180000,
        },
        triggerPatterns: ["直播", "口播", "复盘", "转化", "运营"],
        priority: 88,
        enabled: true,
        version: "0.1.0",
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
