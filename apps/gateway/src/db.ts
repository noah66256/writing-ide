import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type User = {
  id: string;
  email: string;
  role: "admin" | "user";
  createdAt: string;
  pointsBalance: number; // 积分余额（整数）
};

export type PointsTxType = "recharge" | "consume" | "adjust";

export type PointsTransaction = {
  id: string;
  userId: string;
  type: PointsTxType;
  delta: number; // 正数=增加（充值/补偿），负数=消耗（扣费）
  reason?: string;
  meta?: unknown; // 扣费明细/审计信息（可选）
  createdAt: string;
};

export type LlmModelPrice = {
  /** 输入单价：元/1,000,000 tokens */
  priceInCnyPer1M: number;
  /** 输出单价：元/1,000,000 tokens */
  priceOutCnyPer1M: number;
};

export type LlmConfig = {
  updatedAt: string;
  llm?: {
    baseUrl?: string;
    apiKey?: string;
    models?: string[];
    defaultModel?: string;
  };
  embeddings?: {
    baseUrl?: string;
    apiKey?: string;
    models?: string[];
    defaultModel?: string;
  };
  card?: {
    baseUrl?: string;
    apiKey?: string;
    defaultModel?: string;
  };
  linter?: {
    baseUrl?: string;
    apiKey?: string;
    defaultModel?: string;
    timeoutMs?: number;
  };
  pricing?: Record<string, LlmModelPrice>;
};

export type AiModelTestResult = {
  ok: boolean;
  latencyMs: number | null;
  status: number | null;
  error: string | null;
  testedAt: string;
  headers?: Record<string, string>;
};

