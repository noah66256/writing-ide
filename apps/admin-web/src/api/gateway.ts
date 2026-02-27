import { apiFetchJson } from "./client";

export type UserRole = "admin" | "user";

export type UserDto = {
  id: string;
  email: string | null;
  phone?: string | null;
  role: UserRole;
  pointsBalance: number;
  billingGroup?: string | null;
  createdAt: string;
};

export type PointsTxType = "recharge" | "consume" | "adjust";

export type PointsTransactionDto = {
  id: string;
  userId: string;
  type: PointsTxType;
  delta: number;
  reason?: string;
  createdAt: string;
  meta?: any;
};

export type RunAuditKind = "llm.chat" | "agent.run";
export type RunAuditMode = "chat" | "agent";

export type RunAuditUsageDto = {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
};

export type RunAuditEventDto = {
  ts: number;
  event: string;
  data: any;
};

export type RunAuditDto = {
  id: string;
  kind: RunAuditKind;
  mode: RunAuditMode;
  userId: string | null;
  model: string | null;
  endpoint: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  endReasonCodes: string[];
  usage: RunAuditUsageDto | null;
  chargedPoints: number | null;
  events: RunAuditEventDto[];
  meta: any;
};

export type RunAuditListItemDto = Omit<RunAuditDto, "events"> & {
  eventCount: number;
  toolCallCount: number;
  toolResultCount: number;
  policyDecisionCount: number;
  errorCount: number;
  webToolCount: number;
};

export type LlmModelPriceDto = {
  priceInCnyPer1M: number;
  priceOutCnyPer1M: number;
};

export type AdminLlmStageStored = {
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  models: string[];
  defaultModel: string;
};

export type AdminLlmConfigStored = {
  updatedAt: string;
  llm: AdminLlmStageStored;
  embeddings: AdminLlmStageStored;
  card: AdminLlmStageStored;
  linter: AdminLlmStageStored & { timeoutMs: number };
  pricing: Record<string, LlmModelPriceDto>;
};

export type AdminLlmConfigEffective = {
  llm: { baseUrl: string; defaultModel: string; models: string[] };
  embeddings: { baseUrl: string; defaultModel: string; models: string[] };
  linter: { baseUrl: string; defaultModel: string; timeoutMs: number };
};

export async function adminLogin(args: { username: string; password: string }) {
  return apiFetchJson<{ accessToken: string; user: { id: string; email: string; role: "admin" } }>(
    "/api/admin/auth/login",
    { method: "POST", body: JSON.stringify(args) },
  );
}

// ======== Run/Tool 审计 ========

export async function adminListAuditRuns(args?: { top?: number; kind?: RunAuditKind; userId?: string }) {
  const qs = new URLSearchParams();
  if (args?.top) qs.set("top", String(args.top));
  if (args?.kind) qs.set("kind", String(args.kind));
  if (args?.userId) qs.set("userId", String(args.userId));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetchJson<{ runs: RunAuditListItemDto[] }>(`/api/admin/audit/runs${suffix}`);
}

export async function adminGetAuditRun(args: { runId: string }) {
  return apiFetchJson<{ run: RunAuditDto }>(`/api/admin/audit/runs/${encodeURIComponent(args.runId)}`);
}

// ======== AI Config（对齐「锦李2.0」：模型管理 + stage 路由） ========

export type AiModelTestResultDto = {
  ok: boolean;
  latencyMs: number | null;
  status: number | null;
  error: string | null;
  testedAt: string;
  headers?: Record<string, string>;
};

export type AiModelTestRunDto = AiModelTestResultDto & {
  modelId: string;
  model: string;
  baseURL: string;
  endpoint: string;
  endpointUrl: string;
};

