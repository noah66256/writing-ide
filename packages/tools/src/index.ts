export type ToolRiskLevel = "low" | "medium" | "high";
export type ToolApplyPolicy = "proposal" | "auto_apply";
export type ToolMode = "agent" | "chat";

export type ToolArgType = "string" | "number" | "boolean" | "object" | "array";

export type ToolArgSpec = {
  name: string;
  required?: boolean;
  desc: string;
  type?: ToolArgType;
};

export type ToolJsonSchema = {
  type: "object";
  properties: Record<
    string,
    {
      type: ToolArgType;
      // 对 array/object 保留可选结构，便于上游严格 schema 校验（如 OpenAI strict tools）
      items?: { type: ToolArgType };
      properties?: Record<string, { type: ToolArgType }>;
    }
  >;
  required?: string[];
  additionalProperties?: boolean;
  oneOfRequired?: Array<{ required: string[] }>;
};

/** Tool output schema */
export type ToolOutputSchema = {
  type: "object";
  description?: string;
  properties: Record<string, ToolOutputFieldSchema>;
};

export type ToolOutputFieldSchema = {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  items?: ToolOutputFieldSchema;
  properties?: Record<string, ToolOutputFieldSchema>;
};

export type ToolMeta = {
  name: string;
  description: string;
  args: ToolArgSpec[];
  modes?: ToolMode[];
  inputSchema?: ToolJsonSchema;
  outputSchema?: ToolOutputSchema;
};

/**
 * LLM function-calling API 工具名编码/解码。
 * 大部分 LLM API（Anthropic / OpenAI / Gemini）的 function name 限制为
 * [a-zA-Z0-9_-]，不允许 "." 等字符。
 * 编码规则：. → _dot_（可逆，不与合法字符冲突）
 */
export function encodeToolName(name: string): string {
  return name.replace(/\./g, "_dot_");
}

export function decodeToolName(encoded: string): string {
  const raw = encoded.replace(/_dot_/g, ".");
  const lower = raw.toLowerCase();
  switch (lower) {
    case "web_search":
      return "web.search";
    case "web_fetch":
      return "web.fetch";
    case "kb_search":
      return "kb.search";
    case "tools_search":
    case "tool_search":
      return "tools.search";
    case "tools_describe":
    case "tool_describe":
      return "tools.describe";
    case "run_settodolist":
    case "run_set_todo_list":
      return "run.setTodoList";
    case "run_maindoc_update":
    case "run_main_doc_update":
    case "run.maindoc_update":
      return "run.mainDoc.update";
    case "run_maindoc_get":
    case "run_main_doc_get":
      return "run.mainDoc.get";
    default:
      return raw;
  }
}

