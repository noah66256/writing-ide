import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type User = {
  id: string;
  /** 兼容：允许仅手机号注册/登录；email 可为空（保留位置用于绑定/找回）。 */
  email: string | null;
  /** E.164 本地化简化：当前先存纯数字手机号（不带 +86），countryCode 统一默认 86。 */
  phone: string | null;
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
  /**
   * Agent tool_result 注入格式：
   * - xml：system role 的 `<tool_result><![CDATA[json]]></tool_result>`（默认）
   * - text：user role 的纯文本 `[tool_result] json [/tool_result]`（兼容某些 OpenAI-compatible 代理）
   */
  toolResultFormat: "xml" | "text";
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

// ======== Tool Config（B 端热配置：工具/外部服务） ========

export type WebSearchProvider = "bocha";

export type WebSearchConfig = {
  provider: WebSearchProvider;
  isEnabled: boolean;
  /** 可选：覆盖默认 endpoint（例如 https://api.bochaai.com/v1/web-search） */
  endpoint: string | null;
  /** API Key 加密存储（AES-GCM） */
  apiKeyEnc: string | null;
  apiKeyLast4: string | null;
  /**
   * 计费（按调用次数）：纯工具不扣；但 web.search/web.fetch 属于外部付费 API，按“次”扣积分更直观。
   * - 0 或 null：不扣费
   */
  billPointsPerSearch: number | null;
  billPointsPerFetch: number | null;
  /** 域名治理（可选；为空表示不做 allow 限制；deny 优先生效） */
  allowDomains: string[];
  denyDomains: string[];
  /** 抓取 UA（可选） */
  fetchUa: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ToolMode = "chat" | "plan" | "agent";

export type CapabilitiesConfig = {
  tools: {
    disabledByMode: Partial<Record<ToolMode, string[]>>;
  };
  skills: {
    disabled: string[]; // skillId[]
  };
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ToolConfig = {
  updatedAt: string;
  webSearch?: WebSearchConfig;
  smsVerify?: SmsVerifyConfig;
  capabilities?: CapabilitiesConfig;
};

// ======== SMS Verify Config（B 端热配置：手机号验证码登录/绑定） ========

export type SmsVerifyProvider = "aliyun_dypnsapi";

export type SmsVerifyConfig = {
  provider: SmsVerifyProvider;
  isEnabled: boolean;
  /** 可选：覆盖默认 endpoint（例如 https://dypnsapi.aliyuncs.com 或 dypnsapi.aliyuncs.com） */
  endpoint: string | null;

  /** AccessKeyId/Secret 加密存储（AES-GCM） */
  accessKeyIdEnc: string | null;
  accessKeyIdLast4: string | null;
  accessKeySecretEnc: string | null;
  accessKeySecretLast4: string | null;

  /** 方案名称（可选；为空=默认方案）。需要与发送接口一致。 */
  schemeName: string | null;
  /** 赠送签名（必填；生产必须配置） */
  signName: string | null;
  /** 赠送模板 CODE（必填；生产必须配置） */
  templateCode: string | null;
  /** 模板参数 min 的值（分钟，字符串传给 TemplateParam） */
  templateMin: number | null;

  /** 发送验证码参数（可选，默认会提供合理值） */
  codeLength: number | null; // 4~8，默认建议 6
  validTimeSeconds: number | null; // 默认 300
  duplicatePolicy: number | null; // 1 覆盖（默认），2 保留
  intervalSeconds: number | null; // 默认 60
  codeType: number | null; // 1 纯数字（默认）
  autoRetry: number | null; // 1 开启（默认）

  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Db = {
  users: User[];
  pointsTransactions: PointsTransaction[];
  llmConfig?: LlmConfig;
  aiConfig?: AiConfig;
  toolConfig?: ToolConfig;
  /** Run 审计（开发期先落本地 JSON；后续可迁 Postgres） */
  runAudits?: RunAudit[];
};

export type RunAuditKind = "llm.chat" | "agent.run";

export type RunAuditEvent = {
  ts: number; // epoch ms
  event: string; // run.start/run.end/tool.call/tool.result/policy.decision/error...
  data: unknown;
};

export type RunAudit = {
  id: string; // runId
  kind: RunAuditKind;
  mode: "chat" | "plan" | "agent";
  userId: string | null;
  model: string | null;
  endpoint: string | null;
  startedAt: string; // ISO
  endedAt: string | null; // ISO
  endReason: string | null;
  endReasonCodes: string[];
  usage: { promptTokens: number; completionTokens: number; totalTokens?: number } | null;
  chargedPoints: number | null;
  events: RunAuditEvent[];
  meta: unknown | null;
};

const DEFAULT_DB: Db = { users: [], pointsTransactions: [], llmConfig: undefined, aiConfig: undefined, toolConfig: undefined, runAudits: [] };

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
        const emailRaw = typeof u?.email === "string" ? u.email : "";
        const phoneRaw = typeof (u as any)?.phone === "string" ? String((u as any).phone) : "";
        const email = emailRaw.trim() ? emailRaw.trim().toLowerCase() : null;
        const phone = phoneRaw.trim() ? phoneRaw.trim() : null;
        const role = u?.role === "admin" ? "admin" : "user";
        const pointsBalance = Number.isFinite(u?.pointsBalance) ? Number(u.pointsBalance) : 0;
        const createdAt = typeof u?.createdAt === "string" ? u.createdAt : new Date().toISOString();
        const id = typeof u?.id === "string" ? u.id : "";
        // 兼容历史：旧数据一定有 email；新数据允许 phone-only 或 email-only
        if (!id || (!email && !phone)) return null;
        return { id, email, phone, role, pointsBalance, createdAt };
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

          const toolResultFormat: "xml" | "text" = m?.toolResultFormat === "text" ? "text" : "xml";
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
            toolResultFormat,
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

    const rawTool = (parsed as any)?.toolConfig;
    const toolConfig: Db["toolConfig"] = (() => {
      if (!rawTool || typeof rawTool !== "object") return undefined;
      const t: any = rawTool;
      const updatedAt = normStr(t?.updatedAt) || nowIso;

      const normList = (v: any) =>
        Array.isArray(v) ? v.map((x: any) => normStr(x)).filter(Boolean).slice(0, 200) : [];
      const normNum = (v: any) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const normNullableStr = (v: any) => {
        const s = typeof v === "string" ? String(v).trim() : "";
        return s ? s : null;
      };

      const webRaw = t?.webSearch && typeof t.webSearch === "object" ? (t.webSearch as any) : null;
      const webSearch: WebSearchConfig | undefined = (() => {
        if (!webRaw) return undefined;
        const provider: WebSearchProvider = "bocha"; // v0.1：仅支持 bocha
        const isEnabled = webRaw?.isEnabled === false ? false : true;
        const endpoint = typeof webRaw?.endpoint === "string" ? normStr(webRaw.endpoint) : null;
        const apiKeyEnc = typeof webRaw?.apiKeyEnc === "string" ? String(webRaw.apiKeyEnc) : null;
        const apiKeyLast4 = typeof webRaw?.apiKeyLast4 === "string" ? normStr(webRaw.apiKeyLast4) : null;
        const billPointsPerSearch = normNum(webRaw?.billPointsPerSearch);
        const billPointsPerFetch = normNum(webRaw?.billPointsPerFetch);
        const allowDomains = normList(webRaw?.allowDomains);
        const denyDomains = normList(webRaw?.denyDomains);
        const fetchUa = typeof webRaw?.fetchUa === "string" ? String(webRaw.fetchUa).trim() : null;
        const updatedBy = typeof webRaw?.updatedBy === "string" ? normStr(webRaw.updatedBy) : null;
        const createdAt = typeof webRaw?.createdAt === "string" ? normStr(webRaw.createdAt) || nowIso : nowIso;
        const updatedAt2 = typeof webRaw?.updatedAt === "string" ? normStr(webRaw.updatedAt) || createdAt : createdAt;
        return {
          provider,
          isEnabled,
          endpoint,
          apiKeyEnc,
          apiKeyLast4,
          billPointsPerSearch,
          billPointsPerFetch,
          allowDomains,
          denyDomains,
          fetchUa,
          updatedBy,
          createdAt,
          updatedAt: updatedAt2
        };
      })();

      const smsRaw = t?.smsVerify && typeof t.smsVerify === "object" ? (t.smsVerify as any) : null;
      const smsVerify: SmsVerifyConfig | undefined = (() => {
        if (!smsRaw) return undefined;
        const provider: SmsVerifyProvider = "aliyun_dypnsapi";
        const isEnabled = smsRaw?.isEnabled === false ? false : true;
        const endpoint = normNullableStr(smsRaw?.endpoint);
        const accessKeyIdEnc = typeof smsRaw?.accessKeyIdEnc === "string" ? String(smsRaw.accessKeyIdEnc) : null;
        const accessKeyIdLast4 = typeof smsRaw?.accessKeyIdLast4 === "string" ? normStr(smsRaw.accessKeyIdLast4) : null;
        const accessKeySecretEnc = typeof smsRaw?.accessKeySecretEnc === "string" ? String(smsRaw.accessKeySecretEnc) : null;
        const accessKeySecretLast4 = typeof smsRaw?.accessKeySecretLast4 === "string" ? normStr(smsRaw.accessKeySecretLast4) : null;
        const schemeName = normNullableStr(smsRaw?.schemeName);
        const signName = normNullableStr(smsRaw?.signName);
        const templateCode = normNullableStr(smsRaw?.templateCode);
        const templateMin = normNum(smsRaw?.templateMin);
        const codeLength = normNum(smsRaw?.codeLength);
        const validTimeSeconds = normNum(smsRaw?.validTimeSeconds);
        const duplicatePolicy = normNum(smsRaw?.duplicatePolicy);
        const intervalSeconds = normNum(smsRaw?.intervalSeconds);
        const codeType = normNum(smsRaw?.codeType);
        const autoRetry = normNum(smsRaw?.autoRetry);
        const updatedBy = typeof smsRaw?.updatedBy === "string" ? normStr(smsRaw.updatedBy) : null;
        const createdAt = typeof smsRaw?.createdAt === "string" ? normStr(smsRaw.createdAt) || nowIso : nowIso;
        const updatedAt2 = typeof smsRaw?.updatedAt === "string" ? normStr(smsRaw.updatedAt) || createdAt : createdAt;
        return {
          provider,
          isEnabled,
          endpoint,
          accessKeyIdEnc,
          accessKeyIdLast4,
          accessKeySecretEnc,
          accessKeySecretLast4,
          schemeName,
          signName,
          templateCode,
          templateMin,
          codeLength,
          validTimeSeconds,
          duplicatePolicy,
          intervalSeconds,
          codeType,
          autoRetry,
          updatedBy,
          createdAt,
          updatedAt: updatedAt2,
        };
      })();

      const capsRaw = t?.capabilities && typeof t.capabilities === "object" ? (t.capabilities as any) : null;
      const capabilities: CapabilitiesConfig | undefined = (() => {
        if (!capsRaw) return undefined;
        const tools = capsRaw?.tools && typeof capsRaw.tools === "object" ? capsRaw.tools : { disabledByMode: {} };
        const skills = capsRaw?.skills && typeof capsRaw.skills === "object" ? capsRaw.skills : { disabled: [] };
        const updatedBy = typeof capsRaw?.updatedBy === "string" ? normStr(capsRaw.updatedBy) : null;
        const createdAt = typeof capsRaw?.createdAt === "string" ? normStr(capsRaw.createdAt) || nowIso : nowIso;
        const updatedAt2 = typeof capsRaw?.updatedAt === "string" ? normStr(capsRaw.updatedAt) || createdAt : createdAt;
        return {
          tools: { disabledByMode: tools.disabledByMode ?? {} },
          skills: { disabled: Array.isArray(skills.disabled) ? skills.disabled.map((x: any) => normStr(x)).filter(Boolean).slice(0, 200) : [] },
          updatedBy,
          createdAt,
          updatedAt: updatedAt2,
        } as any;
      })();

      const out: ToolConfig = {
        updatedAt,
        ...(webSearch ? { webSearch } : {}),
        ...(smsVerify ? { smsVerify } : {}),
        ...(capabilities ? { capabilities } : {}),
      };
      return out;
    })();

    const runAuditsRaw = Array.isArray((parsed as any).runAudits) ? (((parsed as any).runAudits as any[]) ?? []) : [];
    const runAudits = runAuditsRaw
      .map((r) => {
        const id = typeof r?.id === "string" ? r.id : "";
        const kind: RunAuditKind = r?.kind === "agent.run" ? "agent.run" : "llm.chat";
        const mode: RunAudit["mode"] = r?.mode === "plan" ? "plan" : r?.mode === "agent" ? "agent" : "chat";
        if (!id) return null;
        const userId = typeof r?.userId === "string" ? String(r.userId) : null;
        const model = typeof r?.model === "string" ? String(r.model) : null;
        const endpoint = typeof r?.endpoint === "string" ? String(r.endpoint) : null;
        const startedAt = typeof r?.startedAt === "string" ? String(r.startedAt) : nowIso;
        const endedAt = typeof r?.endedAt === "string" ? String(r.endedAt) : null;
        const endReason = typeof r?.endReason === "string" ? String(r.endReason) : null;
        const endReasonCodes = Array.isArray(r?.endReasonCodes)
          ? (r.endReasonCodes as any[]).map((x) => String(x ?? "")).filter(Boolean).slice(0, 32)
          : [];
        const usageRaw = r?.usage && typeof r.usage === "object" ? (r.usage as any) : null;
        const usage =
          usageRaw && (Number.isFinite(usageRaw.promptTokens) || Number.isFinite(usageRaw.completionTokens) || Number.isFinite(usageRaw.totalTokens))
            ? {
                promptTokens: Math.max(0, Math.floor(Number(usageRaw.promptTokens) || 0)),
                completionTokens: Math.max(0, Math.floor(Number(usageRaw.completionTokens) || 0)),
                ...(Number.isFinite(usageRaw.totalTokens) ? { totalTokens: Math.max(0, Math.floor(Number(usageRaw.totalTokens))) } : {}),
              }
            : null;
        const chargedPoints = Number.isFinite((r as any)?.chargedPoints) ? Math.floor(Number((r as any).chargedPoints)) : null;
        const eventsRaw = Array.isArray(r?.events) ? (r.events as any[]) : [];
        const events: RunAuditEvent[] = eventsRaw
          .map((e) => {
            const ts = Number(e?.ts);
            const event = typeof e?.event === "string" ? String(e.event) : "";
            if (!Number.isFinite(ts) || !event) return null;
            return { ts: Math.floor(ts), event, data: (e as any).data };
          })
          .filter((x): x is RunAuditEvent => Boolean(x))
          .slice(0, 5000);
        const meta = (r as any)?.meta ?? null;
        return { id, kind, mode, userId, model, endpoint, startedAt, endedAt, endReason, endReasonCodes, usage, chargedPoints, events, meta };
      })
      .filter((x): x is RunAudit => Boolean(x));

    return { users, pointsTransactions, llmConfig, aiConfig, toolConfig, runAudits };
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

// ======== DB 原子更新（串行化 load-modify-save，避免并发覆盖） ========

let dbUpdateQueue: Promise<void> = Promise.resolve();

export function updateDb<T>(fn: (db: Db) => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    dbUpdateQueue = dbUpdateQueue
      .catch(() => void 0)
      .then(async () => {
        try {
          const db = await loadDb();
          const ret = await fn(db);
          await saveDb(db);
          resolve(ret);
        } catch (e) {
          reject(e);
        }
      });
  });
}


