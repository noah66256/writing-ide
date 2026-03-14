import { detectPromptCapabilities, type ToolCatalogEntry } from "./toolCatalog.js";

export type ToolRetrievalCandidate = {
  name: string;
  score: number;
  reasons: string[];
};

export type ToolRetrievalResult = {
  promptCaps: string[];
  queryTokens: string[];
  candidates: ToolRetrievalCandidate[];
  retrievedToolNames: string[];
};

const STRONG_BROWSER_RE = /(公众号|小红书|抖音|知乎|微博|后台|管理后台|扫码|扫码登录|登录|浏览器|网页|网站|页面|打开.*(网页|网站|页面)|navigate|goto|open\s+.*https?:\/\/)/i;
const STRONG_WORD_RE = /(word|docx|文档|公文|报告|备忘录)/i;
const STRONG_SHEET_RE = /(excel|xlsx|表格|电子表格|工作表)/i;

function tokenize(text: string): string[] {
  const s = String(text ?? "").toLowerCase();
  if (!s.trim()) return [];

  const out: string[] = [];
  const ascii = s.match(/[a-z0-9_]+/g);
  if (ascii) out.push(...ascii);

  // CJK：按连续片段取 token + bigram，兼容“公众号/小红书/扫码”等。
  const cjk = s.match(/[\u4e00-\u9fff]+/g);
  if (cjk) {
    for (const seg of cjk) {
      const t = seg.trim();
      if (!t) continue;
      out.push(t);
      if (t.length <= 1) continue;
      for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    }
  }

  return out.filter(Boolean).slice(0, 120);
}

function bm25Score(args: {
  docs: Array<{ name: string; tokens: string[] }>;
  queryTokens: string[];
}): Map<string, number> {
  const docs = args.docs;
  const q = Array.from(new Set(args.queryTokens)).filter(Boolean);
  const scores = new Map<string, number>();
  if (docs.length === 0 || q.length === 0) return scores;

  const k1 = 1.2;
  const b = 0.75;

  const df = new Map<string, number>();
  let totalLen = 0;
  const tfByDoc = new Map<string, Map<string, number>>();

  for (const d of docs) {
    const tfs = new Map<string, number>();
    totalLen += d.tokens.length;
    const seen = new Set<string>();
    for (const t of d.tokens) {
      tfs.set(t, (tfs.get(t) ?? 0) + 1);
      if (!seen.has(t)) {
        df.set(t, (df.get(t) ?? 0) + 1);
        seen.add(t);
      }
    }
    tfByDoc.set(d.name, tfs);
  }

  const avgdl = totalLen / Math.max(1, docs.length);
  const N = docs.length;

  for (const d of docs) {
    const dl = d.tokens.length;
    const tfs = tfByDoc.get(d.name) ?? new Map<string, number>();
    let score = 0;

    for (const term of q) {
      const tf = tfs.get(term) ?? 0;
      if (tf <= 0) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = tf + k1 * (1 - b + b * (dl / Math.max(1e-6, avgdl)));
      score += idf * (tf * (k1 + 1)) / denom;
    }

    if (score > 0) scores.set(d.name, score);
  }

  return scores;
}

function buildToolSearchText(entry: ToolCatalogEntry): string {
  const parts = [
    entry.name,
    entry.description,
    entry.source,
    entry.serverId ?? "",
    entry.serverName ?? "",
    ...(Array.isArray(entry.capabilities) ? entry.capabilities : []),
  ];
  return parts.map((x) => String(x ?? "")).join(" ");
}

export function retrieveToolsForRun(args: {
  catalog: ToolCatalogEntry[];
  userPrompt: string;
  routeId?: string | null;
  maxCandidates?: number;
  desired?: number;
}): ToolRetrievalResult {
  const catalog = Array.isArray(args.catalog) ? args.catalog : [];
  const routeId = String(args.routeId ?? "").trim().toLowerCase();
  const userPrompt = String(args.userPrompt ?? "");

  const caps = detectPromptCapabilities(userPrompt);
  if (STRONG_BROWSER_RE.test(userPrompt)) caps.add("browser_open");
  if (STRONG_WORD_RE.test(userPrompt)) caps.add("mcp_word_doc");
  if (STRONG_SHEET_RE.test(userPrompt)) caps.add("mcp_spreadsheet");

  const promptCaps = Array.from(caps);

  const queryTokens = tokenize(userPrompt);
  const docs = catalog.map((entry) => ({
    name: entry.name,
    tokens: tokenize(buildToolSearchText(entry)),
  }));

  const baseScores = bm25Score({ docs, queryTokens });

  const scored: Array<ToolRetrievalCandidate> = [];
  for (const entry of catalog) {
    const base = baseScores.get(entry.name) ?? 0;
    let score = base;
    const reasons: string[] = [];
    if (base > 0) reasons.push(`bm25=${base.toFixed(3)}`);

    // capability boost：让“意图→能力”在检索中显式生效。
    for (const cap of entry.capabilities ?? []) {
      if (!caps.has(cap)) continue;
      score += 2.2;
      reasons.push(`cap:${cap}`);
    }

    // 浏览器意图：优先保留 playwright 的入口工具（navigate/click/snapshot）。
    if (caps.has("browser_open") && entry.source === "mcp") {
      const n = entry.name.toLowerCase();
      if (/(playwright|browser)/i.test(n) && /(navigate|goto|open|click|snapshot|screenshot)/i.test(n)) {
        score += 6.5;
        reasons.push("browser_entry_boost");
      }
    }

    // 很低的分数不收集，避免噪声强行进入 preferred。
    if (score < 1.2) continue;

    scored.push({ name: entry.name, score, reasons: reasons.length ? reasons : ["match"] });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  const maxCandidates = Math.max(8, Math.min(48, Math.floor(Number(args.maxCandidates ?? 16) || 16)));
  const desired = Math.max(0, Math.min(12, Math.floor(Number(args.desired ?? (routeId === "discussion" ? 4 : 6)) || 6)));

  const candidates = scored.slice(0, maxCandidates);

  // retrievedToolNames：用于 B1 注入 preferredToolNames 的短名单。
  // 规则：去重、保留顺序、优先 MCP 工具，其次内置工具。
  const retrieved: string[] = [];
  for (const item of candidates) {
    if (retrieved.length >= desired) break;
    if (!retrieved.includes(item.name)) retrieved.push(item.name);
  }

  return {
    promptCaps,
    queryTokens: queryTokens.slice(0, 32),
    candidates,
    retrievedToolNames: retrieved,
  };
}
