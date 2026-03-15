#!/usr/bin/env node
/**
 * 冒烟：跑一遍 style_imitate（目录先挑 v0.1）流程，验证 phase 门禁是否能跑通。
 *
 * 说明：
 * - 依赖本地 dev Gateway（/api/agent/run/stream 仅 dev 开放）
 * - 用 admin 登录绕过积分门禁（dev 默认 admin123456）
 * - 脚本模拟 Desktop 执行工具：收到 tool.call 就回传 tool_result（只覆盖最小工具集合）
 *
 * 用法：
 *   node scripts/smoke-style-imitate.mjs
 *   node scripts/smoke-style-imitate.mjs --gateway http://127.0.0.1:8001 --timeoutSec 300
 *   node scripts/smoke-style-imitate.mjs --out out/smoke-style-imitate-latest.md
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_GATEWAY = "http://127.0.0.1:8000";

function readTextIfExists(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function normalizeForOverlap(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitMarkdownToParagraphs(md) {
  const t = normalizeForOverlap(md);
  if (!t) return [];
  // 粗分：按空行切；忽略非常短的段落
  return t
    .split(/\n\s*\n/g)
    .map((x) => x.trim())
    .filter((x) => x.length >= 20);
}

function pickKeywords(q) {
  const s = String(q ?? "").trim();
  if (!s) return [];
  // 简易：按空白/标点切词，保留长度>=2 的词
  return s
    .split(/[\s,，。！？;；、"'“”‘’()（）【】\[\]<>《》·\-_/]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2)
    .slice(0, 16);
}

function scoreParagraph(p, kws) {
  if (!p) return 0;
  if (!kws.length) return 0;
  let s = 0;
  for (const k of kws) {
    const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const m = p.match(re);
    if (m) s += Math.min(5, m.length);
  }
  // 轻微偏好短一点的“可抄片段”（更像 kb.search snippet）
  s += p.length <= 220 ? 1 : 0;
  return s;
}

function detectDirectCopies(args) {
  const draft = normalizeForOverlap(args.draftText);
  const snippets = (args.snippets ?? []).map((x) => String(x ?? "")).filter(Boolean);
  const hits = [];
  for (const sn of snippets) {
    const s = normalizeForOverlap(sn);
    if (s.length < (args.minLen ?? 40)) continue;
    if (draft.includes(s)) hits.push({ len: s.length, snippet: s.slice(0, 120) + (s.length > 120 ? "…" : "") });
    if (hits.length >= 8) break;
  }
  hits.sort((a, b) => b.len - a.len);
  return hits;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!String(a).startsWith("--")) continue;
    const key = String(a).slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function buildContextPackV1(args) {
  const styleLibId = args.styleLibId || "kb_lib_smoke_style";
  const kbSelected = [
    {
      id: styleLibId,
      name: "SMOKE_STYLE",
      purpose: "style",
      facetPackId: "speech_marketing_v1",
      docCount: 0,
      updatedAt: nowIso(),
    },
  ];

  // 目录（简化）：只做“结构化选项池”，不注入任何原文/长 quote
  const catalog = {
    v: 1,
    libraryId: styleLibId,
    libraryName: "SMOKE_STYLE",
    facetPackId: "speech_marketing_v1",
    topK: { must: 6, should: 6, may: 4 },
    facets: [
      {
        facetId: "values_embedding",
        label: "价值观植入",
        options: [
          { optionId: "values_embedding:o1", label: "否定表象→定义本质", signals: ["需要立场/判词"], do: ["先给判词，再解释"], dont: ["不要引用原文句子"] },
          { optionId: "values_embedding:o2", label: "定义框架→重排优先级", signals: ["需要价值排序"], do: ["先框架再建议"], dont: ["不要堆抽象词"] },
          { optionId: "values_embedding:o3", label: "冷峻结论→硬核解法", signals: ["需要收束落点"], do: ["给出可执行动作"], dont: ["不要廉价安慰"] },
        ],
      },
      {
        facetId: "logic_framework",
        label: "逻辑架构",
        options: [
          { optionId: "logic_framework:o1", label: "否定表象→抓根因", signals: ["需要论证"], do: ["先定义根因，再举例"], dont: ["不要跑题"] },
          { optionId: "logic_framework:o2", label: "微观隐喻→悖论推导", signals: ["需要类比"], do: ["用一个短类比开头"], dont: ["不要照抄样例"] },
          { optionId: "logic_framework:o3", label: "三段论→层递推进", signals: ["需要结构推进"], do: ["每段先结论句"], dont: ["不要长篇解释型过渡"] },
        ],
      },
      {
        facetId: "narrative_structure",
        label: "叙事结构",
        options: [
          { optionId: "narrative_structure:o1", label: "总-分-总（回扣）", signals: ["需要闭环"], do: ["结尾回扣开头"], dont: ["不要散"] },
          { optionId: "narrative_structure:o2", label: "反转-解释-落点", signals: ["需要钩子"], do: ["先反直觉再解释"], dont: ["不要废话"] },
          { optionId: "narrative_structure:o3", label: "案例-抽象-建议", signals: ["需要案例"], do: ["案例只用来支撑结论"], dont: ["不要堆案例"] },
        ],
      },
    ],
    softRanges: { avgSentenceLen: [22, 34], questionRatePer100Sentences: [8, 22] },
  };

  const mainDoc = {
    runIntent: "writing",
    goal: "约1200字",
    // v0.1：stylePlanV1 应由模型在 catalog_pick 阶段写入；此处不预置，确保门禁生效。
  };

  const docRules = "（smoke）不注入 Doc Rules。";
  const todo = [];
  return (
    `MAIN_DOC(JSON):\n${JSON.stringify(mainDoc, null, 2)}\n\n` +
    `RUN_TODO(JSON):\n${JSON.stringify(todo, null, 2)}\n\n` +
    `DOC_RULES(Markdown):\n${docRules}\n\n` +
    `KB_SELECTED_LIBRARIES(JSON):\n${JSON.stringify(kbSelected, null, 2)}\n\n` +
    `STYLE_CATALOG(JSON):\n${JSON.stringify(catalog, null, 2)}\n\n`
  );
}

async function jsonFetch(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!res.ok) {
    const msg = json?.error ? String(json.error) : `HTTP_${res.status}`;
    throw new Error(`${msg}: ${text.slice(0, 400)}`);
  }
  return json;
}

async function loginAdmin(gatewayUrl) {
  const username = process.env.SMOKE_ADMIN_USER || "admin";
  const password = process.env.SMOKE_ADMIN_PASS || "admin123456";
  const ret = await jsonFetch(`${gatewayUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const token = String(ret?.accessToken ?? "").trim();
  if (!token) throw new Error("NO_TOKEN_FROM_ADMIN_LOGIN");
  return token;
}

function sseParseBlocks(buffer) {
  const out = [];
  let idx = buffer.indexOf("\n\n");
  while (idx >= 0) {
    const block = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    out.push(block);
    idx = buffer.indexOf("\n\n");
  }
  return { blocks: out, rest: buffer };
}

function parseSseEvent(block) {
  const lines = String(block).split("\n");
  let event = "";
  let data = "";
  for (const l of lines) {
    if (l.startsWith("event:")) event = l.slice("event:".length).trim();
    else if (l.startsWith("data:")) data += l.slice("data:".length).trim();
  }
  let payload = data;
  try {
    payload = data ? JSON.parse(data) : null;
  } catch {
    // keep raw
  }
  return { event, data: payload };
}

function shallowMerge(a, b) {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b || {})) out[k] = b[k];
  return out;
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gatewayUrl = String(args.gateway || process.env.GATEWAY_URL || DEFAULT_GATEWAY).replace(/\/+$/, "");
  const timeoutSec = Number(args.timeoutSec || process.env.SMOKE_TIMEOUT_SEC || 300);
  const idleTimeoutSec = Number(args.idleTimeoutSec || process.env.SMOKE_IDLE_TIMEOUT_SEC || 45);
  const outPathArg = String(args.out || process.env.SMOKE_OUT || "").trim();
  const outPath = outPathArg ? outPathArg : "out/smoke-style-imitate-latest.md";
  const kbFilesArg = String(args.kbFile || process.env.SMOKE_KB_FILE || "李叔短视频稿.md").trim();
  const kbFiles = kbFilesArg
    ? kbFilesArg
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
  const prompt =
    String(
      args.prompt ||
        process.env.SMOKE_PROMPT ||
        // “呆瓜用户一句话”：不教顺序，只给目标与约束（避免批量/多篇等触发 writing_batch）
        "帮我用绑定的风格库仿写一篇短视频口播稿，主题是「挽回里的预期管理」，大概1200字，语气犀利但克制。",
    ).trim();
  if (!prompt) throw new Error("EMPTY_PROMPT");

  const token = await loginAdmin(gatewayUrl);
  const ctx = buildContextPackV1({ styleLibId: String(args.styleLibId || process.env.SMOKE_STYLE_LIB_ID || "").trim() || undefined });

  const abort = new AbortController();
  // 总超时 + 空闲超时（无事件就判定卡死）
  const totalTimer = setTimeout(() => abort.abort(new Error("SMOKE_TIMEOUT")), Math.max(5, timeoutSec) * 1000);
  let idleTimer = setTimeout(() => abort.abort(new Error("SMOKE_IDLE_TIMEOUT")), Math.max(3, idleTimeoutSec) * 1000);
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort.abort(new Error("SMOKE_IDLE_TIMEOUT")), Math.max(3, idleTimeoutSec) * 1000);
  };

  const res = await fetch(`${gatewayUrl}/api/agent/run/stream`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ mode: "agent", prompt, contextPack: ctx }),
    signal: abort.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RUN_START_FAILED HTTP_${res.status}: ${text.slice(0, 600)}`);
  }

  let runId = "";
  let buffer = "";
  const phases = [];
  const notices = [];
  const toolCalls = [];
  const assistantTextParts = [];
  let runEnd = null;
  const kbSnippetsUsed = [];
  const lintStyleStats = { calls: 0, hasEdits: 0, hasReference: 0, patchFallbackUsed: 0 };

  // 模拟 Desktop 维护 mainDoc
  let mainDoc = { runIntent: "writing", goal: "约1200字" };
  let todoList = [];
  let lastWritten = { path: "", text: "" };

  const kbCorpus = (() => {
    const out = [];
    for (const rel of kbFiles) {
      const abs = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
      const txt = readTextIfExists(abs);
      if (!txt) continue;
      out.push({
        relPath: rel.replaceAll("\\", "/"),
        absPath: abs,
        paragraphs: splitMarkdownToParagraphs(txt),
      });
    }
    return out;
  })();

  const reader = res.body.getReader();

  const postToolResult = async (payload) => {
    if (!runId) throw new Error("NO_RUN_ID_YET");
    await jsonFetch(`${gatewayUrl}/api/agent/run/${runId}/tool_result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  };

  const handleToolCall = async (call) => {
    const toolCallId = String(call?.toolCallId ?? "").trim();
    const name = String(call?.name ?? "").trim();
    const executedBy = String(call?.executedBy ?? "").trim();
    const args0 = call?.args && typeof call.args === "object" ? call.args : {};
    toolCalls.push({ name, executedBy });
    if (!toolCallId || !name) return;
    if (executedBy === "gateway") return; // gateway 自己执行

    if (name === "run.setTodoList") {
      todoList = [
        { id: "pick", text: "目录先挑：写入 mainDoc.stylePlanV1", status: "todo" },
        { id: "t1", text: "kb.search 模板/结构", status: "todo" },
        { id: "t2", text: "产出初稿", status: "todo" },
        { id: "t3", text: "二次 kb.search 结尾/金句", status: "todo" },
        { id: "t4", text: "lint.style", status: "todo" },
        { id: "t5", text: "write 写入", status: "todo" },
      ];
      return postToolResult({ toolCallId, name, ok: true, output: { ok: true, todoList }, meta: { applyPolicy: "auto_apply", riskLevel: "low", hasApply: false } });
    }

    if (name === "run.todo.upsertMany") {
      let items = args0?.items;
      if (typeof items === "string") {
        try {
          items = JSON.parse(items);
        } catch {
          items = null;
        }
      }
      const arr = Array.isArray(items) ? items : [];
      const byId = new Map(todoList.map((t) => [String(t.id), t]));
      for (const it of arr) {
        const text = String(it?.text ?? "").trim();
        if (!text) continue;
        let id = String(it?.id ?? "").trim();
        if (!id) id = `t${byId.size + 1}`;
        const cur = byId.get(id);
        const next = {
          id,
          text: text || cur?.text || "",
          status: String(it?.status ?? cur?.status ?? "todo"),
          ...(it?.note !== undefined ? { note: String(it.note ?? "") } : cur?.note !== undefined ? { note: cur.note } : {}),
        };
        byId.set(id, next);
      }
      todoList = Array.from(byId.values());
      return postToolResult({ toolCallId, name, ok: true, output: { ok: true, todoList }, meta: { applyPolicy: "auto_apply", riskLevel: "low", hasApply: false } });
    }

    if (name === "run.todo.update" || name === "run.updateTodo") {
      const idRaw = String(args0?.id ?? "").trim();
      let patch = args0?.patch;
      if (typeof patch === "string") {
        try {
          patch = JSON.parse(patch);
        } catch {
          patch = null;
        }
      }
      const p = patch && typeof patch === "object" ? patch : {};
      let id = idRaw;
      if (!id && todoList.length === 1) id = String(todoList[0]?.id ?? "");
      if (id) {
        todoList = todoList.map((t) => {
          if (String(t.id) !== id) return t;
          return {
            ...t,
            ...(p.text !== undefined ? { text: String(p.text ?? "") } : {}),
            ...(p.status !== undefined ? { status: String(p.status ?? "") } : {}),
            ...(p.note !== undefined ? { note: String(p.note ?? "") } : {}),
          };
        });
      }
      return postToolResult({ toolCallId, name, ok: true, output: { ok: true, todoList }, meta: { applyPolicy: "auto_apply", riskLevel: "low", hasApply: false } });
    }

    if (name === "run.todo.remove") {
      const id = String(args0?.id ?? "").trim();
      if (id) todoList = todoList.filter((t) => String(t.id) !== id);
      return postToolResult({ toolCallId, name, ok: true, output: { ok: true, todoList }, meta: { applyPolicy: "auto_apply", riskLevel: "low", hasApply: false } });
    }

    if (name === "run.todo.clear") {
      todoList = [];
      return postToolResult({ toolCallId, name, ok: true, output: { ok: true, todoList }, meta: { applyPolicy: "auto_apply", riskLevel: "low", hasApply: false } });
    }

    if (name === "run.mainDoc.get") {
      return postToolResult({ toolCallId, name, ok: true, output: { ok: true, mainDoc }, meta: { applyPolicy: "auto_apply", riskLevel: "low", hasApply: false } });
    }

    if (name === "run.mainDoc.update") {
      let patch = args0?.patch;
      if (typeof patch === "string") {
        try {
          patch = JSON.parse(patch);
        } catch {
          patch = null;
        }
      }
      if (!patch || typeof patch !== "object") {
        // 兜底：直接写一个最小 stylePlanV1，确保门禁能过
        patch = {
          stylePlanV1: {
            v: 1,
            libraryId: process.env.SMOKE_STYLE_LIB_ID || "kb_lib_smoke_style",
            facetPackId: "speech_marketing_v1",
            topK: { must: 6, should: 6, may: 4 },
            selected: {
              must: [
                { facetId: "values_embedding", optionId: "values_embedding:o1" },
                { facetId: "logic_framework", optionId: "logic_framework:o1" },
                { facetId: "narrative_structure", optionId: "narrative_structure:o1" },
              ],
              should: [],
              may: [],
            },
            stages: { s0: { done: false }, s1: { done: false } },
            updatedAt: nowIso(),
          },
        };
      }
      mainDoc = shallowMerge(mainDoc, patch);
      return postToolResult({ toolCallId, name, ok: true, output: { ok: true, mainDoc }, meta: { applyPolicy: "auto_apply", riskLevel: "low", hasApply: false } });
    }

    if (name === "kb.search") {
      const query = String(args0?.query ?? "").trim();
      const kind = String(args0?.kind ?? "card").trim() || "card";
      const libraryIds = args0?.libraryIds ?? [];

      const kws = pickKeywords(query);
      const groups = [];
      let gid = 0;
      for (const doc of kbCorpus) {
        const scored = doc.paragraphs
          .map((p, idx) => ({ p, idx, score: scoreParagraph(p, kws) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, kind === "paragraph" ? 3 : 2);
        if (!scored.length) continue;
        gid += 1;
        groups.push({
          sourceDoc: {
            id: `kb_doc_smoke_${gid}`,
            libraryId: (Array.isArray(libraryIds) && libraryIds.length ? String(libraryIds[0]) : process.env.SMOKE_STYLE_LIB_ID) || "kb_lib_smoke_style",
            title: path.basename(doc.relPath),
            format: "md",
            importedFrom: { kind: "project", relPath: doc.relPath, entryIndex: 0 },
            contentHash: "smoke",
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
          bestScore: 100 + scored[0].score,
          hits: scored.map((x, i) => {
            const snippet = x.p.length > 160 ? x.p.slice(0, 160) + "…" : x.p;
            kbSnippetsUsed.push(snippet);
            return {
              score: 100 + x.score - i,
              snippet,
              artifact: {
                id: `kb_art_smoke_${gid}_${x.idx}`,
                kind: kind === "paragraph" ? "paragraph" : "card",
                title: kind === "paragraph" ? `段落#${x.idx}` : "写法片段（smoke）",
                cardType: kind === "paragraph" ? undefined : "other",
                facetIds: [],
                anchor: { paragraphIndex: x.idx },
              },
            };
          }),
        });
        if (groups.length >= 4) break;
      }

      if (!groups.length) {
        // 兜底：避免模型因空检索卡死
        const snippet = "（smoke）未命中本地 KB 文件，建议换关键词或扩大检索范围。";
        kbSnippetsUsed.push(snippet);
        groups.push({
          sourceDoc: {
            id: "kb_doc_smoke_empty",
            libraryId: process.env.SMOKE_STYLE_LIB_ID || "kb_lib_smoke_style",
            title: "SMOKE_EMPTY",
            format: "md",
            importedFrom: { kind: "project", relPath: kbFiles[0] || "SMOKE_EMPTY.md", entryIndex: 0 },
            contentHash: "smoke",
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
          bestScore: 1,
          hits: [
            {
              score: 1,
              snippet,
              artifact: { id: "kb_art_smoke_empty", kind: "card", title: "检索兜底", cardType: "other", facetIds: [], anchor: { paragraphIndex: 0 } },
            },
          ],
        });
      }
      return postToolResult({
        toolCallId,
        name,
        ok: true,
        output: { ok: true, query, kind, libraryIds, useVector: false, embeddingModel: null, groups, debug: { smoke: true } },
        meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
      });
    }

    if (name === "write" || name === "edit") {
      const p = String(args0?.path ?? "drafts/smoke-output.md").trim() || "drafts/smoke-output.md";
      const text = typeof args0?.text === "string" ? String(args0.text) : "";
      if (name === "write" && text) lastWritten = { path: p, text };
      return postToolResult({
        toolCallId,
        name,
        ok: true,
        output: { ok: true, path: p },
        meta: { applyPolicy: "auto_apply", riskLevel: "low", hasApply: true },
      });
    }

    // 兜底：其它工具一律返回 ok，避免脚本卡住
    return postToolResult({ toolCallId, name, ok: true, output: { ok: true }, meta: { applyPolicy: "auto_apply", riskLevel: "low", hasApply: false } });
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bumpIdle();
      buffer += new TextDecoder().decode(value);
      const { blocks, rest } = sseParseBlocks(buffer);
      buffer = rest;
      for (const b of blocks) {
        const evt = parseSseEvent(b);
        if (!evt.event) continue;
        bumpIdle();
        if (evt.event === "run.start") {
          runId = String(evt.data?.runId ?? "").trim() || runId;
        }
        if (evt.event === "policy.decision") {
          const p = evt.data;
          if (p && typeof p === "object" && String(p.policy ?? "") === "SkillToolCapsPolicy") {
            const ph = String(p?.detail?.phase ?? "").trim();
            if (ph) phases.push(ph);
          }
        }
        if (evt.event === "run.notice") {
          const title = String(evt.data?.title ?? "").trim();
          if (title) notices.push(title);
        }
        if (evt.event === "assistant.delta") {
          const delta = String(evt.data?.delta ?? "");
          if (delta) assistantTextParts.push(delta);
        }
        if (evt.event === "tool.call") {
          await handleToolCall(evt.data);
        }
        if (evt.event === "tool.result") {
          try {
            const payload = evt.data;
            const name = String(payload?.name ?? "").trim();
            if (name === "lint.style") {
              lintStyleStats.calls += 1;
              const out = payload?.output;
              const edits = Array.isArray(out?.edits) ? out.edits : [];
              if (edits.length) lintStyleStats.hasEdits += 1;
              if (out?.patchFallback?.used) lintStyleStats.patchFallbackUsed += 1;
              const issues = Array.isArray(out?.issues) ? out.issues : [];
              for (const it of issues) {
                if (it?.evidence?.reference && Array.isArray(it.evidence.reference) && it.evidence.reference.length) {
                  lintStyleStats.hasReference += 1;
                  break;
                }
              }
            }
          } catch {
            // ignore
          }
        }
        if (evt.event === "run.end") {
          runEnd = evt.data ?? null;
          // 结束即退出
          buffer = "";
          reader.cancel().catch(() => {});
          break;
        }
      }
    }
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    try {
      reader.cancel();
    } catch {
      // ignore
    }
  }

  const uniq = (arr) => Array.from(new Set(arr));
  const assistantText = assistantTextParts.join("").trim();
  const stripToolXml = (s) =>
    String(s ?? "")
      .replace(/<tool_result[\s\S]*?<\/tool_result>/g, "")
      .replace(/<tool_calls[\s\S]*?<\/tool_calls>/g, "")
      .replace(/<tool_call[\s\S]*?<\/tool_call>/g, "")
      .trim();
  const draftText = stripToolXml(assistantText);
  // 优先用 write 捕获的”真实写入正文”（更接近最终落盘）
  const finalText = lastWritten?.text && String(lastWritten.text).trim().length > 0 ? String(lastWritten.text) : draftText;
  const assistantChars = assistantText.length;
  const draftChars = finalText.length;
  const assistantPreview = assistantText ? assistantText.slice(0, 260) : "";
  const draftPreview = finalText ? finalText.slice(0, 260) : "";
  const copyHits = detectDirectCopies({ draftText: finalText, snippets: kbSnippetsUsed, minLen: 40 });
  const report = {
    ok: true,
    runId: runId || null,
    phases: uniq(phases),
    notices: uniq(notices).slice(0, 8),
    toolCalls: toolCalls.map((x) => `${x.name}${x.executedBy ? `@${x.executedBy}` : ""}`),
    kb: { files: kbFiles, snippetsUsed: kbSnippetsUsed.length, copyHits: copyHits.slice(0, 6) },
    lintStyle: lintStyleStats,
    assistant: {
      chars: assistantChars,
      preview: assistantPreview,
      draftChars,
      draftPreview,
    },
    draftFile: null,
    runEnd,
  };

  // 落盘：把“正文（去掉 tool XML）”写到 outPath，方便人类直接打开看
  try {
    ensureDirForFile(outPath);
    fs.writeFileSync(outPath, finalText ? finalText + "\n" : "", "utf8");
    report.draftFile = outPath;
  } catch (e) {
    report.draftFile = null;
    report.draftFileError = String(e?.message ?? e);
  }

  const need = ["style_need_catalog_pick", "style_need_templates", "style_need_draft"];
  const missing = need.filter((x) => !report.phases.includes(x));
  if (missing.length) {
    report.ok = false;
    report.missingPhases = missing;
  }
  // 至少要看到一段“稿子文本”（否则等于没出稿）
  if (draftChars < 600) {
    report.ok = false;
    report.missingDraftText = true;
  }
  // 如果出现明显“长串原文复用”，直接判定失败（方便 CI/回归）
  if (copyHits.length) {
    report.ok = false;
    report.copyDetected = true;
  }
  console.log("## smoke-style-imitate report");
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(2);
}

main().catch((e) => {
  console.error("smoke-style-imitate failed:", e?.stack || String(e));
  process.exit(1);
});


