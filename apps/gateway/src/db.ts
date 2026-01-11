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
  createdAt: string;
};

export type Db = {
  users: User[];
  pointsTransactions: PointsTransaction[];
};

const DEFAULT_DB: Db = { users: [], pointsTransactions: [] };

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
        const base: PointsTransaction = { id, userId, type, delta, createdAt };
        return reason ? { ...base, reason } : base;
      })
      .filter((t): t is PointsTransaction => t !== null);

    return { users, pointsTransactions };
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


