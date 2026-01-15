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

export type Db = {
  users: User[];
  pointsTransactions: PointsTransaction[];
  llmConfig?: LlmConfig;
};

const DEFAULT_DB: Db = { users: [], pointsTransactions: [], llmConfig: undefined };

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

    return { users, pointsTransactions, llmConfig };
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


