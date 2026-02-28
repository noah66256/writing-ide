import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { computeDraftStatsForStyleLint } from "../kb/styleLintDraftStats.js";
import { toolConfig } from "../toolConfig.js";

export type ServerToolExecutionDecision = {
  executedBy: "gateway" | "desktop";
  reasonCodes: string[];
};

export type ToolSidecar = {
  styleLinterLibraries?: any[];
  projectFiles?: Array<{ path: string }>;
  docRules?: { path: string; content: string } | null;
};

function parseCsv(v: any) {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getServerToolAllowlist(): Set<string> {
  const cfg = String(process.env.GATEWAY_SERVER_TOOL_ALLOWLIST ?? "").trim();
  const list = cfg
    ? parseCsv(cfg)
    : ["lint.style", "project.listFiles", "project.docRules.get", "time.now",
       "run.done", "run.setTodoList", "run.todo.upsertMany", "run.todo.update", "run.mainDoc.update", "run.mainDoc.get",
       "agent.delegate"];
  return new Set(list.map((x) => String(x ?? "").trim()).filter(Boolean));
}

export function parseIdListArg(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j.map((x: any) => String(x ?? "").trim()).filter(Boolean);
    } catch {
      // ignore
    }
  }
  if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  return [s];
}

export function decideServerToolExecution(args: {
  name: string;
  toolArgs: any;
  toolSidecar: ToolSidecar | null;
}): ServerToolExecutionDecision {
  const name = String(args.name ?? "").trim();

  // 代码执行器强制走 Desktop（无论 allowlist 如何配置）
  if (name === "code.exec") return { executedBy: "desktop", reasonCodes: ["code_exec_desktop_only"] };

  const allow = getServerToolAllowlist();
  if (!allow.has(name)) return { executedBy: "desktop", reasonCodes: ["server_tool_not_allowed"] };

  const sidecar = (args.toolSidecar ?? null) as any;
  const styleLinterLibraries = Array.isArray(sidecar?.styleLinterLibraries) ? (sidecar.styleLinterLibraries as any[]) : [];

  // time.*：完全 server-side（只读时间）；不依赖 Desktop sidecar
  if (name === "time.now") return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "time_now_server_side"] };
  // run.*：系统编排类工具（无副作用，但会影响 run 生命周期），应 server-side 执行
  if (name === "run.done") return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "run_done_server_side"] };
  if (name === "agent.delegate") return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "agent_delegate_server_side"] };
  if (name.startsWith("run.")) return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "run_orchestration_server_side"] };

  // 逐步迁回：先落地 lint.style(text=...)（只读；需要 Desktop sidecar 提供指纹/样例）。
  if (name === "lint.style") {
    const text = typeof args.toolArgs?.text === "string" ? String(args.toolArgs.text) : "";
    const pathArg = typeof args.toolArgs?.path === "string" ? String(args.toolArgs.path) : "";
    const okText = text.trim().length > 0;
    const okNoPath = !pathArg.trim();
    const hasLibs = styleLinterLibraries.length > 0;
    if (okText && okNoPath && hasLibs) {
      return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "lint_style_text_server_side"] };
    }
    return { executedBy: "desktop", reasonCodes: ["server_tool_condition_not_met"] };
  }

  if (name === "project.listFiles") {
    const files = Array.isArray(sidecar?.projectFiles) ? (sidecar.projectFiles as any[]) : [];
    if (files.length > 0) return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "project_files_from_sidecar"] };
    return { executedBy: "desktop", reasonCodes: ["server_tool_condition_not_met"] };
  }

  if (name === "project.docRules.get") {
    const dr = sidecar?.docRules ?? null;
    if (dr && typeof dr === "object" && String(dr.path ?? "").trim()) {
      return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "doc_rules_from_sidecar"] };
    }
    return { executedBy: "desktop", reasonCodes: ["server_tool_condition_not_met"] };
  }

  return { executedBy: "desktop", reasonCodes: ["server_tool_not_supported"] };
}

