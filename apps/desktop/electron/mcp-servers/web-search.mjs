/**
 * Web Search MCP Server（内置，国际网络）
 *
 * 提供两个工具：
 * - web_search：网页搜索（Serper 优先，Tavily 备选）
 * - get_page_content：抓取网页纯文本
 *
 * 环境变量（二选一）：
 * - SERPER_API_KEY — 推荐，Google 搜索结果（https://serper.dev）
 * - TAVILY_API_KEY — 备选（https://tavily.com）
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_INFO = { name: "web-search", version: "0.1.0" };
const SEARCH_TIMEOUT = 15_000;
const PAGE_TIMEOUT = 10_000;
const MAX_PAGE_CHARS = 8_000;

// ── 工具函数 ──────────────────────────────────────────

function trim(v) { return String(v ?? "").trim(); }

function truncate(text, max = 12_000) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max) + `\n\n[已截断，原始 ${s.length} 字符]`;
}

function ok(text) { return { content: [{ type: "text", text: truncate(text) }] }; }
function err(msg) { return { isError: true, content: [{ type: "text", text: `Web Search 错误：${msg}` }] }; }

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

/** 带超时的 JSON fetch */
async function fetchJson(url, init, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const raw = await res.text();
    if (!res.ok) {
      const detail = (() => { try { const j = JSON.parse(raw); return j?.message || j?.error || raw; } catch { return raw; } })();
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return JSON.parse(raw);
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`请求超时（>${timeout}ms）`);
    throw e;
  } finally { clearTimeout(timer); }
}

// ── 搜索后端 ──────────────────────────────────────────

function getBackend() {
  const serper = trim(process.env.SERPER_API_KEY);
  if (serper) return { type: "serper", key: serper };
  const tavily = trim(process.env.TAVILY_API_KEY);
  if (tavily) return { type: "tavily", key: tavily };
  return null;
}

async function searchSerper(query, num, key) {
  const data = await fetchJson("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": key },
    body: JSON.stringify({ q: query, num }),
  }, SEARCH_TIMEOUT);

  const items = [];

  // Answer Box
  const ab = data?.answerBox;
  if (ab?.answer || ab?.snippet) {
    items.push({ title: trim(ab.title) || "Answer Box", url: trim(ab.link), snippet: trim(ab.answer || ab.snippet) });
  }

  // 自然结果
  for (const r of (data?.organic ?? [])) {
    items.push({ title: trim(r.title) || "无标题", url: trim(r.link), snippet: trim(r.snippet), date: trim(r.date) });
  }

  // 新闻
  for (const r of (data?.news ?? [])) {
    items.push({ title: trim(r.title) || "新闻", url: trim(r.link), snippet: trim(r.snippet), date: trim(r.date) });
  }

  return { backend: "Serper", answer: trim(ab?.answer || ab?.snippet), items: items.slice(0, num) };
}

async function searchTavily(query, num, key) {
  const data = await fetchJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: num, include_answer: true }),
  }, SEARCH_TIMEOUT);

  const items = (data?.results ?? []).slice(0, num).map(r => ({
    title: trim(r.title) || "无标题",
    url: trim(r.url),
    snippet: trim(r.content),
    date: trim(r.published_date),
    score: r.score,
  }));

  return { backend: "Tavily", answer: trim(data?.answer), items };
}

// ── 结果格式化 ─────────────────────────────────────────

function fmtSearchResult(query, parsed) {
  const lines = [`查询: ${query}`, `后端: ${parsed.backend}`];
  if (parsed.answer) lines.push("", `答案摘要: ${truncate(parsed.answer, 500)}`);
  if (!parsed.items.length) { lines.push("", "未检索到结果。"); return lines.join("\n"); }

  lines.push("", `结果 (${parsed.items.length}):`);
  for (const [i, item] of parsed.items.entries()) {
    lines.push(`${i + 1}. ${item.title}`);
    if (item.url) lines.push(`   URL: ${item.url}`);
    if (item.date) lines.push(`   时间: ${item.date}`);
    if (item.snippet) lines.push(`   摘要: ${truncate(item.snippet, 320)}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ── HTML → 纯文本 ─────────────────────────────────────

function stripHtml(html) {
  let t = String(html ?? "");
  t = t.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  t = t.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  t = t.replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|br)>/gi, "\n");
  t = t.replace(/<[^>]+>/g, " ");
  // 基本 HTML entity 解码
  t = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  t = t.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  t = t.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return t.trim();
}

// ── MCP Server 定义 ────────────────────────────────────

const server = new McpServer(SERVER_INFO);

server.tool(
  "web_search",
  "网页搜索（Serper 优先，Tavily 备选）。返回标题、URL、摘要等。",
  {
    query: z.string().describe("搜索关键词"),
    num_results: z.number().optional().describe("返回条数，1-20，默认 5"),
  },
  async ({ query, num_results }) => {
    try {
      const q = trim(query);
      if (!q) return err("query 不能为空");
      const n = clampNum(num_results, 1, 20, 5);

      const backend = getBackend();
      if (!backend) return err("未配置搜索密钥。请在设置页填写 SERPER_API_KEY 或 TAVILY_API_KEY（二选一）。");

      const parsed = backend.type === "serper"
        ? await searchSerper(q, n, backend.key)
        : await searchTavily(q, n, backend.key);

      return ok(fmtSearchResult(q, parsed));
    } catch (e) { return err(e?.message ?? String(e)); }
  },
);

server.tool(
  "get_page_content",
  "抓取网页并提取纯文本内容（超时 10 秒，返回前 8000 字符）。",
  {
    url: z.string().describe("网页 URL（http/https）"),
  },
  async ({ url }) => {
    try {
      const raw = trim(url);
      if (!raw) return err("url 不能为空");

      let parsed;
      try { parsed = new URL(raw); } catch { return err("URL 格式不合法"); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return err("仅支持 http/https URL");

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT);
      let res;
      try {
        res = await fetch(parsed.toString(), {
          method: "GET", redirect: "follow", signal: ctrl.signal,
          headers: { Accept: "text/html,text/plain;q=0.9,*/*;q=0.8", "User-Agent": "writing-ide-mcp/0.1" },
        });
      } catch (e) {
        if (e?.name === "AbortError") return err(`抓取超时（>${PAGE_TIMEOUT}ms）`);
        throw e;
      } finally { clearTimeout(timer); }

      if (!res.ok) return err(`HTTP ${res.status}: ${res.statusText}`);

      const body = await res.text();
      const ct = trim(res.headers.get("content-type"));
      const text = ct.includes("html") ? stripHtml(body) : body.trim();

      if (!text) return err("页面内容为空");

      const out = text.length > MAX_PAGE_CHARS
        ? text.slice(0, MAX_PAGE_CHARS) + `\n\n[已截断，原始 ${text.length} 字符]`
        : text;

      return ok(`URL: ${parsed}\n\n${out}`);
    } catch (e) { return err(e?.message ?? String(e)); }
  },
);

// ── 启动 ───────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[web-search] MCP Server 已启动");
