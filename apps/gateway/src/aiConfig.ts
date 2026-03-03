import crypto from "node:crypto";
import type { AiConfig, AiModel, AiModelTestResult, AiProvider, AiStageConfig, Db, LlmModelPrice } from "./db.js";
import { isGeminiEndpoint } from "./llm/gemini.js";

export type AiStageDefinition = {
  key: string;
  name: string;
  description: string;
  defaultModel: string;
  defaultTemperature: number | null;
  defaultMaxTokens: number | null;
  defaultEndpoint: string; // 建议包含 /v1 前缀（对齐锦李2.0）
};

export type ResolvedAiStageRuntime = {
  stage: string;
  modelId: string;
  baseURL: string;
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
};

export type ResolvedAiModelRuntime = {
  modelId: string;
  baseURL: string;
  endpoint: string;
  apiKey: string;
  model: string;
  toolResultFormat: "xml" | "text";
};

export type AiModelListItem = Omit<AiModel, "apiKeyEnc"> & {
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  providerName: string | null;
  providerBaseURL: string | null;
};

export type AiProviderListItem = Omit<AiProvider, "apiKeyEnc"> & {
  hasApiKey: boolean;
  apiKeyMasked: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeApiKeyInput(key: string): string {
  const s = String(key || "").trim();
  if (!s) return "";
  return s.replace(/^bearer\s+/i, "").trim();
}

function safeLast4(key: string): string {
  const s = normalizeApiKeyInput(key);
  if (!s) return "";
  return s.slice(-4);
}

function normalizeBaseURL(baseURL: string): string {
  return String(baseURL || "").trim().replace(/\/+$/g, "");
}

function normalizeEndpoint(endpoint: string, fallback: string): string {
  const raw = String(endpoint || "").trim();
  const v = raw || fallback;
  if (!v) return fallback;
  return v.startsWith("/") ? v : `/${v}`;
}

function joinUrl(baseURL: string, endpoint: string): string {
  const b = normalizeBaseURL(baseURL);
  const e = String(endpoint || "").trim();
  return `${b}${e.startsWith("/") ? "" : "/"}${e}`;
}

function getEncKey(): Buffer {
  const secret =
    String(process.env.AI_CONFIG_SECRET ?? "").trim() ||
    String(process.env.JWT_SECRET ?? "").trim() ||
    "dev-ai-config-secret";
  return crypto.createHash("sha256").update(secret).digest(); // 32 bytes
}

function encryptApiKey(apiKey: string): { enc: string; last4: string } {
  const normalized = normalizeApiKeyInput(apiKey);
  if (!normalized) throw new Error("apiKey_empty");
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let ciphertext = cipher.update(normalized, "utf8");
  ciphertext = Buffer.concat([ciphertext, cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ciphertext.toString("base64"),
  };
  return { enc: JSON.stringify(payload), last4: safeLast4(normalized) };
}

function decryptApiKey(enc: string): string {
  if (!enc) return "";
  const key = getEncKey();
  const payload = JSON.parse(enc) as { v: number; iv: string; tag: string; ct: string };
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ct = Buffer.from(payload.ct, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plaintext = decipher.update(ct, undefined, "utf8");
  plaintext += decipher.final("utf8");
  return plaintext;
}

function clampList<T>(arr: T[], max: number) {
  return arr.length > max ? arr.slice(0, max) : arr;
}

function normalizeModelId(model: string) {
  return String(model || "").trim();
}

function truncateId(raw: string, max = 96) {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function makeUniqueId(existing: Set<string>, base: string) {
  const b = truncateId(base || "", 96);
  let id = b || `model-${Date.now()}`;
  id = truncateId(id, 96);
  if (!existing.has(id)) return id;
  let i = 2;
  while (existing.has(truncateId(`${b}-${i}`, 96))) i += 1;
  return truncateId(`${b}-${i}`, 96);
}

function repairDuplicateModelIds(models: AiModel[]) {
  const used = new Set<string>();
  let changed = false;
  const next = models.map((m) => {
    const cur = String((m as any)?.id || "").trim();
    const modelName = String((m as any)?.model || "").trim();
    const providerId = String((m as any)?.providerId || "").trim();
    const base = truncateId(cur || (providerId ? `${modelName}-${providerId}` : modelName) || "model", 96);
    const id = cur && !used.has(cur) ? cur : makeUniqueId(used, base);
    if (!cur || used.has(cur)) changed = true;
    used.add(id);
    return id === cur ? m : { ...m, id };
  });
  return { changed, models: next };
}

function normalizeProviderId(idOrName: string) {
  const raw = String(idOrName || "").trim();
  if (!raw) return "";
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii) return ascii.slice(0, 64);
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 10);
  return `provider-${hash}`;
}

function hasPricing(m: AiModel) {
  return (
    typeof m.priceInCnyPer1M === "number" &&
    typeof m.priceOutCnyPer1M === "number" &&
    Number.isFinite(m.priceInCnyPer1M) &&
    Number.isFinite(m.priceOutCnyPer1M) &&
    m.priceInCnyPer1M >= 0 &&
    m.priceOutCnyPer1M >= 0
  );
}

export function getDefaultStageDefinitionsFromEnv(): AiStageDefinition[] {
  const llmModel = String(process.env.LLM_MODEL ?? "").trim();
  const embedModels = String(process.env.LLM_EMBED_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const embedModel = embedModels[0] || "text-embedding-3-large";
  const cardModel = String(process.env.LLM_CARD_MODEL ?? "").trim() || llmModel;
  const toolRepairModel =
    String(process.env.LLM_TOOL_REPAIR_MODEL ?? "").trim() ||
    String(process.env.LLM_CARD_MODEL ?? "").trim() ||
    llmModel;
  const contextSelectorModel =
    String(process.env.LLM_CONTEXT_SELECTOR_MODEL ?? "").trim() || toolRepairModel || llmModel;
  const linterModel =
    String(process.env.LLM_LINTER_MODEL ?? "").trim() ||
    String(process.env.LLM_CARD_MODEL ?? "").trim() ||
    llmModel;

  return [
    {
      key: "llm.chat",
      name: "LLM Chat（对话）",
      description: "Chat 模式与通用对话（/v1/chat/completions）",
      defaultModel: llmModel,
      defaultTemperature: 0.7,
      defaultMaxTokens: 8000,
      defaultEndpoint: "/v1/chat/completions",
    },
    {
      key: "agent.run",
      name: "Agent Run（Plan/Agent）",
      description: "写作 Agent 编排（/v1/chat/completions）",
      defaultModel: llmModel,
      defaultTemperature: 0.7,
      defaultMaxTokens: 8000,
      defaultEndpoint: "/v1/chat/completions",
    },
    {
      key: "agent.context_summary",
      name: "Agent Context Summary（滚动摘要/上下文压缩）",
      description:
        "用于对话滚动摘要（每 3–5 轮压缩一次）以减少上下文膨胀；默认可复用 Agent 选用的模型，也可在 B 端独立配置（热生效）",
      defaultModel: llmModel,
      defaultTemperature: 0.2,
      defaultMaxTokens: 1200,
      defaultEndpoint: "/v1/chat/completions",
    },
    {
      key: "agent.router",
      name: "Agent Router（意图门禁）",
      description: "Intent Router（Phase 1：LLM Router stage）。只输出结构化路由决策 JSON；不调用工具；失败应回退到启发式路由。",
      defaultModel: llmModel,
      defaultTemperature: 0.2,
      defaultMaxTokens: 600,
      defaultEndpoint: "/v1/chat/completions",
    },
    {
      key: "agent.context_selector",
      name: "Agent Context Selector（上下文注入选择器）",
      description:
        "Context Pack Selector：用小模型在预算内挑选“本轮需要注入的上下文段落/提示”。只输出 JSON；不调用工具；失败应回退到固定策略。",
      defaultModel: contextSelectorModel,
      defaultTemperature: 0,
      defaultMaxTokens: 600,
      defaultEndpoint: "/v1/chat/completions",
    },
    {
      key: "agent.skill.style_imitate",
      name: "Skill：Style Imitate（风格仿写闭环）",
      description: "style_imitate skill 激活时使用（独立 stageKey：agent.skill.style_imitate）",
      defaultModel: llmModel,
      defaultTemperature: 0.7,
      defaultMaxTokens: 8000,
      defaultEndpoint: "/v1/chat/completions",
    },
    {
      key: "agent.tool_call_repair",
      name: "Agent Tool Call Repair（工具 XML/参数 修复器）",
      description:
        "当模型输出的 <tool_calls> XML 解析失败、或工具参数未通过 schema 校验时，用一个“小模型”把输出修成严格可解析的工具调用。\n" +
        "注意：它只是“格式/参数修复器”，不是决策器；最终仍会经过工具白名单与 schema 校验，不通过则丢弃并回退到让主模型重试。",
      defaultModel: toolRepairModel,
      defaultTemperature: 0,
      defaultMaxTokens: 1200,
      defaultEndpoint: "/v1/chat/completions",
    },
    {
      key: "embedding",
      name: "Embedding（向量）",
      description: "向量检索与入库 embedding（/v1/embeddings）",
      defaultModel: embedModel,
      defaultTemperature: null,
      defaultMaxTokens: null,
      defaultEndpoint: "/v1/embeddings",
    },
    {
      key: "rag.ingest.extract_cards",
      name: "KB：抽卡/结构化",
      description: "抽取知识卡（抽卡、分类等后台工作流）",
      defaultModel: cardModel,
      defaultTemperature: 0.2,
      defaultMaxTokens: 16000,
      defaultEndpoint: "/v1/chat/completions",
    },
    {
      key: "rag.ingest.build_library_playbook",
      name: "KB：生成仿写手册",
      description: "从要素卡生成库级仿写手册（StyleProfile/Facet Playbook）",
      defaultModel: cardModel,
      defaultTemperature: 0.2,
      defaultMaxTokens: 16000,
      defaultEndpoint: "/v1/chat/completions",
    },
    {
      key: "lint.style",
      name: "Style Linter（风格对齐）",
      description: "lint.style 强模型对齐检查（终稿闸门）",
      defaultModel: linterModel,
      defaultTemperature: 0.2,
      defaultMaxTokens: 2000,
      defaultEndpoint: "/v1/chat/completions",
    },
  ];
}

export function createAiConfigService(args: {
  loadDb: () => Promise<Db>;
  saveDb: (db: Db) => Promise<void>;
  updateDb?: <T>(fn: (db: Db) => Promise<T> | T) => Promise<T>;
  cacheTtlMs?: number;
  stageDefinitions?: AiStageDefinition[];
}) {
  const TTL = Number.isFinite(args.cacheTtlMs as any) ? Math.max(0, Number(args.cacheTtlMs)) : 5000;
  const defs = args.stageDefinitions?.length ? args.stageDefinitions : getDefaultStageDefinitionsFromEnv();
  const defMap = new Map(defs.map((d) => [d.key, d]));

  let cached: { at: number; ai: AiConfig } | null = null;

  const clearCache = () => {
    cached = null;
  };

  const getAiConfig = async (): Promise<AiConfig> => {
    const now = Date.now();
    if (cached && now - cached.at < TTL) return cached.ai;
    const db = await args.loadDb();
    const ai: AiConfig =
      db.aiConfig && typeof db.aiConfig === "object"
        ? db.aiConfig
        : {
            updatedAt: nowIso(),
            providers: [],
            models: [],
            stages: [],
          };
    cached = { at: now, ai };
    return ai;
  };

  const saveAiConfig = async (ai: AiConfig, updatedBy?: string | null) => {
    const next: AiConfig = { ...ai, updatedAt: nowIso() };
    // 轻量修正：保证模型/阶段字段存在
    next.providers = Array.isArray((next as any).providers) ? (next as any).providers : [];
    next.models = Array.isArray(next.models) ? next.models : [];
    next.stages = Array.isArray(next.stages) ? next.stages : [];
    if (args.updateDb) {
      await args.updateDb((db) => {
        db.aiConfig = next;
      });
    } else {
      const db = await args.loadDb();
      db.aiConfig = next;
      await args.saveDb(db);
    }
    clearCache();
    void updatedBy;
  };

  const ensureDefaults = async () => {
    const apply = async (db: Db) => {
      const ai: AiConfig =
        db.aiConfig && typeof db.aiConfig === "object"
          ? db.aiConfig
          : {
              updatedAt: nowIso(),
              providers: [],
              models: [],
              stages: [],
            };

    // 修复历史遗留：同名模型导致 id 重复，进而 B 端测速/适配“串台”
    if (Array.isArray(ai.models) && ai.models.length) {
      const repaired = repairDuplicateModelIds(ai.models);
      if (repaired.changed) ai.models = repaired.models;
    }

    const byId = new Map<string, AiModel>((ai.models ?? []).map((m) => [m.id, m]));

    const envBase = normalizeBaseURL(String(process.env.LLM_BASE_URL ?? ""));
    const envKey = normalizeApiKeyInput(String(process.env.LLM_API_KEY ?? ""));
    const envEmbedBase = normalizeBaseURL(String(process.env.LLM_EMBED_BASE_URL ?? process.env.LLM_BASE_URL ?? ""));
    const envEmbedKey =
      normalizeApiKeyInput(String(process.env.LLM_EMBED_API_KEY ?? "")) ||
      normalizeApiKeyInput(String(process.env.LLM_CARD_API_KEY ?? "")) ||
      envKey;
    const envCardBase =
      normalizeBaseURL(String(process.env.LLM_CARD_BASE_URL ?? "")) || envBase;
    const envCardKey =
      normalizeApiKeyInput(String(process.env.LLM_CARD_API_KEY ?? "")) || envKey;
    const envLinterBase =
      normalizeBaseURL(String(process.env.LLM_LINTER_BASE_URL ?? "")) || envCardBase || envBase;
    const envLinterKey =
      normalizeApiKeyInput(String(process.env.LLM_LINTER_API_KEY ?? "")) || envCardKey || envKey;
    const envToolRepairBase =
      normalizeBaseURL(String(process.env.LLM_TOOL_REPAIR_BASE_URL ?? "")) || envBase;
    const envToolRepairKey =
      normalizeApiKeyInput(String(process.env.LLM_TOOL_REPAIR_API_KEY ?? "")) || envKey;
    const envContextSelectorBase =
      normalizeBaseURL(String(process.env.LLM_CONTEXT_SELECTOR_BASE_URL ?? "")) || envToolRepairBase || envBase;
    const envContextSelectorKey =
      normalizeApiKeyInput(String(process.env.LLM_CONTEXT_SELECTOR_API_KEY ?? "")) || envToolRepairKey || envKey;
    const envOpusModel = normalizeModelId(String(process.env.LLM_OPUS_MODEL ?? ""));
    const envHaikuModel = normalizeModelId(String(process.env.LLM_HAIKU_MODEL ?? ""));
    const envHaikuBase = normalizeBaseURL(String(process.env.LLM_HAIKU_BASE_URL ?? "")) || envBase;
    const envHaikuKey = normalizeApiKeyInput(String(process.env.LLM_HAIKU_API_KEY ?? "")) || envKey;
    const envOpenAiModel = normalizeModelId(String(process.env.LLM_OPENAI_MODEL ?? ""));
    const envOpenAiBase = normalizeBaseURL(String(process.env.LLM_OPENAI_BASE_URL ?? "")) || envBase;
    const envOpenAiKey = normalizeApiKeyInput(String(process.env.LLM_OPENAI_API_KEY ?? "")) || envKey;
    const envOpenAiEndpoint = normalizeEndpoint(String(process.env.LLM_OPENAI_ENDPOINT ?? "/v1/responses"), "/v1/responses");

    const pickCredsForStage = (stageKey: string) => {
      if (stageKey === "embedding") return { baseURL: envEmbedBase || envBase, apiKey: envEmbedKey || envKey };
      if (stageKey.startsWith("rag.ingest.")) return { baseURL: envCardBase || envBase, apiKey: envCardKey || envKey };
      if (stageKey === "lint.style") return { baseURL: envLinterBase || envBase, apiKey: envLinterKey || envKey };
      if (stageKey === "agent.tool_call_repair") return { baseURL: envToolRepairBase || envBase, apiKey: envToolRepairKey || envKey };
      if (stageKey === "agent.context_selector") return { baseURL: envContextSelectorBase || envBase, apiKey: envContextSelectorKey || envKey };
      if (stageKey === "llm.haiku") return { baseURL: envHaikuBase || envBase, apiKey: envHaikuKey || envKey };
      if (stageKey === "llm.openai") return { baseURL: envOpenAiBase || envBase, apiKey: envOpenAiKey || envKey };
      return { baseURL: envBase, apiKey: envKey };
    };

    const ensureModel = (modelId: string, stageKey: string, endpoint: string) => {
      const id = normalizeModelId(modelId);
      if (!id) return null;
      const existed = byId.get(id);
      if (existed) return existed;
      const creds = pickCredsForStage(stageKey);
      if (!creds.baseURL) return null;

      const enc = creds.apiKey ? encryptApiKey(creds.apiKey) : null;
      const t = nowIso();
      const endpointNorm = normalizeEndpoint(endpoint, "/v1/chat/completions");
      const useTextToolResult = /\/responses/i.test(endpointNorm);
      const m: AiModel = {
        id,
        model: id,
        providerId: null,
        baseURL: creds.baseURL,
        endpoint: endpointNorm,
        // /responses 在部分 OpenAI-compatible 上对 system+xml 注入兼容较差，默认改为 text 更稳。
        toolResultFormat: useTextToolResult ? "text" : "xml",
        apiKeyEnc: enc ? enc.enc : null,
        apiKeyLast4: enc ? enc.last4 : null,
        priceInCnyPer1M: null,
        priceOutCnyPer1M: null,
        billingGroup: null,
        isEnabled: true,
        sortOrder: 0,
        description: "自动初始化：来自 env 默认值（开发期兜底）",
        testResult: null,
        updatedBy: "system",
        createdAt: t,
        updatedAt: t,
      };
      byId.set(id, m);
      ai.models = [...(ai.models ?? []), m];
      return m;
    };

    // 1) 确保所有 stage 的默认模型都有一个 model 条目（能取到 baseURL/apiKey 时）
    for (const d of defs) {
      ensureModel(d.defaultModel, d.key, d.defaultEndpoint);
    }
    // 1.1) env 额外声明的 opus 模型（共用 chat creds）
    if (envOpusModel) {
      const chatEndpoint = defMap.get("llm.chat")?.defaultEndpoint || "/v1/chat/completions";
      ensureModel(envOpusModel, "llm.chat", chatEndpoint);
    }
    // 1.2) env 额外声明的 haiku 模型（可独立配置 LLM_HAIKU_BASE_URL/API_KEY，未配置则回退主 LLM）
    if (envHaikuModel) {
      const chatEndpoint = defMap.get("llm.chat")?.defaultEndpoint || "/v1/chat/completions";
      ensureModel(envHaikuModel, "llm.haiku", chatEndpoint);
    }
    // 1.3) env 额外声明的 OpenAI Responses 模型（默认 endpoint=/v1/responses）
    if (envOpenAiModel) {
      ensureModel(envOpenAiModel, "llm.openai", envOpenAiEndpoint);
      const openAiDoc = byId.get(envOpenAiModel);
      if (openAiDoc) {
        const ep = normalizeEndpoint(openAiDoc.endpoint, "/v1/chat/completions");
        if (/\/responses/i.test(ep) && openAiDoc.toolResultFormat !== "text") {
          openAiDoc.toolResultFormat = "text";
          openAiDoc.updatedAt = nowIso();
          openAiDoc.updatedBy = "system";
        }
      }
    }

    // 2) 确保所有 stage 都有 stage 配置（缺失则补齐）
    const stageMap = new Map<string, AiStageConfig>((ai.stages ?? []).map((s) => [s.stage, s]));
    const t = nowIso();
    for (const d of defs) {
      if (stageMap.has(d.key)) continue;
      const m = byId.get(normalizeModelId(d.defaultModel)) || null;
      const allowMulti = d.key !== "embedding";
      const s: AiStageConfig = {
        stage: d.key,
        modelId: m ? m.id : null,
        // 候选模型列表（按优先级）：非 embedding stage 默认允许配置，用于“备用模型/fallback”。
        modelIds: allowMulti ? (m ? [m.id] : null) : null,
        temperature: d.defaultTemperature,
        maxTokens: d.defaultMaxTokens,
        isEnabled: true,
        updatedBy: "system",
        createdAt: t,
        updatedAt: t,
      };
      stageMap.set(d.key, s);
      ai.stages = [...(ai.stages ?? []), s];
    }

    // 3) 把 env opus 模型追加到 chat/agent 的候选列表中（仅在模型已启用时）
    const opusDoc = envOpusModel ? byId.get(envOpusModel) : null;
    if (envOpusModel && opusDoc?.isEnabled) {
      const appendToStage = (stage: AiStageConfig | undefined, modelId: string) => {
        if (!stage || stage.stage === "embedding") return;
        const cur = Array.isArray(stage.modelIds)
          ? stage.modelIds.map((x) => normalizeModelId(String(x))).filter(Boolean)
          : [];
        const merged = Array.from(
          new Set([...cur, normalizeModelId(String(stage.modelId ?? "")), modelId].filter(Boolean)),
        ).slice(0, 60);
        if (merged.join(",") !== (cur.join(",") || "")) {
          stage.modelIds = merged.length ? merged : null;
          stage.updatedAt = nowIso();
        }
      };
      appendToStage(stageMap.get("llm.chat"), envOpusModel);
      appendToStage(stageMap.get("agent.run"), envOpusModel);
    }

    // 3.1) 把 env OpenAI 模型追加到 chat/agent 候选列表（用于 C 端模型切换）
    const openAiDoc = envOpenAiModel ? byId.get(envOpenAiModel) : null;
    if (envOpenAiModel && openAiDoc?.isEnabled) {
      const appendToStage = (stage: AiStageConfig | undefined, modelId: string) => {
        if (!stage || stage.stage === "embedding") return;
        const cur = Array.isArray(stage.modelIds)
          ? stage.modelIds.map((x) => normalizeModelId(String(x))).filter(Boolean)
          : [];
        const merged = Array.from(
          new Set([...cur, normalizeModelId(String(stage.modelId ?? "")), modelId].filter(Boolean)),
        ).slice(0, 60);
        if (merged.join(",") !== (cur.join(",") || "")) {
          stage.modelIds = merged.length ? merged : null;
          stage.updatedAt = nowIso();
        }
      };
      appendToStage(stageMap.get("llm.chat"), envOpenAiModel);
      appendToStage(stageMap.get("agent.run"), envOpenAiModel);
    }

      db.aiConfig = { ...ai, updatedAt: nowIso() };
    };

    if (args.updateDb) {
      await args.updateDb(async (db) => {
        await apply(db);
      });
    } else {
      const db = await args.loadDb();
      await apply(db);
      await args.saveDb(db);
    }
    clearCache();
  };

  const listProviders = async (): Promise<AiProviderListItem[]> => {
    const ai = await getAiConfig();
    const providers = Array.isArray((ai as any).providers) ? ((ai as any).providers as AiProvider[]).slice() : [];
    providers.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.name).localeCompare(String(b.name)));
    return providers.map((p) => {
      const { apiKeyEnc, ...rest } = p as any;
      const hasApiKey = Boolean(apiKeyEnc);
      const apiKeyMasked = p.apiKeyLast4 ? `****${p.apiKeyLast4}` : null;
      return { ...(rest as any), hasApiKey, apiKeyMasked } as AiProviderListItem;
    });
  };

  const getProviderById = (ai: AiConfig, id: string): AiProvider | null => {
    const key = normalizeProviderId(id);
    if (!key) return null;
    const providers = Array.isArray((ai as any).providers) ? ((ai as any).providers as AiProvider[]) : [];
    return providers.find((p) => p.id === key) || null;
  };

  const createProvider = async (params: {
    name: string;
    baseURL: string;
    apiKey?: string;
    isEnabled?: boolean;
    sortOrder?: number;
    description?: string | null;
    updatedBy?: string | null;
  }): Promise<string> => {
    const ai = await getAiConfig();
    const name = String(params.name || "").trim();
    if (!name) throw new Error("provider_name_required");
    const baseURL = normalizeBaseURL(params.baseURL);
    if (!baseURL) throw new Error("provider_baseURL_required");

    const providers = Array.isArray((ai as any).providers) ? (((ai as any).providers as AiProvider[]) ?? []) : [];
    const byId = new Map(providers.map((p) => [p.id, p]));

    const baseId = normalizeProviderId(name);
    let id = baseId;
    if (!id) id = normalizeProviderId(`provider-${Date.now()}`);
    if (!id) throw new Error("provider_id_invalid");
    if (byId.has(id)) {
      let i = 2;
      while (byId.has(`${id}-${i}`)) i += 1;
      id = `${id}-${i}`;
    }

    const apiKeyInput = normalizeApiKeyInput(params.apiKey || "");
    let apiKeyEnc: string | null = null;
    let apiKeyLast4: string | null = null;
    if (apiKeyInput) {
      const enc = encryptApiKey(apiKeyInput);
      apiKeyEnc = enc.enc;
      apiKeyLast4 = enc.last4;
    }

    const t = nowIso();
    const item: AiProvider = {
      id,
      name,
      baseURL,
      apiKeyEnc,
      apiKeyLast4,
      isEnabled: params.isEnabled === false ? false : true,
      sortOrder: Number.isFinite(params.sortOrder as any) ? Number(params.sortOrder) : 0,
      description: params.description !== undefined ? (params.description === null ? null : String(params.description)) : null,
      updatedBy: params.updatedBy ?? null,
      createdAt: t,
      updatedAt: t,
    };

    const next: AiConfig = {
      ...ai,
      updatedAt: t,
      providers: clampList([...(providers ?? []), item], 200),
      models: ai.models ?? [],
      stages: ai.stages ?? [],
    };
    await saveAiConfig(next, params.updatedBy);
    return item.id;
  };

  const updateProvider = async (
    id: string,
    patch: Partial<{
      name: string;
      baseURL: string;
      apiKey: string;
      clearApiKey: boolean;
      isEnabled: boolean;
      sortOrder: number;
      description: string | null;
      updatedBy: string | null;
    }>,
  ) => {
    const ai = await getAiConfig();
    const key = normalizeProviderId(id);
    if (!key) throw new Error("provider_id_invalid");
    const providers = Array.isArray((ai as any).providers) ? (((ai as any).providers as AiProvider[]) ?? []) : [];
    const cur = providers.find((p) => p.id === key) || null;
    if (!cur) throw new Error("provider_not_found");

    const nextName = patch.name !== undefined ? String(patch.name || "").trim() : cur.name;
    if (!nextName) throw new Error("provider_name_required");
    const nextBaseURL = patch.baseURL !== undefined ? normalizeBaseURL(patch.baseURL) : cur.baseURL;
    if (!nextBaseURL) throw new Error("provider_baseURL_required");

    let apiKeyEnc = cur.apiKeyEnc;
    let apiKeyLast4 = cur.apiKeyLast4;
    if (patch.clearApiKey) {
      apiKeyEnc = null;
      apiKeyLast4 = null;
    } else if (patch.apiKey !== undefined) {
      const apiKey = normalizeApiKeyInput(patch.apiKey);
      if (apiKey) {
        const enc = encryptApiKey(apiKey);
        apiKeyEnc = enc.enc;
        apiKeyLast4 = enc.last4;
      }
    }

    const t = nowIso();
    const updated: AiProvider = {
      ...cur,
      name: nextName,
      baseURL: nextBaseURL,
      apiKeyEnc,
      apiKeyLast4,
      isEnabled: patch.isEnabled !== undefined ? Boolean(patch.isEnabled) : cur.isEnabled,
      sortOrder: patch.sortOrder !== undefined ? Number(patch.sortOrder) : cur.sortOrder,
      description: patch.description !== undefined ? patch.description : cur.description,
      updatedBy: patch.updatedBy ?? cur.updatedBy,
      updatedAt: t,
    };

    const next: AiConfig = {
      ...ai,
      updatedAt: t,
      providers: providers.map((p) => (p.id === cur.id ? updated : p)),
      models: ai.models ?? [],
      stages: ai.stages ?? [],
    };
    await saveAiConfig(next, patch.updatedBy);
  };

  const deleteProvider = async (id: string) => {
    const ai = await getAiConfig();
    const key = normalizeProviderId(id);
    if (!key) throw new Error("provider_id_invalid");
    const models = ai.models ?? [];
    if (models.some((m) => (m as any).providerId === key)) throw new Error("provider_in_use");
    const providers = Array.isArray((ai as any).providers) ? (((ai as any).providers as AiProvider[]) ?? []) : [];
    const next: AiConfig = {
      ...ai,
      updatedAt: nowIso(),
      providers: providers.filter((p) => p.id !== key),
      models,
      stages: ai.stages ?? [],
    };
    await saveAiConfig(next);
  };

  const listModels = async (): Promise<AiModelListItem[]> => {
    const ai = await getAiConfig();
    const providers = Array.isArray((ai as any).providers) ? (((ai as any).providers as AiProvider[]) ?? []) : [];
    const providerMap = new Map(providers.map((p) => [p.id, p]));
    const models = Array.isArray(ai.models) ? ai.models.slice() : [];
    models.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.model).localeCompare(String(b.model)));
    return models.map((m) => {
      const provider = m.providerId ? providerMap.get(m.providerId) || null : null;
      const last4 = m.apiKeyLast4 || provider?.apiKeyLast4 || null;
      const hasApiKey = Boolean(m.apiKeyEnc) || Boolean(provider?.apiKeyEnc);
      const { apiKeyEnc: _apiKeyEnc, ...rest } = m as any;
      return {
        ...(rest as any),
        hasApiKey,
        apiKeyMasked: last4 ? `****${last4}` : null,
        providerName: provider?.name ?? null,
        providerBaseURL: provider ? normalizeBaseURL(provider.baseURL) : null,
      } as AiModelListItem;
    });
  };

  const getModelById = async (id: string): Promise<AiModel | null> => {
    const ai = await getAiConfig();
    const key = normalizeModelId(id);
    const m = (ai.models ?? []).find((x) => x.id === key) || null;
    return m;
  };

  const resolveStage = async (stage: string): Promise<ResolvedAiStageRuntime> => {
    const key = String(stage || "").trim();
    const def = defMap.get(key);
    if (!def) throw new Error(`unknown_stage:${key}`);
    const ai = await getAiConfig();
    const stageCfg = (ai.stages ?? []).find((s) => s.stage === key) || null;

    // 缺配置：按 ensureDefaults 兜底补齐一次
    if (!stageCfg) {
      await ensureDefaults();
      return resolveStage(key);
    }

    if (!stageCfg.isEnabled) throw new Error(`stage_disabled:${key}`);

    const modelId = stageCfg.modelId || normalizeModelId(def.defaultModel);
    if (!modelId) throw new Error(`missing_model_for_stage:${key}`);
    const modelDoc = (ai.models ?? []).find((m) => m.id === modelId) || null;
    if (!modelDoc || !modelDoc.isEnabled) throw new Error(`model_not_available:${modelId}`);

    const provider = modelDoc.providerId ? getProviderById(ai, modelDoc.providerId) : null;
    if (provider && !provider.isEnabled) throw new Error(`provider_not_available:${provider.id}`);
    const apiKeyEnc = modelDoc.apiKeyEnc || provider?.apiKeyEnc || null;
    const apiKey = apiKeyEnc ? normalizeApiKeyInput(decryptApiKey(apiKeyEnc)) : "";
    const endpoint = normalizeEndpoint(modelDoc.endpoint, def.defaultEndpoint);
    return {
      stage: key,
      modelId: modelDoc.id,
      baseURL: normalizeBaseURL(provider?.baseURL || modelDoc.baseURL),
      endpoint,
      apiKey,
      model: modelDoc.model,
      temperature: stageCfg.temperature ?? def.defaultTemperature,
      maxTokens: stageCfg.maxTokens ?? def.defaultMaxTokens,
    };
  };

  const resolveModel = async (modelId: string): Promise<ResolvedAiModelRuntime> => {
    const id = normalizeModelId(modelId);
    if (!id) throw new Error("model_required");
    const ai = await getAiConfig();
    const modelDoc = (ai.models ?? []).find((m) => m.id === id) || null;
    if (!modelDoc || !modelDoc.isEnabled) throw new Error(`model_not_available:${id}`);
    const provider = modelDoc.providerId ? getProviderById(ai, modelDoc.providerId) : null;
    if (provider && !provider.isEnabled) throw new Error(`provider_not_available:${provider.id}`);
    const apiKeyEnc = modelDoc.apiKeyEnc || provider?.apiKeyEnc || null;
    const apiKey = apiKeyEnc ? normalizeApiKeyInput(decryptApiKey(apiKeyEnc)) : "";
    const endpoint = normalizeEndpoint(modelDoc.endpoint, "/v1/chat/completions");
    return {
      modelId: modelDoc.id,
      baseURL: normalizeBaseURL(provider?.baseURL || modelDoc.baseURL),
      endpoint,
      apiKey,
      model: modelDoc.model,
      toolResultFormat: modelDoc.toolResultFormat === "text" ? "text" : "xml",
    };
  };

  const getModelPricing = async (modelId: string): Promise<LlmModelPrice | null> => {
    const m = await getModelById(modelId);
    if (!m) return null;
    if (!hasPricing(m)) return null;
    return { priceInCnyPer1M: m.priceInCnyPer1M!, priceOutCnyPer1M: m.priceOutCnyPer1M! };
  };

  const createModel = async (params: {
    model: string;
    providerId?: string | null;
    baseURL?: string;
    endpoint?: string;
    apiKey?: string;
    copyFromId?: string;
    toolResultFormat?: "xml" | "text";
    priceInCnyPer1M: number;
    priceOutCnyPer1M: number;
    billingGroup?: string | null;
    isEnabled?: boolean;
    sortOrder?: number;
    description?: string | null;
    updatedBy?: string | null;
  }): Promise<string> => {
    const ai = await getAiConfig();
    const model = normalizeModelId(params.model);
    if (!model) throw new Error("model_required");

    let providerId: string | null = params.providerId ? normalizeProviderId(params.providerId) : null;
    let provider: AiProvider | null = providerId ? getProviderById(ai, providerId) : null;
    if (providerId && !provider) throw new Error("provider_not_found");
    if (provider && !provider.isEnabled) throw new Error("provider_not_available");

    const baseURL = normalizeBaseURL(provider?.baseURL || String(params.baseURL || ""));
    if (!baseURL) throw new Error("baseURL_required");
    const endpoint = normalizeEndpoint(params.endpoint || "/v1/chat/completions", "/v1/chat/completions");
    const priceIn = Number(params.priceInCnyPer1M);
    const priceOut = Number(params.priceOutCnyPer1M);
    if (!Number.isFinite(priceIn) || !Number.isFinite(priceOut) || priceIn < 0 || priceOut < 0) throw new Error("pricing_invalid");

    const apiKeyInput = normalizeApiKeyInput(params.apiKey || "");
    let apiKeyEnc: string | null = null;
    let apiKeyLast4: string | null = null;
    let toolResultFormat: "xml" | "text" = params.toolResultFormat === "text" ? "text" : "xml";
    if (apiKeyInput) {
      const enc = encryptApiKey(apiKeyInput);
      apiKeyEnc = enc.enc;
      apiKeyLast4 = enc.last4;
    } else if (params.copyFromId) {
      const src = (ai.models ?? []).find((m) => m.id === String(params.copyFromId).trim()) || null;
      if (!src) throw new Error("copyFrom_not_found");
      // 允许 copyFrom 带出 provider（便于“同供应商下新增模型”）
      if (!providerId && src.providerId) {
        const pid = normalizeProviderId(src.providerId);
        const p = pid ? getProviderById(ai, pid) : null;
        if (p && p.isEnabled) {
          providerId = pid;
          provider = p;
        }
      }
      if (src.apiKeyEnc) {
        apiKeyEnc = src.apiKeyEnc;
        apiKeyLast4 = src.apiKeyLast4;
      }
      // 继承 tool_result 兼容性配置（若本次未显式指定）
      if (params.toolResultFormat === undefined && src.toolResultFormat === "text") toolResultFormat = "text";
    }

    // apiKey：允许“模型不存 key，仅引用 provider 的 key”
    if (!apiKeyEnc && !provider?.apiKeyEnc) throw new Error("apiKey_required");
    if (!apiKeyLast4) apiKeyLast4 = provider?.apiKeyLast4 ?? null;

    // 防止“看起来一模一样”的重复（model/provider/baseURL/endpoint/key后四位相同）
    const dup = (ai.models ?? []).find(
      (m) =>
        m.model === model &&
        String(m.providerId || "") === String(providerId || "") &&
        normalizeBaseURL(m.baseURL) === baseURL &&
        normalizeEndpoint(m.endpoint, "/v1/chat/completions") === endpoint &&
        String(m.apiKeyLast4 || "") === String(apiKeyLast4 || ""),
    );
    if (dup) throw new Error("duplicate_model");

    // 生成唯一 id：避免同名模型导致 B 端测速/适配状态串联（React key / Record key 都会撞）
    const existingIds = new Set<string>((ai.models ?? []).map((m) => String(m.id || "").trim()).filter(Boolean));
    const idBase = providerId ? `${model}-${providerId}` : model;
    const id = makeUniqueId(existingIds, idBase);

    const t = nowIso();
    const item: AiModel = {
      id,
      model,
      providerId: providerId || null,
      baseURL,
      endpoint,
      toolResultFormat,
      apiKeyEnc,
      apiKeyLast4,
      priceInCnyPer1M: priceIn,
      priceOutCnyPer1M: priceOut,
      billingGroup: params.billingGroup ?? null,
      isEnabled: params.isEnabled === false ? false : true,
      sortOrder: Number.isFinite(params.sortOrder as any) ? Number(params.sortOrder) : 0,
      description: typeof params.description === "string" ? params.description.trim() : null,
      testResult: null,
      updatedBy: params.updatedBy ?? null,
      createdAt: t,
      updatedAt: t,
    };

    const next: AiConfig = {
      ...ai,
      updatedAt: t,
      models: clampList([...(ai.models ?? []), item], 500),
      stages: ai.stages ?? [],
    };
    await saveAiConfig(next, params.updatedBy);
    return item.id;
  };

  const updateModel = async (
    id: string,
    patch: Partial<{
      model: string;
      providerId: string | null;
      baseURL: string;
      endpoint: string;
      toolResultFormat: "xml" | "text";
      apiKey: string;
      clearApiKey: boolean;
      priceInCnyPer1M: number | null;
      priceOutCnyPer1M: number | null;
      billingGroup: string | null;
      isEnabled: boolean;
      sortOrder: number;
      description: string | null;
      updatedBy: string | null;
    }>,
  ) => {
    const ai = await getAiConfig();
    const key = normalizeModelId(id);
    const cur = (ai.models ?? []).find((m) => m.id === key) || null;
    if (!cur) throw new Error("model_not_found");

    const nextModel = patch.model !== undefined ? normalizeModelId(patch.model) : cur.model;

    const nextProviderId =
      patch.providerId !== undefined ? (patch.providerId ? normalizeProviderId(patch.providerId) : null) : cur.providerId ?? null;
    const nextProvider = nextProviderId ? getProviderById(ai, nextProviderId) : null;
    if (nextProviderId && !nextProvider) throw new Error("provider_not_found");
    if (nextProvider && !nextProvider.isEnabled) throw new Error("provider_not_available");

    const nextBase = nextProvider ? normalizeBaseURL(nextProvider.baseURL) : patch.baseURL !== undefined ? normalizeBaseURL(patch.baseURL) : cur.baseURL;
    const nextEndpoint = patch.endpoint !== undefined ? normalizeEndpoint(patch.endpoint, cur.endpoint) : cur.endpoint;
    const nextToolResultFormat = patch.toolResultFormat !== undefined ? (patch.toolResultFormat === "text" ? "text" : "xml") : cur.toolResultFormat === "text" ? "text" : "xml";

    let apiKeyEnc = cur.apiKeyEnc;
    let apiKeyLast4 = cur.apiKeyLast4;

    // 切换到 provider：默认清掉模型自带 key，让 key 统一从 provider 读取（除非本次显式传 apiKey 覆盖）
    if (patch.providerId !== undefined && nextProviderId && nextProviderId !== cur.providerId) {
      if (patch.apiKey === undefined && !patch.clearApiKey) {
        apiKeyEnc = null;
        apiKeyLast4 = null;
      }
    }
    if (patch.clearApiKey) {
      apiKeyEnc = null;
      apiKeyLast4 = null;
    } else if (patch.apiKey !== undefined) {
      const apiKey = normalizeApiKeyInput(patch.apiKey);
      if (apiKey) {
        const enc = encryptApiKey(apiKey);
        apiKeyEnc = enc.enc;
        apiKeyLast4 = enc.last4;
      }
    }

    if (!apiKeyLast4) apiKeyLast4 = nextProvider?.apiKeyLast4 ?? null;

    const priceIn =
      patch.priceInCnyPer1M !== undefined ? (patch.priceInCnyPer1M === null ? null : Number(patch.priceInCnyPer1M)) : cur.priceInCnyPer1M;
    const priceOut =
      patch.priceOutCnyPer1M !== undefined ? (patch.priceOutCnyPer1M === null ? null : Number(patch.priceOutCnyPer1M)) : cur.priceOutCnyPer1M;
    if (priceIn !== null && (!Number.isFinite(priceIn) || priceIn < 0)) throw new Error("pricing_invalid");
    if (priceOut !== null && (!Number.isFinite(priceOut) || priceOut < 0)) throw new Error("pricing_invalid");

    // 防重复（排除自己）
    if (apiKeyLast4) {
      const dup = (ai.models ?? []).find(
        (m) =>
          m.id !== cur.id &&
          m.model === nextModel &&
          String(m.providerId || "") === String(nextProviderId || "") &&
          normalizeBaseURL(m.baseURL) === nextBase &&
          normalizeEndpoint(m.endpoint, "/v1/chat/completions") === nextEndpoint &&
          String(m.apiKeyLast4 || "") === String(apiKeyLast4 || ""),
      );
      if (dup) throw new Error("duplicate_model");
    }

    const t = nowIso();
    const updated: AiModel = {
      ...cur,
      model: nextModel,
      providerId: nextProviderId || null,
      baseURL: nextBase,
      endpoint: nextEndpoint,
      toolResultFormat: nextToolResultFormat,
      apiKeyEnc,
      apiKeyLast4,
      priceInCnyPer1M: priceIn,
      priceOutCnyPer1M: priceOut,
      billingGroup: patch.billingGroup !== undefined ? patch.billingGroup : cur.billingGroup,
      isEnabled: patch.isEnabled !== undefined ? Boolean(patch.isEnabled) : cur.isEnabled,
      sortOrder: patch.sortOrder !== undefined ? Number(patch.sortOrder) : cur.sortOrder,
      description: patch.description !== undefined ? patch.description : cur.description,
      updatedBy: patch.updatedBy ?? cur.updatedBy,
      updatedAt: t,
    };

    const next: AiConfig = {
      ...ai,
      updatedAt: t,
      models: (ai.models ?? []).map((m) => (m.id === cur.id ? updated : m)),
      stages: ai.stages ?? [],
    };
    await saveAiConfig(next, patch.updatedBy);
  };

  const deleteModel = async (id: string) => {
    const ai = await getAiConfig();
    const key = normalizeModelId(id);
    const inUse = (ai.stages ?? []).some((s) => s.modelId === key || (Array.isArray((s as any).modelIds) && ((s as any).modelIds as string[]).includes(key)));
    if (inUse) throw new Error("model_in_use");
    const next: AiConfig = {
      ...ai,
      updatedAt: nowIso(),
      models: (ai.models ?? []).filter((m) => m.id !== key),
      stages: ai.stages ?? [],
    };
    await saveAiConfig(next);
  };

  const listStages = async () => {
    const ai = await getAiConfig();
    const providers = Array.isArray((ai as any).providers) ? (((ai as any).providers as AiProvider[]) ?? []) : [];
    const providerMap = new Map(providers.map((p) => [p.id, p]));
    const models = ai.models ?? [];
    const stageMap = new Map<string, AiStageConfig>((ai.stages ?? []).map((s) => [s.stage, s]));
    return defs.map((d) => {
      const s = stageMap.get(d.key) || null;
      const modelId = s?.modelId || normalizeModelId(d.defaultModel);
      const m = models.find((x) => x.id === modelId) || null;
      const p = m?.providerId ? providerMap.get(m.providerId) || null : null;
      const stageModelIds =
        Array.isArray((s as any)?.modelIds) && ((s as any).modelIds as any[]).length
          ? (((s as any).modelIds as any[]).map((x) => String(x)).filter(Boolean) as string[])
          : d.key !== "embedding"
            ? m
              ? [m.id]
              : modelId
                ? [modelId]
                : null
            : null;
      return {
        stage: d.key,
        name: d.name,
        description: d.description,
        modelId: m ? m.id : modelId,
        model: m ? m.model : d.defaultModel,
        modelIds: stageModelIds,
        baseURL: m ? normalizeBaseURL(p?.baseURL || m.baseURL) : "",
        endpoint: m ? m.endpoint : d.defaultEndpoint,
        temperature: s?.temperature ?? d.defaultTemperature,
        maxTokens: s?.maxTokens ?? d.defaultMaxTokens,
        isEnabled: s?.isEnabled ?? true,
      };
    });
  };

  const upsertStages = async (configs: Array<Pick<AiStageConfig, "stage"> & Partial<AiStageConfig>>, updatedBy?: string | null) => {
    const ai = await getAiConfig();
    const stageKeys = new Set(defs.map((d) => d.key));
    const models = ai.models ?? [];
    const stageMap = new Map<string, AiStageConfig>((ai.stages ?? []).map((s) => [s.stage, s]));
    const t = nowIso();

    for (const c of configs) {
      const stage = String(c.stage || "").trim();
      if (!stageKeys.has(stage)) throw new Error(`unknown_stage:${stage}`);
      const prev = stageMap.get(stage);
      const modelId = c.modelId !== undefined ? (c.modelId ? normalizeModelId(c.modelId) : null) : prev?.modelId ?? null;
      if (modelId) {
        const m = models.find((x) => x.id === modelId) || null;
        if (!m || !m.isEnabled) throw new Error(`model_not_available:${modelId}`);
      }

      const allowMulti = stage !== "embedding";
      const nextModelIdsRaw =
        c.modelIds !== undefined
          ? Array.isArray(c.modelIds)
            ? (c.modelIds as any[]).map((x) => normalizeModelId(String(x))).filter(Boolean)
            : null
          : prev?.modelIds ?? null;
      let modelIds: string[] | null = allowMulti
        ? nextModelIdsRaw && Array.isArray(nextModelIdsRaw) && nextModelIdsRaw.length
          ? Array.from(new Set(nextModelIdsRaw)).slice(0, 60)
          : null
        : null;

      if (allowMulti && modelIds) {
        for (const id of modelIds) {
          const m = models.find((x) => x.id === id) || null;
          if (!m || !m.isEnabled) throw new Error(`model_not_available:${id}`);
        }
      }

      // 默认模型必须在可选列表里（Desktop 侧用）
      if (allowMulti) {
        const set = new Set(modelIds ?? []);
        if (modelId) set.add(modelId);
        modelIds = set.size ? Array.from(set).slice(0, 60) : null;
      }
      stageMap.set(stage, {
        stage,
        modelId,
        modelIds,
        temperature: c.temperature !== undefined ? (c.temperature === null ? null : Number(c.temperature)) : prev?.temperature ?? null,
        maxTokens: c.maxTokens !== undefined ? (c.maxTokens === null ? null : Number(c.maxTokens)) : prev?.maxTokens ?? null,
        isEnabled: c.isEnabled !== undefined ? Boolean(c.isEnabled) : prev?.isEnabled ?? true,
        updatedBy: updatedBy ?? prev?.updatedBy ?? null,
        createdAt: prev?.createdAt ?? t,
        updatedAt: t,
      });
    }

    const next: AiConfig = { ...ai, updatedAt: t, stages: Array.from(stageMap.values()), models };
    await saveAiConfig(next, updatedBy);
  };

  const dedupeModels = async () => {
    const ai = await getAiConfig();
    const models = ai.models ?? [];
    const stages = ai.stages ?? [];
    const useCount = new Map<string, number>();
    for (const s of stages) {
      const ids: string[] = [];
      const id = s.modelId ? String(s.modelId) : "";
      if (id) ids.push(id);
      const arr = Array.isArray((s as any).modelIds) ? (((s as any).modelIds as any[]) ?? []) : [];
      for (const x of arr) {
        const mid = String(x || "").trim();
        if (mid) ids.push(mid);
      }
      for (const mid of ids) {
        useCount.set(mid, (useCount.get(mid) || 0) + 1);
      }
    }

    const groups = new Map<string, AiModel[]>();
    for (const m of models) {
      const key = [
        String(m.model || "").trim(),
        normalizeBaseURL(m.baseURL),
        normalizeEndpoint(m.endpoint, "/v1/chat/completions"),
        String(m.apiKeyLast4 || ""),
      ].join("||");
      const arr = groups.get(key) || [];
      arr.push(m);
      groups.set(key, arr);
    }

    let groupsAffected = 0;
    let removedModels = 0;
    let updatedStages = 0;
    const keptModelIds: string[] = [];

    const stageNext = stages.slice();
    const removeSet = new Set<string>();
    const keepMap = new Map<string, string>(); // removeId -> keepId

    for (const arr of groups.values()) {
      if (arr.length <= 1) continue;
      groupsAffected += 1;
      const sorted = [...arr].sort((a, b) => {
        const aCnt = useCount.get(a.id) || 0;
        const bCnt = useCount.get(b.id) || 0;
        if (aCnt !== bCnt) return bCnt - aCnt;
        return String(b.updatedAt).localeCompare(String(a.updatedAt));
      });
      const keep = sorted[0]!;
      keptModelIds.push(keep.id);
      for (const r of sorted.slice(1)) {
        removeSet.add(r.id);
        keepMap.set(r.id, keep.id);
      }
    }

    if (removeSet.size) {
      for (const s of stageNext) {
        let touched = false;
        if (s.modelId) {
          const k = keepMap.get(s.modelId);
          if (k) {
            s.modelId = k;
            touched = true;
          }
        }
        if (Array.isArray((s as any).modelIds) && ((s as any).modelIds as any[]).length) {
          const before = ((s as any).modelIds as any[]).map((x) => String(x || "").trim()).filter(Boolean);
          const after = Array.from(new Set(before.map((x) => keepMap.get(x) || x))).filter(Boolean);
          if (before.join("||") !== after.join("||")) {
            (s as any).modelIds = after.length ? after : null;
            touched = true;
          }
        }
        if (touched) {
          s.updatedAt = nowIso();
          updatedStages += 1;
        }
      }
      removedModels = removeSet.size;
    }

    const nextModels = models.filter((m) => !removeSet.has(m.id));
    const next: AiConfig = { ...ai, updatedAt: nowIso(), models: nextModels, stages: stageNext };
    if (groupsAffected > 0) await saveAiConfig(next, "system");

    return { groupsAffected, removedModels, updatedStages, keptModelIds };
  };

  const testModel = async (id: string) => {
    const m = await getModelById(id);
    if (!m) throw new Error("model_not_found");

    const endpoint = normalizeEndpoint(m.endpoint, "/v1/chat/completions");

    const ai = await getAiConfig();
    const provider = m.providerId ? getProviderById(ai, m.providerId) : null;
    if (provider && !provider.isEnabled) {
      const tr: AiModelTestResult = { ok: false, latencyMs: null, status: null, error: "provider_not_available", testedAt: nowIso() };
      const now = nowIso();
      const next: AiConfig = {
        ...ai,
        updatedAt: now,
        models: (ai.models ?? []).map((x) => (x.id === m.id ? { ...x, testResult: tr, updatedAt: now, updatedBy: "system" } : x)),
        stages: ai.stages ?? [],
        providers: (ai as any).providers ?? [],
      };
      await saveAiConfig(next, "system");
      return { modelId: m.id, model: m.model, baseURL: m.baseURL, endpoint, endpointUrl: joinUrl(m.baseURL, endpoint), ...tr };
    }

    const baseURL = normalizeBaseURL(provider?.baseURL || m.baseURL);
    const endpointUrl = joinUrl(baseURL, endpoint);

    const writeResult = async (tr: AiModelTestResult) => {
      const ai = await getAiConfig();
      const now = nowIso();
      const next: AiConfig = {
        ...ai,
        updatedAt: now,
        models: (ai.models ?? []).map((x) => (x.id === m.id ? { ...x, testResult: tr, updatedAt: now, updatedBy: "system" } : x)),
        stages: ai.stages ?? [],
      };
      await saveAiConfig(next, "system");
    };

    // 这些“失败”也要写回 testResult，避免前端看起来“点了没反应/没变化”
    if (!m.isEnabled) {
      const tr: AiModelTestResult = { ok: false, latencyMs: null, status: null, error: "model_disabled", testedAt: nowIso() };
      await writeResult(tr);
      return { modelId: m.id, model: m.model, baseURL, endpoint, endpointUrl, ...tr };
    }

    const apiKeyEnc = m.apiKeyEnc || provider?.apiKeyEnc || null;
    const apiKey = apiKeyEnc ? normalizeApiKeyInput(decryptApiKey(apiKeyEnc)) : "";
    if (!apiKey) {
      const tr: AiModelTestResult = { ok: false, latencyMs: null, status: null, error: "apiKey_missing", testedAt: nowIso() };
      await writeResult(tr);
      return { modelId: m.id, model: m.model, baseURL, endpoint, endpointUrl, ...tr };
    }

    const isGemini = isGeminiEndpoint(endpoint);
    const isEmbedding = /\/embeddings/i.test(endpoint);
    const isResponses = /\/responses/i.test(endpoint);
    const controller = new AbortController();
    const timeoutMs = 20_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = { "Content-Type": "application/json" };

    let url = endpointUrl;
    let body: any;

    if (isGemini) {
      // Gemini：key 既支持 query param，也支持 x-goog-api-key（兼容代理）
      if (!/[\?&]key=/.test(url)) url = `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`;
      headers["x-goog-api-key"] = apiKey;
      body = {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1 },
      };
    } else if (isEmbedding) {
      headers.Authorization = `Bearer ${apiKey}`;
      body = { model: m.model, input: "ping" };
    } else if (isResponses) {
      headers.Authorization = `Bearer ${apiKey}`;
      body = {
        model: m.model,
        input: [{ role: "user", content: "ping" }],
        max_output_tokens: 8,
        stream: false,
      };
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
      body = { model: m.model, messages: [{ role: "user", content: "ping" }], temperature: 0, max_tokens: 1, stream: false };
    }

    const start = Date.now();
    let ok = false;
    let status: number | null = null;
    let error: string | null = null;
    let headersObj: Record<string, string> | undefined = undefined;

    try {
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      status = resp.status;
      const latencyMs = Date.now() - start;
      const testedAt = nowIso();

      try {
        const h: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          const kk = String(k || "").toLowerCase();
          if (kk === "set-cookie") return;
          if (Object.keys(h).length >= 30) return;
          h[kk] = String(v || "").slice(0, 200);
        });
        if (Object.keys(h).length) headersObj = h;
      } catch {
        // ignore
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        ok = false;
        error = text.slice(0, 400) || `HTTP_${resp.status}`;
      } else {
        ok = true;
        error = null;
        if (isResponses) {
          const text = await resp.text().catch(() => "");
          try {
            const j = text ? JSON.parse(text) : null;
            const hasText =
              typeof j?.output_text === "string"
                ? j.output_text.trim().length > 0
                : Array.isArray(j?.output)
                  ? j.output.some((x: any) =>
                      Array.isArray(x?.content)
                        ? x.content.some((c: any) => String(c?.text ?? c?.output_text ?? "").trim().length > 0)
                        : String(x?.text ?? "").trim().length > 0,
                    )
                  : false;
            if (!hasText) {
              ok = false;
              error = "UPSTREAM_EMPTY_CONTENT";
            }
          } catch {
            ok = false;
            error = "UPSTREAM_INVALID_JSON";
          }
        }
      }

      const tr: AiModelTestResult = { ok, latencyMs, status, error, testedAt, ...(headersObj ? { headers: headersObj } : {}) };
      await writeResult(tr);
      return { modelId: m.id, model: m.model, baseURL, endpoint, endpointUrl: url, ...tr };
    } catch (e: any) {
      const msg = String(e?.name ?? "") === "AbortError" ? `请求超时（>${Math.round(timeoutMs / 1000)}s）` : String(e?.message ?? e);
      status = null;
      const latencyMs = null;
      const testedAt = nowIso();
      const tr: AiModelTestResult = { ok: false, latencyMs, status, error: msg.slice(0, 400), testedAt };
      await writeResult(tr);
      return { modelId: m.id, model: m.model, baseURL, endpoint, endpointUrl: url, ...tr };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    defs,
    clearCache,
    ensureDefaults,
    listProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    listModels,
    createModel,
    updateModel,
    deleteModel,
    dedupeModels,
    testModel,
    listStages,
    upsertStages,
    resolveModel,
    resolveStage,
    getModelPricing,
  };
}
