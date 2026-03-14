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
  {
    manifest: {
      id: "official.deep-research-skill",
      type: "skill",
      name: "Deep Research",
      version: "0.1.0",
      publisher: "Friday Official",
      source: "official",
      description: "用当前 Agent LLM + web.search/web.fetch/Browser 自主完成多步深度调研，并可导出 PDF。",
      minAppVersion: "0.1.0",
      platforms: ["darwin-arm64", "darwin-x64", "win32-x64"],
      tags: ["research", "analysis", "skill", "pdf"],
      install: { kind: "skill" },
      permissions: {
        fs: ["write:userData/skills"],
      },
      changelog: [
        "首个版本：基于当前 Agent LLM、自带 web.search/web.fetch 和 Browser MCP 的 research loop。",
        "支持研究完成后按需导出 PDF（通过 built-in pdf skill + code.exec Python fallback）。",
      ],
    },
    payload: {
      kind: "skill",
      skillId: "deep_research",
      files: {
        "skill.json": JSON.stringify(
          {
            id: "deep_research",
            name: "Deep Research",
            description: "执行多步深度调研，输出带证据链的长报告，并在需要时导出 PDF。",
            priority: 72,
            stageKey: "agent.skill.user.deep_research",
            autoEnable: true,
            triggers: [
              {
                when: "text_regex",
                args: {
                  pattern: "(?i)(deep\s*research|深度研究|调研|研究报告|竞品分析|行业研究|尽职调查|文献综述|市场分析|竞争格局|资料收集)",
                },
              },
            ],
            toolCaps: {
              allowTools: [
                "run.setTodoList",
                "run.todo",
                "run.mainDoc.update",
                "run.mainDoc.get",
                "time.now",
                "web.search",
                "web.fetch",
                "write",
                "code.exec",
              ],
            },
            policies: ["AutoRetryPolicy"],
            version: "0.1.0",
            source: "user",
            ui: { badge: "RESEARCH", color: "violet" },
          },
          null,
          2,
        ),
        "system-prompt.md": [
          "当该技能开启时，你是一个会自己做 research loop 的深度研究代理，但必须完全复用当前系统能力，不调用外部 Deep Research API / CLI。",
          "",
          "执行原则：",
          "1) 先把用户任务收敛成 research brief：目标、范围、时间窗、交付格式。若问题足够明确，不要反复追问。",
          "2) 只要任务带有时效性、‘最近/最新/今年/当下’等信号，先调用 time.now。",
          "3) 先用 web.search 找线索，再用 web.fetch 抓正文证据，不要只凭 snippet 下结论。",
          "4) 若网页需要登录、JS 渲染、分页导航、截图取证或复杂表格，再调用 Browser / Playwright MCP；否则不要滥用浏览器。",
          "5) 至少完成一轮‘搜 → 读 → 收敛 → 补搜’，重要结论尽量来自多个来源，优先官方、一手、原始来源。",
          "6) 在研究过程中维护 todo，必要时更新 mainDoc，让连续任务不失忆。",
          "7) 最终输出必须区分：事实、推断、待验证项；不能把推测写成事实。",
          "8) 默认先用 write 产出 Markdown 母版；只有用户明确要求 PDF 或 .pdf 时，才进入 PDF 导出步骤。",
          "9) 如果当前请求包含 PDF 交付目标，请复用已激活的 pdf skill 规则；若没有可用 PDF 专用 MCP，就用 code.exec(runtime=python) 生成简单、可交付的 PDF。",
          "",
          "推荐报告结构：",
          "- Executive Summary",
          "- Key Findings",
          "- Evidence Log（标题 / URL / 日期 / 备注）",
          "- Risks & Unknowns",
          "- Recommendations / Next Actions",
          "",
          "约束：",
          "- 不编造来源",
          "- 不把未 fetch 的搜索结果当作正文证据",
          "- 不在证据不足时给过度确定的结论",
          "- 如果用户要的是可交付文件，最后必须明确列出产物路径",
        ].join("\n"),
        "context-prompt.md": [
          "ACTIVE_SKILL: deep_research",
          "RESEARCH_MODE: autonomous_loop",
          "DELIVERY_DEFAULT: markdown_first_pdf_on_demand",
        ].join("\n"),
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