// 工具契约（单一来源）：
// - Gateway 用于 toolsPrompt/allowlist（提示词与审计）
// - Desktop 用于工具说明/参数校验提示（后续逐步对齐）
export const TOOL_LIST: ToolMeta[] = [
  {
    name: "time.now",
    description:
      "获取当前时间（只读、无副作用）。用于所有时间敏感的任务：\n" +
      "- 让模型明确当前年份/日期，避免过期关键词\n" +
      "- 便于根据今天/最近/最新选择搜索时间范围\n" +
      "输出包含：nowIso/year/month/day/weekday/unixMs/timezoneOffsetMinutes。",
    args: [],
    modes: ["chat", "agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      "type": "object",
      "description": "Current time (multi-format)",
      "properties": {
        "nowIso": {
          "type": "string",
          "description": "ISO 8601 timestamp"
        },
        "unixMs": {
          "type": "number",
          "description": "Unix timestamp (ms)"
        },
        "utc": {
          "type": "object",
          "description": "UTC components",
          "properties": {
            "year": {
              "type": "number"
            },
            "month": {
              "type": "number"
            },
            "day": {
              "type": "number"
            },
            "weekday": {
              "type": "number"
            }
          }
        },
        "local": {
          "type": "object",
          "description": "Local time components",
          "properties": {
            "year": {
              "type": "number"
            },
            "month": {
              "type": "number"
            },
            "day": {
              "type": "number"
            },
            "weekday": {
              "type": "number"
            },
            "timezoneOffsetMinutes": {
              "type": "number"
            }
          }
        }
      }
    },

  },
  {
    name: "style_imitate.run",
    description:
      "风格仿写闭环的高阶入口工具。\n" +
      "【用途】在已绑定风格库的写作任务中，给定任务描述和候选稿文本（draft），自动执行：\n" +
      "1) 必要时对风格库做一次样例检索（kb.search）；\n" +
      "2) 调用 lint.copy 做复述/重合风险检查；\n" +
      "3) 调用 lint.style 做风格对齐检查；\n" +
      "4) 若 lint 全部通过且提供了 outputPath，则将 draft 写入该路径作为终稿。\n" +
      "【注意】draft 文本可能较长，请仅在需要闭环校验时调用此工具；若只需轻量提示，可直接使用 lint.copy / lint.style。",
    args: [
      { name: "task", required: true, desc: "写作任务描述（主题、受众、平台、长度等）", type: "string" },
      { name: "draft", required: true, desc: "候选稿文本，将用于 lint.copy / lint.style / 最终写入", type: "string" },
      { name: "outputPath", required: false, desc: "可选：终稿写入路径（如 drafts/script.md）；不传则只做 lint 不落盘", type: "string" },
      { name: "lengthHint", required: false, desc: "可选：长度提示（如“约 800 字”），仅作说明用", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        draft: { type: "string" },
        outputPath: { type: "string" },
        lengthHint: { type: "string" },
      },
      required: ["task", "draft"],
      additionalProperties: true,
    },
    outputSchema: {
      type: "object",
      description: "Style imitate orchestrated workflow result",
      properties: {
        ok: { type: "boolean", description: "是否完整走完风格闭环" },
        path: { type: "string", description: "若已写入终稿，则为写入路径" },
        summary: { type: "string", description: "本次闭环执行的简要摘要" },
        error: { type: "string", description: "若失败，则为错误编码/原因" },
      },
    },
  },
  {
    name: "tools.search",
    description:
      "搜索当前可用能力目录，返回候选项。\n" +
      "结果既可能是具体工具（内置 + MCP），也可能是 MCP 能力卡片或未激活的 Skill 卡片。\n" +
      "当工具很多、不确定该用哪个时：先 tools.search，再 tools.describe，再调用具体工具或确认是否要激活某项能力。\n" +
      "只读、无副作用。",
    args: [
      { name: "query", required: true, desc: "搜索问题/想要的能力（自然语言即可）", type: "string" },
      { name: "limit", desc: "返回数量（默认 8，最大 20）", type: "number" },
      { name: "sources", desc: "可选：限制来源（builtin/mcp/skill/mcp_capability）", type: "array" },
      { name: "includeSchemas", desc: "是否附带 inputSchema（默认 false）", type: "boolean" },
    ],
    modes: ["chat", "agent"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        sources: { type: "array", items: { type: "string" } },
        includeSchemas: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      description: "Tool search results",
      properties: {
        ok: { type: "boolean", description: "success" },
        tools: {
          type: "array",
          description: "matched tools or capability cards",
          items: {
            type: "object",
            properties: {
              resultType: { type: "string" },
              name: { type: "string" },
              source: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              riskLevel: { type: "string" },
              capabilities: { type: "array", items: { type: "string" } },
              requiredArgs: { type: "array", items: { type: "string" } },
              schemaSummary: { type: "object" },
            },
          },
        },
      },
    },
  },
  {
    name: "tools.describe",
    description:
      "获取某个候选能力的详细说明。\n" +
      "既支持具体工具（内置 + MCP），也支持 MCP 能力卡片和 Skill 卡片。\n" +
      "建议用法：tools.search 找到候选后，再 tools.describe 确认参数、能力边界或激活线索；对 Skill 卡片，tools.describe 只会记入最近查看记录，不等于激活，真正加载合同请使用 skills.activate。\n" +
      "只读、无副作用。",
    args: [
      { name: "name", required: true, desc: "工具名或能力卡片 ID（例如 write、mcp.playwright.browser_snapshot、mcp:playwright/browser、skill:style_imitate）", type: "string" },
      { name: "includeSchema", desc: "是否附带完整 schema（默认 true）", type: "boolean" },
    ],
    modes: ["chat", "agent"],
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        includeSchema: { type: "boolean" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      description: "Tool details",
      properties: {
        ok: { type: "boolean" },
        tool: { type: "object" },
      },
    },
  },
  {
    name: "web.search",
    description:
      "联网搜索。用于热点追踪、关键词研究、竞品分析、实时信息获取。\n" +
      "返回 title/url/snippet/summary 列表。\n" +
      "系统自动选择可用后端（博查 API → 搜索 MCP → Playwright 浏览器）。\n" +
      "实现层会自动注入当前日期/年份上下文；不再要求先显式调用 time.now。",
    args: [
      { name: "query", required: true, desc: "搜索关键词", type: "string" as const },
      { name: "freshness", desc: "时效过滤：noLimit(默认)/day/week/month", type: "string" as const },
      { name: "count", desc: "返回数量（1-50，默认10）", type: "number" as const },
      { name: "summary", desc: "是否返回摘要（默认true）", type: "boolean" as const },
    ],
    modes: ["agent"] as ToolMode[],
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const },
        freshness: { type: "string" as const },
        count: { type: "number" as const },
        summary: { type: "boolean" as const },
      },
      required: ["query"],
    },
  },
  {
    name: "web.fetch",
    description:
      "抓取指定 URL 网页内容并提取文本。\n" +
      "用于阅读搜索结果详情、获取参考资料原文。自动去除脚本/样式。\n" +
      "系统自动选择可用后端（直接抓取 → 搜索 MCP → Playwright 浏览器）。",
    args: [
      { name: "url", required: true, desc: "要抓取的 URL", type: "string" as const },
      { name: "format", desc: "返回格式：markdown（默认）或 text", type: "string" as const },
      { name: "maxChars", desc: "最大字符数（默认12000）", type: "number" as const },
    ],
    modes: ["agent"] as ToolMode[],
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string" as const },
        format: { type: "string" as const },
        maxChars: { type: "number" as const },
      },
      required: ["url"],
    },
  },
  {
    name: "kb.listLibraries",
    description:
      "列出本地知识库中的所有库（只读）。返回 id/name/purpose/docCount 列表。\n" +
      "【何时用】在 kb.ingest 之前查看可用库，决定是新建还是导入到已有库。",
    args: [],
    modes: ["agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      "type": "object",
      "description": "Library list",
      "properties": {
        "currentLibraryId": {
          "type": "string"
        },
        "libraries": {
          "type": "array",
          "description": "Libraries",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "purpose": {
                "type": "string",
                "description": "material|style|product"
              },
              "docCount": {
                "type": "number"
              }
            }
          }
        }
      }
    },

  },
  {
    name: "kb.ingest",
    description:
      "语料抽卡入库（一键完成：导入文档→智能分块→LLM 抽卡→可选生成手册→自动挂载库）。\n" +
      "【输入】text/path/url 三选一：\n" +
      "- text：直接传入要分析的文本内容\n" +
      "- path：项目内文件路径（相对路径）或绝对路径\n" +
      "- url：网页 URL（自动抓取正文）\n" +
      "【输出】返回 libraryId、docId、抽取的卡片数量（按 cardType 分类）。\n" +
      "抽卡完成后库自动 attach，后续可直接通过 kb.search 检索使用。",
    args: [
      { name: "text", required: false, desc: "要导入的文本内容（text/path/url 三选一）", type: "string" },
      { name: "path", required: false, desc: "文件路径（项目相对路径或绝对路径；text/path/url 三选一）", type: "string" },
      { name: "url", required: false, desc: "网页 URL（text/path/url 三选一）", type: "string" },
      { name: "libraryId", required: false, desc: "可选：指定已有库 ID；不传则自动创建新库", type: "string" },
      { name: "libraryName", required: false, desc: "可选：新库名称（仅新建库时生效）", type: "string" },
      { name: "purpose", required: false, desc: '可选：库用途 "style"|"material"|"product"（默认 "style"）', type: "string" },
      { name: "autoPlaybook", required: false, desc: "可选：抽卡后是否自动生成风格手册（默认 true）", type: "boolean" },
      { name: "autoAttach", required: false, desc: "可选：完成后是否自动 attach 库（默认 true）", type: "boolean" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        path: { type: "string" },
        url: { type: "string" },
        libraryId: { type: "string" },
        libraryName: { type: "string" },
        purpose: { type: "string" },
        autoPlaybook: { type: "boolean" },
        autoAttach: { type: "boolean" },
      },
      oneOfRequired: [{ required: ["text"] }, { required: ["path"] }, { required: ["url"] }],
      additionalProperties: true,
    },
  },
  {
    name: "kb.learn",
    description:
      "一键学习入库 workflow（导入 → 入队抽卡 → 入队手册生成 → 自动挂载）。\n" +
      "【用途】处理用户提交的学习语料（文本/文件/URL），完整执行学习入库流程。\n" +
      "抽卡和手册生成在后台异步执行，本工具毫秒级返回。用 kb.jobStatus 查询进度。\n" +
      "【输入方式】textRef/text/path/url 四选一：\n" +
      "- textRef：大文本场景，系统会自动生成引用 ID，直接传入\n" +
      "- text：短文本场景，可直接传入文本内容\n" +
      "- path：文件路径\n" +
      "- url：网页 URL",
    args: [
      { name: "textRef", required: false, desc: "系统自动生成的文本引用 ID（大文本场景，由系统预存）", type: "string" as const },
      { name: "text", required: false, desc: "文本内容（短文本可直接传入；大文本请用 textRef）", type: "string" as const },
      { name: "path", required: false, desc: "文件路径（项目相对路径或绝对路径）", type: "string" as const },
      { name: "url", required: false, desc: "网页 URL", type: "string" as const },
      { name: "autoPlaybook", required: false, desc: "可选：是否入队手册生成（默认 true）", type: "boolean" as const },
      { name: "autoAttach", required: false, desc: "可选：是否自动挂载库（默认 true）", type: "boolean" as const },
    ],
    modes: ["agent"] as const,
    inputSchema: {
      type: "object" as const,
      properties: {
        textRef: { type: "string" },
        text: { type: "string" },
        path: { type: "string" },
        url: { type: "string" },
        autoPlaybook: { type: "boolean" },
        autoAttach: { type: "boolean" },
      },
      oneOfRequired: [
        { required: ["textRef"] },
        { required: ["text"] },
        { required: ["path"] },
        { required: ["url"] },
      ],
      additionalProperties: true,
    },
  },
  {
    name: "kb.import",
    description:
      "仅导入语料到知识库（不抽卡）：接收 text/path/url（三选一），秒级完成入库。\n" +
      "【输入】text/path/url 三选一；可选 libraryId/libraryName/purpose 指定目标库。\n" +
      "【输出】返回 libraryId、docIds、imported/skipped 计数。\n" +
      "【与 kb.ingest 区别】kb.import 只做导入不抽卡，适合大体量语料场景——导入后用 kb.extract 异步入队抽卡。",
    args: [
      { name: "text", required: false, desc: "要导入的文本内容（text/path/url 三选一）", type: "string" },
      { name: "path", required: false, desc: "文件路径（项目相对路径或绝对路径；text/path/url 三选一）", type: "string" },
      { name: "url", required: false, desc: "网页 URL（text/path/url 三选一）", type: "string" },
      { name: "libraryId", required: false, desc: "可选：目标库 ID；不传则弹出库选择器", type: "string" },
      { name: "libraryName", required: false, desc: "可选：目标库名称（用于匹配已有库）", type: "string" },
      { name: "purpose", required: false, desc: '可选：库用途 "style"|"material"|"product"（用于匹配库）', type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        path: { type: "string" },
        url: { type: "string" },
        libraryId: { type: "string" },
        libraryName: { type: "string" },
        purpose: { type: "string" },
      },
      oneOfRequired: [{ required: ["text"] }, { required: ["path"] }, { required: ["url"] }],
      additionalProperties: true,
    },
    outputSchema: {
      type: "object",
      description: "KB import result",
      properties: {
        ok: { type: "boolean" },
        libraryId: { type: "string" },
        docIds: { type: "array", items: { type: "string" } },
        imported: { type: "number" },
        skipped: { type: "number" },
      },
    },
  },
  {
    name: "kb.extract",
    description:
      "入队抽卡并启动（毫秒级返回）：将 docIds 入队到后台抽卡队列并自动开始执行。\n" +
      "抽卡在后台异步进行，不阻塞当前工具调用。可选入队手册任务、自动关联库。\n" +
      "【配合使用】先 kb.import 导入 → 拿到 docIds → kb.extract 启动抽卡 → kb.jobStatus 查进度。",
    args: [
      { name: "docIds", required: true, desc: "文档 ID 数组（必填，来自 kb.import 的返回）", type: "array" },
      { name: "autoPlaybook", required: false, desc: "可选：是否自动入队风格手册生成任务（默认 false）", type: "boolean" },
      { name: "autoAttach", required: false, desc: "可选：是否自动将库关联到当前会话（默认 false）", type: "boolean" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        docIds: { type: "array", items: { type: "string" } },
        autoPlaybook: { type: "boolean" },
        autoAttach: { type: "boolean" },
      },
      required: ["docIds"],
      additionalProperties: true,
    },
    outputSchema: {
      type: "object",
      description: "KB extract enqueue result",
      properties: {
        ok: { type: "boolean" },
        enqueuedCards: { type: "number" },
        enqueuedPlaybook: { type: "number" },
        attached: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "kb.jobStatus",
    description:
      "查询 KB 抽卡/手册任务的进度（毫秒级返回）。\n" +
      "默认返回全部任务；可选传 docIds 仅查看指定文档的相关进度。\n" +
      "返回值包含逐条任务状态 + 汇总统计。",
    args: [{ name: "docIds", required: false, desc: "可选：仅查看这些文档 ID 相关的任务", type: "array" }],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        docIds: { type: "array", items: { type: "string" } },
      },
      additionalProperties: true,
    },
    outputSchema: {
      type: "object",
      description: "KB jobs status",
      properties: {
        status: { type: "string", description: "idle|running|paused" },
        jobs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              docId: { type: "string" },
              docTitle: { type: "string" },
              status: { type: "string" },
              extractedCards: { type: "number" },
              error: { type: "string" },
            },
          },
        },
        playbookJobs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              libraryId: { type: "string" },
              libraryName: { type: "string" },
              status: { type: "string" },
              totalFacets: { type: "number" },
              generatedFacets: { type: "number" },
              phase: { type: "string" },
            },
          },
        },
        summary: {
          type: "object",
          properties: {
            cards: {
              type: "object",
              properties: {
                total: { type: "number" },
                pending: { type: "number" },
                running: { type: "number" },
                success: { type: "number" },
                failed: { type: "number" },
              },
            },
            playbook: {
              type: "object",
              properties: {
                total: { type: "number" },
                pending: { type: "number" },
                running: { type: "number" },
                success: { type: "number" },
                failed: { type: "number" },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "kb.search",
    description:
      "在本地知识库中检索（按库过滤、按 source_doc 分组返回）。\n" +
      "【仿写检索 skill（强烈建议）】当用户要求“按某库风格仿写/改写”时：先用 kb.search 拉 3–8 条可抄样例，再写稿；写作中遇到具体段落（开头/转折/结尾/金句）再补一次 kb.search。\n" +
      "【查询建议】\n" +
      "- 结构套路/五段论：kind=card，cardTypes=[outline,thesis]（这是“抽卡产物”，更适合口播/无标题文本）\n" +
      "- Markdown 标题目录：kind=outline（仅当源文档含 # 标题时才会命中；0 命中不代表库为空）\n" +
      "- 口吻/句式/金句：kind=paragraph，配合 anchorParagraphIndexMax/anchorFromEndMax 拉开头/结尾原文段\n" +
      "- 维度：传 facetIds（FacetPack，例如 opening_design/logic_framework/ending 等；主要对 kind=card 生效）\n" +
      "【提示】如未关联库，会报错 NO_LIBRARY_SELECTED；请先在右侧把库关联上。",
    args: [
      { name: "query", required: true, desc: "搜索关键词/问题", type: "string" },
      { name: "kind", required: false, desc: '可选：artifact kind（"card"|"outline"|"paragraph"），默认 "card"', type: "string" },
      { name: "libraryIds", required: false, desc: "可选：库 ID 数组；不传则默认使用右侧已关联库", type: "array" },
      { name: "facetIds", required: false, desc: "可选：outlineFacet id 数组（多选）", type: "array" },
      { name: "cardTypes", required: false, desc: "可选：仅 kind=card 时生效；限制 cardType（例如 hook/one_liner/ending/outline/thesis）", type: "array" },
      { name: "anchorParagraphIndexMax", required: false, desc: "可选：只搜前 N 段（开头样例；paragraphIndex < N）", type: "number" },
      { name: "anchorFromEndMax", required: false, desc: "可选：只搜距结尾 N 段内（结尾样例）", type: "number" },
      { name: "debug", required: false, desc: "可选：返回检索诊断信息（默认 true）", type: "boolean" },
      { name: "perDocTopN", required: false, desc: "每篇文档最多返回多少条命中（默认 3）", type: "number" },
      { name: "topDocs", required: false, desc: "最多返回多少篇文档（默认 12）", type: "number" },
    ],
    modes: ["chat", "agent"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string" },
        libraryIds: { type: "array", items: { type: "string" } },
        facetIds: { type: "array", items: { type: "string" } },
        cardTypes: { type: "array", items: { type: "string" } },
        anchorParagraphIndexMax: { type: "number" },
        anchorFromEndMax: { type: "number" },
        debug: { type: "boolean" },
        perDocTopN: { type: "number" },
        topDocs: { type: "number" },
      },
      required: ["query"],
      additionalProperties: true,
    },
    outputSchema: {
      "type": "object",
      "description": "KB search results (grouped by source doc)",
      "properties": {
        "query": {
          "type": "string"
        },
        "kind": {
          "type": "string"
        },
        "groups": {
          "type": "array",
          "description": "Hit groups by source document",
          "items": {
            "type": "object",
            "properties": {
              "sourceDoc": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "title": {
                    "type": "string"
                  }
                }
              },
              "bestScore": {
                "type": "number"
              },
              "hits": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "score": {
                      "type": "number"
                    },
                    "snippet": {
                      "type": "string"
                    },
                    "artifact": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string"
                        },
                        "kind": {
                          "type": "string"
                        },
                        "title": {
                          "type": "string"
                        },
                        "cardType": {
                          "type": "string",
                          "description": "hook|thesis|ending|one_liner|outline"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

  },
  {
    name: "lint.copy",
    description:
      "Copy Linter（防贴原文/防复用）：对候选稿（text 或 path 指向的文本）做确定性重合检测。\n" +
      "设计目标：用于仿写/改写链路中的“anti-regurgitation”阶段闸门，优先拦截明显连续重合与高相似 n-gram。\n" +
      "【推荐工作流】（风格库已绑定且任务为写作类）：\n" +
      "1) 先 kb.search(kind=card, cardTypes=[hook,one_liner,ending,outline,thesis]) 拉模板\n" +
      "2) 产出一版候选稿（不要立刻写入文件）\n" +
      "3) lint.copy(text=候选稿) → 若风险偏高则改写降重 → 再 lint.style → 最后写入\n",
    args: [
      { name: "text", required: false, desc: "要检查的候选稿文本（text/path 二选一必填）", type: "string" },
      { name: "path", required: false, desc: "要检查的文件路径（text/path 二选一必填；会优先读取提案态内容）", type: "string" },
      { name: "libraryIds", required: false, desc: "可选：风格库 ID 数组；不传则默认使用右侧已绑定的风格库（purpose=style）作为对照样例池", type: "array" },
      { name: "maxSources", required: false, desc: "可选：最多使用多少条对照源（默认 14；包含编辑器选区 + 少量风格样例）", type: "number" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        path: { type: "string" },
        libraryIds: { type: "array", items: { type: "string" } },
        maxSources: { type: "number" },
      },
      oneOfRequired: [{ required: ["text"] }, { required: ["path"] }],
      additionalProperties: true,
    },
    outputSchema: {
      "type": "object",
      "description": "Copy detection result",
      "properties": {
        "passed": {
          "type": "boolean",
          "description": "Whether passed detection"
        },
        "riskLevel": {
          "type": "string",
          "description": "low|medium|high"
        },
        "maxOverlapChars": {
          "type": "number"
        },
        "maxChar5gramJaccard": {
          "type": "number"
        },
        "topOverlaps": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "source": {
                "type": "string"
              },
              "overlapChars": {
                "type": "number"
              },
              "snippet": {
                "type": "string"
              }
            }
          }
        }
      }
    },

  },
  {
    name: "lint.style",
    description:
      "风格 Linter（强烈建议用于仿写/改写/润色终稿）。\n" +
      "给定一段“候选稿”（text 或 path 指向的文件内容），以及绑定的风格库（purpose=style）的统计指纹/高频口癖/少量原文样例，使用强模型（默认 gpt-5）做对照检查：\n" +
      "- 找出“不像”的具体点（含证据与可量化差异）\n" +
      "- 生成一段可直接喂给工作模型（如 deepseek）的 rewritePrompt，用来二次改写\n" +
      "\n" +
      "【推荐工作流】（风格库已绑定且任务为写作类）：\n" +
      "1) 先 kb.search(kind=card, cardTypes=[hook,one_liner,ending,outline,thesis]) 拉套路/结构，再按需 kb.search(kind=paragraph, anchorParagraphIndexMax/anchorFromEndMax) 拉原文证据\n" +
      "2) 先产出一版候选稿（不要立刻写入文件）\n" +
      "3) lint.style(text=候选稿) → 拿 rewritePrompt 再改一版 → 最后 write/edit\n",
    args: [
      { name: "text", required: false, desc: "要检查的候选稿文本（text/path 二选一必填）", type: "string" },
      { name: "path", required: false, desc: "要检查的文件路径（text/path 二选一必填；会优先读取提案态内容）", type: "string" },
      { name: "libraryIds", required: false, desc: "可选：风格库 ID 数组；不传则默认使用右侧已绑定的风格库（purpose=style）", type: "array" },
      { name: "model", required: false, desc: "可选：用于 linter 的强模型（默认优先 LLM_LINTER_MODEL，其次 LLM_CARD_MODEL）", type: "string" },
      { name: "maxIssues", required: false, desc: "\u53ef\u9009\uff1a\u6700\u591a\u8fd4\u56de\u591a\u5c11\u6761\u201c\u4e0d\u50cf\u70b9\u201d\uff08\u9ed8\u8ba4 10\uff09", type: "number" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        path: { type: "string" },
        libraryIds: { type: "array", items: { type: "string" } },
        model: { type: "string" },
        maxIssues: { type: "number" },
      },
      oneOfRequired: [{ required: ["text"] }, { required: ["path"] }],
      additionalProperties: true,
    },
    outputSchema: {
      "type": "object",
      "description": "Style check result",
      "properties": {
        "score": {
          "type": "number",
          "description": "Style similarity score"
        },
        "issues": {
          "type": "array",
          "description": "Issue list",
          "items": {
            "type": "object",
            "properties": {
              "dimension": {
                "type": "string"
              },
              "issue": {
                "type": "string"
              },
              "severity": {
                "type": "string",
                "description": "low|medium|high"
              },
              "rewritePrompt": {
                "type": "string"
              },
              "snippet": {
                "type": "string"
              }
            }
          }
        },
        "rewritePrompt": {
          "type": "string",
          "description": "Unified rewrite prompt"
        },
        "copyRisk": {
          "type": "object",
          "description": "Attached copy risk result",
          "properties": {
            "riskLevel": {
              "type": "string"
            },
            "maxOverlapChars": {
              "type": "number"
            }
          }
        }
      }
    },

  },
  {
    name: "run.mainDoc.get",
    description: "读取本次 Run 的 Main Doc（主文档/主线）。",
    args: [],
    modes: ["agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run.mainDoc.update",
    description: "更新本次 Run 的 Main Doc（主线）。输入 patch(JSON)。",
    args: [{ name: "patch", required: true, desc: "JSON 对象：MainDoc 的增量 patch", type: "object" }],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { patch: { type: "object" } }, required: ["patch"], additionalProperties: true },
  },
  {
    name: "run.todo",
    description:
      "管理本次 Run 的待办事项（增删改清/整体替换）。\n" +
      "action=replace：整体替换 todoList（传 items 数组）。\n" +
      "action=upsert：批量新增或更新（传 items 数组；id 命中则 patch，不命中或无 id 则新增）。\n" +
      "action=update：更新单条（传 id + status/note/text）。todoList 仅 1 条时可省略 id。\n" +
      "action=remove：删除单条（传 id）。\n" +
      "action=clear：清空全部。",
    args: [
      { name: "action", required: true, desc: "操作类型: replace|upsert|update|remove|clear", type: "string" },
      { name: "items", desc: 'upsert 时的 todo 列表：Array<{ id?, text?, status?, note? }>', type: "array" },
      { name: "id", desc: "update/remove 时的 todo ID", type: "string" },
      { name: "status", desc: 'update 时的新状态（"todo"|"in_progress"|"done"|"blocked"|"skipped"）', type: "string" },
      { name: "note", desc: "update 时的备注", type: "string" },
      { name: "text", desc: "update 时的新文本", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        items: { type: "array", items: { type: "object" } },
        id: { type: "string" },
        status: { type: "string" },
        note: { type: "string" },
        text: { type: "string" },
      },
      required: ["action"],
      additionalProperties: true,
    },
  },
  {
    name: "run.done",
    description:
      "显式结束本次 Run（让系统立刻停机，而不是继续多跑一轮）。\n" +
      "【何时用】\n" +
      "- 你确认任务已完成，且不需要再调用任何工具\n" +
      "- 尤其是：已完成写入（write/edit/doc.splitToDir 等）并且 To-do 已清空/全部 done\n" +
      "【注意】调用 run.done 后，系统会生成一份\u201c执行报告\u201d并终止本次 run。",
    args: [{ name: "note", required: false, desc: "可选：完成口径/选取策略的简短备注（<=200字）", type: "string" }],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" } },
      additionalProperties: true,
    },
  },
  // spawn_agent/send_input/resume_agent/wait_agent/close_agent 已合并为 Agent wrapper（见 GatewayRuntime._buildAgentTools）

  {
    name: "project.listFiles",
    description: "列出当前项目文件列表（path）。",
    args: [],
    modes: ["chat", "agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "project.searchPaths",
    description: "按路径/文件名/目录名在当前项目索引中做模糊搜索，不读取文件正文；适合先缩圈到可能文件/目录，再决定是否 read。",
    args: [
      { name: "query", required: true, desc: "路径、文件名、目录名或关键词", type: "string" },
      { name: "kind", required: false, desc: "可选：all/file/dir，默认 all", type: "string" },
      { name: "maxResults", required: false, desc: "可选：返回条数，默认 12，最大 50", type: "number" },
    ],
    modes: ["chat", "agent"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "project.dir.summary",
    description: "查询项目目录摘要，适合回答“哪个目录大概率负责什么 / 某类内容通常在哪块”。不读取文件正文。",
    args: [
      { name: "query", required: true, desc: "目录名、用途关键词或内容关键词", type: "string" },
      { name: "maxResults", required: false, desc: "可选：返回条数，默认 8，最大 20", type: "number" },
    ],
    modes: ["chat", "agent"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "project.file.summary",
    description: "查询项目文件摘要，适合回答“哪类文件最相关 / 某个文档或入口文件大概率是哪一个”。不读取文件正文。",
    args: [
      { name: "query", required: true, desc: "文件名、用途关键词、文档主题或模块关键词", type: "string" },
      { name: "maxResults", required: false, desc: "可选：返回条数，默认 8，最大 20", type: "number" },
    ],
    modes: ["chat", "agent"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "project.search",
    description:
      "按内容/正则在当前项目文本中搜索（跨文件）。\n" +
      "适合在 read 前先定位命中文件与片段；支持正则、大小写和路径范围。",
    args: [
      { name: "query", required: true, desc: "搜索关键字（或正则表达式文本）", type: "string" },
      { name: "useRegex", required: false, desc: "可选：是否按正则搜索（默认 false）", type: "boolean" },
      { name: "caseSensitive", required: false, desc: "可选：是否大小写敏感（默认 false）", type: "boolean" },
      { name: "paths", required: false, desc: "可选：限制搜索范围（JSON 数组：文件路径或目录前缀）", type: "array" },
      { name: "maxResults", required: false, desc: "可选：最多返回多少条命中（默认 80，最大 500）", type: "number" },
      { name: "maxPerFile", required: false, desc: "可选：每个文件最多返回多少条命中（默认 20，最大 200）", type: "number" },
    ],
    modes: ["chat", "agent"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        useRegex: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        paths: { type: "array", items: { type: "string" } },
        maxResults: { type: "number" },
        maxPerFile: { type: "number" },
      },
      required: ["query"],
      additionalProperties: true,
    },
  },
  {
    name: "read",
    description: "读取文件内容（path）。",
    args: [{ name: "path", required: true, desc: "文件路径（如 drafts/draft.md）", type: "string" }],
    modes: ["chat", "agent"],
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: true },
    outputSchema: {
      "type": "object",
      "description": "File content",
      "properties": {
        "path": {
          "type": "string"
        },
        "content": {
          "type": "string"
        },
        "virtualFromProposal": {
          "type": "boolean",
          "description": "Whether from unapplied proposal"
        }
      }
    },

  },
  {
    name: "mkdir",
    description: "创建目录（path）。用于新建文件夹/目录结构。",
    args: [{ name: "path", required: true, desc: "目录路径（如 drafts/ 或 assets/images/）", type: "string" }],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: true },
  },
  {
    name: "skill.install",
    description:
      "安装或更新一个技能到用户全局技能目录（不是当前项目目录），使其被 SkillLoader 热加载。\n" +
      "该操作会写入 Desktop 管理的用户 skills 根目录，通常只应在助手模式下使用。\n" +
      "支持 inline 模式（name + content）和 GitHub 模式（source=github + owner/repo/subdir/ref）。\n" +
      "只用于安装/更新技能文件，不要用于普通文件写入。",
    args: [
      { name: "name", required: false, desc: "inline 模式下的技能 ID（目录名，如 weekly-report-writer）", type: "string" },
      { name: "content", required: false, desc: "inline 模式下的 SKILL.md 完整内容（含 frontmatter + body）", type: "string" },
      { name: "source", required: false, desc: "来源类型；github 表示从 GitHub 仓库目录安装", type: "string" },
      { name: "owner", required: false, desc: "GitHub owner", type: "string" },
      { name: "repo", required: false, desc: "GitHub repo", type: "string" },
      { name: "subdir", required: false, desc: "仓库内 skill 子目录（如 skills/skill-creator）", type: "string" },
      { name: "ref", required: false, desc: "可选 git ref（branch/tag/sha）", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        content: { type: "string" },
        source: { type: "string" },
        owner: { type: "string" },
        repo: { type: "string" },
        subdir: { type: "string" },
        ref: { type: "string" },
      },
      oneOfRequired: [{ required: ["name", "content"] }, { required: ["source", "owner", "repo", "subdir"] }],
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.searchCatalog",
    description: "搜索官方/审核 MCP catalog，返回可安装的 MCP 候选。",
    args: [{ name: "query", required: true, desc: "搜索词", type: "string" }],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.planInstall",
    description: "为某个 MCP 来源生成安装计划，不直接执行安装。支持 catalog item 或 GitHub 仓库 URL。",
    args: [{ name: "source", required: true, desc: "MCP 来源对象", type: "object" }],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "object" },
      },
      required: ["source"],
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.applyInstall",
    description: "根据 source + candidateId + configValues 执行 MCP 安装、连接与验证。仅应在助手模式下使用。",
    args: [
      { name: "source", required: true, desc: "MCP 来源对象", type: "object" },
      { name: "candidateId", required: true, desc: "候选 ID", type: "string" },
      { name: "configValues", required: false, desc: "配置值", type: "object" },
      { name: "confirm", required: true, desc: "显式确认执行安装", type: "boolean" },
    ],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "object" },
        candidateId: { type: "string" },
        configValues: { type: "object" },
        confirm: { type: "boolean" },
      },
      required: ["source", "candidateId", "confirm"],
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.list",
    description: "列出当前已配置 MCP server 的脱敏运行状态与托管状态摘要。",
    args: [],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.updateConfig",
    description: "更新某个 MCP server 的配置，并返回新的脱敏状态摘要。",
    args: [
      { name: "serverId", required: true, desc: "server id", type: "string" },
      { name: "configValues", required: true, desc: "配置更新", type: "object" },
    ],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        configValues: { type: "object" },
      },
      required: ["serverId", "configValues"],
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.enable",
    description: "启用并连接某个 MCP server。",
    args: [{ name: "serverId", required: true, desc: "server id", type: "string" }],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
      },
      required: ["serverId"],
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.disable",
    description: "断开并禁用某个 MCP server。",
    args: [{ name: "serverId", required: true, desc: "server id", type: "string" }],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
      },
      required: ["serverId"],
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.test",
    description: "测试某个已安装 MCP server 的连接状态与工具暴露情况。",
    args: [{ name: "serverId", required: true, desc: "server id", type: "string" }],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
      },
      required: ["serverId"],
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.repairRuntime",
    description: "修复某个 MCP server 所需的运行时环境，然后重新验证。",
    args: [{ name: "serverId", required: true, desc: "server id", type: "string" }],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
      },
      required: ["serverId"],
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.planUpgrade",
    description: "为某个已托管 MCP server 生成升级计划，不直接执行升级。",
    args: [{ name: "serverId", required: true, desc: "server id", type: "string" }],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
      },
      required: ["serverId"],
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.applyUpgrade",
    description: "执行某个已托管 MCP server 的升级，并在完成后重新验证。",
    args: [
      { name: "serverId", required: true, desc: "server id", type: "string" },
      { name: "confirm", required: true, desc: "显式确认执行升级", type: "boolean" },
    ],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["serverId", "confirm"],
      additionalProperties: true,
    },
  },
  {
    name: "mcpServer.uninstall",
    description: "卸载某个已托管 MCP server，并清理托管状态。",
    args: [
      { name: "serverId", required: true, desc: "server id", type: "string" },
      { name: "confirm", required: true, desc: "显式确认执行卸载", type: "boolean" },
    ],
    modes: [],
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["serverId", "confirm"],
      additionalProperties: true,
    },
  },
  {
    name: "rename",
    description: "重命名/移动 文件或目录（fromPath → toPath）。默认自动执行（可 Undo 回滚）。",
    args: [
      { name: "fromPath", required: true, desc: "源路径（文件或目录）", type: "string" },
      { name: "toPath", required: true, desc: "目标路径（文件或目录）", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: { fromPath: { type: "string" }, toPath: { type: "string" } },
      required: ["fromPath", "toPath"],
      additionalProperties: true,
    },
  },
  {
    name: "delete",
    description: "删除文件或目录（path）。高风险操作会先在对话中确认，确认后自动删除；支持 Undo 回滚。",
    args: [{ name: "path", required: true, desc: "文件或目录路径", type: "string" }],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: true },
  },
  {
    name: "write",
    description: "写入文件（path, content）。高风险写入会先在对话中确认，确认后自动执行；支持 Undo 回滚。",
    args: [
      { name: "path", required: true, desc: "文件路径", type: "string" },
      { name: "content", required: true, desc: "文件全文内容", type: "string" },
      { name: "ifExists", required: false, desc: "文件已存在时的策略：rename/overwrite/error", type: "string" },
      { name: "suggestedName", required: false, desc: "建议的新文件名（仅 ifExists=rename 时使用）", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" }, ifExists: { type: "string" }, suggestedName: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: true,
    },
    outputSchema: {
      "type": "object",
      "description": "File write result",
      "properties": {
        "path": {
          "type": "string",
          "description": "Actual written path"
        },
        "created": {
          "type": "boolean",
          "description": "Whether new file created"
        },
        "diffUnified": {
          "type": "string",
          "description": "Unified diff"
        },
        "stats": {
          "type": "object",
          "properties": {
            "added": {
              "type": "number"
            },
            "removed": {
              "type": "number"
            }
          }
        },
        "renamedFrom": {
          "type": "string",
          "description": "Original name if auto-renamed"
        }
      }
    },

  },
  {
    name: "edit",
    description: "对指定文件应用一组 TextEdit（增量编辑，支持 Undo 回滚）。",
    args: [
      { name: "path", required: false, desc: "文件路径（默认 activePath）", type: "string" },
      { name: "edits", required: true, desc: "JSON 数组：TextEdit[]", type: "array" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object" } } },
      required: ["edits"],
      additionalProperties: true,
    },
  },
  // shell.exec + code.exec 已合并为 Bash wrapper（见 GatewayRuntime._buildAgentTools）

  {
    name: "process.run",
    description: "启动一个长时间运行的本地进程（仅管理由 Crab 自己启动的进程）。",
    args: [
      { name: "command", required: true, desc: "命令名或完整命令行", type: "string" },
      { name: "args", required: false, desc: "命令参数数组", type: "array" },
      { name: "cwd", required: false, desc: "可选：工作目录（默认项目目录）", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
      },
      required: ["command"],
      additionalProperties: true,
    },
    outputSchema: {
      type: "object",
      description: "进程启动结果",
      properties: {
        ok: { type: "boolean" },
        /** 统一的“终端会话 ID”语义，对齐 Codex Unified Exec；等价于 id。 */
        processId: { type: "string", description: "终端会话 ID（processId），等价于 id" },
        id: { type: "string", description: "Crab 内部进程 ID（向后兼容字段）" },
        pid: { type: "number", description: "操作系统进程 PID" },
        command: { type: "string", description: "完整命令行" },
        cwd: { type: "string", description: "工作目录" },
        status: { type: "string", description: "当前状态：running|exited|error" },
        startedAt: { type: "number", description: "启动时间（unix ms）" },
        error: { type: "string" },
      },
    },
  },
  {
    name: "process.list",
    description: "列出当前由 Crab 启动并跟踪的本地进程。",
    args: [],
    modes: ["agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      description: "进程列表",
      properties: {
        ok: { type: "boolean" },
        processes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              /** 统一的“终端会话 ID”语义，对齐 Codex Unified Exec；等价于 id。 */
              processId: { type: "string" },
              id: { type: "string" },
              pid: { type: "number" },
              command: { type: "string" },
              cwd: { type: "string" },
              status: { type: "string" },
              startedAt: { type: "number" },
              endedAt: { type: "number" },
              exitCode: { type: "number" },
              signal: { type: "string" },
              lastError: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    name: "process.stop",
    description: "停止一个由 Crab 启动并跟踪的本地进程（仅限自身启动的进程）。",
    args: [
      { name: "id", required: true, desc: "Crab 内部进程 ID", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      description: "停止结果",
      properties: {
        ok: { type: "boolean" },
        /** 统一的“终端会话 ID”语义，对齐 Codex Unified Exec；等价于 id。 */
        processId: { type: "string" },
        id: { type: "string" },
        stopped: { type: "boolean" },
        pid: { type: "number" },
        status: { type: "string" },
        error: { type: "string" },
      },
    },
  },
  {
    name: "cron.create",
    description: "创建一个基于本地 automations 的简单定时任务（封装 Codex automation）。",
    args: [
      { name: "name", required: true, desc: "任务名称", type: "string" },
      { name: "prompt", required: true, desc: "任务说明/要做的事", type: "string" },
      { name: "rrule", required: true, desc: "调度规则（如 FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0）", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string" },
        rrule: { type: "string" },
      },
      required: ["name", "prompt", "rrule"],
      additionalProperties: true,
    },
    outputSchema: {
      type: "object",
      description: "定时任务创建结果",
      properties: {
        ok: { type: "boolean" },
        id: { type: "string" },
        error: { type: "string" },
      },
    },
  },
  {
    name: "cron.list",
    description: "列出当前本地 automations 中与项目相关的定时任务。",
    args: [],
    modes: ["agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      description: "定时任务列表",
      properties: {
        ok: { type: "boolean" },
        automations: { type: "array", items: { type: "object" } },
      },
    },
  },
  // ── MCP 信息（只读）──────────────────────────────────
  {
    name: "mcp.info",
    description:
      "查看当前已连接的 MCP Server 列表及其工具概况（只读，无副作用）。\n" +
      "返回每个 server 的名称、连接状态、工具数量和工具名列表。\n" +
      "创作模式和助手模式均可用。",
    args: [
      { name: "serverId", required: false, desc: "可选：只查某个 server 的详情", type: "string" },
    ],
    modes: ["chat", "agent"] as ToolMode[],
    inputSchema: {
      type: "object" as const,
      properties: {
        serverId: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object" as const,
      description: "MCP server 信息",
      properties: {
        ok: { type: "boolean" as const },
        servers: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              id: { type: "string" as const },
              name: { type: "string" as const },
              status: { type: "string" as const },
              toolCount: { type: "number" as const },
              toolNames: { type: "array" as const, items: { type: "string" as const } },
            },
          },
        },
      },
    },
  },
  // ── 记忆系统 ──────────────────────────────────────
  {
    name: "memory",
    description:
      "管理跨对话持久记忆（读取或更新）。\n" +
      "action=read：读取记忆内容（传 level）。\n" +
      "action=update：追加新事实/决策到指定 section（传 level + section + content）。\n" +
      "level='global'（L1 全局：用户画像/决策偏好/跨项目进展）。\n" +
      "level='project'（L2 项目：项目概况/项目决策/重要约定/当前进展）。\n" +
      "只应记录值得跨对话持久化的重要信息。",
    args: [
      { name: "action", required: true, desc: "操作类型: read|update", type: "string" as ToolArgType },
      { name: "level", required: true, desc: "记忆层级：'global'（L1 全局）或 'project'（L2 项目）", type: "string" as ToolArgType },
      { name: "section", desc: "update 时必填的 section 标题（如 项目决策、用户画像 等）", type: "string" as ToolArgType },
      { name: "content", desc: "update 时必填的追加内容（Markdown 格式）", type: "string" as ToolArgType },
    ],
    modes: ["agent" as ToolMode],
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string" as ToolArgType },
        level: { type: "string" as ToolArgType },
        section: { type: "string" as ToolArgType },
        content: { type: "string" as ToolArgType },
      },
      required: ["action", "level"],
    },
  },
];