export type AiProvider = {
  id: string;
  name: string;
  baseURL: string;
  apiKeyEnc: string | null;
  apiKeyLast4: string | null;
  isEnabled: boolean;
  sortOrder: number;
  description: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiModel = {
  id: string;
  model: string;
  providerId: string | null;
  baseURL: string;
  endpoint: string;
  apiKeyEnc: string | null;
  apiKeyLast4: string | null;
  priceInCnyPer1M: number | null;
  priceOutCnyPer1M: number | null;
  billingGroup: string | null;
  isEnabled: boolean;
  sortOrder: number;
  description: string | null;
  testResult: AiModelTestResult | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiStageConfig = {
  stage: string;
  modelId: string | null; // 对应 AiModel.id
  /** 仅 llm.chat / agent.run 使用：可选模型列表（Desktop 用）。为空时表示只使用 modelId。 */
  modelIds: string[] | null;
  temperature: number | null;
  maxTokens: number | null;
  isEnabled: boolean;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiConfig = {
  updatedAt: string;
  providers: AiProvider[];
  models: AiModel[];
  stages: AiStageConfig[];
};

export type Db = {
  users: User[];
  pointsTransactions: PointsTransaction[];
  llmConfig?: LlmConfig;
  aiConfig?: AiConfig;
};

const DEFAULT_DB: Db = { users: [], pointsTransactions: [], llmConfig: undefined, aiConfig: undefined };

function getDbFilePath() {
  return path.resolve(process.cwd(), "data", "db.json");
}

export async function loadDb(): Promise<Db> {
  const file = getDbFilePath();
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Db>;
    const usersRaw = Array.isArray(parsed.users) ? (parsed.users as any[]) : [];
    const users: User[] = usersRaw
      .map((u) => {
        const email = typeof u?.email === "string" ? u.email : "";
        const role = u?.role === "admin" ? "admin" : "user";
        const pointsBalance = Number.isFinite(u?.pointsBalance) ? Number(u.pointsBalance) : 0;
        const createdAt = typeof u?.createdAt === "string" ? u.createdAt : new Date().toISOString();
        const id = typeof u?.id === "string" ? u.id : "";
        if (!id || !email) return null;
        return { id, email, role, pointsBalance, createdAt };
      })
      .filter((u): u is User => Boolean(u));

    const txRaw = Array.isArray((parsed as any).pointsTransactions)
      ? (((parsed as any).pointsTransactions as any[]) ?? [])
      : [];
    const pointsTransactions: PointsTransaction[] = txRaw
      .map((t) => {
        const id = typeof t?.id === "string" ? t.id : "";
        const userId = typeof t?.userId === "string" ? t.userId : "";
        const type: PointsTxType =
          t?.type === "consume" || t?.type === "adjust" || t?.type === "recharge" ? t.type : "adjust";
        const delta = Number.isFinite(t?.delta) ? Number(t.delta) : 0;
        const createdAt = typeof t?.createdAt === "string" ? t.createdAt : new Date().toISOString();
        const reason = typeof t?.reason === "string" ? t.reason : undefined;
        if (!id || !userId) return null;
        const meta = (t as any)?.meta;
        const base: PointsTransaction = { id, userId, type, delta, createdAt };
        const withReason = reason ? { ...base, reason } : base;
        return meta !== undefined ? { ...withReason, meta } : withReason;
      })
      .filter((t): t is PointsTransaction => t !== null);

    const rawCfg = (parsed as any)?.llmConfig;
    const nowIso = new Date().toISOString();
    const normStr = (v: any) => (typeof v === "string" ? v.trim() : "");
    const normModels = (v: any) =>
      Array.isArray(v) ? v.map((x: any) => normStr(x)).filter(Boolean).slice(0, 200) : [];
    const normNum = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const llmConfig: Db["llmConfig"] = (() => {
      if (!rawCfg || typeof rawCfg !== "object") return undefined;
      const c: any = rawCfg;
      const pricingRaw = c?.pricing && typeof c.pricing === "object" ? c.pricing : null;
      const pricing: Record<string, LlmModelPrice> = {};
      if (pricingRaw) {
        for (const [k, v] of Object.entries(pricingRaw)) {
          const modelId = normStr(k);
          if (!modelId) continue;
          const priceIn = normNum((v as any)?.priceInCnyPer1M);
          const priceOut = normNum((v as any)?.priceOutCnyPer1M);
          if (priceIn === null || priceOut === null) continue;
          pricing[modelId] = { priceInCnyPer1M: priceIn, priceOutCnyPer1M: priceOut };
        }
      }
      const updatedAt = normStr(c?.updatedAt) || nowIso;
      const toStage = (x: any) => {
        if (!x || typeof x !== "object") return undefined;
        const o: any = x;
        const baseUrl = normStr(o.baseUrl);
        const apiKey = normStr(o.apiKey);
        const models = normModels(o.models);
        const defaultModel = normStr(o.defaultModel);
        const out: any = {};
        if (baseUrl) out.baseUrl = baseUrl;
        if (apiKey) out.apiKey = apiKey;
        if (models.length) out.models = models;
        if (defaultModel) out.defaultModel = defaultModel;
        return Object.keys(out).length ? out : undefined;
      };
      const llm = toStage(c?.llm);
      const embeddings = toStage(c?.embeddings);
      const card = (() => {
        const o: any = c?.card;
        if (!o || typeof o !== "object") return undefined;
        const out: any = {};
        const baseUrl = normStr(o.baseUrl);
        const apiKey = normStr(o.apiKey);
        const defaultModel = normStr(o.defaultModel);
        if (baseUrl) out.baseUrl = baseUrl;
        if (apiKey) out.apiKey = apiKey;
        if (defaultModel) out.defaultModel = defaultModel;
        return Object.keys(out).length ? out : undefined;
      })();
      const linter = (() => {
        const o: any = c?.linter;
        if (!o || typeof o !== "object") return undefined;
        const out: any = {};
        const baseUrl = normStr(o.baseUrl);
        const apiKey = normStr(o.apiKey);
        const defaultModel = normStr(o.defaultModel);
        const timeoutMs = normNum(o.timeoutMs);
        if (baseUrl) out.baseUrl = baseUrl;
        if (apiKey) out.apiKey = apiKey;
        if (defaultModel) out.defaultModel = defaultModel;
        if (timeoutMs !== null) out.timeoutMs = timeoutMs;
        return Object.keys(out).length ? out : undefined;
      })();
      const out: LlmConfig = {
        updatedAt,
        ...(llm ? { llm } : {}),
        ...(embeddings ? { embeddings } : {}),
        ...(card ? { card } : {}),
        ...(linter ? { linter } : {}),
        ...(Object.keys(pricing).length ? { pricing } : {}),
      };
      return out;
    })();

    const rawAi = (parsed as any)?.aiConfig;
    const aiConfig: Db["aiConfig"] = (() => {
      if (!rawAi || typeof rawAi !== "object") return undefined;
      const a: any = rawAi;
      const updatedAt = normStr(a?.updatedAt) || nowIso;

      const providersRaw = Array.isArray(a?.providers) ? (a.providers as any[]) : [];
      const providers: AiProvider[] = providersRaw
        .map((p) => {
          const id = normStr(p?.id);
          const name = normStr(p?.name);
          const baseURL = normStr(p?.baseURL);
          if (!id || !name || !baseURL) return null;

          const apiKeyEnc = typeof p?.apiKeyEnc === "string" ? String(p.apiKeyEnc) : null;
          const apiKeyLast4 = typeof p?.apiKeyLast4 === "string" ? normStr(p.apiKeyLast4) : null;
          const isEnabled = p?.isEnabled === false ? false : true;
          const sortOrder = Number.isFinite(p?.sortOrder) ? Number(p.sortOrder) : 0;
          const description = typeof p?.description === "string" ? String(p.description).trim() : null;
          const updatedBy = typeof p?.updatedBy === "string" ? normStr(p.updatedBy) : null;
          const createdAt = typeof p?.createdAt === "string" ? normStr(p.createdAt) || nowIso : nowIso;
          const updatedAt2 = typeof p?.updatedAt === "string" ? normStr(p.updatedAt) || createdAt : createdAt;

          return {
            id,
            name,
            baseURL,
            apiKeyEnc,
            apiKeyLast4,
            isEnabled,
            sortOrder,
            description,
            updatedBy,
            createdAt,
            updatedAt: updatedAt2,
          };
        })
        .filter((x): x is AiProvider => Boolean(x));

      const modelsRaw = Array.isArray(a?.models) ? (a.models as any[]) : [];
      const models: AiModel[] = modelsRaw
        .map((m) => {
          const id = normStr(m?.id) || normStr(m?.model);
          const model = normStr(m?.model);
          const providerId = typeof m?.providerId === "string" ? normStr(m.providerId) : null;
          const baseURL = normStr(m?.baseURL);
          const endpoint = normStr(m?.endpoint) || "/v1/chat/completions";
          if (!id || !model || !baseURL) return null;

          const apiKeyEnc = typeof m?.apiKeyEnc === "string" ? String(m.apiKeyEnc) : null;
          const apiKeyLast4 = typeof m?.apiKeyLast4 === "string" ? normStr(m.apiKeyLast4) : null;
          const priceIn = normNum(m?.priceInCnyPer1M);
          const priceOut = normNum(m?.priceOutCnyPer1M);
          const billingGroup = typeof m?.billingGroup === "string" ? normStr(m.billingGroup) : null;
          const isEnabled = m?.isEnabled === false ? false : true;
          const sortOrder = Number.isFinite(m?.sortOrder) ? Number(m.sortOrder) : 0;
          const description = typeof m?.description === "string" ? String(m.description).trim() : null;
          const updatedBy = typeof m?.updatedBy === "string" ? normStr(m.updatedBy) : null;
          const createdAt = typeof m?.createdAt === "string" ? normStr(m.createdAt) || nowIso : nowIso;
          const updatedAt2 = typeof m?.updatedAt === "string" ? normStr(m.updatedAt) || createdAt : createdAt;
          const tr = m?.testResult && typeof m.testResult === "object" ? (m.testResult as any) : null;
          const testResult: AiModelTestResult | null = tr
            ? {
                ok: Boolean(tr.ok),
                latencyMs: normNum(tr.latencyMs),
                status: normNum(tr.status),
                error: typeof tr.error === "string" ? String(tr.error).slice(0, 800) : null,
                testedAt: typeof tr.testedAt === "string" ? normStr(tr.testedAt) || nowIso : nowIso,
                headers: tr.headers && typeof tr.headers === "object" ? (tr.headers as any) : undefined,
              }
            : null;

          return {
            id,
            model,
            providerId,
            baseURL,
            endpoint,
            apiKeyEnc,
            apiKeyLast4,
            priceInCnyPer1M: priceIn,
            priceOutCnyPer1M: priceOut,
            billingGroup,
            isEnabled,
            sortOrder,
            description,
            testResult,
            updatedBy,
            createdAt,
            updatedAt: updatedAt2,
          };
        })
        .filter((x): x is AiModel => Boolean(x));

      const stagesRaw = Array.isArray(a?.stages) ? (a.stages as any[]) : [];
      const stages: AiStageConfig[] = stagesRaw
        .map((s) => {
          const stage = normStr(s?.stage);
          if (!stage) return null;
          const modelId = typeof s?.modelId === "string" ? normStr(s.modelId) : null;
          const modelIds =
            Array.isArray((s as any)?.modelIds) && (s as any).modelIds.length
              ? Array.from(
                  new Set(
                    ((s as any).modelIds as any[])
                      .map((x) => normStr(x))
                      .filter(Boolean)
                      .slice(0, 200),
                  ),
                )
              : null;
          const temperature = normNum(s?.temperature);
          const maxTokens = normNum(s?.maxTokens);
          const isEnabled = s?.isEnabled === false ? false : true;
          const updatedBy = typeof s?.updatedBy === "string" ? normStr(s.updatedBy) : null;
          const createdAt = typeof s?.createdAt === "string" ? normStr(s.createdAt) || nowIso : nowIso;
          const updatedAt2 = typeof s?.updatedAt === "string" ? normStr(s.updatedAt) || createdAt : createdAt;
          return { stage, modelId, modelIds, temperature, maxTokens, isEnabled, updatedBy, createdAt, updatedAt: updatedAt2 };
        })
        .filter((x): x is AiStageConfig => Boolean(x));

      return { updatedAt, providers, models, stages };
    })();

    return { users, pointsTransactions, llmConfig, aiConfig };
  } catch {
    return { ...DEFAULT_DB };
  }
}

export async function saveDb(db: Db): Promise<void> {
  const file = getDbFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2), "utf-8");
  await rename(tmp, file);
}


