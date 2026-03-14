import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { computeDraftStatsForStyleLint } from "../kb/styleLintDraftStats.js";
import { toolConfig } from "../toolConfig.js";
import { TOOL_LIST } from "@ohmycrab/tools";
import { buildToolCatalog, type ToolCatalogEntry } from "./toolCatalog.js";
import { retrieveToolsForRun } from "./toolRetriever.js";

export type ServerToolExecutionDecision = {
  executedBy: "gateway" | "desktop";
  reasonCodes: string[];
};

export type ToolSidecar = {
  styleLinterLibraries?: any[];
  projectFiles?: Array<{ path: string }>;
  /** 当前 run 选择出的 MCP tools（已按 server selection 过滤） */
  mcpTools?: any[];
  mcpServers?: any[];
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
    : ["lint.style", "time.now",
       "tools.search", "tools.describe",
       "web.search", "web.fetch",
       "run.done", "run.setTodoList", "run.todo", "run.mainDoc.update", "run.mainDoc.get",
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
  // tools.*：工具发现（只读）
  if (name === "tools.search" || name === "tools.describe") {
    return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "tool_discovery_server_side"] };
  }
  // web.*：优先 Gateway 执行（Bocha API / 直接 HTTP）；若不可用，Runner 层回退到 MCP
  if (name === "web.search" || name === "web.fetch") return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "web_gateway_first"] };
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

  // project.listFiles 统一回到 Desktop 权威源，避免 sidecar 快照滞后导致“能看到但删不到/读不到”。
  if (name === "project.listFiles") {
    return { executedBy: "desktop", reasonCodes: ["project_list_desktop_source_of_truth"] };
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

// ── Tool Discovery (Phase 1) ────────────────────────────────────────────────

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
  llmOverride?: { baseUrl: string; endpoint?: string; apiKey: string; model: string } | null;
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
      ...(args.llmOverride ? { llmOverride: args.llmOverride } : {}),
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

export async function executeServerToolOnGateway(args: {
  fastify: FastifyInstance;
  call: any;
  toolSidecar: ToolSidecar | null;
  styleLinterLibraries: any[];
  authorization?: string | null;
  mainDoc: Record<string, unknown>;
  llmOverride?: { baseUrl: string; endpoint?: string; apiKey: string; model: string } | null;
  mode: "chat" | "agent";
  allowedToolNames?: Set<string> | null;
}) {
  const name = String(args.call?.name ?? "").trim();
  if (name === "run.done") return { ok: true as const, output: { ok: true } };

  // run.* 编排工具：server-side 直接 ACK（结果通过 SSE 事件回传 Desktop 更新 UI）
  if (name === "run.setTodoList" || name === "run.todo.upsertMany" || name === "run.todo.update") {
    const items = args.call?.args?.items ?? args.call?.args?.todos ?? [];
    return { ok: true as const, output: { ok: true, items } };
  }
  // 合并后的 run.todo（通过 action 分发）
  if (name === "run.todo") {
    const action = String(args.call?.args?.action ?? "").trim().toLowerCase();
    if (action === "upsert") {
      const items = args.call?.args?.items ?? [];
      return { ok: true as const, output: { ok: true, items } };
    }
    if (action === "update") {
      return { ok: true as const, output: { ok: true } };
    }
    if (action === "remove") {
      return { ok: true as const, output: { ok: true } };
    }
    if (action === "clear") {
      return { ok: true as const, output: { ok: true } };
    }
    return { ok: false as const, error: `INVALID_TODO_ACTION: action="${action}" 不合法，请使用 upsert|update|remove|clear。` };
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
          error: `MAIN_DOC_FIELD_TOO_LARGE: 字段 "${key}" 长度 ${fieldChars} 超过 ${MAX_FIELD_CHARS}。mainDoc 只存摘要/约束，请用 write 存储草稿或 lint 结果。`,
        };
      }
    }

    // 合并后总量限制
    const merged = { ...args.mainDoc, ...patch };
    const mergedChars = safeLen(merged);
    if (mergedChars > MAX_MAIN_DOC_CHARS) {
      return {
        ok: false as const,
        error: `MAIN_DOC_TOO_LARGE: mainDoc 总长度 ${mergedChars} 超过 ${MAX_MAIN_DOC_CHARS}。请把草稿/中间产物用 write 写入文件。`,
      };
    }

    Object.assign(args.mainDoc, patch);
    return { ok: true as const, output: { ok: true } };
  }
  if (name === "run.mainDoc.get") {
    return { ok: true as const, output: { ok: true, mainDoc: args.mainDoc } };
  }
  if (name === "time.now") return executeTimeNowOnGateway();
  if (name === "tools.search") {
    return executeToolsSearchOnGateway({
      call: args.call,
      toolSidecar: args.toolSidecar,
      mode: args.mode,
      allowedToolNames: args.allowedToolNames ?? null,
    });
  }
  if (name === "tools.describe") {
    return executeToolsDescribeOnGateway({
      call: args.call,
      toolSidecar: args.toolSidecar,
      mode: args.mode,
      allowedToolNames: args.allowedToolNames ?? null,
    });
  }
  if (name === "web.search") {
    const ret = await executeWebSearchOnGateway({ call: args.call });
    if (ret.ok) return ret;
    // Bocha API 不可用（未配置/超时/错误）→ 标记需回退到 MCP
    return { ok: false as const, error: "WEB_SEARCH_FALLBACK_TO_MCP", detail: ret };
  }
  if (name === "web.fetch") {
    const ret = await executeWebFetchOnGateway({ call: args.call });
    if (ret.ok) return ret;
    return { ok: false as const, error: "WEB_FETCH_FALLBACK_TO_MCP", detail: ret };
  }
  if (name === "lint.style") {
    return executeLintStyleOnGateway({
      fastify: args.fastify,
      call: args.call,
      styleLinterLibraries: args.styleLinterLibraries,
      authorization: args.authorization ?? null,
      llmOverride: args.llmOverride ?? null,
    });
  }
  if (name === "project.listFiles") return executeProjectListFilesOnGateway({ toolSidecar: args.toolSidecar });
  if (name === "agent.delegate") return { ok: false as const, error: "HANDLED_BY_RUNNER" };
  return { ok: false as const, error: "SERVER_TOOL_NOT_IMPLEMENTED" };
}

