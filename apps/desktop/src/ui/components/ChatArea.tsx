import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Copy,
  Bot,
} from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import {
  useRunStore,
  type Step,
  type UserStep,
  type AssistantStep,
  type ToolBlockStep,
} from "@/state/runStore";
import { useProjectStore } from "@/state/projectStore";
import { useAuthStore } from "@/state/authStore";
import { useConversationStore, buildCurrentSnapshot } from "@/state/conversationStore";
import { startGatewayRun } from "@/agent/gatewayAgent";
import { getGatewayBaseUrl } from "@/agent/gatewayUrl";
import { WelcomePage } from "./WelcomePage";
import { InputBar } from "./InputBar";
import { usePersonaStore } from "@/state/personaStore";
import { BUILTIN_SUB_AGENTS } from "@writing-ide/agent-core";
import {
  injectFileRefLinksInMarkdown,
  parseFileRefHref,
  resolveProjectAbsPath,
} from "@/utils/fileRefLink";

type RunController = { cancel: (reason?: string) => void; done: Promise<void> };
function parseAtMention(text: string): { agentId: string; cleanText: string } | null {
  const m = text.match(/^@(\S+)\s+/);
  if (!m) return null;
  const mention = m[1];
  const agent = BUILTIN_SUB_AGENTS.find(a => a.enabled && (a.id === mention || a.name === mention));
  if (!agent) return null;
  return { agentId: agent.id, cleanText: text.slice(m[0].length) };
}


