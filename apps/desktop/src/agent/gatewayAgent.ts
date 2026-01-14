import { useProjectStore } from "../state/projectStore";
import { useRunStore, type Mode } from "../state/runStore";
import { useKbStore } from "../state/kbStore";
import { executeToolCall, toolsPrompt } from "./toolRegistry";
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

  const refs = extra?.referencesText ? `${extra.referencesText}\n\n` : "";
  const kbText = (() => {
    const ids = Array.isArray(kbAttached) ? kbAttached.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [];
    const map = new Map(kbLibraries.map((l: any) => [l.id, { id: l.id, name: l.name, docCount: l.docCount, updatedAt: l.updatedAt }]));
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
  return (
    `MAIN_DOC(JSON):\n${JSON.stringify(mainDoc, null, 2)}\n\n` +
    `RUN_TODO(JSON):\n${JSON.stringify(todoList, null, 2)}\n\n` +
    `DOC_RULES(Markdown):\n${docRules}\n\n` +
    refs +
    kbText +
    playbookSection +
    `EDITOR_SELECTION(JSON):\n${JSON.stringify(selection, null, 2)}\n\n` +
    `PROJECT_STATE(JSON):\n${JSON.stringify(state, null, 2)}\n\n` +
    `注意：\n` +
    `- 已提供当前编辑器选区（EDITOR_SELECTION）。若用户说“改写我选中的这段”，优先用该选区。\n` +
    `- 如需文件正文请调用 doc.read；如需刷新选区也可调用 doc.getSelection。\n` +
    `- 本次 Context Pack 不包含完整历史对话；关键决策请写入 Main Doc（run.mainDoc.update），历史素材请用 @{} 显式引用。`
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

  const abort = new AbortController();
  let currentAssistantId: string | null = null;

  (async () => {
    log("info", "gateway.run.start", { gatewayUrl: args.gatewayUrl, model: args.model, mode: args.mode });
    try {
      const referencesText = await buildReferencesText(args.prompt).catch(() => "");
      // 尽量确保 doc.rules 与 activePath 已加载，避免“上下文不对”（空规则/空正文）
      const proj = useProjectStore.getState();
      const docRulesPath = proj.getFileByPath("doc.rules.md")?.path;
      if (docRulesPath) {
        await proj.ensureLoaded(docRulesPath).catch(() => void 0);
      }
      if (proj.activePath) {
        await proj.ensureLoaded(proj.activePath).catch(() => void 0);
      }

      // 记录 Context Pack 摘要（便于排查“上下文不对/自动终止”）
      try {
        const todo = useRunStore.getState().todoList ?? [];
        const done = todo.filter((t) => t.status === "done").length;
        const refs = parseRefsFromPrompt(args.prompt);
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
          hasSelection,
        });
      } catch {
        // ignore
      }

      // Chat：纯对话，不启用工具循环
      if (args.mode === "chat") {
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
        return;
      }

      // Plan/Agent：改为走 Gateway 的 /api/agent/run/stream（Gateway 负责 ReAct 循环；Desktop 负责执行工具并回传 tool_result）
      const url = args.gatewayUrl ? `${args.gatewayUrl}/api/agent/run/stream` : "/api/agent/run/stream";

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: args.model,
          mode: args.mode,
          prompt: args.prompt,
          contextPack: await buildContextPack({ referencesText }),
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

          if (evt.event === "assistant.delta") {
            try {
              const payload = JSON.parse(evt.data);
              const delta = payload?.delta;
              if (typeof delta === "string" && delta.length) {
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

            log("info", "tool.call", { toolCallId, name });

            // 关键：Gateway 侧不会在每次模型调用结束都发 assistant.done。
            // 如果此时不手动结束当前 assistant 气泡，后续新的 assistant.delta 会继续追加到“上面那条气泡”，
            // 造成视觉上“工具卡片插入后，内容在中间继续生成/自动滚动失效”。
            if (assistantId) {
              finishAssistant(assistantId);
              assistantId = null;
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
          }

          if (evt.event === "tool.result") {
            // 预留：未来支持 server-side tool 时，可在这里 patchTool(toolCallId,...)
            // 当前 client-side 工具已经本地更新 ToolBlock，这里只打日志即可。
            log("info", "tool.result", evt.data);
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
            return;
          }

          idx = buffer.indexOf("\n\n");
        }
      }

      setRunning(false);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      log("error", "gateway.network_error", { message: msg });
      const a = currentAssistantId ?? addAssistant("", false, false);
      patchAssistant(a, { hidden: false });
      appendAssistantDelta(a, `\n\n[网络错误] ${msg}`);
      finishAssistant(a);
      setRunning(false);
    }
  })();

  return {
    cancel: () => {
      log("warn", "gateway.run.cancel");
      abort.abort();
      setRunning(false);
      if (currentAssistantId) finishAssistant(currentAssistantId);
    }
  };
}


