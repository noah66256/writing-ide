import { useProjectStore } from "../state/projectStore";
import { useRunStore, type Mode } from "../state/runStore";
import { useKbStore } from "../state/kbStore";
import { buildStyleLinterLibrariesSidecar, executeToolCall, getTool, toolsPrompt } from "./toolRegistry";
import { isToolCallMessage, parseToolCalls, renderToolErrorXml, renderToolResultXml } from "./xmlProtocol";

type GatewayRunController = {
  cancel: () => void;
};

type ChatRole = "system" | "user" | "assistant";
type ChatMessage = { role: ChatRole; content: string };

type SseEvent = {
  event: string;
  data: string;
};

function coerceSseArgValue(v: string): unknown {
  const raw = String(v ?? "");
  const s = raw.trim();
  if (!s) return "";
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.parse(s);
    } catch {
      return raw;
    }
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 32) return Number(s);
  return raw;
}

function parseSseToolArgs(rawArgs: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawArgs ?? {})) out[k] = coerceSseArgValue(v);
  return out;
}

function parseSseBlock(block: string): SseEvent | null {
  // Very small SSE parser: expects lines like "event: xxx" and "data: {...}"
  const lines = block
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean);
  if (!lines.length) return null;

  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (line.startsWith("data:")) data += line.slice("data:".length).trim();
  }
  return { event, data };
}

function buildAgentProtocolPrompt() {
  return (
    `你是写作 IDE 的内置 Agent（偏写作产出与编辑体验，不要跑偏成通用工作流平台）。\n\n` +
    `你可以在需要时“调用工具”。当你要调用工具时，你必须输出 **且只能输出** 下面 XML 之一：\n` +
    `- 单次：<tool_call name="..."><arg name="...">...</arg></tool_call>\n` +
    `- 多次：<tool_calls>...多个 tool_call...</tool_calls>\n\n` +
    `规则：\n` +
    `- 如果你输出 tool_call/tool_calls，则消息里禁止夹杂任何其它自然语言。\n` +
    `- <arg> 内可以放 JSON（不要代码块，不要反引号）。\n` +
    `- 工具结果会由系统用 XML 回传（system message）：<tool_result name="xxx"><![CDATA[{...json}]]></tool_result>\n\n` +
    `编辑器选区约定：\n` +
    `- Context Pack 会提供 EDITOR_SELECTION。\n` +
    `- 如果用户要求“改写/润色我选中的这段”，请优先使用 EDITOR_SELECTION.selectedText；如 hasSelection=false，再提示用户先选中，或用 doc.read 获取全文后让用户指定范围。\n` +
    `- 写回选区请用 doc.replaceSelection。\n\n` +
    `你可用的工具如下（只能调用这里列出的）：\n\n` +
    toolsPrompt()
  );
}

type Ref = { kind: "file" | "dir"; path: string };