export function getToolsForMode(mode: ToolMode) {
  return TOOL_LIST.filter((t) => (!Array.isArray(t.modes) ? true : t.modes.includes(mode)));
}

export function toolsPrompt(mode: ToolMode) {
  const list = getToolsForMode(mode);
  if (!list.length) return "（当前模式不允许调用工具）\n";
  return list
    .map((t) => {
      const args = t.args.length ? t.args.map((a) => `- ${a.required ? "(必填) " : ""}${a.name}: ${a.desc}`).join("\n") : "- （无参数）";
      return `工具：${t.name}\n说明：${t.description}\n参数：\n${args}\n`;
    })
    .join("\n");
}

export function toolNamesForMode(mode: ToolMode) {
  return new Set(getToolsForMode(mode).map((t) => t.name));
}

export function getToolMeta(name: string): ToolMeta | null {
  const key = String(name ?? "").trim();
  if (!key) return null;
  return TOOL_LIST.find((t) => t.name === key) ?? null;
}

/** Standard tool error codes */
export type ToolErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "EXECUTION_ERROR"
  | "TIMEOUT"
  | "RATE_LIMIT";

/** Standard tool error */
export type ToolError = {
  code: ToolErrorCode | (string & {});
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

/** Standard tool handler result */
export type ToolHandlerResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError };

