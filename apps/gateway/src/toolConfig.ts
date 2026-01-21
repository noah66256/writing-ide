import crypto from "node:crypto";
import {
  loadDb,
  saveDb,
  updateDb,
  type CapabilitiesConfig,
  type Db,
  type SmsVerifyConfig,
  type SmsVerifyProvider,
  type ToolConfig,
  type ToolMode,
  type WebSearchConfig,
} from "./db.js";

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

function getEncKey(): Buffer {
  const secret =
    String(process.env.TOOL_CONFIG_SECRET ?? "").trim() ||
    String(process.env.AI_CONFIG_SECRET ?? "").trim() ||
    String(process.env.JWT_SECRET ?? "").trim() ||
    "dev-tool-config-secret";
  return crypto.createHash("sha256").update(secret).digest(); // 32 bytes
}

function encryptSecret(apiKey: string): { enc: string; last4: string } {
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

function decryptSecret(enc: string): string {
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

function parseCsv(v: any) {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clampList(arr: string[], max: number) {
  return arr.length > max ? arr.slice(0, max) : arr;
}

function normalizeDomainsInput(input: unknown): string[] {
  if (Array.isArray(input)) {
    return clampList(
      input
        .map((x) => String(x ?? "").trim().toLowerCase())
        .filter(Boolean),
      200,
    );
  }
  const s = String(input ?? "").trim();
  if (!s) return [];
  // 兼容 textarea：换行或逗号分隔
  const parts = s
    .split(/[\n,]+/g)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return clampList(parts, 200);
}

export type WebSearchConfigStoredView = Omit<WebSearchConfig, "apiKeyEnc" | "apiKeyLast4"> & {
  hasApiKey: boolean;
  apiKeyMasked: string | null;
};

export type WebSearchConfigEffectiveView = {
  provider: "bocha";
  isEnabled: boolean;
  endpoint: string;
  allowDomains: string[];
  denyDomains: string[];
  fetchUa: string | null;
  source: {
    apiKey: "stored" | "env" | "none";
    endpoint: "stored" | "env" | "default";
    allowDomains: "stored" | "env" | "default";
    denyDomains: "stored" | "env" | "default";
    fetchUa: "stored" | "env" | "default";
  };
};

export type WebSearchRuntime = {
  provider: "bocha";
  isEnabled: boolean;
  endpoint: string;
  apiKey: string;
  allowDomains: string[];
  denyDomains: string[];
  fetchUa: string | null;
};

export type SmsVerifyConfigStoredView = Omit<
  SmsVerifyConfig,
  "accessKeyIdEnc" | "accessKeyIdLast4" | "accessKeySecretEnc" | "accessKeySecretLast4"
> & {
  hasAccessKeyId: boolean;
  accessKeyIdMasked: string | null;
  hasAccessKeySecret: boolean;
  accessKeySecretMasked: string | null;
};

export type SmsVerifyConfigEffectiveView = {
  provider: SmsVerifyProvider;
  isEnabled: boolean;
  endpoint: string;
  schemeName: string | null;
  signName: string | null;
  templateCode: string | null;
  templateMin: number | null;
  codeLength: number | null;
  validTimeSeconds: number | null;
  duplicatePolicy: number | null;
  intervalSeconds: number | null;
  codeType: number | null;
  autoRetry: number | null;
  source: {
    accessKeyId: "stored" | "env" | "none";
    accessKeySecret: "stored" | "env" | "none";
    endpoint: "stored" | "env" | "default";
    schemeName: "stored" | "env" | "default";
    signName: "stored" | "env" | "default";
    templateCode: "stored" | "env" | "default";
  };
};

export type SmsVerifyRuntime = {
  provider: SmsVerifyProvider;
  isEnabled: boolean;
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  schemeName: string | null;
  signName: string;
  templateCode: string;
  templateMin: number;
  codeLength: number;
  validTimeSeconds: number;
  duplicatePolicy: number;
  intervalSeconds: number;
  codeType: number;
  autoRetry: number;
};

const LOCKED_TOOL_NAMES_V1: string[] = [
  "run.mainDoc.get",
  "run.mainDoc.update",
  "run.setTodoList",
  "run.updateTodo",
  "run.todo.upsertMany",
  "run.todo.update",
  "run.todo.remove",
  "run.todo.clear",
];

function normalizeNameList(v: unknown, max = 400): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,]+/g) : [];
  const arr = raw
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
  // 去重保序
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of arr) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizeDisabledByMode(input: unknown): Partial<Record<ToolMode, string[]>> {
  const o = (input && typeof input === "object" ? input : {}) as any;
  const chat = normalizeNameList(o.chat ?? []);
  const plan = normalizeNameList(o.plan ?? []);
  const agent = normalizeNameList(o.agent ?? []);
  const out: Partial<Record<ToolMode, string[]>> = {};
  if (chat.length) out.chat = chat;
  if (plan.length) out.plan = plan;
  if (agent.length) out.agent = agent;
  return out;
}

