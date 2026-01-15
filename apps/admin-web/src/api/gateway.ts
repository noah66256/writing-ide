import { apiFetchJson } from "./client";

export type UserRole = "admin" | "user";

export type UserDto = {
  id: string;
  email: string;
  role: UserRole;
  pointsBalance: number;
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
  return apiFetchJson<{ user: Pick<UserDto, "id" | "email" | "role" | "pointsBalance"> }>("/api/me");
}

export async function adminListUsers() {
  return apiFetchJson<{ users: UserDto[] }>("/api/admin/users");
}

export async function adminSetUserRole(args: { userId: string; role: UserRole }) {
  return apiFetchJson<{ ok: true }>(`/api/admin/users/${encodeURIComponent(args.userId)}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role: args.role }),
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