function clampInt(v: any, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function decodeHtmlEntities(input: string) {
  const s = String(input ?? "");
  return (
    s
      // named (minimal set)
      .replaceAll("&nbsp;", " ")
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      // numeric: &#123; / &#x1f60a;
      .replace(/&#(\d+);/g, (_, d) => {
        const code = Number(d);
        if (!Number.isFinite(code)) return _;
        try {
          return String.fromCodePoint(code);
        } catch {
          return _;
        }
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hx) => {
        const code = Number.parseInt(String(hx), 16);
        if (!Number.isFinite(code)) return _;
        try {
          return String.fromCodePoint(code);
        } catch {
          return _;
        }
      })
  );
}

function extractTextFromHtml(html: string): { title: string | null; text: string } {
  const raw = String(html ?? "");
  const title = (() => {
    const m = raw.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
    const t = m?.[1] ? decodeHtmlEntities(String(m[1])) : "";
    const cleaned = t.replace(/\s+/g, " ").trim();
    return cleaned || null;
  })();

  // strip scripts/styles
  let t = raw
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ");

  // add newlines around common block tags to preserve structure a bit
  t = t
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<(p|div|li|h\d)\b[^>]*>/gi, "\n");

  // strip tags
  t = t.replace(/<[^>]+>/g, " ");
  t = decodeHtmlEntities(t);
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  t = t.replace(/[ \t\f\v]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return { title, text: t };
}

function parseDomainsEnv(name: string) {
  return parseCsv(process.env[name] ?? "")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function matchDomain(hostname: string, rule: string) {
  const h = hostname.toLowerCase();
  const r = rule.toLowerCase().replace(/^\*\./, ""); // "*.example.com" => "example.com"
  if (!r) return false;
  if (h === r) return true;
  return h.endsWith(`.${r}`);
}

function isUrlAllowed(
  url: string,
  rules?: {
    allowDomains?: string[];
    denyDomains?: string[];
  },
) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false as const, error: "INVALID_URL" as const };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false as const, error: "UNSUPPORTED_PROTOCOL" as const };

  const host = String(u.hostname ?? "").trim().toLowerCase();
  if (!host) return { ok: false as const, error: "INVALID_URL" as const };

  // deny：优先 rules（B 端配置）；否则回退 env
  const deny = Array.isArray(rules?.denyDomains) ? (rules!.denyDomains as string[]) : parseDomainsEnv("WEB_DENY_DOMAINS");
  for (const r of deny) if (matchDomain(host, r)) return { ok: false as const, error: "DOMAIN_DENIED" as const, hostname: host, rule: r };

  const allow = Array.isArray(rules?.allowDomains) ? (rules!.allowDomains as string[]) : parseDomainsEnv("WEB_ALLOW_DOMAINS");
  if (allow.length) {
    for (const r of allow) if (matchDomain(host, r)) return { ok: true as const, hostname: host };
    return { ok: false as const, error: "DOMAIN_NOT_ALLOWED" as const, hostname: host };
  }

  return { ok: true as const, hostname: host };
}

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number }) {
  const timeoutMs = clampInt((init as any)?.timeoutMs, 1000, 120_000, 10_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function executeWebSearchOnGateway(args: { call: any }) {
  const call = args.call;
  const query = String((call?.args as any)?.query ?? "").trim();
  if (!query) return { ok: false as const, error: "MISSING_QUERY" };

  const rt = await toolConfig.resolveWebSearchRuntime().catch(() => null as any);
  if (!rt || !rt.isEnabled) return { ok: false as const, error: "WEB_SEARCH_DISABLED" };
  if (!String(rt.apiKey ?? "").trim()) return { ok: false as const, error: "BOCHA_API_KEY_NOT_CONFIGURED" };

  const freshness = String((call?.args as any)?.freshness ?? "noLimit").trim() || "noLimit";
  const count = clampInt((call?.args as any)?.count, 1, 50, 10);
  const summary = (call?.args as any)?.summary === undefined ? true : Boolean((call?.args as any)?.summary);

  const endpoint = String(rt.endpoint ?? "https://api.bochaai.com/v1/web-search").trim();

  try {
    const res = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rt.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, freshness, count, summary }),
      timeoutMs: 10_000,
    } as any);

    const fetchedAt = new Date().toISOString();
    const status = res.status;
    const text = await res.text().catch(() => "");
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      return { ok: false as const, error: `HTTP_${status}`, detail: { status, body: (json ?? text ?? "").slice(0, 2000) } };
    }

    const data = json?.data ?? null;
    const values = Array.isArray(data?.webPages?.value) ? (data.webPages.value as any[]) : [];
    const results = values.slice(0, 50).map((r: any) => ({
      title: String(r?.name ?? "").trim(),
      url: String(r?.url ?? "").trim(),
      snippet: typeof r?.snippet === "string" ? String(r.snippet) : null,
      summary: typeof r?.summary === "string" ? String(r.summary) : null,
      publishedAt: typeof r?.datePublished === "string" ? String(r.datePublished) : null,
      source: typeof r?.siteName === "string" ? String(r.siteName) : null,
    }));

    return {
      ok: true as const,
      output: {
        ok: true,
        provider: "bocha",
        fetchedAt,
        query,
        freshness,
        count,
        summary,
        results,
        raw: json ?? null,
      },
    };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "TIMEOUT" : e?.message ? String(e.message) : String(e);
    return { ok: false as const, error: "FETCH_FAILED", detail: { message: msg } };
  }
}