export type CapabilitiesConfigStoredView = {
  tools: { disabledByMode: Partial<Record<ToolMode, string[]>> };
  skills: { disabled: string[] };
  lockedTools: string[];
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CapabilitiesRuntime = {
  lockedTools: string[];
  disabledToolsByMode: Record<ToolMode, Set<string>>;
  disabledSkillIds: Set<string>;
};

export function createToolConfigService(args?: { cacheTtlMs?: number }) {
  const TTL = Number.isFinite(args?.cacheTtlMs as any) ? Math.max(0, Number(args?.cacheTtlMs)) : 5000;
  let cached: { at: number; tool: ToolConfig } | null = null;
  let cachedCaps: { at: number; caps: CapabilitiesRuntime } | null = null;

  const clearCache = () => {
    cached = null;
    cachedCaps = null;
  };

  const getToolConfig = async (): Promise<ToolConfig> => {
    const now = Date.now();
    if (cached && now - cached.at < TTL) return cached.tool;
    const db = await loadDb();
    const tool: ToolConfig =
      db.toolConfig && typeof db.toolConfig === "object"
        ? db.toolConfig
        : {
            updatedAt: nowIso(),
          };
    cached = { at: now, tool };
    return tool;
  };

  const saveToolConfig = async (tool: ToolConfig) => {
    const next: ToolConfig = { ...tool, updatedAt: nowIso() };
    if (next.webSearch && typeof (next as any).webSearch === "object") {
      // 轻量修正：数组字段兜底
      next.webSearch.allowDomains = Array.isArray(next.webSearch.allowDomains) ? next.webSearch.allowDomains : [];
      next.webSearch.denyDomains = Array.isArray(next.webSearch.denyDomains) ? next.webSearch.denyDomains : [];
    }
    if (next.capabilities && typeof (next as any).capabilities === "object") {
      const c = next.capabilities as any;
      c.tools = c.tools && typeof c.tools === "object" ? c.tools : { disabledByMode: {} };
      c.tools.disabledByMode = normalizeDisabledByMode(c.tools.disabledByMode ?? {});
      c.skills = c.skills && typeof c.skills === "object" ? c.skills : { disabled: [] };
      c.skills.disabled = normalizeNameList(c.skills.disabled ?? [], 200);
    }
    await updateDb((db: Db) => {
      db.toolConfig = next;
    });
    clearCache();
  };

  const getStoredWebSearch = async (): Promise<WebSearchConfigStoredView> => {
    const tool = await getToolConfig();
    const web = tool.webSearch ?? null;
    const hasApiKey = Boolean(web?.apiKeyEnc);
    const apiKeyMasked = web?.apiKeyLast4 ? `****${web.apiKeyLast4}` : null;
    const base: WebSearchConfig = web ?? {
      provider: "bocha",
      isEnabled: true,
      endpoint: null,
      apiKeyEnc: null,
      apiKeyLast4: null,
      allowDomains: [],
      denyDomains: [],
      fetchUa: null,
      updatedBy: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const { apiKeyEnc: _1, apiKeyLast4: _2, ...rest } = base as any;
    return { ...(rest as any), hasApiKey, apiKeyMasked };
  };

  const getStoredSmsVerify = async (): Promise<SmsVerifyConfigStoredView> => {
    const tool = await getToolConfig();
    const sms = tool.smsVerify ?? null;
    const hasAccessKeyId = Boolean(sms?.accessKeyIdEnc);
    const hasAccessKeySecret = Boolean(sms?.accessKeySecretEnc);
    const accessKeyIdMasked = sms?.accessKeyIdLast4 ? `****${sms.accessKeyIdLast4}` : null;
    const accessKeySecretMasked = sms?.accessKeySecretLast4 ? `****${sms.accessKeySecretLast4}` : null;
    const t = nowIso();
    const base: SmsVerifyConfig =
      sms ?? ({
        provider: "aliyun_dypnsapi",
        isEnabled: true,
        endpoint: null,
        accessKeyIdEnc: null,
        accessKeyIdLast4: null,
        accessKeySecretEnc: null,
        accessKeySecretLast4: null,
        schemeName: null,
        signName: null,
        templateCode: null,
        templateMin: 5,
        codeLength: 6,
        validTimeSeconds: 300,
        duplicatePolicy: 1,
        intervalSeconds: 60,
        codeType: 1,
        autoRetry: 1,
        updatedBy: null,
        createdAt: t,
        updatedAt: t,
      } as any);
    const {
      accessKeyIdEnc: _1,
      accessKeyIdLast4: _2,
      accessKeySecretEnc: _3,
      accessKeySecretLast4: _4,
      ...rest
    } = base as any;
    return { ...(rest as any), hasAccessKeyId, accessKeyIdMasked, hasAccessKeySecret, accessKeySecretMasked };
  };

  const resolveSmsVerifyRuntime = async (): Promise<SmsVerifyRuntime> => {
    const tool = await getToolConfig();
    const stored = tool.smsVerify ?? null;

    const endpointDefault = "dypnsapi.aliyuncs.com";
    const endpointEnv = String(process.env.ALIYUN_DYPNSAPI_ENDPOINT ?? "").trim();
    const endpoint = (stored?.endpoint && String(stored.endpoint).trim()) || endpointEnv || endpointDefault;

    // SDK 通用环境变量兼容
    const akidEnv =
      String(process.env.ALIYUN_ACCESS_KEY_ID ?? "").trim() || String(process.env.ALIBABA_CLOUD_ACCESS_KEY_ID ?? "").trim();
    const aksEnv =
      String(process.env.ALIYUN_ACCESS_KEY_SECRET ?? "").trim() ||
      String(process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET ?? "").trim();
    const akidStored = stored?.accessKeyIdEnc ? normalizeApiKeyInput(decryptSecret(stored.accessKeyIdEnc)) : "";
    const aksStored = stored?.accessKeySecretEnc ? normalizeApiKeyInput(decryptSecret(stored.accessKeySecretEnc)) : "";
    const accessKeyId = akidStored || akidEnv || "";
    const accessKeySecret = aksStored || aksEnv || "";

    const schemeEnv = String(process.env.ALIYUN_DYPNSAPI_SCHEME_NAME ?? "").trim();
    const signEnv = String(process.env.ALIYUN_DYPNSAPI_SIGN_NAME ?? "").trim();
    const tplEnv = String(process.env.ALIYUN_DYPNSAPI_TEMPLATE_CODE ?? "").trim();

    const schemeName = (stored?.schemeName && String(stored.schemeName).trim()) || schemeEnv || null;
    const signName = (stored?.signName && String(stored.signName).trim()) || signEnv || "";
    const templateCode = (stored?.templateCode && String(stored.templateCode).trim()) || tplEnv || "";

    const templateMin = Number.isFinite(stored?.templateMin as any) ? Math.max(1, Math.floor(Number(stored!.templateMin))) : 5;
    const codeLength =
      Number.isFinite(stored?.codeLength as any) ? Math.min(8, Math.max(4, Math.floor(Number(stored!.codeLength)))) : 6;
    const validTimeSeconds =
      Number.isFinite(stored?.validTimeSeconds as any) ? Math.max(60, Math.floor(Number(stored!.validTimeSeconds))) : 300;
    const duplicatePolicy =
      Number.isFinite(stored?.duplicatePolicy as any) ? Math.max(1, Math.min(2, Math.floor(Number(stored!.duplicatePolicy)))) : 1;
    const intervalSeconds =
      Number.isFinite(stored?.intervalSeconds as any) ? Math.max(1, Math.floor(Number(stored!.intervalSeconds))) : 60;
    const codeType = Number.isFinite(stored?.codeType as any) ? Math.max(1, Math.floor(Number(stored!.codeType))) : 1;
    const autoRetry = Number.isFinite(stored?.autoRetry as any) ? Math.max(0, Math.min(1, Math.floor(Number(stored!.autoRetry)))) : 1;

    const isEnabled = stored ? stored.isEnabled !== false : true;

    return {
      provider: "aliyun_dypnsapi",
      isEnabled,
      endpoint,
      accessKeyId,
      accessKeySecret,
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
    };
  };

  const getEffectiveSmsVerify = async (): Promise<SmsVerifyConfigEffectiveView> => {
    const tool = await getToolConfig();
    const stored = tool.smsVerify ?? null;

    const endpointDefault = "dypnsapi.aliyuncs.com";
    const endpointEnv = String(process.env.ALIYUN_DYPNSAPI_ENDPOINT ?? "").trim();
    const endpointStored = stored?.endpoint ? String(stored.endpoint).trim() : "";
    const endpoint = endpointStored || endpointEnv || endpointDefault;
    const endpointSrc: SmsVerifyConfigEffectiveView["source"]["endpoint"] = endpointStored ? "stored" : endpointEnv ? "env" : "default";

    const akidEnv =
      String(process.env.ALIYUN_ACCESS_KEY_ID ?? "").trim() || String(process.env.ALIBABA_CLOUD_ACCESS_KEY_ID ?? "").trim();
    const aksEnv =
      String(process.env.ALIYUN_ACCESS_KEY_SECRET ?? "").trim() ||
      String(process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET ?? "").trim();
    const akidStored = stored?.accessKeyIdEnc ? normalizeApiKeyInput(decryptSecret(stored.accessKeyIdEnc)) : "";
    const aksStored = stored?.accessKeySecretEnc ? normalizeApiKeyInput(decryptSecret(stored.accessKeySecretEnc)) : "";
    const akidSrc: SmsVerifyConfigEffectiveView["source"]["accessKeyId"] = akidStored ? "stored" : akidEnv ? "env" : "none";
    const aksSrc: SmsVerifyConfigEffectiveView["source"]["accessKeySecret"] = aksStored ? "stored" : aksEnv ? "env" : "none";

    const schemeEnv = String(process.env.ALIYUN_DYPNSAPI_SCHEME_NAME ?? "").trim();
    const signEnv = String(process.env.ALIYUN_DYPNSAPI_SIGN_NAME ?? "").trim();
    const tplEnv = String(process.env.ALIYUN_DYPNSAPI_TEMPLATE_CODE ?? "").trim();
    const schemeStored = stored?.schemeName ? String(stored.schemeName).trim() : "";
    const signStored = stored?.signName ? String(stored.signName).trim() : "";
    const tplStored = stored?.templateCode ? String(stored.templateCode).trim() : "";
    const schemeName = schemeStored || schemeEnv || null;
    const signName = signStored || signEnv || null;
    const templateCode = tplStored || tplEnv || null;

    const schemeSrc: SmsVerifyConfigEffectiveView["source"]["schemeName"] = schemeStored ? "stored" : schemeEnv ? "env" : "default";
    const signSrc: SmsVerifyConfigEffectiveView["source"]["signName"] = signStored ? "stored" : signEnv ? "env" : "default";
    const tplSrc: SmsVerifyConfigEffectiveView["source"]["templateCode"] = tplStored ? "stored" : tplEnv ? "env" : "default";

    const isEnabled = stored ? stored.isEnabled !== false : true;

    return {
      provider: "aliyun_dypnsapi",
      isEnabled,
      endpoint,
      schemeName,
      signName,
      templateCode,
      templateMin: stored?.templateMin ?? null,
      codeLength: stored?.codeLength ?? null,
      validTimeSeconds: stored?.validTimeSeconds ?? null,
      duplicatePolicy: stored?.duplicatePolicy ?? null,
      intervalSeconds: stored?.intervalSeconds ?? null,
      codeType: stored?.codeType ?? null,
      autoRetry: stored?.autoRetry ?? null,
      source: {
        accessKeyId: akidSrc,
        accessKeySecret: aksSrc,
        endpoint: endpointSrc,
        schemeName: schemeSrc,
        signName: signSrc,
        templateCode: tplSrc,
      },
    };
  };

  const upsertSmsVerify = async (patch: Partial<{
    isEnabled: boolean;
    endpoint: string | null;
    accessKeyId: string;
    accessKeySecret: string;
    clearAccessKeyId: boolean;
    clearAccessKeySecret: boolean;
    schemeName: string | null;
    signName: string | null;
    templateCode: string | null;
    templateMin: number | null;
    codeLength: number | null;
    validTimeSeconds: number | null;
    duplicatePolicy: number | null;
    intervalSeconds: number | null;
    codeType: number | null;
    autoRetry: number | null;
    updatedBy: string | null;
  }>) => {
    const tool = await getToolConfig();
    const cur = tool.smsVerify ?? null;
    const t = nowIso();

    let accessKeyIdEnc = cur?.accessKeyIdEnc ?? null;
    let accessKeyIdLast4 = cur?.accessKeyIdLast4 ?? null;
    if (patch.clearAccessKeyId) {
      accessKeyIdEnc = null;
      accessKeyIdLast4 = null;
    } else if (patch.accessKeyId !== undefined) {
      const k = String(patch.accessKeyId ?? "").trim();
      if (k) {
        const enc = encryptSecret(k);
        accessKeyIdEnc = enc.enc;
        accessKeyIdLast4 = enc.last4;
      }
    }

    let accessKeySecretEnc = cur?.accessKeySecretEnc ?? null;
    let accessKeySecretLast4 = cur?.accessKeySecretLast4 ?? null;
    if (patch.clearAccessKeySecret) {
      accessKeySecretEnc = null;
      accessKeySecretLast4 = null;
    } else if (patch.accessKeySecret !== undefined) {
      const k = String(patch.accessKeySecret ?? "").trim();
      if (k) {
        const enc = encryptSecret(k);
        accessKeySecretEnc = enc.enc;
        accessKeySecretLast4 = enc.last4;
      }
    }

    const next: SmsVerifyConfig = {
      provider: "aliyun_dypnsapi",
      isEnabled: patch.isEnabled !== undefined ? Boolean(patch.isEnabled) : cur ? cur.isEnabled !== false : true,
      endpoint: patch.endpoint !== undefined ? (patch.endpoint ? String(patch.endpoint).trim() : null) : cur?.endpoint ?? null,
      accessKeyIdEnc,
      accessKeyIdLast4,
      accessKeySecretEnc,
      accessKeySecretLast4,
      schemeName: patch.schemeName !== undefined ? (patch.schemeName ? String(patch.schemeName).trim() : null) : cur?.schemeName ?? null,
      signName: patch.signName !== undefined ? (patch.signName ? String(patch.signName).trim() : null) : cur?.signName ?? null,
      templateCode:
        patch.templateCode !== undefined ? (patch.templateCode ? String(patch.templateCode).trim() : null) : cur?.templateCode ?? null,
      templateMin: patch.templateMin !== undefined ? (patch.templateMin === null ? null : Math.floor(Number(patch.templateMin))) : cur?.templateMin ?? null,
      codeLength: patch.codeLength !== undefined ? (patch.codeLength === null ? null : Math.floor(Number(patch.codeLength))) : cur?.codeLength ?? null,
      validTimeSeconds:
        patch.validTimeSeconds !== undefined ? (patch.validTimeSeconds === null ? null : Math.floor(Number(patch.validTimeSeconds))) : cur?.validTimeSeconds ?? null,
      duplicatePolicy:
        patch.duplicatePolicy !== undefined ? (patch.duplicatePolicy === null ? null : Math.floor(Number(patch.duplicatePolicy))) : cur?.duplicatePolicy ?? null,
      intervalSeconds:
        patch.intervalSeconds !== undefined ? (patch.intervalSeconds === null ? null : Math.floor(Number(patch.intervalSeconds))) : cur?.intervalSeconds ?? null,
      codeType: patch.codeType !== undefined ? (patch.codeType === null ? null : Math.floor(Number(patch.codeType))) : cur?.codeType ?? null,
      autoRetry: patch.autoRetry !== undefined ? (patch.autoRetry === null ? null : Math.floor(Number(patch.autoRetry))) : cur?.autoRetry ?? null,
      updatedBy: patch.updatedBy !== undefined ? patch.updatedBy : cur?.updatedBy ?? null,
      createdAt: cur?.createdAt ?? t,
      updatedAt: t,
    };

    await saveToolConfig({ ...tool, smsVerify: next, updatedAt: nowIso() });
  };

  const resolveWebSearchRuntime = async (): Promise<WebSearchRuntime> => {
    const tool = await getToolConfig();
    const stored = tool.webSearch ?? null;

    const endpointDefault = "https://api.bochaai.com/v1/web-search";
    const endpointEnv = String(process.env.BOCHA_WEB_SEARCH_ENDPOINT ?? "").trim();
    const endpoint = (stored?.endpoint && String(stored.endpoint).trim()) || endpointEnv || endpointDefault;

    const apiKeyStored = stored?.apiKeyEnc ? normalizeApiKeyInput(decryptSecret(stored.apiKeyEnc)) : "";
    const apiKeyEnv = normalizeApiKeyInput(String(process.env.BOCHA_API_KEY ?? ""));
    const apiKey = apiKeyStored || apiKeyEnv || "";

    const allowStored = Array.isArray(stored?.allowDomains) ? stored!.allowDomains : [];
    const denyStored = Array.isArray(stored?.denyDomains) ? stored!.denyDomains : [];
    const allowEnv = parseCsv(process.env.WEB_ALLOW_DOMAINS ?? "").map((x) => x.toLowerCase());
    const denyEnv = parseCsv(process.env.WEB_DENY_DOMAINS ?? "").map((x) => x.toLowerCase());
    const allowDomains = allowStored.length ? allowStored : allowEnv;
    const denyDomains = denyStored.length ? denyStored : denyEnv;

    const fetchUaStored = stored?.fetchUa ? String(stored.fetchUa).trim() : "";
    const fetchUaEnv = String(process.env.WEB_FETCH_UA ?? "").trim();
    const fetchUa = fetchUaStored || fetchUaEnv || null;

    const isEnabled = stored ? stored.isEnabled !== false : true;

    return {
      provider: "bocha",
      isEnabled,
      endpoint,
      apiKey,
      allowDomains: clampList(allowDomains.map((x) => String(x).trim().toLowerCase()).filter(Boolean), 200),
      denyDomains: clampList(denyDomains.map((x) => String(x).trim().toLowerCase()).filter(Boolean), 200),
      fetchUa: fetchUa ? fetchUa.slice(0, 400) : null,
    };
  };

  const getEffectiveWebSearch = async (): Promise<WebSearchConfigEffectiveView> => {
    const tool = await getToolConfig();
    const stored = tool.webSearch ?? null;

    const endpointDefault = "https://api.bochaai.com/v1/web-search";
    const endpointEnv = String(process.env.BOCHA_WEB_SEARCH_ENDPOINT ?? "").trim();
    const endpointStored = stored?.endpoint ? String(stored.endpoint).trim() : "";
    const endpoint = endpointStored || endpointEnv || endpointDefault;
    const endpointSrc: WebSearchConfigEffectiveView["source"]["endpoint"] = endpointStored ? "stored" : endpointEnv ? "env" : "default";

    const apiKeyStored = stored?.apiKeyEnc ? normalizeApiKeyInput(decryptSecret(stored.apiKeyEnc)) : "";
    const apiKeyEnv = normalizeApiKeyInput(String(process.env.BOCHA_API_KEY ?? ""));
    const apiKeySrc: WebSearchConfigEffectiveView["source"]["apiKey"] = apiKeyStored ? "stored" : apiKeyEnv ? "env" : "none";

    const allowStored = Array.isArray(stored?.allowDomains) ? stored!.allowDomains : [];
    const denyStored = Array.isArray(stored?.denyDomains) ? stored!.denyDomains : [];
    const allowEnv = parseCsv(process.env.WEB_ALLOW_DOMAINS ?? "").map((x) => x.toLowerCase());
    const denyEnv = parseCsv(process.env.WEB_DENY_DOMAINS ?? "").map((x) => x.toLowerCase());
    const allowDomains = allowStored.length ? allowStored : allowEnv;
    const denyDomains = denyStored.length ? denyStored : denyEnv;
    const allowSrc: WebSearchConfigEffectiveView["source"]["allowDomains"] = allowStored.length ? "stored" : allowEnv.length ? "env" : "default";
    const denySrc: WebSearchConfigEffectiveView["source"]["denyDomains"] = denyStored.length ? "stored" : denyEnv.length ? "env" : "default";

    const fetchUaStored = stored?.fetchUa ? String(stored.fetchUa).trim() : "";
    const fetchUaEnv = String(process.env.WEB_FETCH_UA ?? "").trim();
    const fetchUa = fetchUaStored || fetchUaEnv || null;
    const fetchUaSrc: WebSearchConfigEffectiveView["source"]["fetchUa"] = fetchUaStored ? "stored" : fetchUaEnv ? "env" : "default";

    const isEnabled = stored ? stored.isEnabled !== false : true;

    return {
      provider: "bocha",
      isEnabled,
      endpoint,
      allowDomains: clampList(allowDomains.map((x) => String(x).trim().toLowerCase()).filter(Boolean), 200),
      denyDomains: clampList(denyDomains.map((x) => String(x).trim().toLowerCase()).filter(Boolean), 200),
      fetchUa: fetchUa ? fetchUa.slice(0, 400) : null,
      source: {
        apiKey: apiKeySrc,
        endpoint: endpointSrc,
        allowDomains: allowSrc,
        denyDomains: denySrc,
        fetchUa: fetchUaSrc,
      },
    };
  };

  const upsertWebSearch = async (patch: Partial<{
    isEnabled: boolean;
    endpoint: string | null;
    apiKey: string;
    clearApiKey: boolean;
    allowDomains: unknown;
    denyDomains: unknown;
    fetchUa: string | null;
    updatedBy: string | null;
  }>) => {
    const tool = await getToolConfig();
    const cur = tool.webSearch ?? null;
    const t = nowIso();

    let apiKeyEnc = cur?.apiKeyEnc ?? null;
    let apiKeyLast4 = cur?.apiKeyLast4 ?? null;
    if (patch.clearApiKey) {
      apiKeyEnc = null;
      apiKeyLast4 = null;
    } else if (patch.apiKey !== undefined) {
      const k = normalizeApiKeyInput(patch.apiKey);
      if (k) {
        const enc = encryptSecret(k);
        apiKeyEnc = enc.enc;
        apiKeyLast4 = enc.last4;
      }
    }

    const next: WebSearchConfig = {
      provider: "bocha",
      isEnabled: patch.isEnabled !== undefined ? Boolean(patch.isEnabled) : cur ? cur.isEnabled !== false : true,
      endpoint: patch.endpoint !== undefined ? (patch.endpoint ? String(patch.endpoint).trim() : null) : cur?.endpoint ?? null,
      apiKeyEnc,
      apiKeyLast4,
      allowDomains: patch.allowDomains !== undefined ? normalizeDomainsInput(patch.allowDomains) : cur?.allowDomains ?? [],
      denyDomains: patch.denyDomains !== undefined ? normalizeDomainsInput(patch.denyDomains) : cur?.denyDomains ?? [],
      fetchUa: patch.fetchUa !== undefined ? (patch.fetchUa ? String(patch.fetchUa).trim().slice(0, 400) : null) : cur?.fetchUa ?? null,
      updatedBy: patch.updatedBy !== undefined ? patch.updatedBy : cur?.updatedBy ?? null,
      createdAt: cur?.createdAt ?? t,
      updatedAt: t,
    };

    await saveToolConfig({ ...tool, webSearch: next, updatedAt: nowIso() });
  };

  const testWebSearch = async (query: string) => {
    const q = String(query ?? "").trim();
    if (!q) return { ok: false as const, error: "MISSING_QUERY" };
    const rt = await resolveWebSearchRuntime();
    if (!rt.isEnabled) return { ok: false as const, error: "WEB_SEARCH_DISABLED" };
    if (!rt.apiKey) return { ok: false as const, error: "BOCHA_API_KEY_NOT_CONFIGURED" };
    const start = Date.now();
    try {
      const resp = await fetch(rt.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rt.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: q, freshness: "oneWeek", count: 3, summary: true }),
      });
      const text = await resp.text().catch(() => "");
      const latencyMs = Date.now() - start;
      if (!resp.ok) return { ok: false as const, error: `HTTP_${resp.status}`, latencyMs, detail: text.slice(0, 800) };
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const values = Array.isArray(json?.data?.webPages?.value) ? (json.data.webPages.value as any[]) : [];
      return { ok: true as const, latencyMs, resultCount: values.length };
    } catch (e: any) {
      const latencyMs = Date.now() - start;
      const msg = e?.message ? String(e.message) : String(e);
      return { ok: false as const, error: "FETCH_FAILED", latencyMs, detail: msg.slice(0, 800) };
    }
  };

  const getStoredCapabilities = async (): Promise<CapabilitiesConfigStoredView> => {
    const tool = await getToolConfig();
    const cur = tool.capabilities ?? null;
    const t = nowIso();
    const base: CapabilitiesConfig =
      cur ??
      ({
        tools: { disabledByMode: {} },
        skills: { disabled: [] },
        updatedBy: null,
        createdAt: t,
        updatedAt: t,
      } as any);
    const disabledByMode = normalizeDisabledByMode(base.tools?.disabledByMode ?? {});
    const disabledSkills = normalizeNameList(base.skills?.disabled ?? [], 200);
    return {
      tools: { disabledByMode },
      skills: { disabled: disabledSkills },
      lockedTools: LOCKED_TOOL_NAMES_V1.slice(),
      updatedBy: base.updatedBy ?? null,
      createdAt: base.createdAt ?? t,
      updatedAt: base.updatedAt ?? t,
    };
  };

  const resolveCapabilitiesRuntime = async (): Promise<CapabilitiesRuntime> => {
    const now = Date.now();
    if (cachedCaps && now - cachedCaps.at < TTL) return cachedCaps.caps;
    const stored = await getStoredCapabilities();
    const locked = new Set(LOCKED_TOOL_NAMES_V1);
    const toSet = (mode: ToolMode) => {
      const arr = (stored.tools.disabledByMode as any)?.[mode] ?? [];
      const set = new Set<string>();
      for (const n of Array.isArray(arr) ? arr : []) {
        const s = String(n ?? "").trim();
        if (!s) continue;
        if (locked.has(s)) continue;
        set.add(s);
      }
      return set;
    };
    const caps: CapabilitiesRuntime = {
      lockedTools: LOCKED_TOOL_NAMES_V1.slice(),
      disabledToolsByMode: {
        chat: toSet("chat"),
        plan: toSet("plan"),
        agent: toSet("agent"),
      },
      disabledSkillIds: new Set(stored.skills.disabled.map((x) => String(x ?? "").trim()).filter(Boolean)),
    };
    cachedCaps = { at: now, caps };
    return caps;
  };

  const upsertCapabilities = async (
    patch: Partial<{
      tools: Partial<{ disabledByMode: Partial<Record<ToolMode, unknown>> }>;
      skills: Partial<{ disabled: unknown }>;
      updatedBy: string | null;
    }>,
  ) => {
    const tool = await getToolConfig();
    const cur = tool.capabilities ?? null;
    const t = nowIso();
    const next: CapabilitiesConfig = {
      tools: {
        disabledByMode: normalizeDisabledByMode(
          patch?.tools?.disabledByMode !== undefined ? patch.tools.disabledByMode : cur?.tools?.disabledByMode ?? {},
        ),
      },
      skills: {
        disabled: normalizeNameList(patch?.skills?.disabled !== undefined ? patch.skills.disabled : cur?.skills?.disabled ?? [], 200),
      },
      updatedBy: patch.updatedBy !== undefined ? patch.updatedBy : cur?.updatedBy ?? null,
      createdAt: cur?.createdAt ?? t,
      updatedAt: t,
    };
    await saveToolConfig({ ...tool, capabilities: next, updatedAt: nowIso() });
  };

  return {
    clearCache,
    getStoredWebSearch,
    getEffectiveWebSearch,
    resolveWebSearchRuntime,
    upsertWebSearch,
    testWebSearch,
    getStoredSmsVerify,
    getEffectiveSmsVerify,
    resolveSmsVerifyRuntime,
    upsertSmsVerify,
    getStoredCapabilities,
    resolveCapabilitiesRuntime,
    upsertCapabilities,
  };
}

// 单例：全局工具配置中心（DB + 热缓存）
export const toolConfig = createToolConfigService({ cacheTtlMs: 5000 });