export function toolOk<T>(data: T): ToolHandlerResult<T> {
  return { ok: true, data };
}

export function toolErr(
  code: ToolErrorCode | (string & {}),
  message: string,
  opts?: { retryable?: boolean; retryAfterMs?: number },
): ToolHandlerResult<never> {
  return { ok: false, error: { code, message, retryable: opts?.retryable ?? false, retryAfterMs: opts?.retryAfterMs } };
}

export type ToolArgValidationError = ToolError & {
  field?: string;
};

export function validateToolCallArgs(args: { name: string; toolArgs: Record<string, unknown> }) {
  const meta = getToolMeta(args.name);
  if (!meta?.inputSchema) return { ok: true as const };

  const schema = meta.inputSchema;
  const rawArgs = args.toolArgs ?? {};

  const hasNonEmpty = (k: string) => {
    const v = rawArgs[k];
    if (v === null || v === undefined) return false;
    if (typeof v === "string") return v.trim().length > 0;
    return true;
  };

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const k of required) {
    if (!hasNonEmpty(k)) {
      return { ok: false as const, error: { code: "MISSING_REQUIRED", message: `缺少必填参数：${k}`, field: k, retryable: false } satisfies ToolArgValidationError };
    }
  }

  const oneOf = Array.isArray(schema.oneOfRequired) ? schema.oneOfRequired : [];
  if (oneOf.length) {
    const ok = oneOf.some((g) => Array.isArray(g.required) && g.required.length && g.required.every((k) => hasNonEmpty(k)));
    if (!ok) {
      return {
        ok: false as const,
        error: {
          code: "ONE_OF_REQUIRED",
          message: `参数不满足二选一约束：${oneOf.map((g) => `[${g.required.join(", ")}]`).join(" 或 ")}`,
          retryable: false,
        } satisfies ToolArgValidationError,
      };
    }
  }

  for (const [k, v] of Object.entries(rawArgs)) {
    if (!schema.properties?.[k]) continue;
    const rule = schema.properties[k]!;
    if (v === null || v === undefined) continue;

    if (rule.type === "number") {
      if (typeof v === "number") {
        if (!Number.isFinite(v)) return { ok: false as const, error: { code: "INVALID_NUMBER", message: `参数 ${k} 不是合法数字`, field: k, retryable: false } satisfies ToolArgValidationError };
      } else {
        const n = Number(String(v));
        if (!Number.isFinite(n)) return { ok: false as const, error: { code: "INVALID_NUMBER", message: `参数 ${k} 不是合法数字`, field: k, retryable: false } satisfies ToolArgValidationError };
      }
    } else if (rule.type === "boolean") {
      if (typeof v !== "boolean") {
        const t = String(v).trim().toLowerCase();
        const ok = t === "true" || t === "false" || t === "1" || t === "0";
        if (!ok) return { ok: false as const, error: { code: "INVALID_BOOLEAN", message: `参数 ${k} 不是合法布尔值(true/false)`, field: k, retryable: false } satisfies ToolArgValidationError };
      }
    } else if (rule.type === "array") {
      if (Array.isArray(v)) { /* native array — ok */ }
      else if (typeof v === "string") {
        try { if (!Array.isArray(JSON.parse(v))) return { ok: false as const, error: { code: "JSON_TYPE_MISMATCH", message: `参数 ${k} 必须是数组`, field: k, retryable: false } satisfies ToolArgValidationError }; }
        catch { return { ok: false as const, error: { code: "INVALID_JSON", message: `参数 ${k} 不是合法 JSON`, field: k, retryable: false } satisfies ToolArgValidationError }; }
      } else {
        return { ok: false as const, error: { code: "JSON_TYPE_MISMATCH", message: `参数 ${k} 必须是数组`, field: k, retryable: false } satisfies ToolArgValidationError };
      }
    } else if (rule.type === "object") {
      if (typeof v === "object" && !Array.isArray(v)) { /* native object — ok */ }
      else if (typeof v === "string") {
        try { const p = JSON.parse(v); if (p === null || Array.isArray(p) || typeof p !== "object") return { ok: false as const, error: { code: "JSON_TYPE_MISMATCH", message: `参数 ${k} 必须是对象`, field: k, retryable: false } satisfies ToolArgValidationError }; }
        catch { return { ok: false as const, error: { code: "INVALID_JSON", message: `参数 ${k} 不是合法 JSON`, field: k, retryable: false } satisfies ToolArgValidationError }; }
      } else {
        return { ok: false as const, error: { code: "JSON_TYPE_MISMATCH", message: `参数 ${k} 必须是对象`, field: k, retryable: false } satisfies ToolArgValidationError };
      }
    }
  }

  return { ok: true as const };
}