export async function executeWebFetchOnGateway(args: { call: any }) {
  const call = args.call;
  const url = String((call?.args as any)?.url ?? "").trim();
  if (!url) return { ok: false as const, error: "MISSING_URL" };

  const rt = await toolConfig.resolveWebSearchRuntime().catch(() => null as any);
  if (!rt || !rt.isEnabled) return { ok: false as const, error: "WEB_SEARCH_DISABLED" };

  const allowed = isUrlAllowed(url, { allowDomains: rt.allowDomains, denyDomains: rt.denyDomains });
  if (!allowed.ok) return { ok: false as const, error: allowed.error, detail: allowed };

  const formatRaw = String((call?.args as any)?.format ?? "markdown").trim().toLowerCase();
  const format: "markdown" | "text" = formatRaw === "text" ? "text" : "markdown";
  const timeoutMs = clampInt((call?.args as any)?.timeoutMs, 1000, 120_000, 10_000);
  // 默认截断更保守：避免一次抓取把大量噪声 HTML 文本塞进上下文导致模型报错/超时
  const maxChars = clampInt((call?.args as any)?.maxChars, 1000, 200_000, 12_000);

  try {
    const res = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        // 尽量模拟普通浏览器，降低部分站点 403
        "User-Agent":
          String(rt.fetchUa ?? "").trim() ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      timeoutMs,
    } as any);

    const fetchedAt = new Date().toISOString();
    const status = res.status;
    const finalUrl = typeof (res as any)?.url === "string" ? String((res as any).url) : url;
    const contentType = res.headers.get("content-type");

    const body = await res.text().catch(() => "");
    if (!res.ok) {
      return { ok: false as const, error: `HTTP_${status}`, detail: { status, url, finalUrl } };
    }

    const isHtml = /text\/html|application\/xhtml\+xml/i.test(String(contentType ?? ""));
    let extractedBy: "fallback" | "not_html" = isHtml ? "fallback" : "not_html";
    let title: string | null = null;
    let extractedText = "";

    if (isHtml) {
      const extracted = extractTextFromHtml(body);
      title = extracted.title;
      extractedText = extracted.text;
    } else {
      extractedText = String(body ?? "");
    }

    if (extractedText.length > maxChars) extractedText = extractedText.slice(0, maxChars);

    const contentHash = createHash("sha256").update(extractedText, "utf8").digest("hex");

    const out: any = {
      ok: true,
      url,
      finalUrl,
      status,
      contentType: contentType ?? null,
      title,
      extractedBy,
      fetchedAt,
      contentHash,
    };
    if (format === "text") out.extractedText = extractedText;
    else out.extractedMarkdown = extractedText; // v0.1：先用纯文本/准 Markdown；后续可升级 Readability + Markdown 化

    return { ok: true as const, output: out };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "TIMEOUT" : e?.message ? String(e.message) : String(e);
    return { ok: false as const, error: "FETCH_FAILED", detail: { message: msg } };
  }
}

