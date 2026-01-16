import { updateDb, type RunAudit } from "../db.js";

type SanitizeOptions = {
  maxDepth: number;
  maxKeys: number;
  maxArray: number;
  maxString: number;
};

const DEFAULT_OPTS: SanitizeOptions = { maxDepth: 3, maxKeys: 64, maxArray: 32, maxString: 600 };

function truncateString(s: string, max: number) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return t.slice(0, max) + `…(truncated,len=${t.length})`;
}

export function sanitizeForAudit(value: unknown, opts?: Partial<SanitizeOptions>, depth = 0): unknown {
  const o: SanitizeOptions = { ...DEFAULT_OPTS, ...(opts ?? {}) };
  if (depth > o.maxDepth) return "[TRUNCATED_DEPTH]";
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") return truncateString(value as string, o.maxString);
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "function") return "[Function]";
  if (value instanceof Error) return { name: value.name, message: truncateString(value.message, o.maxString) };

  if (Array.isArray(value)) {
    const arr = value as any[];
    const head = arr.slice(0, o.maxArray).map((x) => sanitizeForAudit(x, o, depth + 1));
    return arr.length > o.maxArray ? { items: head, truncated: true, total: arr.length } : head;
  }

  if (t === "object") {
    const obj: any = value as any;
    const keys = Object.keys(obj);
    const out: any = {};
    const take = keys.slice(0, o.maxKeys);
    for (const k of take) out[k] = sanitizeForAudit(obj[k], o, depth + 1);
    if (keys.length > o.maxKeys) out.__truncated_keys__ = { total: keys.length, kept: take.length };
    return out;
  }

  try {
    return truncateString(JSON.stringify(value), o.maxString);
  } catch {
    return "[UNSERIALIZABLE]";
  }
}

export function recordRunAuditEvent(audit: RunAudit, event: string, data: unknown) {
  const ts = Date.now();
  if (!Array.isArray(audit.events)) audit.events = [];
  if (audit.events.length >= 5000) return; // 防止单次 run 过大

  audit.events.push({
    ts,
    event: String(event ?? ""),
    data: sanitizeForAudit(data),
  });
}

export function ensureRunAuditEnded(audit: RunAudit, args?: { endReason?: string; endReasonCodes?: string[] }) {
  if (!audit.endedAt) audit.endedAt = new Date().toISOString();
  if (!audit.endReason && args?.endReason) audit.endReason = String(args.endReason);
  if (Array.isArray(args?.endReasonCodes) && args!.endReasonCodes!.length && !audit.endReasonCodes.length) {
    audit.endReasonCodes = args!.endReasonCodes!.map((x) => String(x ?? "")).filter(Boolean).slice(0, 32);
  }
}

export async function persistRunAudit(audit: RunAudit) {
  const maxCfg = Number(String(process.env.AUDIT_RUNS_MAX ?? "").trim());
  const max = Number.isFinite(maxCfg) && maxCfg > 0 ? Math.max(50, Math.min(5000, Math.floor(maxCfg))) : 400;

  await updateDb((db) => {
    const list = Array.isArray((db as any).runAudits) ? (((db as any).runAudits as any[]) ?? []) : [];
    const idx = list.findIndex((r: any) => String(r?.id ?? "") === audit.id && String(r?.kind ?? "") === audit.kind);
    if (idx >= 0) list[idx] = audit;
    else list.push(audit);
    (db as any).runAudits = list.length > max ? list.slice(-max) : list;
  });
}


