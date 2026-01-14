import { generateTopicLab } from "./topicLab";
import { useRunStore } from "../state/runStore";

export type MockRunController = {
  cancel: () => void;
};

export function startMockRun(prompt: string): MockRunController {
  const {
    resetRun,
    setRunning,
    addAssistant,
    appendAssistantDelta,
    finishAssistant,
    addTool,
    patchTool,
    updateMainDoc,
  } = useRunStore.getState();

  resetRun();
  setRunning(true);
  updateMainDoc({ goal: prompt });

  const mode = useRunStore.getState().mode;
  const assistantId = addAssistant("", true);

  const timers: Array<{ kind: "timeout" | "interval"; id: number }> = [];

  const say = (text: string, done: () => void) => {
    let i = 0;
    const id = window.setInterval(() => {
      const ch = text[i];
      if (!ch) {
        window.clearInterval(id);
        done();
        return;
      }
      appendAssistantDelta(assistantId, ch);
      i += 1;
    }, 12);
    timers.push({ kind: "interval", id });
  };

  const cancel = () => {
    for (const t of timers) {
      if (t.kind === "interval") window.clearInterval(t.id);
      else window.clearTimeout(t.id);
    }
    finishAssistant(assistantId);
    setRunning(false);
  };

  // Chat 模式：不调用工具、不产生写入
  if (mode === "chat") {
    say(
      "当前是 Chat 模式：我可以和你讨论、总结、头脑风暴，但不会调用写入类工具，也不会改动文件。\n\n你可以把目标说清楚（受众/平台画像/风格/素材来源），我会给你一份可复制的文本建议。",
      () => {
        finishAssistant(assistantId);
        setRunning(false);
      },
    );
    return { cancel };
  }

  const intro =
    mode === "plan"
      ? "收到。我先给你一份最小 Todo（你可以随时打断）：\n- 定平台画像/受众/目的\n- 生成选题+标题池\n- 你选一个写进 Main Doc\n- 新建草稿并给出结构\n\n下面先生成选题/标题池…"
      : "收到。我会直接生成选题/标题池，你选一个作为主线（写进 Main Doc），并自动创建草稿文件（可 Undo）。";

  say(intro, () => {
    finishAssistant(assistantId);

    // tool: topic.generate
    const toolId = addTool({
      toolName: "topic.generate",
      status: "running",
      input: { seed: prompt, platformType: "feed_preview", useKb: true, useWebSearch: false },
      output: undefined,
      applyPolicy: "proposal",
      riskLevel: "low",
      undoable: false,
    });

    const t = window.setTimeout(() => {
      const output = generateTopicLab({
        seed: prompt,
        platformType: "feed_preview",
        useKb: true,
        useWebSearch: false,
      });
      patchTool(toolId, { status: "success", output });
      setRunning(false);
    }, 450);
    timers.push({ kind: "timeout", id: t });
  });

  return { cancel };
}