export async function executeLintStyleOnGateway(args: {
  fastify: FastifyInstance;
  call: any;
  styleLinterLibraries: any[];
  authorization?: string | null;
}) {
  const call = args.call;
  const text = typeof (call?.args as any)?.text === "string" ? String((call.args as any).text) : "";
  const pathArg = typeof (call?.args as any)?.path === "string" ? String((call.args as any).path) : "";
  if (!text.trim() || pathArg.trim()) {
    return { ok: false as const, error: "MISSING_TEXT_OR_PATH_NOT_SUPPORTED" };
  }

  const ids = parseIdListArg((call?.args as any)?.libraryIds);
  const filtered = ids.length
    ? (args.styleLinterLibraries ?? []).filter((l: any) => ids.includes(String(l?.id ?? "").trim()))
    : args.styleLinterLibraries ?? [];
  const libraries = filtered.slice(0, 6);
  if (!libraries.length) return { ok: false as const, error: "NO_STYLE_LIBRARIES_IN_SIDECAR" };

  const modelArg = typeof (call?.args as any)?.model === "string" ? String((call.args as any).model).trim() : "";
  const maxIssuesRaw = (call?.args as any)?.maxIssues;
  const maxIssuesNum = Number(maxIssuesRaw);
  const maxIssues = Number.isFinite(maxIssuesNum) ? Math.max(3, Math.min(24, Math.floor(maxIssuesNum))) : 10;

  const fp = computeDraftStatsForStyleLint(text);
  const injected = await args.fastify.inject({
    method: "POST",
    url: "/api/kb/dev/lint_style",
    headers: {
      "Content-Type": "application/json",
      ...(args.authorization ? { Authorization: String(args.authorization) } : {}),
    },
    payload: {
      ...(modelArg ? { model: modelArg } : {}),
      maxIssues,
      draft: { text, chars: fp.chars, sentences: fp.sentences, stats: fp.stats },
      libraries,
    },
  });
  const status = injected.statusCode;
  let json: any = null;
  try {
    json = injected.json();
  } catch {
    json = null;
  }
  if (status < 200 || status >= 300) {
    const msg = json?.error ? String(json.error) : `HTTP_${status}`;
    return { ok: false as const, error: msg, detail: json };
  }
  return {
    ok: true as const,
    output: {
      ok: true,
      ...(json ?? {}),
      libraryIds: libraries.map((l: any) => String(l?.id ?? "").trim()).filter(Boolean),
    },
  };
}

export async function executeProjectListFilesOnGateway(args: { toolSidecar: ToolSidecar | null }) {
  const sidecar: any = args.toolSidecar ?? null;
  const filesRaw = Array.isArray(sidecar?.projectFiles) ? (sidecar.projectFiles as any[]) : [];
  const files = filesRaw
    .map((f: any) => ({ path: String(f?.path ?? "").trim() }))
    .filter((f: any) => f.path)
    .slice(0, 5000);
  if (!files.length) return { ok: false as const, error: "NO_PROJECT_FILES_IN_SIDECAR" };
  return { ok: true as const, output: { ok: true, files } };
}

export async function executeProjectDocRulesGetOnGateway(args: { toolSidecar: ToolSidecar | null }) {
  const sidecar: any = args.toolSidecar ?? null;
  const dr = sidecar?.docRules ?? null;
  if (!dr || typeof dr !== "object") return { ok: false as const, error: "DOC_RULES_NOT_FOUND" };
  const path = String(dr?.path ?? "").trim();
  const content = typeof dr?.content === "string" ? String(dr.content) : "";
  if (!path) return { ok: false as const, error: "DOC_RULES_NOT_FOUND" };
  return { ok: true as const, output: { ok: true, path, content } };
}

