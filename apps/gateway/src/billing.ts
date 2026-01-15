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
};

/**
 * 计费口径（对齐「锦李2.0」）：
 * - 单价：元/1,000,000 tokens
 * - 积分定义：1 元 = 1000 积分
 * - points = ceil( (prompt/1e6*inPrice + completion/1e6*outPrice) * 1000 )
 */
export function calculateCostPoints(args: {
  usage: LlmTokenUsage;
  price: LlmModelPrice;
  pointsPerCny?: number; // 默认 1000
}): number {
  const pointsPerCny = Number.isFinite(args.pointsPerCny as any) ? Number(args.pointsPerCny) : 1000;
  const promptTokens = Math.max(0, Math.floor(Number(args.usage.promptTokens) || 0));
  const completionTokens = Math.max(0, Math.floor(Number(args.usage.completionTokens) || 0));
  const priceIn = Number(args.price.priceInCnyPer1M);
  const priceOut = Number(args.price.priceOutCnyPer1M);
  if (!Number.isFinite(priceIn) || !Number.isFinite(priceOut) || priceIn < 0 || priceOut < 0) return 0;

  const costCny = (promptTokens / 1_000_000) * priceIn + (completionTokens / 1_000_000) * priceOut;
  const points = Math.ceil(costCny * pointsPerCny);
  return Number.isFinite(points) && points > 0 ? points : 0;
}









