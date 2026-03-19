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
const COLLAB_TOOL_ORDER = ["spawn_agent", "send_input", "wait_agent", "resume_agent", "close_agent"] as const;

type CollabIntent = "spawn" | "send" | "wait" | "resume" | "close" | "generic" | null;

function isCollabToolName(name: string): boolean {
  return COLLAB_TOOL_ORDER.includes(name as (typeof COLLAB_TOOL_ORDER)[number]);
}

function inferCollabIntent(text: string): CollabIntent {
  const raw = String(text ?? "").trim().toLowerCase();
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, "");
  const hasCollabTarget =
    /(sub[\s_-]?agent|spawn[_\s-]?agent|子\s*(agent|代理|智能体)|子agent|子代理|子智能体)/i.test(raw);
  if (!hasCollabTarget) return null;
  if (/(关闭|关掉|结束|回收|删掉|清掉|停掉|停用|释放|close|stop|terminate)/i.test(raw)) return "close";
  if (/(等待|等下|等一等|join|wait)/i.test(raw)) return "wait";
  if (/(恢复|继续跑|续跑|resume)/i.test(raw)) return "resume";
  if (/(发消息|补充|追发|追加|send|message|input)/i.test(raw)) return "send";
  if (/(创建|新建|启动|拉个|拉起|起个|开个|开一个|来个|试试拉个|spawn|start)/i.test(raw) || /拉个子agent/.test(normalized)) {
    return "spawn";
  }
  return "generic";
}

function collabIntentToolOrder(intent: CollabIntent): string[] {
  switch (intent) {
    case "close":
      return ["close_agent", "wait_agent", "resume_agent", "send_input", "spawn_agent"];
    case "wait":
      return ["wait_agent", "send_input", "resume_agent", "close_agent", "spawn_agent"];
    case "resume":
      return ["resume_agent", "send_input", "wait_agent", "close_agent", "spawn_agent"];
    case "send":
      return ["send_input", "wait_agent", "resume_agent", "close_agent", "spawn_agent"];
    case "spawn":
    case "generic":
      return [...COLLAB_TOOL_ORDER];
    default:
      return [];
  }
}

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
  const collabIntent = inferCollabIntent(userPrompt);
  if (collabIntent) caps.add("collab");

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

    if (collabIntent && isCollabToolName(entry.name)) {
      score += 2.8;
      reasons.push("collab_family");
      if (
        (collabIntent === "spawn" && entry.name === "spawn_agent") ||
        (collabIntent === "send" && entry.name === "send_input") ||
        (collabIntent === "wait" && entry.name === "wait_agent") ||
        (collabIntent === "resume" && entry.name === "resume_agent") ||
        (collabIntent === "close" && entry.name === "close_agent")
      ) {
        score += 8.5;
        reasons.push(`collab_intent:${collabIntent}`);
      } else if (collabIntent === "generic" && entry.name === "spawn_agent") {
        score += 6.5;
        reasons.push("collab_default_spawn");
      }
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

  if (collabIntent) {
    const collabNames = new Set(
      catalog
        .filter((entry) => isCollabToolName(entry.name))
        .map((entry) => entry.name),
    );
    for (const name of collabIntentToolOrder(collabIntent)) {
      if (!collabNames.has(name)) continue;
      if (!retrieved.includes(name)) retrieved.push(name);
    }
  }

  return {
    promptCaps,
    queryTokens: queryTokens.slice(0, 32),
    candidates,
    retrievedToolNames: retrieved,
  };
}
