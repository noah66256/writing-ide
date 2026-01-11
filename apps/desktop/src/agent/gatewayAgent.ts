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
    updateMainDoc
  } = useRunStore.getState();

  resetRun();
  setRunning(true);
  updateMainDoc({ goal: args.prompt });

  const assistantId = addAssistant("", true);

  const abort = new AbortController();

  (async () => {
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

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
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
              if (typeof delta === "string") appendAssistantDelta(assistantId, delta);
            } catch {
              // ignore
            }
          }

          if (evt.event === "assistant.done") {
            finishAssistant(assistantId);
            setRunning(false);
          }

          if (evt.event === "error") {
            try {
              const payload = JSON.parse(evt.data);
              const msg = payload?.error ? String(payload.error) : "unknown";
              appendAssistantDelta(assistantId, `\n\n[模型错误] ${msg}`);
            } catch {
              appendAssistantDelta(assistantId, `\n\n[模型错误] ${evt.data}`);
            }
            finishAssistant(assistantId);
            setRunning(false);
          }

          idx = buffer.indexOf("\n\n");
        }
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      appendAssistantDelta(assistantId, `\n\n[网络错误] ${msg}`);
      finishAssistant(assistantId);
      setRunning(false);
    }
  })();

  return {
    cancel: () => {
      abort.abort();
      finishAssistant(assistantId);
      setRunning(false);
    }
  };
}