function parseRefsFromPrompt(prompt: string): Ref[] {
  const out: Ref[] = [];
  const re = /@\{([^}]+)\}/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(prompt)) !== null) {
    const raw = String(m[1] ?? "").trim();
    if (!raw) continue;
    let p = raw.replaceAll("\\", "/").replace(/^\.\//, "").trim();
    if (!p) continue;
    let kind: Ref["kind"] = p.endsWith("/") ? "dir" : "file";
    if (kind === "dir") p = p.replace(/\/+$/g, "");
    out.push({ kind, path: p });
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = `${r.kind}:${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildReferencesText(prompt: string) {
  const refs = parseRefsFromPrompt(prompt);
  if (!refs.length) return "";
  const proj = useProjectStore.getState();

  const maxTotal = 60_000;
  const maxPerFile = 8_000;
  const maxFilesInDir = 12;
  let used = 0;

  const pushLimited = (s: string, parts: string[]) => {
    if (!s) return;
    if (used >= maxTotal) return;
    const left = maxTotal - used;
    const chunk = s.length > left ? s.slice(0, left) + "\n…(references truncated)\n" : s;
    parts.push(chunk);
    used += chunk.length;
  };

  const parts: string[] = [];
  pushLimited(
    `REFERENCES（来自用户输入中的 @{} 引用；已提供正文，无需再调用 doc.read）：\n`,
    parts,
  );

  for (const ref of refs) {
    if (used >= maxTotal) break;
    const path = ref.path;
    if (!path) continue;

    const looksDir =
      ref.kind === "dir" ||
      (Array.isArray((proj as any).dirs) && (proj as any).dirs.includes(path)) ||
      proj.files.some((f) => f.path.startsWith(`${path}/`));

    if (looksDir) {
      const children = proj.files
        .map((f) => f.path)
        .filter((p) => p.startsWith(`${path}/`))
        .sort((a, b) => a.localeCompare(b));
      const listed = children.slice(0, maxFilesInDir);
      pushLimited(`\n- DIR: ${path}/ (files=${children.length}${children.length > maxFilesInDir ? `, showing=${maxFilesInDir}` : ""})\n`, parts);
      if (!listed.length) {
        pushLimited(`  (no text files)\n`, parts);
        continue;
      }
      for (const fp of listed) {
        if (used >= maxTotal) break;
        let content = "";
        try {
          content = await proj.ensureLoaded(fp);
        } catch {
          content = proj.getFileByPath(fp)?.content ?? "";
        }
        const truncated = content.length > maxPerFile;
        const body = truncated ? content.slice(0, maxPerFile) + "\n…(file truncated)\n" : content;
        pushLimited(`  - FILE: ${fp} (chars=${content.length}${truncated ? ", truncated" : ""})\n`, parts);
        pushLimited(`-----BEGIN ${fp}-----\n${body}\n-----END ${fp}-----\n`, parts);
      }
      continue;
    }

    const file = proj.getFileByPath(path);
    if (!file) {
      pushLimited(`\n- FILE: ${path} (not found)\n`, parts);
      continue;
    }
    let content = "";
    try {
      content = await proj.ensureLoaded(path);
    } catch {
      content = file.content ?? "";
    }
    const truncated = content.length > maxPerFile;
    const body = truncated ? content.slice(0, maxPerFile) + "\n…(file truncated)\n" : content;
    pushLimited(`\n- FILE: ${path} (chars=${content.length}${truncated ? ", truncated" : ""})\n`, parts);
    pushLimited(`-----BEGIN ${path}-----\n${body}\n-----END ${path}-----\n`, parts);
  }

  return parts.join("");
}

async function buildContextPack(extra?: { referencesText?: string }) {
  const mainDoc = useRunStore.getState().mainDoc;
  const todoList = useRunStore.getState().todoList;
  const proj = useProjectStore.getState();
  const docRules = proj.getFileByPath("doc.rules.md")?.content ?? "";
  const kbAttached = useRunStore.getState().kbAttachedLibraryIds ?? [];
  const kbLibraries = useKbStore.getState().libraries ?? [];
  const files = proj.files.map((f) => ({ path: f.path, chars: f.content.length }));
  const state = {
    activePath: proj.activePath,
    openPaths: proj.openPaths,
    files,
  };

  const selection = (() => {
    const ed = proj.editorRef;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !model || !sel) {
      return { ok: false, hasSelection: false, reason: "NO_EDITOR" as const };
    }
    const fullText = model.getValueInRange(sel);
    const maxChars = 4000;
    const truncated = fullText.length > maxChars;
    const selectedText = truncated ? fullText.slice(0, maxChars) : fullText;
    return {
      ok: true,
      hasSelection: fullText.length > 0,
      path: proj.activePath,
      selectedChars: fullText.length,
      truncated,
      range: {
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      },
      selectedText,
    };
  })();

  // 最近对话片段（只注入少量，避免上下文噪音；关键决策仍应写入 Main Doc）
  const recentDialogue = (() => {
    const stripToolXml = (text: string) =>
      String(text ?? "")
        .replace(/<tool_calls[\s\S]*?<\/tool_calls>/g, "")
        .replace(/<tool_call[\s\S]*?<\/tool_call>/g, "")
        .trim();
    const all = useRunStore.getState().steps ?? [];
    const msgs = all
      .filter((s: any) => s && typeof s === "object" && (s.type === "user" || s.type === "assistant"))
      .map((s: any) => ({
        role: s.type === "user" ? "user" : "assistant",
        text: stripToolXml(String(s.text ?? "")).slice(0, 800),
      }))
      .filter((x: any) => String(x.text ?? "").trim());
    // 去掉最后一条 user（通常是“本轮 prompt”，它会单独作为 user message 发送）
    const trimmed = msgs.length && msgs[msgs.length - 1].role === "user" ? msgs.slice(0, -1) : msgs;
    const recent = trimmed.slice(-6);
    return recent.length ? `RECENT_DIALOGUE(JSON):\n${JSON.stringify(recent, null, 2)}\n\n` : "";
  })();

  const refs = extra?.referencesText ? `${extra.referencesText}\n\n` : "";
  const kbText = (() => {
    const ids = Array.isArray(kbAttached) ? kbAttached.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [];
    const map = new Map(
      kbLibraries.map((l: any) => [
        l.id,
        {
          id: l.id,
          name: l.name,
          purpose: l.purpose ?? "material",
          facetPackId: l.facetPackId,
          docCount: l.docCount,
          updatedAt: l.updatedAt,
        },
      ]),
    );
    const selected = ids.map((id: string) => map.get(id) ?? { id, name: id });
    return `KB_SELECTED_LIBRARIES(JSON):\n${JSON.stringify(selected, null, 2)}\n\n` +
      `提示：如需引用知识库内容，请调用工具 kb.search（默认只在已关联库中检索）。\n\n`;
  })();

  const playbookText = await useKbStore.getState().getPlaybookTextForLibraries(
    Array.isArray(kbAttached) ? kbAttached.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [],
  );
  const playbookSection = playbookText
    ? `KB_LIBRARY_PLAYBOOK(Markdown):\n${playbookText}\n\n` +
      `提示：上面已注入库级“仿写手册”（Style Profile + 维度写法）。如需更多原文证据/更多样例，再调用 kb.search。\n\n`
    : "";

  // Pending proposals：用于“proposal-first 不落盘”但仍可继续下一步（避免下一轮说‘没有初稿’）
  const pendingProposals = (() => {
    const steps = useRunStore.getState().steps ?? [];
    const out: Array<{ toolName: string; path?: string; note?: string }> = [];
    for (const st of steps as any[]) {
      if (!st || typeof st !== "object") continue;
      if (st.type !== "tool") continue;
      if (st.status !== "success") continue;
      if (st.applyPolicy !== "proposal") continue;
      if (st.applied === true) continue;
      if (st.status === "undone") continue;
      if (st.toolName === "doc.write") {
        out.push({
          toolName: "doc.write",
          path: typeof st.input?.path === "string" ? st.input.path : typeof st.output?.path === "string" ? st.output.path : undefined,
          note: typeof st.output?.preview?.note === "string" ? st.output.preview.note : undefined,
        });
        continue;
      }
      if (st.toolName === "doc.applyEdits") {
        out.push({
          toolName: "doc.applyEdits",
          path: typeof st.output?.path === "string" ? st.output.path : typeof st.input?.path === "string" ? st.input.path : undefined,
          note: typeof st.output?.preview?.note === "string" ? st.output.preview.note : undefined,
        });
        continue;
      }
      if (st.toolName === "doc.splitToDir") {
        out.push({
          toolName: "doc.splitToDir",
          path: typeof st.output?.targetDir === "string" ? st.output.targetDir : undefined,
          note: typeof st.output?.note === "string" ? st.output.note : undefined,
        });
        continue;
      }
      if (st.toolName === "doc.restoreSnapshot") {
        out.push({
          toolName: "doc.restoreSnapshot",
          path: typeof st.output?.preview?.path === "string" ? st.output.preview.path : undefined,
          note: typeof st.output?.note === "string" ? st.output.note : undefined,
        });
        continue;
      }
    }
    return out.slice(-20);
  })();
  const pendingSection = pendingProposals.length
    ? `PENDING_FILE_PROPOSALS(JSON):\n${JSON.stringify(pendingProposals, null, 2)}\n\n` +
      `提示：存在未 Keep 的“文件提案”。后续若调用 doc.read 读取对应文件，系统会优先返回“提案态最新内容”（不要求先 Keep）。\n\n`
    : "";
  return (
    `MAIN_DOC(JSON):\n${JSON.stringify(mainDoc, null, 2)}\n\n` +
    `RUN_TODO(JSON):\n${JSON.stringify(todoList, null, 2)}\n\n` +
    `DOC_RULES(Markdown):\n${docRules}\n\n` +
    recentDialogue +
    refs +
    kbText +
    playbookSection +
    pendingSection +
    `EDITOR_SELECTION(JSON):\n${JSON.stringify(selection, null, 2)}\n\n` +
    `PROJECT_STATE(JSON):\n${JSON.stringify(state, null, 2)}\n\n` +
    `注意：\n` +
    `- 已提供当前编辑器选区（EDITOR_SELECTION）。若用户说“改写我选中的这段”，优先用该选区。\n` +
    `- 如需文件正文请调用 doc.read；如需刷新选区也可调用 doc.getSelection。\n` +
    `- 本次 Context Pack 仅注入少量最近对话片段（RECENT_DIALOGUE），不是完整历史；关键决策请写入 Main Doc（run.mainDoc.update），历史素材请用 @{} 显式引用。`
  );
}

function buildChatContextPack(extra?: { referencesText?: string }) {
  const proj = useProjectStore.getState();
  const docRules = proj.getFileByPath("doc.rules.md")?.content ?? "";
  const selection = (() => {
    const ed = proj.editorRef;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !model || !sel) {
      return { ok: false, hasSelection: false, reason: "NO_EDITOR" as const };
    }
    const fullText = model.getValueInRange(sel);
    const maxChars = 4000;
    const truncated = fullText.length > maxChars;
    const selectedText = truncated ? fullText.slice(0, maxChars) : fullText;
    return {
      ok: true,
      hasSelection: fullText.length > 0,
      path: proj.activePath,
      selectedChars: fullText.length,
      truncated,
      range: {
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      },
      selectedText,
    };
  })();
  const refs = extra?.referencesText ? `${extra.referencesText}\n\n` : "";
  return `DOC_RULES(Markdown):\n${docRules}\n\n${refs}EDITOR_SELECTION(JSON):\n${JSON.stringify(selection, null, 2)}\n`;
}

async function fetchChatStream(args: {
  gatewayUrl: string;
  model: string;
  messages: ChatMessage[];
  abort: AbortController;
  onDelta: (delta: string) => void;
  log: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
}) {
  const doFetch = async (baseUrl: string) => {
    const url = baseUrl ? `${baseUrl}/api/llm/chat/stream` : "/api/llm/chat/stream";
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
      }),
      signal: args.abort.signal,
    });
  };

  let res: Response | null = null;
  try {
    res = await doFetch(args.gatewayUrl);
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    if (msg.includes("Failed to fetch") && args.gatewayUrl.includes("localhost")) {
      const fallback = args.gatewayUrl.replace("localhost", "127.0.0.1");
      args.log("warn", "gateway.fetch_retry", { from: args.gatewayUrl, to: fallback });
      res = await doFetch(fallback);
    } else {
      throw e;
    }
  }

  args.log("info", "gateway.response", { status: res.status });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    return { ok: false as const, error: text || `HTTP_${res.status}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltaCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const evt = parseSseBlock(block);
      if (!evt) {
        idx = buffer.indexOf("\n\n");
        continue;
      }

      if (evt.event === "assistant.delta") {
        try {
          const payload = JSON.parse(evt.data);
          const delta = payload?.delta;
          if (typeof delta === "string") {
            deltaCount += 1;
            args.onDelta(delta);
          }
        } catch {
          // ignore
        }
      }

      if (evt.event === "assistant.done") {
        return { ok: true as const, deltaCount };
      }

      if (evt.event === "error") {
        try {
          const payload = JSON.parse(evt.data);
          const msg = payload?.error ? String(payload.error) : "unknown";
          return { ok: false as const, error: msg };
        } catch {
          return { ok: false as const, error: String(evt.data) };
        }
      }

      idx = buffer.indexOf("\n\n");
    }
  }

  return { ok: true as const, deltaCount, endedWithoutDone: true as const };
}

