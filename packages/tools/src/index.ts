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
  properties: Record<string, { type: ToolArgType }>;
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
  return encoded.replace(/_dot_/g, ".");
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
      "抽卡完成后库自动 attach，后续写作请求可直接通过 kb.search 检索使用。",
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
      { name: "useVector", required: false, desc: "可选：是否使用向量做重排（true/false；默认 true）", type: "boolean" },
      { name: "embeddingModel", required: false, desc: '可选：向量模型 id（例如 "text-embedding-3-large" 或 "Embedding-V1"）', type: "string" },
    ],
    modes: ["chat", "agent"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string" },
        libraryIds: { type: "array" },
        facetIds: { type: "array" },
        cardTypes: { type: "array" },
        anchorParagraphIndexMax: { type: "number" },
        anchorFromEndMax: { type: "number" },
        debug: { type: "boolean" },
        perDocTopN: { type: "number" },
        topDocs: { type: "number" },
        useVector: { type: "boolean" },
        embeddingModel: { type: "string" },
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
        libraryIds: { type: "array" },
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
      "3) lint.style(text=候选稿) → 拿 rewritePrompt 再改一版 → 最后 doc.write/doc.applyEdits\n",
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
        libraryIds: { type: "array" },
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
    name: "run.setTodoList",
    description: "设置本次 Run 的 Todo List（用于进度追踪与防跑偏）。",
    args: [{ name: "items", required: true, desc: 'JSON 数组：TodoItem[]（{ id?, text, status?, note? }）', type: "array" }],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { items: { type: "array" } }, required: ["items"], additionalProperties: true },
  },
  {
    name: "run.updateTodo",
    description:
      "更新某一条 Todo 的状态/备注（用于记录进度；legacy）。\n" +
      "- 推荐优先用 run.todo.update（扁平参数版，LLM 更不容易漏 patch）。\n" +
      "- 本工具兼容两种入参：\n" +
      "  A) patch(JSON)：{ status?, note?, text? }\n" +
      "  B) 顶层字段：status/note/text（Gateway 会自动封装成 patch）",
    args: [
      { name: "id", required: false, desc: "Todo ID（来自 run.setTodoList 的返回）。若当前仅有 1 条 todo，可省略。", type: "string" },
      { name: "patch", required: false, desc: "JSON 对象：{ status?, note?, text? }（推荐写法）", type: "object" },
      { name: "status", required: false, desc: '可选：状态（"todo"|"in_progress"|"done"|"blocked"|"skipped"）', type: "string" },
      { name: "note", required: false, desc: "可选：备注/阻塞原因", type: "string" },
      { name: "text", required: false, desc: "可选：更新文本", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        patch: { type: "object" },
        status: { type: "string" },
        note: { type: "string" },
        text: { type: "string" },
      },
      // patch 或任意一个扁平字段必须存在（避免空调用浪费协议重试预算）
      oneOfRequired: [{ required: ["patch"] }, { required: ["status"] }, { required: ["note"] }, { required: ["text"] }],
      additionalProperties: true,
    },
  },
  {
    name: "run.todo.upsertMany",
    description:
      "批量 upsert Todo（新增或更新）。\n" +
      "- 若传入 id 且命中现有 todo：按提供字段 patch（未提供的不改）。\n" +
      "- 若 id 不命中或未传 id：视为新增（需要 text），自动生成稳定 id 并追加到列表末尾。\n" +
      "用于避免模型反复 run.setTodoList 覆盖进度。",
    args: [
      {
        name: "items",
        required: true,
        desc: 'JSON 数组：Array<{ id?: string; text?: string; status?: "todo"|"in_progress"|"done"|"blocked"|"skipped"; note?: string }>',
        type: "array",
      },
    ],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { items: { type: "array" } }, required: ["items"], additionalProperties: true },
  },
  {
    name: "run.todo.update",
    description:
      "更新某一条 Todo（扁平参数版，LLM 更不容易漏 patch）。\n" +
      "- 当 todoList 只有 1 条时可省略 id；否则必须传 id。",
    args: [
      { name: "id", required: false, desc: "Todo ID（可省略：仅当当前 todoList 只有 1 条）", type: "string" },
      { name: "text", required: false, desc: "可选：更新文本", type: "string" },
      { name: "status", required: false, desc: '可选：状态（"todo"|"in_progress"|"done"|"blocked"|"skipped"）', type: "string" },
      { name: "note", required: false, desc: "可选：备注/阻塞原因", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        status: { type: "string" },
        note: { type: "string" },
      },
      additionalProperties: true,
    },
  },
  {
    name: "run.todo.remove",
    description: "删除一条 Todo（按 id）。",
    args: [{ name: "id", required: true, desc: "Todo ID", type: "string" }],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: true },
  },
  {
    name: "run.todo.clear",
    description: "清空本次 Run 的 Todo List。",
    args: [],
    modes: ["agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run.done",
    description:
      "显式结束本次 Run（让系统立刻停机，而不是继续多跑一轮）。\n" +
      "【何时用】\n" +
      "- 你确认任务已完成，且不需要再调用任何工具\n" +
      "- 尤其是：已完成写入（doc.write/doc.applyEdits/doc.splitToDir 等）并且 To-do 已清空/全部 done\n" +
      "【注意】调用 run.done 后，系统会生成一份\u201c执行报告\u201d并终止本次 run。",
    args: [{ name: "note", required: false, desc: "可选：完成口径/选取策略的简短备注（<=200字）", type: "string" }],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" } },
      additionalProperties: true,
    },
  },
  {
    name: "project.listFiles",
    description: "列出当前项目文件列表（path）。",
    args: [],
    modes: ["chat", "agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "project.docRules.get",
    description: "读取项目级 Doc Rules（doc.rules.md）。",
    args: [],
    modes: ["chat", "agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "project.search",
    description:
      "在当前项目中搜索文本（跨文件）。\n" +
      "- 这是 IDE 级“Find in Files”的基础能力。\n" +
      "- 默认只搜索项目内可见的文本文件（如 .md/.mdx/.txt）。\n" +
      "- 若要限定范围，请先用 project.listFiles 观察路径，再用 paths 传入文件/目录前缀过滤。",
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
        paths: { type: "array" },
        maxResults: { type: "number" },
        maxPerFile: { type: "number" },
      },
      required: ["query"],
      additionalProperties: true,
    },
  },
  {
    name: "doc.read",
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
    name: "doc.mkdir",
    description: "创建目录（path）。用于新建文件夹/目录结构。",
    args: [{ name: "path", required: true, desc: "目录路径（如 drafts/ 或 assets/images/）", type: "string" }],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: true },
  },
  {
    name: "doc.renamePath",
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
    name: "doc.deletePath",
    description: "删除文件或目录（path）。真删磁盘内容；默认自动执行（可 Undo 回滚）。",
    args: [{ name: "path", required: true, desc: "文件或目录路径", type: "string" }],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: true },
  },
  {
    name: "doc.commitSnapshot",
    description: "创建一个项目快照（用于回滚/Undo）。",
    args: [{ name: "label", required: false, desc: "快照备注（可选）", type: "string" }],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { label: { type: "string" } }, additionalProperties: true },
  },
  {
    name: "doc.listSnapshots",
    description: "列出当前项目的快照列表（只读）。",
    args: [],
    modes: ["agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "doc.restoreSnapshot",
    description: "恢复到指定快照（proposal-first：Keep 才会真正恢复；Undo 可回滚）。",
    args: [{ name: "snapshotId", required: true, desc: "快照 ID（doc.commitSnapshot 的返回）", type: "string" }],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { snapshotId: { type: "string" } }, required: ["snapshotId"], additionalProperties: true },
  },
  {
    name: "doc.previewDiff",
    description: "生成 diff 预览（无副作用）。可传 newContent 或 edits。ifExists 默认 rename，避免覆盖已有文件。",
    args: [
      { name: "path", required: true, desc: "文件路径", type: "string" },
      { name: "newContent", required: false, desc: "新内容全文", type: "string" },
      { name: "edits", required: false, desc: "JSON 数组：TextEdit[]", type: "array" },
      { name: "ifExists", required: false, desc: "文件已存在时的策略：rename/overwrite/error", type: "string" },
      { name: "suggestedName", required: false, desc: "建议的新文件名（仅 ifExists=rename 时使用）", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        newContent: { type: "string" },
        edits: { type: "array" },
        ifExists: { type: "string" },
        suggestedName: { type: "string" },
      },
      required: ["path"],
      additionalProperties: true,
    },
  },
  {
    name: "doc.write",
    description: "写入文件（path, content）。新建可自动落盘；覆盖会走提案确认（Keep）。ifExists 默认 rename。",
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
    name: "doc.splitToDir",
    description: "\u5c06\u4e00\u4e2a\u5927\u6587\u6863\u6309\u201c\u6807\u9898/\u6587\u6848(\u6b63\u6587)\u201d\u5757\u5206\u5272\u6210\u591a\u7bc7\uff0c\u5e76\u5199\u5165\u76ee\u6807\u6587\u4ef6\u5939\uff08proposal-first\uff1aKeep \u624d\u4f1a\u771f\u6b63\u5199\u5165\uff1bUndo \u53ef\u56de\u6eda\uff09\u3002",
    args: [
      { name: "path", required: true, desc: "源文件路径（如 直男财经.md）", type: "string" },
      { name: "targetDir", required: true, desc: "目标目录（如 直男财经/）", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { path: { type: "string" }, targetDir: { type: "string" } }, required: ["path", "targetDir"], additionalProperties: true },
  },
  {
    name: "doc.getSelection",
    description: "获取编辑器当前选区内容。",
    args: [],
    modes: ["agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "doc.replaceSelection",
    description: "替换当前选区为 text（可 Undo）。",
    args: [{ name: "text", required: true, desc: "替换后的文本", type: "string" }],
    modes: ["agent"],
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: true },
  },
  {
    name: "doc.applyEdits",
    description: "对指定文件应用一组 TextEdit（默认提案，Keep 才 apply）。",
    args: [
      { name: "path", required: false, desc: "文件路径（默认 activePath）", type: "string" },
      { name: "edits", required: true, desc: "JSON 数组：TextEdit[]", type: "array" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, edits: { type: "array" } },
      required: ["edits"],
      additionalProperties: true,
    },
  },
  {
    name: "agent.delegate",
    description:
      "负责人将任务委托给子 Agent（员工）执行。\n" +
      "只有负责人可调用此工具（子 Agent 不可再委托）。\n" +
      "调用后 Gateway 会启动独立的子 Agent 推理循环，完成后产物返回负责人上下文。",
    args: [
      { name: "agentId", required: true, desc: "目标子 Agent ID（如 copywriter、seo_specialist）", type: "string" },
      { name: "task", required: true, desc: "任务描述（自然语言，尽量具体）", type: "string" },
      { name: "inputArtifacts", required: false, desc: "上游产物引用（JSON 数组：串联场景传入前一个 Agent 的产出）", type: "array" },
      { name: "acceptanceCriteria", required: false, desc: "验收标准（可选）", type: "string" },
      { name: "budget", required: false, desc: "覆盖默认预算（JSON 对象：{ maxTurns?, maxToolCalls?, timeoutMs? }）", type: "object" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        task: { type: "string" },
        inputArtifacts: { type: "array" },
        acceptanceCriteria: { type: "string" },
        budget: { type: "object" },
      },
      required: ["agentId", "task"],
    },
    outputSchema: {
      type: "object",
      description: "agent.delegate 返回值",
      properties: {
        agentId: { type: "string", description: "执行的子 Agent ID" },
        status: { type: "string", description: "执行状态：completed / error / timeout" },
        artifact: { type: "string", description: "子 Agent 产出的主要内容" },
        turnsUsed: { type: "number", description: "实际使用的推理轮数" },
        toolCallsUsed: { type: "number", description: "实际使用的工具调用次数" },
      },
    },
  },
  // ── agent.config.* ─────────────────────────────
  {
    name: "agent.config.create",
    description:
      "创建一个自定义子 Agent（团队成员）。\n" +
      "创建后立即生效，负责人可通过 agent.delegate 委托任务给它。",
    args: [
      { name: "name", required: true, desc: "显示名称（最长 32 字符）", type: "string" },
      { name: "description", required: true, desc: "一句话职责描述（最长 200 字符）", type: "string" },
      { name: "systemPrompt", required: true, desc: "完整的 system prompt（指导子 Agent 的行为）", type: "string" },
      { name: "tools", required: false, desc: "工具白名单（JSON 字符串数组；不传则为空）", type: "array" },
      { name: "model", required: false, desc: "偏好模型（如 sonnet / haiku；默认 haiku）", type: "string" },
      { name: "toolPolicy", required: false, desc: "工具策略：readonly / proposal_first / auto_apply（默认 proposal_first）", type: "string" },
      { name: "budget", required: false, desc: "执行预算 JSON 对象", type: "object" },
      { name: "triggerPatterns", required: false, desc: "触发关键词数组", type: "array" },
      { name: "avatar", required: false, desc: "头像（emoji 或图片 URL）", type: "string" },
      { name: "priority", required: false, desc: "优先级（默认 50）", type: "number" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        systemPrompt: { type: "string" },
        tools: { type: "array" },
        model: { type: "string" },
        toolPolicy: { type: "string" },
        budget: { type: "object" },
        triggerPatterns: { type: "array" },
        avatar: { type: "string" },
        priority: { type: "number" },
      },
      required: ["name", "description", "systemPrompt"],
    },
  },
  {
    name: "agent.config.list",
    description: "列出所有子 Agent（内置 + 自定义），包含各自的启用状态、工具列表、模型等配置。",
    args: [],
    modes: ["agent"],
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent.config.update",
    description:
      "更新子 Agent 配置。\n" +
      "自定义 Agent（custom_ 开头）可修改全部字段；内置 Agent 只能修改 enabled 状态。",
    args: [
      { name: "agentId", required: true, desc: "要更新的 Agent ID", type: "string" },
      { name: "enabled", required: false, desc: "启用/禁用", type: "boolean" },
      { name: "name", required: false, desc: "新的显示名称", type: "string" },
      { name: "description", required: false, desc: "新的职责描述", type: "string" },
      { name: "systemPrompt", required: false, desc: "新的 system prompt", type: "string" },
      { name: "tools", required: false, desc: "新的工具白名单", type: "array" },
      { name: "model", required: false, desc: "新的偏好模型", type: "string" },
      { name: "toolPolicy", required: false, desc: "新的工具策略", type: "string" },
      { name: "budget", required: false, desc: "新的执行预算", type: "object" },
      { name: "triggerPatterns", required: false, desc: "新的触发关键词", type: "array" },
      { name: "avatar", required: false, desc: "新的头像", type: "string" },
      { name: "priority", required: false, desc: "新的优先级", type: "number" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        enabled: { type: "boolean" },
        name: { type: "string" },
        description: { type: "string" },
        systemPrompt: { type: "string" },
        tools: { type: "array" },
        model: { type: "string" },
        toolPolicy: { type: "string" },
        budget: { type: "object" },
        triggerPatterns: { type: "array" },
        avatar: { type: "string" },
        priority: { type: "number" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "agent.config.remove",
    description: "删除一个自定义子 Agent。内置 Agent 不可删除（只能通过 agent.config.update 禁用）。",
    args: [
      { name: "agentId", required: true, desc: "要删除的自定义 Agent ID（必须以 custom_ 开头）", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
      },
      required: ["agentId"],
    },
  },
];

export function getToolsForMode(mode: ToolMode) {
  return TOOL_LIST.filter((t) => (t.modes?.length ? t.modes.includes(mode) : true));
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









