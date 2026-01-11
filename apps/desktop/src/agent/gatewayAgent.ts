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

      // Plan/Agent：ReAct（LLM 产出 tool_calls XML → 本地执行工具 → tool_result 回注 → 继续）
      const baseSystem: ChatMessage[] = [{ role: "system", content: buildAgentProtocolPrompt() }];
      const history: ChatMessage[] = [{ role: "user", content: args.prompt }];
      const maxTurns = 12;

      for (let turn = 0; turn < maxTurns; turn += 1) {
        if (abort.signal.aborted) break;
        log("info", "agent.turn.start", { turn });

        const messages: ChatMessage[] = [...baseSystem, { role: "system", content: buildContextPack() }, ...history];

        // 先隐藏 assistant（如果最终是 tool_calls，就不把 XML 展示给用户）
        const assistantId = addAssistant("", true, true);
        currentAssistantId = assistantId;

        let assistantText = "";
        let flushed = 0;
        let decided: "unknown" | "tool" | "text" = "unknown";

        const ret = await fetchChatStream({
          gatewayUrl: args.gatewayUrl,
          model: args.model,
          messages,
          abort,
          onDelta: (d) => {
            assistantText += d;

            if (decided === "unknown") {
              const t = assistantText.trimStart();
              if (t.startsWith("<tool_calls") || t.startsWith("<tool_call")) {
                decided = "tool";
              } else if (t.length > 0 && !t.startsWith("<")) {
                decided = "text";
                patchAssistant(assistantId, { hidden: false });
              } else if (t.length > 96 && t.startsWith("<") && !t.startsWith("<tool_calls") && !t.startsWith("<tool_call")) {
                // 防止模型把正常文本包成奇怪 XML，这里兜底当作文本展示
                decided = "text";
                patchAssistant(assistantId, { hidden: false });
              }
            }

            if (decided === "text") {
              const next = assistantText.slice(flushed);
              flushed = assistantText.length;
              if (next) appendAssistantDelta(assistantId, next);
            }
          },
          log,
        });

        if (!ret.ok) {
          patchAssistant(assistantId, { hidden: false });
          appendAssistantDelta(assistantId, `\n\n[模型错误] ${ret.error}`);
          finishAssistant(assistantId);
          setRunning(false);
          return;
        }

        // flush 尾巴
        if (decided === "text") {
          const next = assistantText.slice(flushed);
          if (next) appendAssistantDelta(assistantId, next);
        }

        finishAssistant(assistantId);
        history.push({ role: "assistant", content: assistantText });

        const toolCalls = parseToolCalls(assistantText);
        if (!toolCalls) {
          // 如果看起来像 tool_calls 但解析失败，直接把原文展示出来并结束，方便调试
          if (isToolCallMessage(assistantText)) {
            patchAssistant(assistantId, { hidden: false, text: assistantText });
            appendAssistantDelta(
              assistantId,
              "\n\n[解析提示] 该条看起来像工具调用，但 XML 解析失败；请让模型严格输出 <tool_calls>...</tool_calls>。",
            );
          } else {
            patchAssistant(assistantId, { hidden: false, text: assistantText });
          }
          setRunning(false);
          return;
        }

        // tool_calls：隐藏这条 assistant
        patchAssistant(assistantId, { hidden: true });
        log("info", "agent.tool_calls", { count: toolCalls.length });

        for (const call of toolCalls) {
          if (abort.signal.aborted) break;

          const exec = await executeToolCall({ toolName: call.name, rawArgs: call.args, mode: args.mode });
          const def = exec.def;
          const toolStepId = addTool({
            toolName: call.name,
            status: "running",
            input: exec.parsedArgs,
            output: undefined,
            riskLevel: def?.riskLevel ?? "high",
            applyPolicy: def?.applyPolicy ?? "proposal",
            undoable: false,
            kept: true,
            applied: def?.applyPolicy === "auto_apply",
          });

          if (exec.result.ok) {
            patchTool(toolStepId, {
              status: "success",
              output: exec.result.output,
              undoable: exec.result.undoable,
              undo: exec.result.undo,
              kept: true,
              applied: def?.applyPolicy === "auto_apply",
            });
            history.push({ role: "system", content: renderToolResultXml(call.name, exec.result.output) });
          } else {
            patchTool(toolStepId, {
              status: "failed",
              output: { ok: false, error: exec.result.error },
              undoable: false,
              kept: false,
              applied: false,
            });
            history.push({ role: "system", content: renderToolErrorXml(call.name, exec.result.error) });
          }
        }
      }

      // 被 Stop/Cancel 打断：不额外提示（避免误报“死循环”）
      if (abort.signal.aborted) {
        setRunning(false);
        return;
      }

      // 超出最大轮数（防止死循环）
      const warnId = addAssistant("", false, false);
      patchAssistant(warnId, {
        text: "\n\n[提示] 已达到本次 Run 的最大工具循环轮数（maxTurns），为避免死循环已自动停止。你可以补充指令或更具体的目标再试一次。",
      });
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