export async function executeServerToolOnGateway(args: {
  fastify: FastifyInstance;
  call: any;
  toolSidecar: ToolSidecar | null;
  styleLinterLibraries: any[];
  authorization?: string | null;
  mainDoc: Record<string, unknown>;
}) {
  const name = String(args.call?.name ?? "").trim();
  if (name === "run.done") return { ok: true as const, output: { ok: true } };

  // run.* 编排工具：server-side 直接 ACK（结果通过 SSE 事件回传 Desktop 更新 UI）
  if (name === "run.setTodoList" || name === "run.todo.upsertMany" || name === "run.todo.update") {
    const items = args.call?.args?.items ?? args.call?.args?.todos ?? [];
    return { ok: true as const, output: { ok: true, items } };
  }
  if (name === "run.mainDoc.update") {
    const patchRaw = args.call?.args?.patch;
    if (!patchRaw || typeof patchRaw !== "object" || Array.isArray(patchRaw)) {
      return {
        ok: false as const,
        error: "INVALID_MAIN_DOC_PATCH: patch 必须是 JSON object。",
      };
    }

    const patch = patchRaw as Record<string, unknown>;
    const MAX_FIELD_CHARS = 800;
    const MAX_MAIN_DOC_CHARS = 3000;
    const safeLen = (v: unknown): number => {
      if (typeof v === "string") return v.length;
      try { return JSON.stringify(v ?? "").length; } catch { return String(v ?? "").length; }
    };

    // 单字段大小限制
    for (const [key, value] of Object.entries(patch)) {
      const fieldChars = safeLen(value);
      if (fieldChars > MAX_FIELD_CHARS) {
        return {
          ok: false as const,
          error: `MAIN_DOC_FIELD_TOO_LARGE: 字段 "${key}" 长度 ${fieldChars} 超过 ${MAX_FIELD_CHARS}。mainDoc 只存摘要/约束，请用 doc.write 存储草稿或 lint 结果。`,
        };
      }
    }

    // 合并后总量限制
    const merged = { ...args.mainDoc, ...patch };
    const mergedChars = safeLen(merged);
    if (mergedChars > MAX_MAIN_DOC_CHARS) {
      return {
        ok: false as const,
        error: `MAIN_DOC_TOO_LARGE: mainDoc 总长度 ${mergedChars} 超过 ${MAX_MAIN_DOC_CHARS}。请把草稿/中间产物用 doc.write 写入文件。`,
      };
    }

    Object.assign(args.mainDoc, patch);
    return { ok: true as const, output: { ok: true } };
  }
  if (name === "run.mainDoc.get") {
    return { ok: true as const, output: { ok: true, mainDoc: args.mainDoc } };
  }
  if (name === "time.now") return executeTimeNowOnGateway();
  if (name === "lint.style") {
    return executeLintStyleOnGateway({
      fastify: args.fastify,
      call: args.call,
      styleLinterLibraries: args.styleLinterLibraries,
      authorization: args.authorization ?? null,
    });
  }
  if (name === "project.listFiles") return executeProjectListFilesOnGateway({ toolSidecar: args.toolSidecar });
  if (name === "project.docRules.get") return executeProjectDocRulesGetOnGateway({ toolSidecar: args.toolSidecar });
  if (name === "agent.delegate") return { ok: false as const, error: "HANDLED_BY_RUNNER" };
  return { ok: false as const, error: "SERVER_TOOL_NOT_IMPLEMENTED" };
}

function executeTimeNowOnGateway() {
  const d = new Date();
  const utc = {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(), // 0=Sun..6=Sat
  };
  const local = {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    weekday: d.getDay(),
    timezoneOffsetMinutes: d.getTimezoneOffset(),
  };
  return {
    ok: true as const,
    output: {
      ok: true,
      nowIso: d.toISOString(),
      unixMs: d.getTime(),
      utc,
      local,
    },
  };
}


