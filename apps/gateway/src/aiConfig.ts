import crypto from "node:crypto";
import type { AiConfig, AiModel, AiModelTestResult, AiStageConfig, Db, LlmModelPrice } from "./db.js";

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
};

export type AiModelListItem = Omit<AiModel, "apiKeyEnc"> & {
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
  const llmModel = String(process.env.LLM_MODEL ?? "").trim() || "deepseek-v3";
  const embedModels = String(process.env.LLM_EMBED_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const embedModel = embedModels[0] || "text-embedding-3-large";
  const cardModel = String(process.env.LLM_CARD_MODEL ?? "").trim() || llmModel;
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
      defaultMaxTokens: 8000,
      defaultEndpoint: "/v1/chat/completions",
    },
    {
      key: "rag.ingest.build_library_playbook",
      name: "KB：生成仿写手册",
      description: "从要素卡生成库级仿写手册（StyleProfile/Facet Playbook）",
      defaultModel: cardModel,
      defaultTemperature: 0.2,
      defaultMaxTokens: 8000,
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
            models: [],
            stages: [],
          };
    cached = { at: now, ai };
    return ai;
  };

  const saveAiConfig = async (ai: AiConfig, updatedBy?: string | null) => {
    const db = await args.loadDb();
    const next: AiConfig = { ...ai, updatedAt: nowIso() };
    // 轻量修正：保证模型/阶段字段存在
    next.models = Array.isArray(next.models) ? next.models : [];
    next.stages = Array.isArray(next.stages) ? next.stages : [];
    db.aiConfig = next;
    await args.saveDb(db);
    clearCache();
    void updatedBy;
  };

  const ensureDefaults = async () => {
    const db = await args.loadDb();
    const ai: AiConfig =
      db.aiConfig && typeof db.aiConfig === "object"
        ? db.aiConfig
        : {
            updatedAt: nowIso(),
            models: [],
            stages: [],
          };

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

    const pickCredsForStage = (stageKey: string) => {
      if (stageKey === "embedding") return { baseURL: envEmbedBase || envBase, apiKey: envEmbedKey || envKey };
      if (stageKey.startsWith("rag.ingest.")) return { baseURL: envCardBase || envBase, apiKey: envCardKey || envKey };
      if (stageKey === "lint.style") return { baseURL: envLinterBase || envBase, apiKey: envLinterKey || envKey };
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
      const m: AiModel = {
        id,
        model: id,
        baseURL: creds.baseURL,
        endpoint: normalizeEndpoint(endpoint, "/v1/chat/completions"),
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

    // 2) 确保所有 stage 都有 stage 配置（缺失则补齐）
    const stageMap = new Map<string, AiStageConfig>((ai.stages ?? []).map((s) => [s.stage, s]));
    const t = nowIso();
    for (const d of defs) {
      if (stageMap.has(d.key)) continue;
      const m = byId.get(normalizeModelId(d.defaultModel)) || null;
      const s: AiStageConfig = {
        stage: d.key,
        modelId: m ? m.id : null,
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

    db.aiConfig = { ...ai, updatedAt: nowIso() };
    await args.saveDb(db);
    clearCache();
  };

  const listModels = async (): Promise<AiModelListItem[]> => {
    const ai = await getAiConfig();
    const models = Array.isArray(ai.models) ? ai.models.slice() : [];
    models.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.model).localeCompare(String(b.model)));
    return models.map((m) => ({
      ...m,
      apiKeyEnc: null, // never expose
      hasApiKey: Boolean(m.apiKeyEnc),
      apiKeyMasked: m.apiKeyLast4 ? `****${m.apiKeyLast4}` : null,
    }));
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

    const apiKey = modelDoc.apiKeyEnc ? normalizeApiKeyInput(decryptApiKey(modelDoc.apiKeyEnc)) : "";
    const endpoint = normalizeEndpoint(modelDoc.endpoint, def.defaultEndpoint);
    return {
      stage: key,
      modelId: modelDoc.id,
      baseURL: normalizeBaseURL(modelDoc.baseURL),
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
    const apiKey = modelDoc.apiKeyEnc ? normalizeApiKeyInput(decryptApiKey(modelDoc.apiKeyEnc)) : "";
    const endpoint = normalizeEndpoint(modelDoc.endpoint, "/v1/chat/completions");
    return {
      modelId: modelDoc.id,
      baseURL: normalizeBaseURL(modelDoc.baseURL),
      endpoint,
      apiKey,
      model: modelDoc.model,
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
    baseURL: string;
    endpoint?: string;
    apiKey?: string;
    copyFromId?: string;
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
    const baseURL = normalizeBaseURL(params.baseURL);
    if (!baseURL) throw new Error("baseURL_required");
    const endpoint = normalizeEndpoint(params.endpoint || "/v1/chat/completions", "/v1/chat/completions");
    const priceIn = Number(params.priceInCnyPer1M);
    const priceOut = Number(params.priceOutCnyPer1M);
    if (!Number.isFinite(priceIn) || !Number.isFinite(priceOut) || priceIn < 0 || priceOut < 0) throw new Error("pricing_invalid");

    const apiKeyInput = normalizeApiKeyInput(params.apiKey || "");
    let apiKeyEnc: string | null = null;
    let apiKeyLast4: string | null = null;
    if (apiKeyInput) {
      const enc = encryptApiKey(apiKeyInput);
      apiKeyEnc = enc.enc;
      apiKeyLast4 = enc.last4;
    } else if (params.copyFromId) {
      const src = (ai.models ?? []).find((m) => m.id === String(params.copyFromId).trim()) || null;
      if (!src) throw new Error("copyFrom_not_found");
      if (src.apiKeyEnc) {
        apiKeyEnc = src.apiKeyEnc;
        apiKeyLast4 = src.apiKeyLast4;
      }
    }

    if (!apiKeyEnc) throw new Error("apiKey_required");

    // 防止“看起来一模一样”的重复（model/baseURL/endpoint/key后四位相同）
    const dup = (ai.models ?? []).find(
      (m) =>
        m.model === model &&
        normalizeBaseURL(m.baseURL) === baseURL &&
        normalizeEndpoint(m.endpoint, "/v1/chat/completions") === endpoint &&
        String(m.apiKeyLast4 || "") === String(apiKeyLast4 || ""),
    );
    if (dup) throw new Error("duplicate_model");

    const t = nowIso();
    const item: AiModel = {
      id: model,
      model,
      baseURL,
      endpoint,
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
      baseURL: string;
      endpoint: string;
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
    const nextBase = patch.baseURL !== undefined ? normalizeBaseURL(patch.baseURL) : cur.baseURL;
    const nextEndpoint = patch.endpoint !== undefined ? normalizeEndpoint(patch.endpoint, cur.endpoint) : cur.endpoint;

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

    const priceIn =
      patch.priceInCnyPer1M !== undefined ? (patch.priceInCnyPer1M === null ? null : Number(patch.priceInCnyPer1M)) : cur.priceInCnyPer1M;
    const priceOut =
      patch.priceOutCnyPer1M !== undefined ? (patch.priceOutCnyPer1M === null ? null : Number(patch.priceOutCnyPer1M)) : cur.priceOutCnyPer1M;
    if (priceIn !== null && (!Number.isFinite(priceIn) || priceIn < 0)) throw new Error("pricing_invalid");
    if (priceOut !== null && (!Number.isFinite(priceOut) || priceOut < 0)) throw new Error("pricing_invalid");

    // 重命名 id：当前实现以 model 作为 id，不支持变更（避免联动大量引用）
    if (nextModel !== cur.id) throw new Error("model_id_immutable");

    // 防重复（排除自己）
    if (apiKeyLast4) {
      const dup = (ai.models ?? []).find(
        (m) =>
          m.id !== cur.id &&
          m.model === nextModel &&
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
      baseURL: nextBase,
      endpoint: nextEndpoint,
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
    const inUse = (ai.stages ?? []).some((s) => s.modelId === key);
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
    const models = ai.models ?? [];
    const stageMap = new Map<string, AiStageConfig>((ai.stages ?? []).map((s) => [s.stage, s]));
    return defs.map((d) => {
      const s = stageMap.get(d.key) || null;
      const modelId = s?.modelId || normalizeModelId(d.defaultModel);
      const m = models.find((x) => x.id === modelId) || null;
      return {
        stage: d.key,
        name: d.name,
        description: d.description,
        modelId: m ? m.id : modelId,
        model: m ? m.model : d.defaultModel,
        baseURL: m ? m.baseURL : "",
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
      stageMap.set(stage, {
        stage,
        modelId,
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
      const id = s.modelId ? String(s.modelId) : "";
      if (!id) continue;
      useCount.set(id, (useCount.get(id) || 0) + 1);
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
        if (!s.modelId) continue;
        const k = keepMap.get(s.modelId);
        if (!k) continue;
        s.modelId = k;
        s.updatedAt = nowIso();
        updatedStages += 1;
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
    const endpointUrl = joinUrl(m.baseURL, endpoint);

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
      return { modelId: m.id, model: m.model, baseURL: m.baseURL, endpoint, endpointUrl, ...tr };
    }

    const apiKey = m.apiKeyEnc ? normalizeApiKeyInput(decryptApiKey(m.apiKeyEnc)) : "";
    if (!apiKey) {
      const tr: AiModelTestResult = { ok: false, latencyMs: null, status: null, error: "apiKey_missing", testedAt: nowIso() };
      await writeResult(tr);
      return { modelId: m.id, model: m.model, baseURL: m.baseURL, endpoint, endpointUrl, ...tr };
    }

    const isEmbedding = /\/embeddings/i.test(endpoint);
    const controller = new AbortController();
    const timeoutMs = 20_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    headers.Authorization = `Bearer ${apiKey}`;

    const body = isEmbedding
      ? { model: m.model, input: "ping" }
      : { model: m.model, messages: [{ role: "user", content: "ping" }], temperature: 0, max_tokens: 1, stream: false };

    const start = Date.now();
    let ok = false;
    let status: number | null = null;
    let error: string | null = null;
    let headersObj: Record<string, string> | undefined = undefined;

    try {
      const resp = await fetch(endpointUrl, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
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
      }

      const tr: AiModelTestResult = { ok, latencyMs, status, error, testedAt, ...(headersObj ? { headers: headersObj } : {}) };
      await writeResult(tr);
      return { modelId: m.id, model: m.model, baseURL: m.baseURL, endpoint, endpointUrl, ...tr };
    } catch (e: any) {
      const msg = String(e?.name ?? "") === "AbortError" ? `请求超时（>${Math.round(timeoutMs / 1000)}s）` : String(e?.message ?? e);
      status = null;
      const latencyMs = null;
      const testedAt = nowIso();
      const tr: AiModelTestResult = { ok: false, latencyMs, status, error: msg.slice(0, 400), testedAt };
      await writeResult(tr);
      return { modelId: m.id, model: m.model, baseURL: m.baseURL, endpoint, endpointUrl, ...tr };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    defs,
    clearCache,
    ensureDefaults,
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


