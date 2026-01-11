import { useProjectStore } from "../state/projectStore";
import { useRunStore, type Mode } from "../state/runStore";
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

function buildContextPack() {
  const mainDoc = useRunStore.getState().mainDoc;
  const proj = useProjectStore.getState();
  const docRules = proj.getFileByPath("doc.rules.md")?.content ?? "";
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

  return (
    `MAIN_DOC(JSON):\n${JSON.stringify(mainDoc, null, 2)}\n\n` +
    `DOC_RULES(Markdown):\n${docRules}\n\n` +
    `EDITOR_SELECTION(JSON):\n${JSON.stringify(selection, null, 2)}\n\n` +
    `PROJECT_STATE(JSON):\n${JSON.stringify(state, null, 2)}\n\n` +
    `注意：\n` +
    `- 已提供当前编辑器选区（EDITOR_SELECTION）。若用户说“改写我选中的这段”，优先用该选区。\n` +
    `- 如需文件正文请调用 doc.read；如需刷新选区也可调用 doc.getSelection。`
  );
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
    resetRun,
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

  resetRun();
  setRunning(true);
  updateMainDoc({ goal: args.prompt });

  const abort = new AbortController();
  let currentAssistantId: string | null = null;

  (async () => {
    log("info", "gateway.run.start", { gatewayUrl: args.gatewayUrl, model: args.model, mode: args.mode });
    try {
      // Chat：纯对话，不启用工具循环
      if (args.mode === "chat") {
        const assistantId = addAssistant("", true, false);
        currentAssistantId = assistantId;
        const ret = await fetchChatStream({
          gatewayUrl: args.gatewayUrl,
          model: args.model,
          messages: [{ role: "user", content: args.prompt }],
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
          contextPack: buildContextPack(),
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