export function ChatArea() {
  const steps = useRunStore((s) => s.steps);
  const isRunning = useRunStore((s) => s.isRunning);
  const mode = useRunStore((s) => s.mode);
  const model = useRunStore((s) => s.model);

  const [suggestText, setSuggestText] = useState<string>("");
  const controllerRef = useRef<RunController | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const hasMessages = steps.length > 0;

  // 自动滚动到底部
  useEffect(() => {
    if (!stickRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [steps]);

  // 滚动事件：判断是否 stick to bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 80;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // 自动保存草稿到 conversationStore，同时更新活跃对话
  useEffect(() => {
    if (steps.length === 0) return;
    const timer = setTimeout(() => {
      const snap = buildCurrentSnapshot();
      useConversationStore.getState().setDraftSnapshot(snap);
      const convId = useConversationStore.getState().activeConvId;
      if (convId) {
        useConversationStore.getState().updateConversation(convId, { snapshot: snap });
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [steps]);

  // 卸载时取消运行
  useEffect(() => {
    return () => {
      if (controllerRef.current) {
        controllerRef.current.cancel("unmount");
        controllerRef.current = null;
      }
    };
  }, []);

  const handleSend = useCallback(
    (text: string, meta?: { mentions?: Array<{ id: string; label: string; type: string }>; targetAgentIds?: string[] }) => {
      // 运行中发送：先中断当前 run
      if (controllerRef.current) {
        controllerRef.current.cancel("start_new_turn_or_user_interrupt");
        controllerRef.current = null;
      }

      stickRef.current = true;

      // 始终先记录用户消息
      const baseline = {
        project: useProjectStore.getState().snapshot(),
        mainDoc: JSON.parse(JSON.stringify(useRunStore.getState().mainDoc ?? {})),
        todoList: JSON.parse(JSON.stringify(useRunStore.getState().todoList ?? [])),
        ctxRefs: JSON.parse(JSON.stringify(useRunStore.getState().ctxRefs ?? [])),
      };
      const userMentions = meta?.mentions?.length ? meta.mentions : undefined;
      useRunStore.getState().addUser(text, baseline as any, userMentions);

      // 首次发送：优先重命名预创建的"新任务"对话；兜底仍支持直接创建
      const convStore = useConversationStore.getState();
      const currentConvId = convStore.activeConvId;
      const title = text.length > 20 ? text.slice(0, 20) + "\u2026" : text;
      if (currentConvId) {
        const currentConv = convStore.conversations.find((c) => c.id === currentConvId);
        if (currentConv?.title === "新任务") {
          convStore.renameConversation(currentConvId, title);
        }
      } else {
        const convId = convStore.addConversation({ title, snapshot: buildCurrentSnapshot() });
        convStore.setActiveConvId(convId);
      }

      if (!model) {
        useRunStore.getState().addAssistant("（未选择模型：请先启动 Gateway 并选择一个模型）");
        return;
      }

      const gatewayUrl = getGatewayBaseUrl();
      const parsed = parseAtMention(text);
      const targetAgentIds = meta?.targetAgentIds ?? (parsed ? [parsed.agentId] : undefined);
      const cleanPrompt = !meta?.targetAgentIds && parsed ? parsed.cleanText : text;
      const activeSkillIds = meta?.mentions?.filter((m) => m.type === "skill").map((m) => m.id);
      const kbMentionIds = meta?.mentions?.filter((m) => m.type === "kb").map((m) => m.id);
      const c = startGatewayRun({
        gatewayUrl, mode, model, prompt: cleanPrompt,
        ...(targetAgentIds?.length ? { targetAgentIds } : {}),
        ...(activeSkillIds?.length ? { activeSkillIds } : {}),
        ...(kbMentionIds?.length ? { kbMentionIds } : {}),
      });
      controllerRef.current = c;
      void c.done.finally(() => {
        if (controllerRef.current === c) controllerRef.current = null;
      });
    },
    [mode, model],
  );

  const handleStop = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.cancel("stop_button");
      controllerRef.current = null;
    }
  }, []);

  const handleSuggest = useCallback((text: string) => {
    setSuggestText(text);
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 pt-[52px]">
      {hasMessages ? (
        /* 消息列表 */
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col"
        >
          {/* spacer: 消息少时把内容推到底部 */}
          <div className="flex-1 min-h-6" />
          <div className="max-w-[var(--chat-max-width)] mx-auto w-full px-6 pb-4 space-y-1">
            {steps.map((step) => (
              <StepRenderer key={step.id} step={step} />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      ) : (
        /* 欢迎页 */
        <WelcomePage onSuggest={handleSuggest} />
      )}

      {/* 输入栏（始终可见） */}
      <InputBar
        onSend={handleSend}
        onStop={handleStop}
        isRunning={isRunning}
        externalValue={suggestText}
        onExternalValueConsumed={() => setSuggestText("")}
      />
    </div>
  );
}

/* ─── Step 渲染分发 ─── */

function StepRenderer({ step }: { step: Step }) {
  switch (step.type) {
    case "user":
      return <UserMessage step={step} />;
    case "assistant":
      return <AssistantMessage step={step} />;
    case "tool":
      return <ToolCallCard step={step} />;
    default:
      return null;
  }
}

/* ─── 用户消息 ─── */

function UserMessage({ step }: { step: UserStep }) {
  return (
    <div className="flex justify-end py-3">
      <div className="max-w-[85%] bg-accent-soft rounded-2xl rounded-tr-md px-4 py-2.5">
        {step.mentions && step.mentions.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {step.mentions.map((m) => (
              <span
                key={m.id}
                className={cn(
                  "inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium",
                  m.type === "agent"
                    ? "bg-emerald-100/80 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : m.type === "skill"
                      ? "bg-accent-soft/80 text-accent"
                      : "bg-blue-100/80 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
                )}
              >
                {m.label}
              </span>
            ))}
          </div>
        )}
        <div className="text-[14px] text-text leading-relaxed whitespace-pre-wrap break-words">
          {step.text}
        </div>
      </div>
    </div>
  );
}

/* ─── 助手消息 ─── */

function AssistantMessage({ step }: { step: AssistantStep }) {
  if (step.hidden) return null;

  const subAgent = step.agentId
    ? BUILTIN_SUB_AGENTS.find((a) => a.id === step.agentId)
    : null;
  const agentName = usePersonaStore((s) => s.agentName);
  const avatar = subAgent?.avatar;
  const displayName = (subAgent?.name ?? step.agentName ?? agentName) || "Friday";
  const rootDir = useProjectStore((s) => s.rootDir);

  const markdownText = useMemo(
    () => injectFileRefLinksInMarkdown(step.text),
    [step.text],
  );

  const openFileRef = useCallback(
    async (relPath: string) => {
      if (!rootDir) return;
      const absPath = resolveProjectAbsPath(rootDir, relPath);
      const ret = await window.desktop?.exec?.openFile?.(absPath);
      if (ret && !ret.ok) alert(ret.detail || `无法打开文件：${relPath}`);
    },
    [rootDir],
  );

  return (
    <div className="flex gap-3 py-3">
      <div className="shrink-0 w-7 h-7 rounded-full bg-accent-soft flex items-center justify-center text-[14px]">
        {avatar ? <span>{avatar}</span> : <Bot size={14} className="text-accent" />}
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="text-[11px] text-text-faint mb-1.5">{displayName}</div>
        <div className="text-[14px] text-text leading-relaxed">
          {step.streaming && !step.text ? (
            <span className="inline-flex items-center gap-1.5 text-text-faint">
              <Loader2 size={13} className="animate-spin" />
              思考中...
            </span>
          ) : (
            <div className="whitespace-pre-wrap break-words max-w-none markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                urlTransform={(url) => url.startsWith("file-ref:") ? url : defaultUrlTransform(url)}
                components={{
                  a: ({ href, children }) => {
                    const relPath = parseFileRefHref(href);
                    if (relPath) {
                      return (
                        <span
                          className={cn("rtFileRef", !rootDir && "rtFileRefDisabled")}
                          role="button"
                          tabIndex={rootDir ? 0 : -1}
                          title={rootDir ? `打开文件：${relPath}` : "未打开项目目录"}
                          onClick={(e) => { e.preventDefault(); void openFileRef(relPath); }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void openFileRef(relPath);
                            }
                          }}
                        >
                          {children}
                        </span>
                      );
                    }
                    return (
                      <a href={href} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {markdownText}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {/* 消息操作栏 */}
        {!step.streaming && step.text && (
          <div className="flex items-center gap-1 mt-3 opacity-0 hover:opacity-100 transition-opacity duration-fast">
            <button
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-faint hover:text-text-muted hover:bg-surface-alt transition-colors duration-fast"
              onClick={() => navigator.clipboard.writeText(step.text)}
              title="复制"
            >
              <Copy size={12} />
              复制
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── 工具调用卡片 ─── */

function ToolCallCard({ step }: { step: ToolBlockStep }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    running: <Loader2 size={13} className="animate-spin text-accent" />,
    success: <CheckCircle2 size={13} className="text-success" />,
    failed: <XCircle size={13} className="text-error" />,
    undone: <XCircle size={13} className="text-text-faint" />,
  }[step.status];

  const statusColor = {
    running: "border-accent/20 bg-accent-soft/30",
    success: "border-success/10 bg-surface",
    failed: "border-error/10 bg-error/5",
    undone: "border-border-soft bg-surface",
  }[step.status];

  const summary = formatToolSummary(step);

  return (
    <div className={cn("rounded-lg border px-3 py-2 my-1 ml-10", statusColor)}>
      <button
        className="flex items-center gap-2 w-full text-left"
        onClick={() => setExpanded(!expanded)}
      >
        {statusIcon}
        <span className="text-[12px] font-mono text-text-muted truncate flex-1">
          {step.toolName}
          {summary && <span className="text-text-faint ml-1.5">— {summary}</span>}
        </span>
        {expanded ? (
          <ChevronUp size={12} className="text-text-faint shrink-0" />
        ) : (
          <ChevronDown size={12} className="text-text-faint shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-border-soft">
          {step.input != null && (
            <div className="mb-2">
              <div className="text-[10px] uppercase tracking-wider text-text-faint mb-1">
                Input
              </div>
              <pre className="text-[11px] text-text-muted font-mono whitespace-pre-wrap break-words bg-surface-alt rounded-md p-2 max-h-[160px] overflow-auto">
                {typeof step.input === "string"
                  ? step.input
                  : JSON.stringify(step.input, null, 2)}
              </pre>
            </div>
          )}
          {step.output != null && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-faint mb-1">
                Output
              </div>
              <pre className="text-[11px] text-text-muted font-mono whitespace-pre-wrap break-words bg-surface-alt rounded-md p-2 max-h-[160px] overflow-auto">
                {typeof step.output === "string"
                  ? step.output
                  : JSON.stringify(step.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatToolSummary(step: ToolBlockStep): string {
  const out = step.output;
  if (step.status === "running") return "";
  if (typeof out === "string" && out.length < 80) return out;
  if (out && typeof out === "object" && "message" in (out as any)) {
    return String((out as any).message ?? "").slice(0, 80);
  }
  return step.status === "success" ? "完成" : step.status === "failed" ? "失败" : "";
}
