import { randomUUID } from "node:crypto";
import type { Db, LlmModelPrice, PointsTransaction, PointsTxType, User } from "./db.js";

export function adjustUserPoints(params: {
  db: Db;
  userId: string;
  delta: number;
  type: PointsTxType;
  reason?: string;
}): { user: User; tx: PointsTransaction } {
  const { db, userId, delta, type, reason } = params;
  const user = db.users.find((u) => u.id === userId);
  if (!user) {
    throw new Error("USER_NOT_FOUND");
  }

  const nextBalance = (user.pointsBalance ?? 0) + delta;
  if (nextBalance < 0) {
    throw new Error("INSUFFICIENT_POINTS");
  }

  user.pointsBalance = nextBalance;

  const tx: PointsTransaction = {
    id: randomUUID(),
    userId,
    type,
    delta,
    reason,
    createdAt: new Date().toISOString()
  };
  db.pointsTransactions.push(tx);
  return { user, tx };
}

export function listUserTransactions(db: Db, userId: string): PointsTransaction[] {
  return db.pointsTransactions
    .filter((t) => t.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export type LlmTokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
};

function toNonNegativeInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

function pickFirstInt(...values: unknown[]): number | null {
  for (const value of values) {
    const n = toNonNegativeInt(value);
    if (n !== null) return n;
  }
  return null;
}

function normalizeCostPrice(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function normalizeLlmTokenUsage(raw: unknown): LlmTokenUsage {
  const source = raw && typeof raw === "object" ? (raw as any) : {};

  const rawPromptTokens = pickFirstInt(
    source?.promptTokens,
    source?.prompt_tokens,
    source?.inputTokens,
    source?.input_tokens,
    source?.input,
  ) ?? 0;
  const completionTokens = pickFirstInt(
    source?.completionTokens,
    source?.completion_tokens,
    source?.outputTokens,
    source?.output_tokens,
    source?.output,
  ) ?? 0;

  const anthropicCacheReadTokens = pickFirstInt(
    source?.cacheReadInputTokens,
    source?.cache_read_input_tokens,
  );
  const openAiCachedInputTokens = pickFirstInt(
    source?.cached_input_tokens,
    source?.cachedInputTokens,
    source?.input_tokens_details?.cached_tokens,
    source?.inputTokensDetails?.cachedTokens,
    source?.prompt_tokens_details?.cached_tokens,
    source?.promptTokensDetails?.cachedTokens,
  );
  const cacheReadInputTokens = anthropicCacheReadTokens ?? openAiCachedInputTokens ?? 0;

  const cacheCreation = source?.cache_creation && typeof source.cache_creation === "object"
    ? source.cache_creation
    : source?.cacheCreation && typeof source.cacheCreation === "object"
      ? source.cacheCreation
      : {};

  const cacheCreation5mInputTokens = pickFirstInt(
    source?.cacheCreation5mInputTokens,
    source?.cache_creation_5m_input_tokens,
    cacheCreation?.ephemeral_5m_input_tokens,
    cacheCreation?.ephemeral5mInputTokens,
  ) ?? 0;
  const cacheCreation1hInputTokens = pickFirstInt(
    source?.cacheCreation1hInputTokens,
    source?.cache_creation_1h_input_tokens,
    cacheCreation?.ephemeral_1h_input_tokens,
    cacheCreation?.ephemeral1hInputTokens,
  ) ?? 0;
  const cacheCreationInputTokens = pickFirstInt(
    source?.cacheCreationInputTokens,
    source?.cache_creation_input_tokens,
  ) ?? (cacheCreation5mInputTokens + cacheCreation1hInputTokens);

  const promptTokens =
    anthropicCacheReadTokens !== null
      ? rawPromptTokens
      : openAiCachedInputTokens !== null
        ? Math.max(0, rawPromptTokens - cacheReadInputTokens)
        : rawPromptTokens;

  const totalTokens = pickFirstInt(
    source?.totalTokens,
    source?.total_tokens,
  ) ?? (promptTokens + completionTokens + cacheReadInputTokens + cacheCreationInputTokens);

  return {
    promptTokens,
    completionTokens,
    ...(totalTokens > 0 ? { totalTokens } : {}),
    ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    ...(cacheCreation5mInputTokens > 0 ? { cacheCreation5mInputTokens } : {}),
    ...(cacheCreation1hInputTokens > 0 ? { cacheCreation1hInputTokens } : {}),
  };
}

export function hasBillableUsage(raw: unknown): boolean {
  const usage = normalizeLlmTokenUsage(raw);
  return (
    usage.promptTokens > 0 ||
    usage.completionTokens > 0 ||
    (usage.cacheReadInputTokens ?? 0) > 0 ||
    (usage.cacheCreationInputTokens ?? 0) > 0
  );
}

export function addLlmTokenUsage(left: unknown, right: unknown): LlmTokenUsage {
  const a = normalizeLlmTokenUsage(left);
  const b = normalizeLlmTokenUsage(right);
  const promptTokens = a.promptTokens + b.promptTokens;
  const completionTokens = a.completionTokens + b.completionTokens;
  const cacheReadInputTokens = (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0);
  const cacheCreationInputTokens = (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0);
  const cacheCreation5mInputTokens = (a.cacheCreation5mInputTokens ?? 0) + (b.cacheCreation5mInputTokens ?? 0);
  const cacheCreation1hInputTokens = (a.cacheCreation1hInputTokens ?? 0) + (b.cacheCreation1hInputTokens ?? 0);
  const totalTokens = promptTokens + completionTokens + cacheReadInputTokens + cacheCreationInputTokens;
  return {
    promptTokens,
    completionTokens,
    ...(totalTokens > 0 ? { totalTokens } : {}),
    ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    ...(cacheCreation5mInputTokens > 0 ? { cacheCreation5mInputTokens } : {}),
    ...(cacheCreation1hInputTokens > 0 ? { cacheCreation1hInputTokens } : {}),
  };
}

export function maxLlmTokenUsage(left: unknown, right: unknown): LlmTokenUsage {
  const a = normalizeLlmTokenUsage(left);
  const b = normalizeLlmTokenUsage(right);
  const promptTokens = Math.max(a.promptTokens, b.promptTokens);
  const completionTokens = Math.max(a.completionTokens, b.completionTokens);
  const cacheReadInputTokens = Math.max(a.cacheReadInputTokens ?? 0, b.cacheReadInputTokens ?? 0);
  const cacheCreationInputTokens = Math.max(a.cacheCreationInputTokens ?? 0, b.cacheCreationInputTokens ?? 0);
  const cacheCreation5mInputTokens = Math.max(a.cacheCreation5mInputTokens ?? 0, b.cacheCreation5mInputTokens ?? 0);
  const cacheCreation1hInputTokens = Math.max(a.cacheCreation1hInputTokens ?? 0, b.cacheCreation1hInputTokens ?? 0);
  const totalTokens = Math.max(
    a.totalTokens ?? 0,
    b.totalTokens ?? 0,
    promptTokens + completionTokens + cacheReadInputTokens + cacheCreationInputTokens,
  );
  return {
    promptTokens,
    completionTokens,
    ...(totalTokens > 0 ? { totalTokens } : {}),
    ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    ...(cacheCreation5mInputTokens > 0 ? { cacheCreation5mInputTokens } : {}),
    ...(cacheCreation1hInputTokens > 0 ? { cacheCreation1hInputTokens } : {}),
  };
}

export function calculateCostCny(args: {
  usage: LlmTokenUsage;
  price: LlmModelPrice;
}): number {
  const usage = normalizeLlmTokenUsage(args.usage);
  const priceIn = normalizeCostPrice(args.price.priceInCnyPer1M);
  const priceOut = normalizeCostPrice(args.price.priceOutCnyPer1M);
  const priceCacheRead = normalizeCostPrice(args.price.priceCacheReadCnyPer1M);
  const priceCacheCreation5m = normalizeCostPrice(args.price.priceCacheCreation5mCnyPer1M);
  const cacheCreation5mTokens =
    (usage.cacheCreation5mInputTokens ?? 0) > 0
      ? (usage.cacheCreation5mInputTokens ?? 0)
      : (usage.cacheCreation1hInputTokens ?? 0) > 0
        ? 0
        : (usage.cacheCreationInputTokens ?? 0);
  return (
    (usage.promptTokens / 1_000_000) * priceIn +
    (usage.completionTokens / 1_000_000) * priceOut +
    ((usage.cacheReadInputTokens ?? 0) / 1_000_000) * priceCacheRead +
    (cacheCreation5mTokens / 1_000_000) * priceCacheCreation5m
  );
}

/**
 * 计费口径（对齐「锦李2.0」）：
 * - 单价：元/1,000,000 tokens
 * - 积分定义：1 元 = 1000 积分
 * - points = ceil( (input + output + cache_read + cache_create_5m) * 1000 )
 */
export function calculateCostPoints(args: {
  usage: LlmTokenUsage;
  price: LlmModelPrice;
  pointsPerCny?: number; // 默认 1000
}): number {
  const pointsPerCny = Number.isFinite(args.pointsPerCny as any) ? Number(args.pointsPerCny) : 1000;
  const costCny = calculateCostCny(args);
  const points = Math.ceil(costCny * pointsPerCny);
  return Number.isFinite(points) && points > 0 ? points : 0;
}

export function calculateImageGenPoints(args: {
  billPointsPerCall: number;
}): number {
  return Math.max(0, Math.ceil(Number(args.billPointsPerCall) || 0));
}






