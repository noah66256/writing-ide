import { useRunStore, type Mode } from "../state/runStore";

type GatewayRunController = {
  cancel: () => void;
};

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
    updateMainDoc,
    log
  } = useRunStore.getState();

  resetRun();
  setRunning(true);
  updateMainDoc({ goal: args.prompt });

  const assistantId = addAssistant("", true);

  const abort = new AbortController();

  (async () => {
    log("info", "gateway.run.start", { gatewayUrl: args.gatewayUrl, model: args.model, mode: args.mode });
    try {
      const res = await fetch(`${args.gatewayUrl}/api/llm/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: args.model,
          messages: [{ role: "user", content: args.prompt }]
        }),
        signal: abort.signal
      });

      log("info", "gateway.response", { status: res.status });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        log("error", "gateway.bad_response", { status: res.status, text });
        appendAssistantDelta(
          assistantId,
          `\n\n[Gateway 错误] ${text || `HTTP_${res.status}`}`,
        );
        finishAssistant(assistantId);
        setRunning(false);
        return;
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

          if (evt.event === "run.start") {
            try {
              log("info", "sse.run.start", JSON.parse(evt.data));
            } catch {
              log("info", "sse.run.start", evt.data);
            }
          }

          if (evt.event === "assistant.delta") {
            try {
              const payload = JSON.parse(evt.data);
              const delta = payload?.delta;
              if (typeof delta === "string") {
                deltaCount += 1;
                appendAssistantDelta(assistantId, delta);
              }
            } catch {
              // ignore
            }
          }

          if (evt.event === "assistant.done") {
            log("info", "sse.assistant.done", { deltaCount });
            finishAssistant(assistantId);
            setRunning(false);
          }

          if (evt.event === "error") {
            try {
              const payload = JSON.parse(evt.data);
              const msg = payload?.error ? String(payload.error) : "unknown";
              log("error", "sse.error", payload);
              appendAssistantDelta(assistantId, `\n\n[模型错误] ${msg}`);
            } catch {
              log("error", "sse.error", evt.data);
              appendAssistantDelta(assistantId, `\n\n[模型错误] ${evt.data}`);
            }
            finishAssistant(assistantId);
            setRunning(false);
          }

          idx = buffer.indexOf("\n\n");
        }
      }

      // 流结束但没收到 done/error：也要收尾，否则 UI 一直 running
      if (useRunStore.getState().isRunning) {
        log("warn", "sse.ended_without_done", { deltaCount });
        finishAssistant(assistantId);
        setRunning(false);
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      log("error", "gateway.network_error", { message: msg });
      appendAssistantDelta(assistantId, `\n\n[网络错误] ${msg}`);
      finishAssistant(assistantId);
      setRunning(false);
    }
  })();

  return {
    cancel: () => {
      log("warn", "gateway.run.cancel");
      abort.abort();
      finishAssistant(assistantId);
      setRunning(false);
    }
  };
}