function clampBool(v: any, fallback: boolean) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes") return true;
  if (s === "0" || s === "false" || s === "no") return false;
  return fallback;
}

function normalizeStringArray(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  return [s];
}

function summarizeInputSchema(schema: any, maxKeys = 10): Record<string, unknown> | null {
  const s = schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as any) : null;
  if (!s) return null;
  const props = s.properties && typeof s.properties === "object" ? s.properties : null;
  const required = Array.isArray(s.required) ? s.required.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [];
  const keys = props ? Object.keys(props).slice(0, Math.max(0, Math.floor(maxKeys))) : [];
  return {
    type: String(s.type ?? "object"),
    required,
    keys,
  };
}

function requiredArgsFromSchema(schema: any): string[] {
  const s = schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as any) : null;
  if (!s) return [];
  const req = Array.isArray(s.required) ? s.required : [];
  return req.map((x: any) => String(x ?? "").trim()).filter(Boolean);
}

function listCatalogForDiscovery(args: {
  mode: "chat" | "agent";
  allowedToolNames: Set<string> | null;
  toolSidecar: ToolSidecar | null;
  includeAllMcpTools?: boolean;
}): ToolCatalogEntry[] {
  const allowed = args.allowedToolNames ?? new Set(TOOL_LIST.map((t) => String(t?.name ?? "").trim()).filter(Boolean));
  const sidecar = (args.toolSidecar ?? null) as any;
  const mcpTools = Array.isArray(sidecar?.mcpTools) ? (sidecar.mcpTools as any[]) : [];

  if (args.includeAllMcpTools && mcpTools.length > 0) {
    // tools.search 模式：内置工具仍按 allowed 过滤，但 MCP 工具使用全量目录。
    const expandedAllowed = new Set(allowed);
    for (const t of mcpTools) {
      const name = String(t?.name ?? "").trim();
      if (name) expandedAllowed.add(name);
    }
    return buildToolCatalog({
      mode: args.mode,
      allowedToolNames: expandedAllowed,
      mcpTools,
    });
  }

  return buildToolCatalog({
    mode: args.mode,
    allowedToolNames: allowed,
    mcpTools,
  });
}

function executeToolsSearchOnGateway(args: {
  call: any;
  toolSidecar: ToolSidecar | null;
  mode: "chat" | "agent";
  allowedToolNames: Set<string> | null;
}) {
  const query = String(args.call?.args?.query ?? "").trim();
  if (!query) return { ok: false as const, error: "MISSING_QUERY" };

  const limit = clampInt(args.call?.args?.limit, 1, 20, 8);
  const includeSchemas = clampBool(args.call?.args?.includeSchemas, false);
  const sources = new Set(normalizeStringArray(args.call?.args?.sources).map((x) => x.toLowerCase()));

  const catalog = listCatalogForDiscovery({
    mode: args.mode,
    allowedToolNames: args.allowedToolNames,
    toolSidecar: args.toolSidecar,
    includeAllMcpTools: true,
  });

  const filteredCatalog = sources.size > 0
    ? catalog.filter((e) => sources.has(String(e.source ?? "").toLowerCase()))
    : catalog;

  const retrieval = retrieveToolsForRun({
    catalog: filteredCatalog,
    userPrompt: query,
    routeId: null,
    maxCandidates: Math.max(12, limit * 2),
    desired: limit,
  });

  const byName = new Map(filteredCatalog.map((e) => [e.name, e] as const));
  const tools = retrieval.retrievedToolNames
    .map((name) => byName.get(name))
    .filter(Boolean)
    .slice(0, limit)
    .map((e) => ({
      name: e!.name,
      source: e!.source,
      description: e!.description,
      riskLevel: e!.riskLevel,
      capabilities: e!.capabilities,
      requiredArgs: requiredArgsFromSchema(e!.inputSchema),
      schemaSummary: includeSchemas ? (e!.inputSchema ?? null) : summarizeInputSchema(e!.inputSchema, 10),
    }));

  return {
    ok: true as const,
    output: {
      ok: true,
      tools,
    },
  };
}

function executeToolsDescribeOnGateway(args: {
  call: any;
  toolSidecar: ToolSidecar | null;
  mode: "chat" | "agent";
  allowedToolNames: Set<string> | null;
}) {
  const name = String(args.call?.args?.name ?? "").trim();
  if (!name) return { ok: false as const, error: "MISSING_NAME" };
  const includeSchema = clampBool(args.call?.args?.includeSchema, true);

  const catalog = listCatalogForDiscovery({
    mode: args.mode,
    allowedToolNames: args.allowedToolNames,
    toolSidecar: args.toolSidecar,
  });
  const entry = catalog.find((e) => e.name === name) ?? null;
  if (!entry) return { ok: false as const, error: "TOOL_NOT_FOUND", detail: { name } };

  return {
    ok: true as const,
    output: {
      ok: true,
      tool: {
        name: entry.name,
        source: entry.source,
        description: entry.description,
        riskLevel: entry.riskLevel,
        capabilities: entry.capabilities,
        inputSchema: includeSchema ? (entry.inputSchema ?? null) : summarizeInputSchema(entry.inputSchema, 20),
      },
    },
  };
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
