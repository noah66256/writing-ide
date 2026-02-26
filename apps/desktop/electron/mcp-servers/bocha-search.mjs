/**
 * 博查搜索 MCP Server（内置）
 *
 * 提供两个工具：
 * - bocha_web_search：通用网页搜索
 * - bocha_ai_search：语义增强搜索（含结构化卡片）
 *
 * 环境变量：BOCHA_API_KEY（必填，Bearer token）
 * API 文档：https://open.bochaai.com
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_INFO = { name: "bocha-search", version: "0.1.0" };
const BOCHA_BASE = "https://api.bochaai.com/v1";
const TIMEOUT_MS = 15_000;

// ── 工具函数 ──────────────────────────────────────────

function trim(v) { return String(v ?? "").trim(); }

function truncate(text, max = 12_000) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max) + `\n\n[已截断，原始 ${s.length} 字符]`;
}

function ok(text) { return { content: [{ type: "text", text: truncate(text) }] }; }
function err(msg) { return { isError: true, content: [{ type: "text", text: `博查搜索错误：${msg}` }] }; }

function clampCount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(50, Math.round(n))) : 10;
}

async function bochaPost(path, body) {
  const key = trim(process.env.BOCHA_API_KEY);
  if (!key) throw new Error("缺少 BOCHA_API_KEY，请在设置页填写后重试");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BOCHA_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const detail = (() => { try { const j = JSON.parse(text); return j?.message || j?.msg || text; } catch { return text; } })();
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return JSON.parse(text);
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`请求超时（>${TIMEOUT_MS}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── 结果格式化 ─────────────────────────────────────────

function fmtWebItem(item, i) {
  const lines = [`${i + 1}. ${trim(item?.name || item?.title) || "无标题"}`];
  if (item?.url) lines.push(`   URL: ${item.url}`);
  const src = [trim(item?.siteName), trim(item?.datePublished)].filter(Boolean).join(" | ");
  if (src) lines.push(`   来源: ${src}`);
  const desc = trim(item?.summary || item?.snippet);
  if (desc) lines.push(`   摘要: ${desc}`);
  return lines.join("\n");
}

function fmtWebSearch(query, pages) {
  if (!pages?.length) return `查询: ${query}\n未找到结果。`;
  return [`查询: ${query}`, `命中: ${pages.length} 条`, "", ...pages.map(fmtWebItem)].join("\n");
}

function fmtAiSearch(query, raw) {
  const lines = [`查询: ${query}`];
  const messages = raw?.messages || raw?.data?.messages || [];
  if (!messages.length) {
    // 兼容 web-search 格式的 fallback
    const pages = raw?.data?.webPages?.value;
    if (Array.isArray(pages) && pages.length) return fmtWebSearch(query, pages);
    return `查询: ${query}\n未找到结果。`;
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const type = trim(msg.content_type);
    let content = msg.content;

    // content 可能是 JSON 字符串
    if (typeof content === "string") {
      try { content = JSON.parse(content); } catch { /* 保持原样 */ }
    }

    if (type === "webpage" && content?.value) {
      lines.push("", `网页结果 (${content.value.length}):`);
      content.value.forEach((item, i) => lines.push(fmtWebItem(item, i)));
    } else if (type !== "image" && content && JSON.stringify(content) !== "{}") {
      // 结构化卡片或其他内容
      const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
      lines.push("", `[${type || "其他"}]`, truncate(text, 1500));
    }
  }

  return lines.join("\n").trim() || `查询: ${query}\n未找到结果。`;
}

// ── MCP Server 定义 ────────────────────────────────────

const server = new McpServer(SERVER_INFO);

server.tool(
  "bocha_web_search",
  "使用博查搜索引擎检索网页。返回标题、URL、摘要、来源等信息。",
  {
    query: z.string().describe("搜索关键词"),
    freshness: z.string().optional().describe("时间范围：noLimit(默认)/oneDay/oneWeek/oneMonth/oneYear 或 YYYY-MM-DD"),
    count: z.number().optional().describe("返回条数，1-50，默认 10"),
  },
  async ({ query, freshness, count }) => {
    try {
      const q = trim(query);
      if (!q) return err("query 不能为空");
      const data = await bochaPost("/web-search", {
        query: q, summary: true, freshness: freshness || "noLimit", count: clampCount(count ?? 10),
      });
      const pages = data?.data?.webPages?.value ?? [];
      return ok(fmtWebSearch(q, pages));
    } catch (e) { return err(e?.message ?? String(e)); }
  },
);

server.tool(
  "bocha_ai_search",
  "使用博查 AI 搜索（语义增强），返回网页结果和结构化卡片（天气、百科、股票等）。",
  {
    query: z.string().describe("搜索关键词"),
    freshness: z.string().optional().describe("时间范围：noLimit(默认)/oneDay/oneWeek/oneMonth/oneYear"),
    count: z.number().optional().describe("返回条数，1-50，默认 10"),
  },
  async ({ query, freshness, count }) => {
    try {
      const q = trim(query);
      if (!q) return err("query 不能为空");
      const data = await bochaPost("/ai-search", {
        query: q, freshness: freshness || "noLimit", count: clampCount(count ?? 10),
        answer: false, stream: false,
      });
      return ok(fmtAiSearch(q, data));
    } catch (e) { return err(e?.message ?? String(e)); }
  },
);

// ── 启动 ───────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[bocha-search] MCP Server 已启动");