export type AiProviderDto = {
  id: string;
  name: string;
  baseURL: string;
  isEnabled: boolean;
  sortOrder: number;
  description: string | null;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiModelDto = {
  id: string;
  model: string;
  providerId: string | null;
  providerName: string | null;
  providerBaseURL: string | null;
  baseURL: string;
  endpoint: string;
  toolResultFormat?: "xml" | "text";
  priceInCnyPer1M: number | null;
  priceOutCnyPer1M: number | null;
  billingGroup: string | null;
  isEnabled: boolean;
  sortOrder: number;
  description: string | null;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  testResult: AiModelTestResultDto | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiStageDto = {
  stage: string;
  name: string;
  description: string;
  modelId: string | null;
  modelIds: string[] | null;
  model: string;
  baseURL: string;
  endpoint: string;
  temperature: number | null;
  maxTokens: number | null;
  isEnabled: boolean;
};

export async function aiConfigListProviders() {
  return apiFetchJson<{ providers: AiProviderDto[] }>("/api/ai-config/providers");
}

export async function aiConfigCreateProvider(body: {
  name: string;
  baseURL: string;
  apiKey?: string;
  isEnabled?: boolean;
  sortOrder?: number;
  description?: string | null;
}) {
  return apiFetchJson<{ ok: true; id: string }>("/api/ai-config/providers", { method: "POST", body: JSON.stringify(body) });
}

export async function aiConfigUpdateProvider(id: string, body: Partial<{
  name: string;
  baseURL: string;
  apiKey: string;
  clearApiKey: boolean;
  isEnabled: boolean;
  sortOrder: number;
  description: string | null;
}>) {
  return apiFetchJson<{ ok: true }>(`/api/ai-config/providers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function aiConfigDeleteProvider(id: string) {
  return apiFetchJson<{ ok: true }>(`/api/ai-config/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function aiConfigListModels() {
  return apiFetchJson<{ models: AiModelDto[] }>("/api/ai-config/models");
}

export async function aiConfigCreateModel(body: {
  model: string;
  providerId?: string;
  baseURL?: string;
  endpoint?: string;
  apiKey?: string;
  copyFromId?: string;
  toolResultFormat?: "xml" | "text";
  priceInCnyPer1M: number;
  priceOutCnyPer1M: number;
  billingGroup?: string;
  isEnabled?: boolean;
  sortOrder?: number;
  description?: string;
}) {
  return apiFetchJson<{ ok: true; id: string }>("/api/ai-config/models", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function aiConfigUpdateModel(id: string, body: Partial<{
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
}>) {
  return apiFetchJson<{ ok: true }>(`/api/ai-config/models/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function aiConfigDeleteModel(id: string) {
  return apiFetchJson<{ ok: true }>(`/api/ai-config/models/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function aiConfigTestModel(id: string) {
  return apiFetchJson<{ ok: true; result: AiModelTestRunDto }>(`/api/ai-config/models/${encodeURIComponent(id)}/test`, {
    method: "POST",
  });
}

export type AiToolCompatRunDto = {
  ok: boolean;
  format: "xml" | "text";
  latencyMs: number;
  outputSample: string | null;
  error: string | null;
};

export async function aiConfigToolCompat(id: string) {
  return apiFetchJson<{
    ok: true;
    modelId: string;
    model: string;
    endpoint: string;
    results: { xml: AiToolCompatRunDto; text: AiToolCompatRunDto };
    recommended: "xml" | "text" | null;
  }>(`/api/ai-config/models/${encodeURIComponent(id)}/tool-compat`, {
    method: "POST",
  });
}

export async function aiConfigDedupeModels() {
  return apiFetchJson<{ ok: true; result: any }>(`/api/ai-config/models/dedupe`, { method: "POST" });
}

export async function aiConfigGetStages() {
  return apiFetchJson<{ stages: AiStageDto[]; models: AiModelDto[]; providers: AiProviderDto[] }>("/api/ai-config/stages");
}

export async function aiConfigUpdateStages(stages: Array<{
  stage: string;
  modelId?: string | null;
  modelIds?: string[] | null;
  temperature?: number | null;
  maxTokens?: number | null;
  isEnabled?: boolean;
}>) {
  return apiFetchJson<{ ok: true }>("/api/ai-config/stages", {
    method: "PUT",
    body: JSON.stringify({ stages }),
  });
}

export async function requestEmailCode(email: string) {
  return apiFetchJson<{
    requestId: string;
    expiresInSeconds: number;
    devCode?: string;
  }>("/api/auth/email/request-code", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function verifyEmailCode(args: { email: string; requestId: string; code: string }) {
  return apiFetchJson<{
    accessToken: string;
    user: UserDto;
  }>("/api/auth/email/verify", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function getMe() {
  return apiFetchJson<{ user: Pick<UserDto, "id" | "email" | "phone" | "role" | "pointsBalance"> }>("/api/me");
}

export async function adminListUsers() {
  return apiFetchJson<{ users: UserDto[] }>("/api/admin/users");
}

export async function adminCreateUser(args: { email?: string; phone?: string; role?: UserRole; pointsBalance?: number }) {
  return apiFetchJson<{ ok: true; user: UserDto; existed: boolean }>("/api/admin/users/create", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function adminSetUserRole(args: { userId: string; role: UserRole }) {
  return apiFetchJson<{ ok: true }>(`/api/admin/users/${encodeURIComponent(args.userId)}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role: args.role }),
  });
}

export async function adminSetUserBillingGroup(args: { userId: string; billingGroup?: string | null }) {
  return apiFetchJson<{ ok: true; billingGroup: string | null }>(`/api/admin/users/${encodeURIComponent(args.userId)}/billing-group`, {
    method: "PATCH",
    body: JSON.stringify({ billingGroup: args.billingGroup ?? null }),
  });
}

export async function adminRechargeUserPoints(args: { userId: string; points: number; reason?: string }) {
  return apiFetchJson<{
    ok: true;
    pointsBalance: number;
    tx: PointsTransactionDto;
  }>(`/api/admin/users/${encodeURIComponent(args.userId)}/points/recharge`, {
    method: "POST",
    body: JSON.stringify({ points: args.points, reason: args.reason }),
  });
}

export async function adminListUserTransactions(args: { userId: string }) {
  return apiFetchJson<{ transactions: PointsTransactionDto[] }>(
    `/api/admin/users/${encodeURIComponent(args.userId)}/points/transactions`,
  );
}

export type RechargeConfigDto = {
  pointsPerCnyByGroup: Record<string, number>;
  defaultGroup: string;
  giftEnabled: boolean;
  giftMultiplierByGroup: Record<string, number>;
  giftDefaultMultiplier: number;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function adminGetRechargeConfig() {
  return apiFetchJson<{ ok: true; config: RechargeConfigDto | null }>("/api/admin/recharge/config");
}

export async function adminUpdateRechargeConfig(args: {
  defaultGroup: string;
  pointsPerCnyByGroup: Record<string, number>;
  giftEnabled?: boolean;
  giftMultiplierByGroup?: Record<string, number>;
  giftDefaultMultiplier?: number;
}) {
  return apiFetchJson<{ ok: true; config: RechargeConfigDto }>("/api/admin/recharge/config", {
    method: "PUT",
    body: JSON.stringify(args),
  });
}

export type RechargeProductDto = {
  id: string;
  sku: string;
  name: string;
  amountCent: number;
  pointsFixed: number | null;
  originalAmountCent: number | null;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
};

export async function adminGetRechargeProducts() {
  return apiFetchJson<{ ok: true; products: RechargeProductDto[] }>("/api/admin/recharge/products");
}

export async function adminUpdateRechargeProducts(args: {
  products: Array<{
    sku: string;
    name: string;
    amountCent: number;
    originalAmountCent?: number | null;
    pointsFixed?: number | null;
    status?: "active" | "inactive";
  }>;
}) {
  return apiFetchJson<{ ok: true; products: RechargeProductDto[] }>("/api/admin/recharge/products", {
    method: "PUT",
    body: JSON.stringify(args),
  });
}

export async function adminGetLlmConfig() {
  return apiFetchJson<{ stored: AdminLlmConfigStored; effective: AdminLlmConfigEffective }>("/api/admin/llm/config");
}

export async function adminUpdateLlmConfig(body: {
  llm?: { baseUrl?: string; apiKey?: string; models?: string[]; defaultModel?: string };
  embeddings?: { baseUrl?: string; apiKey?: string; models?: string[]; defaultModel?: string };
  card?: { baseUrl?: string; apiKey?: string; defaultModel?: string };
  linter?: { baseUrl?: string; apiKey?: string; defaultModel?: string; timeoutMs?: number };
  pricing?: Record<string, LlmModelPriceDto>;
}) {
  return apiFetchJson<{ ok: true; stored: AdminLlmConfigStored }>("/api/admin/llm/config", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// ======== Tool Config（B 端：工具/外部服务热配置） ========

export type WebSearchConfigStoredDto = {
  provider: "bocha";
  isEnabled: boolean;
  endpoint: string | null;
  billPointsPerSearch: number | null;
  billPointsPerFetch: number | null;
  allowDomains: string[];
  denyDomains: string[];
  fetchUa: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
};

export type WebSearchConfigEffectiveDto = {
  provider: "bocha";
  isEnabled: boolean;
  endpoint: string;
  billPointsPerSearch: number | null;
  billPointsPerFetch: number | null;
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

export async function toolConfigGetWebSearch() {
  return apiFetchJson<{ stored: WebSearchConfigStoredDto; effective: WebSearchConfigEffectiveDto }>("/api/tool-config/web-search");
}

export async function toolConfigUpdateWebSearch(body: Partial<{
  isEnabled: boolean;
  endpoint: string | null;
  apiKey: string;
  clearApiKey: boolean;
  billPointsPerSearch: number | null;
  billPointsPerFetch: number | null;
  allowDomains: string[] | string;
  denyDomains: string[] | string;
  fetchUa: string | null;
}>) {
  return apiFetchJson<{ ok: true }>("/api/tool-config/web-search", { method: "PUT", body: JSON.stringify(body) });
}

export async function toolConfigTestWebSearch(body: { query: string }) {
  return apiFetchJson<{ ok: true; latencyMs: number; resultCount: number }>("/api/tool-config/web-search/test", { method: "POST", body: JSON.stringify(body) });
}

export type SmsVerifyConfigStoredDto = {
  provider: "aliyun_dypnsapi";
  isEnabled: boolean;
  endpoint: string | null;
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
  createdAt: string;
  updatedAt: string;
  hasAccessKeyId: boolean;
  accessKeyIdMasked: string | null;
  hasAccessKeySecret: boolean;
  accessKeySecretMasked: string | null;
};

export type SmsVerifyConfigEffectiveDto = {
  provider: "aliyun_dypnsapi";
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

export async function toolConfigGetSmsVerify() {
  return apiFetchJson<{ stored: SmsVerifyConfigStoredDto; effective: SmsVerifyConfigEffectiveDto }>("/api/tool-config/sms-verify");
}

export async function toolConfigUpdateSmsVerify(body: Partial<{
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
}>) {
  return apiFetchJson<{ ok: true }>("/api/tool-config/sms-verify", { method: "PUT", body: JSON.stringify(body) });
}

export async function toolConfigTestSmsVerify() {
  return apiFetchJson<{ ok: true; configured: boolean }>("/api/tool-config/sms-verify/test", { method: "POST", body: JSON.stringify({}) });
}

export type CapabilitiesToolDto = {
  name: string;
  module: string;
  description: string;
  modes: Array<"chat" | "agent">;
  args: Array<{ name: string; required?: boolean; desc: string; type?: string; jsonType?: string }>;
  inputSchema: any;
};

export type CapabilitiesSkillDto = {
  id: string;
  module: string;
  name: string;
  description: string;
  priority: number;
  stageKey: string;
  autoEnable: boolean;
  triggers: any[];
  toolCaps: any;
  policies: string[];
  ui: any;
};

export type CapabilitiesStoredDto = {
  tools: { disabledByMode: Partial<Record<"chat" | "agent", string[]>> };
  skills: { disabled: string[] };
  lockedTools: string[];
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CapabilitiesEffectiveDto = {
  lockedTools: string[];
  tools: { disabledByMode: Record<"chat" | "agent", string[]> };
  skills: { disabled: string[] };
};

export type CapabilitiesRegistryDto = {
  tools: CapabilitiesToolDto[];
  skills: CapabilitiesSkillDto[];
  lockedTools: string[];
};

export async function toolConfigGetCapabilities() {
  return apiFetchJson<{ registry: CapabilitiesRegistryDto; stored: CapabilitiesStoredDto; effective: CapabilitiesEffectiveDto }>(
    "/api/tool-config/capabilities",
  );
}

export async function toolConfigUpdateCapabilities(body: Partial<{ tools: { disabledByMode?: any }; skills: { disabled?: any } }>) {
  return apiFetchJson<{ ok: true }>("/api/tool-config/capabilities", { method: "PUT", body: JSON.stringify(body) });
}

// ======== 数据备份 ========

export type BackupEntry = {
  name: string;
  size: number;
  createdAt: string;
  userCount: number;
  txCount: number;
};

export async function adminListBackups() {
  return apiFetchJson<{ backups: BackupEntry[] }>("/api/admin/backup/list");
}

export async function adminCreateBackup(note?: string) {
  return apiFetchJson<{ ok: true; backup: { name: string; size: number; createdAt: string } }>(
    "/api/admin/backup/create",
    { method: "POST", body: JSON.stringify({ note }) },
  );
}

export async function adminRestoreBackup(name: string) {
  return apiFetchJson<{ ok: true; preRestoreBackup: string; userCount: number; txCount: number }>(
    "/api/admin/backup/restore",
    { method: "POST", body: JSON.stringify({ name }) },
  );
}