export type ToolSchemaIssue = {
  toolName: string;
  code:
    | "TOP_LEVEL_NOT_OBJECT"
    | "TOP_LEVEL_COMBINATOR_FORBIDDEN"
    | "PROPERTIES_NOT_OBJECT"
    | "ARRAY_ITEMS_MISSING"
    | "ONE_OF_REQUIRED_FIELD_NOT_DEFINED";
  message: string;
  path?: string;
};

export function collectToolSchemaIssues(toolList: ToolMeta[] = TOOL_LIST): ToolSchemaIssue[] {
  const out: ToolSchemaIssue[] = [];
  for (const tool of toolList) {
    const schema = tool?.inputSchema as any;
    if (!schema) continue;
    const toolName = String(tool?.name ?? "").trim() || "unknown";
    if (String(schema?.type ?? "") !== "object") {
      out.push({
        toolName,
        code: "TOP_LEVEL_NOT_OBJECT",
        message: "inputSchema 顶层必须是 type=object。",
        path: "inputSchema.type",
      });
      continue;
    }
    for (const k of ["oneOf", "anyOf", "allOf", "enum", "not"]) {
      if (schema?.[k] !== undefined) {
        out.push({
          toolName,
          code: "TOP_LEVEL_COMBINATOR_FORBIDDEN",
          message: `inputSchema 顶层禁止包含 ${k}。`,
          path: `inputSchema.${k}`,
        });
      }
    }

    const properties = schema?.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      out.push({
        toolName,
        code: "PROPERTIES_NOT_OBJECT",
        message: "inputSchema.properties 必须是对象。",
        path: "inputSchema.properties",
      });
      continue;
    }

    for (const [propName, propRule] of Object.entries(properties as Record<string, any>)) {
      if (String(propRule?.type ?? "") === "array" && (propRule?.items === undefined || propRule?.items === null)) {
        out.push({
          toolName,
          code: "ARRAY_ITEMS_MISSING",
          message: `数组字段 ${propName} 缺少 items 定义（会被适配层自动兜底为 {}，建议补齐）。`,
          path: `inputSchema.properties.${propName}.items`,
        });
      }
    }

    const oneOf = Array.isArray(schema?.oneOfRequired) ? schema.oneOfRequired : [];
    if (oneOf.length > 0) {
      for (const group of oneOf) {
        const req = Array.isArray(group?.required) ? group.required : [];
        for (const field of req) {
          if (!Object.prototype.hasOwnProperty.call(properties, field)) {
            out.push({
              toolName,
              code: "ONE_OF_REQUIRED_FIELD_NOT_DEFINED",
              message: `oneOfRequired 引用了未定义字段：${field}`,
              path: "inputSchema.oneOfRequired",
            });
          }
        }
      }
    }
  }
  return out;
}
