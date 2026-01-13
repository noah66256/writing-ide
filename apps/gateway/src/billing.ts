import { randomUUID } from "node:crypto";
import type { Db, PointsTransaction, PointsTxType, User } from "./db.js";

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