export function startGatewayRun(args: {
  gatewayUrl: string;
  mode: Mode;
  model: string;
  prompt: string;
}): GatewayRunController {
  const {
    setRunning,
    setActivity,
    addAssistant,
    appendAssistantDelta,
    finishAssistant,
    patchAssistant,
    addTool,
    patchTool,
    updateMainDoc,
    log
  } = useRunStore.getState();

  setRunning(true);
  setActivity("正在构建上下文…", { resetTimer: true });
  // 不要每轮覆盖 goal：只在为空时初始化（后续由 run.mainDoc.update 维护主线）
  // 关键：不要把整段长原文/长 prompt 塞进 Main Doc（会每轮注入 Context Pack，导致仿写手册/约束被淹没，输出变差）
  const cur = useRunStore.getState().mainDoc;
  if (!cur.goal) {
    const raw = String(args.prompt ?? "").trim();
    const oneLine = raw.replace(/\s+/g, " ");
    const max = 180;
    const short = oneLine.length > max ? oneLine.slice(0, max) + "…（已截断；原始输入见置顶回合/历史）" : oneLine;
    updateMainDoc({ goal: short });
  }

  // 用户偏好：lint 不过就保留最高分（写入 Main Doc，跨本轮对话生效）
  const wantsKeepBestOnLintFail =
    /(lint|linter|风格(对齐|校验|检查)).{0,30}(不过|不通过).{0,30}(保留|留下|用).{0,30}(最高分|最好|最佳)/i.test(
      String(args.prompt ?? ""),
    );
  if (wantsKeepBestOnLintFail) updateMainDoc({ styleLintFailPolicy: "keep_best" });

  const abort = new AbortController();
  let currentAssistantId: string | null = null;

  (async () => {
    log("info", "gateway.run.start", { gatewayUrl: args.gatewayUrl, model: args.model, mode: args.mode });
    try {
      const referencesText = await buildReferencesText(args.prompt).catch(() => "");
      setActivity("正在构建上下文…");
      // 尽量确保 doc.rules 与 activePath 已加载，避免“上下文不对”（空规则/空正文）
      const proj = useProjectStore.getState();
      const docRulesPath = proj.getFileByPath("doc.rules.md")?.path;
      if (docRulesPath) {
        await proj.ensureLoaded(docRulesPath).catch(() => void 0);
      }
      if (proj.activePath) {
        await proj.ensureLoaded(proj.activePath).catch(() => void 0);
      }

      // 关键：确保 KB 库列表（含 purpose=style 等元信息）已刷新，否则 Context Pack 里可能注入不到风格库用途，导致 Gateway 不开启“风格库强闭环闸门”
      const kb = useKbStore.getState();
      const attached = useRunStore.getState().kbAttachedLibraryIds ?? [];
      if (Array.isArray(attached) && attached.length) {
        await kb.refreshLibraries().catch(() => void 0);
      }

      // 记录 Context Pack 摘要（便于排查“上下文不对/自动终止”）
      try {
        const todo = useRunStore.getState().todoList ?? [];
        const done = todo.filter((t) => t.status === "done").length;
        const refs = parseRefsFromPrompt(args.prompt);
        const kbLibCount = (useKbStore.getState().libraries ?? []).length;
        const pendingProposals = (() => {
          const steps = useRunStore.getState().steps ?? [];
          const out: Array<{ toolName: string; path?: string }> = [];
          for (const st of steps as any[]) {
            if (!st || typeof st !== "object") continue;
            if (st.type !== "tool") continue;
            if (st.status !== "success") continue;
            if (st.applyPolicy !== "proposal") continue;
            if (st.applied === true) continue;
            if (st.status === "undone") continue;
            if (st.toolName === "doc.write") {
              out.push({
                toolName: "doc.write",
                path: typeof st.input?.path === "string" ? st.input.path : typeof st.output?.path === "string" ? st.output.path : undefined,
              });
              continue;
            }
            if (st.toolName === "doc.applyEdits") {
              out.push({
                toolName: "doc.applyEdits",
                path: typeof st.output?.path === "string" ? st.output.path : typeof st.input?.path === "string" ? st.input.path : undefined,
              });
              continue;
            }
            if (st.toolName === "doc.splitToDir") {
              out.push({
                toolName: "doc.splitToDir",
                path: typeof st.output?.targetDir === "string" ? st.output.targetDir : undefined,
              });
              continue;
            }
            if (st.toolName === "doc.restoreSnapshot") {
              out.push({
                toolName: "doc.restoreSnapshot",
                path: typeof st.output?.preview?.path === "string" ? st.output.preview.path : undefined,
              });
              continue;
            }
          }
          return out.slice(-20);
        })();
        const ed = proj.editorRef;
        const hasSelection = (() => {
          const model = ed?.getModel();
          const sel = ed?.getSelection();
          if (!ed || !model || !sel) return false;
          return model.getValueInRange(sel).length > 0;
        })();
        const docRulesChars = proj.getFileByPath("doc.rules.md")?.content?.length ?? 0;
        log("info", "context.pack.summary", {
          mode: args.mode,
          model: args.model,
          activePath: proj.activePath,
          openPaths: proj.openPaths?.length ?? 0,
          fileCount: proj.files?.length ?? 0,
          docRulesChars,
          refs: refs.map((r) => ({ kind: r.kind, path: r.path })),
          todo: { done, total: todo.length },
          pendingProposals: { total: pendingProposals.length, tail: pendingProposals.slice(-6) },
          hasSelection,
        });
      } catch {
        // ignore
      }

      // Chat：纯对话，不启用工具循环
      if (args.mode === "chat") {
        setActivity("正在请求模型…", { resetTimer: true });
        const assistantId = addAssistant("", true, false);
        currentAssistantId = assistantId;
        const ret = await fetchChatStream({
          gatewayUrl: args.gatewayUrl,
          model: args.model,
          messages: [
            { role: "system", content: buildChatContextPack({ referencesText }) },
            { role: "user", content: args.prompt },
          ],
          abort,
          onDelta: (d) => appendAssistantDelta(assistantId, d),
          log,
        });
        if (!ret.ok) appendAssistantDelta(assistantId, `\n\n[模型错误] ${ret.error}`);
        finishAssistant(assistantId);
        setRunning(false);
        setActivity(null);
        return;
      }

      // Plan/Agent：改为走 Gateway 的 /api/agent/run/stream（Gateway 负责 ReAct 循环；Desktop 负责执行工具并回传 tool_result）
      const url = args.gatewayUrl ? `${args.gatewayUrl}/api/agent/run/stream` : "/api/agent/run/stream";

      setActivity("正在请求模型…", { resetTimer: true });
      // toolSidecar：用于“工具逐步迁回 Gateway”时携带必要的本地只读上下文（不注入模型 messages，避免 token 爆炸）
      const toolSidecar = await (async () => {
        const proj = useProjectStore.getState();
        const projectFiles = (proj.files ?? [])
          .map((f: any) => ({ path: String(f?.path ?? "").trim() }))
          .filter((f: any) => f.path)
          .slice(0, 5000);
        const docRulesFile = proj.getFileByPath("doc.rules.md");
        const docRules = docRulesFile ? { path: docRulesFile.path, content: docRulesFile.content ?? "" } : null;

        const attached = useRunStore.getState().kbAttachedLibraryIds ?? [];
        let styleLinterLibraries: any[] | undefined = undefined;
        if (Array.isArray(attached) && attached.length) {
          // 仅携带风格库的 lint 所需 payload（stats/ngrams/samples）；非风格库不带
          const ret = await buildStyleLinterLibrariesSidecar({ maxLibraries: 6 }).catch(() => ({ ok: false } as any));
          if (ret?.ok && Array.isArray(ret.libraries) && ret.libraries.length) styleLinterLibraries = ret.libraries;
        }

        const out: any = { projectFiles, docRules };
        if (styleLinterLibraries) out.styleLinterLibraries = styleLinterLibraries;
        return out;
      })();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: args.model,
          mode: args.mode,
          prompt: args.prompt,
          contextPack: await buildContextPack({ referencesText }),
          toolSidecar,
        }),
        signal: abort.signal,
      });

      log("info", "gateway.agent.response", { status: res.status });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const a = addAssistant("", false, false);
        patchAssistant(a, { hidden: false });
        appendAssistantDelta(a, `\n\n[Gateway 错误] ${text || `HTTP_${res.status}`}`);
        finishAssistant(a);
        setRunning(false);
        setActivity(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let runId: string | null = null;
      let assistantId: string | null = null;

      const ensureAssistant = () => {
        if (assistantId) return assistantId;
        assistantId = addAssistant("", true, false);
        currentAssistantId = assistantId;
        return assistantId;
      };

      const postToolResult = async (payload: any) => {
        if (!runId) return;
        const postUrl = args.gatewayUrl
          ? `${args.gatewayUrl}/api/agent/run/${runId}/tool_result`
          : `/api/agent/run/${runId}/tool_result`;
        await fetch(postUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: abort.signal,
        });
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const evt = parseSseBlock(block);
          if (!evt) {
            idx = buffer.indexOf("\n\n");
            continue;
          }

          if (evt.event === "run.start") {
            try {
              const payload = JSON.parse(evt.data);
              runId = payload?.runId ? String(payload.runId) : runId;
              log("info", "agent.run.start", payload);
            } catch {
              log("info", "agent.run.start", evt.data);
            }
          }

          if (evt.event === "run.end") {
            log("info", "agent.run.end", evt.data);
          }

          if (evt.event === "policy.decision") {
            try {
              const payload = JSON.parse(evt.data);
              log("info", "policy.decision", payload);
            } catch {
              log("info", "policy.decision", evt.data);
            }
          }

          if (evt.event === "assistant.start") {
            // SSE 强边界：Gateway 会在每次模型调用前发 assistant.start(turn)
            // - 用于强制切分“回合边界”，避免下一轮 delta 追加到上一条 assistant 气泡
            // - 兼容旧实现：如果 Gateway 不发 assistant.start，本地仍会在首个 delta 时创建气泡
            try {
              const payload = JSON.parse(evt.data);
              log("info", "assistant.start", payload);
            } catch {
              log("info", "assistant.start", evt.data);
            }
            if (assistantId) finishAssistant(assistantId);
            assistantId = null;
            if (useRunStore.getState().isRunning) setActivity("正在生成…");
          }

          if (evt.event === "assistant.delta") {
            try {
              const payload = JSON.parse(evt.data);
              const delta = payload?.delta;
              if (typeof delta === "string" && delta.length) {
                // 一旦开始输出正文，更新状态（避免用户以为卡住）
                setActivity("正在生成…");
                const id = ensureAssistant();
                appendAssistantDelta(id, delta);
              }
            } catch {
              // ignore
            }
          }

          if (evt.event === "assistant.done") {
            if (assistantId) finishAssistant(assistantId);
            assistantId = null;
            // 一个 assistant 气泡结束后，先标记“继续运行中”，直到 run.end 或下一个 tool.call
            if (useRunStore.getState().isRunning) setActivity("正在继续…");
          }

          if (evt.event === "tool.call") {
            let payload: any = null;
            try {
              payload = JSON.parse(evt.data);
            } catch {
              payload = null;
            }
            const toolCallId = String(payload?.toolCallId ?? "");
            const name = String(payload?.name ?? "");
            const rawArgs = (payload?.args ?? {}) as Record<string, string>;
            const executedBy = String(payload?.executedBy ?? "desktop");

            log("info", "tool.call", { toolCallId, name });
            setActivity(executedBy === "gateway" ? `正在等待 Gateway 执行工具：${name}…` : `正在执行工具：${name}…`, { resetTimer: true });

            // 兼容：旧实现里 Gateway 可能不会在每次模型调用结束都发 assistant.done（现在 tool_calls 分支也会发）。
            // 如果此时不手动结束当前 assistant 气泡，后续新的 assistant.delta 会继续追加到“上面那条气泡”，
            // 造成视觉上“工具卡片插入后，内容在中间继续生成/自动滚动失效”。
            if (assistantId) {
              finishAssistant(assistantId);
              assistantId = null;
            }

            // Gateway 执行：Desktop 只创建占位 ToolBlock（running），等待 tool.result 回填，不执行本地工具也不回传 tool_result。
            if (executedBy === "gateway") {
              const def = getTool(name);
              const parsedArgs = parseSseToolArgs(rawArgs);
              addTool({
                id: toolCallId || undefined,
                toolName: name,
                status: "running",
                input: parsedArgs,
                output: null,
                riskLevel: def?.riskLevel ?? "high",
                applyPolicy: def?.applyPolicy ?? "proposal",
                undoable: false,
                kept: false,
                applied: false,
              });
              continue;
            }

            const exec = await executeToolCall({ toolName: name, rawArgs, mode: args.mode });
            const def = exec.def;
            const stepApplyPolicy =
              exec.result.ok ? exec.result.applyPolicy ?? def?.applyPolicy ?? "proposal" : def?.applyPolicy ?? "proposal";
            const stepRiskLevel =
              exec.result.ok ? exec.result.riskLevel ?? def?.riskLevel ?? "high" : def?.riskLevel ?? "high";
            const initialKept = stepApplyPolicy === "auto_apply";

            // 用 toolCallId 作为 stepId，便于后续 tool.result 对齐（即使未来有 server-side tool）
            const stepId = addTool({
              id: toolCallId || undefined,
              toolName: name,
              status: exec.result.ok ? "success" : "failed",
              input: exec.parsedArgs,
              output: exec.result.ok ? exec.result.output : { ok: false, error: exec.result.error },
              riskLevel: stepRiskLevel,
              applyPolicy: stepApplyPolicy,
              undoable: exec.result.ok ? exec.result.undoable : false,
              undo: exec.result.ok ? exec.result.undo : undefined,
              apply: exec.result.ok ? exec.result.apply : undefined,
              kept: initialKept,
              applied: stepApplyPolicy === "auto_apply",
            });
            void stepId;

            await postToolResult({
              toolCallId,
              name,
              ok: exec.result.ok,
              output: exec.result.ok ? exec.result.output : { ok: false, error: exec.result.error },
              meta: {
                applyPolicy: stepApplyPolicy,
                riskLevel: stepRiskLevel,
                hasApply: exec.result.ok ? typeof exec.result.apply === "function" : false,
              },
            });
            if (useRunStore.getState().isRunning) setActivity("正在等待模型继续…", { resetTimer: true });
          }

          if (evt.event === "tool.result") {
            // server-side tool：tool.call 只占位（running），tool.result 在这里回填
            try {
              const payload = JSON.parse(evt.data);
              const toolCallId = String(payload?.toolCallId ?? "");
              const ok0 = Boolean(payload?.ok);
              const out = payload?.output;
              const meta = payload?.meta ?? null;
              if (toolCallId) {
                const st = (useRunStore.getState().steps ?? []).find((s: any) => s && s.type === "tool" && s.id === toolCallId);
                if (st && st.type === "tool" && st.status === "running") {
                  patchTool(toolCallId, {
                    status: ok0 ? "success" : "failed",
                    output: out,
                    ...(meta && typeof meta === "object"
                      ? {
                          applyPolicy: (meta as any).applyPolicy ?? st.applyPolicy,
                          riskLevel: (meta as any).riskLevel ?? st.riskLevel,
                        }
                      : {}),
                  });
                  if (useRunStore.getState().isRunning) setActivity("正在等待模型继续…", { resetTimer: true });
                }
              }
              log("info", "tool.result", payload);
            } catch {
              log("info", "tool.result", evt.data);
            }
          }

          if (evt.event === "error") {
            try {
              const payload = JSON.parse(evt.data);
              const msg = payload?.error ? String(payload.error) : "unknown";
              const id = ensureAssistant();
              patchAssistant(id, { hidden: false });
              appendAssistantDelta(id, `\n\n[模型错误] ${msg}`);
              finishAssistant(id);
            } catch {
              const id = ensureAssistant();
              patchAssistant(id, { hidden: false });
              appendAssistantDelta(id, `\n\n[模型错误] ${evt.data}`);
              finishAssistant(id);
            }
            setRunning(false);
            setActivity(null);
            return;
          }

          idx = buffer.indexOf("\n\n");
        }
      }

      setRunning(false);
      setActivity(null);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      // 用户点击“停止/取消”会触发 AbortController.abort；这不应显示为“网络错误”
      const aborted =
        abort.signal.aborted ||
        String(e?.name ?? "") === "AbortError" ||
        /BodyStreamBuffer was aborted/i.test(msg) ||
        /\baborted\b/i.test(msg);
      if (aborted) {
        log("info", "gateway.run.aborted", { message: msg });
        setRunning(false);
        setActivity(null);
        if (currentAssistantId) {
          finishAssistant(currentAssistantId);
          currentAssistantId = null;
        }
        return;
      }

      log("error", "gateway.network_error", { message: msg });
      const a = currentAssistantId ?? addAssistant("", false, false);
      patchAssistant(a, { hidden: false });
      appendAssistantDelta(a, `\n\n[网络错误] ${msg}`);
      finishAssistant(a);
      setRunning(false);
      setActivity(null);
    }
  })();

  return {
    cancel: () => {
      log("warn", "gateway.run.cancel");
      abort.abort();
      setRunning(false);
      setActivity(null);
      if (currentAssistantId) {
        finishAssistant(currentAssistantId);
        currentAssistantId = null;
      }
    }
  };
}


