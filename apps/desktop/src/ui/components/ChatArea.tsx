import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Copy,
  Bot,
  ChevronDown,
  ChevronRight,
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
  type ImageAttachment,
  type TodoItem,
  setActiveRunCancel,
  cancelActiveRun,
} from "@/state/runStore";
import { cancelConvRun } from "@/state/runRegistry";
import { useProjectStore } from "@/state/projectStore";
import { useAuthStore } from "@/state/authStore";
import { useKbStore } from "@/state/kbStore";
import { useConversationStore, buildCurrentSnapshot } from "@/state/conversationStore";
import { resolveInlineFileOpConfirm } from "@/state/inlineFileOpConfirm";
import { startGatewayRun, humanizeToolActivity } from "@/agent/gatewayAgent";
import { getGatewayBaseUrl } from "@/agent/gatewayUrl";
import { WelcomePage } from "./WelcomePage";
import { InputBar } from "./InputBar";
import { usePersonaStore } from "@/state/personaStore";
import { BUILTIN_SUB_AGENTS } from "@ohmycrab/agent-core";
import {
  injectFileRefLinksInMarkdown,
  wrapBareUrlsInMarkdown,
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

function looksLikeKbPanelOnlyIntent(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/^(我已完成抽卡|抽卡已完成|已经完成抽卡)/.test(t)) return false;
  const hasKbOpVerb =
    /(抽卡|入库|导入语料|导入素材|学.{0,4}风格|学.{0,4}写法|学习.{0,4}风格|分析.{0,4}文风|生成.{0,4}手册|风格手册)/.test(t);
  if (!hasKbOpVerb) return false;
  const looksLikeDebug = /(问题|bug|报错|失败|修复|检查|日志|代码|实现|排查|原因|为什么)/i.test(t);
  if (looksLikeDebug) return false;
  return true;
}

function fileToImageAttachment(file: File): Promise<ImageAttachment | null> {
  if (!String(file.type ?? "").startsWith("image/")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      const comma = raw.indexOf(",");
      const data = (comma >= 0 ? raw.slice(comma + 1) : raw).trim();
      if (!data) { resolve(null); return; }
      resolve({ mediaType: file.type || "image/png", data, name: file.name || "image" });
    };
    reader.onerror = () => resolve(null);
    reader.onabort = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

type RenderRow =
  | { kind: "step"; key: string; step: Step }
  | { kind: "tool_group"; key: string; steps: ToolBlockStep[] };

function parseMcpToolMeta(toolName: string): { serverId: string; toolId: string } | null {
  const parts = String(toolName ?? "").trim().split(".");
  if (parts.length < 3 || parts[0] !== "mcp") return null;
  return {
    serverId: String(parts[1] ?? "").trim(),
    toolId: parts.slice(2).join(".").trim(),
  };
}

function getToolGroupKey(step: ToolBlockStep): string | null {
  const meta = parseMcpToolMeta(step.toolName);
  if (!meta) return null;
  return `${step.agentId ?? "main"}:${meta.serverId || meta.toolId}`;
}

function buildRenderRows(steps: Step[]): RenderRow[] {
  const rows: RenderRow[] = [];
  for (let index = 0; index < steps.length;) {
    const current = steps[index];
    if (current.type === "tool") {
      const groupKey = getToolGroupKey(current);
      if (groupKey) {
        const group: ToolBlockStep[] = [current];
        let cursor = index + 1;
        while (cursor < steps.length) {
          const next = steps[cursor];
          if (next.type !== "tool") break;
          if (getToolGroupKey(next) !== groupKey) break;
          group.push(next);
          cursor += 1;
        }
        if (group.length > 1) {
          rows.push({ kind: "tool_group", key: `tool_group_${current.id}`, steps: group });
          index = cursor;
          continue;
        }
      }
    }
    rows.push({ kind: "step", key: current.id, step: current });
    index += 1;
  }
  return rows;
}

function humanizeMcpToolDisplayName(toolName: string): string | null {
  const meta = parseMcpToolMeta(toolName);
  if (!meta) return null;
  const toolId = meta.toolId.toLowerCase();
  if (/(browser_navigate|navigate|goto|go_to|open_url|openurl)/.test(toolId)) return "打开网页";
  if (/(browser_snapshot|snapshot|get_page_content|get_page|page_content)/.test(toolId)) return "读取页面内容";
  if (/(browser_click|click)/.test(toolId)) return "点击页面元素";
  if (/(browser_type|type|fill|input)/.test(toolId)) return "填写页面内容";
  if (/(browser_wait_for|wait_for)/.test(toolId)) return "等待页面状态";
  if (/(browser_run_code|run_code|evaluate|exec_js)/.test(toolId)) return "执行网页脚本";
  if (/(create_document|new_document|document_create)/.test(toolId)) return "生成 Word 文档";
  if (/(read_doc|get_doc|read_document)/.test(toolId)) return "读取 Word 文档";
  if (/(search|web_search)/.test(toolId)) return "执行搜索";
  if (/(get_page_content|fetch)/.test(toolId)) return "抓取网页内容";
  if (/(create_workbook|spreadsheet|worksheet|sheet|excel)/.test(toolId)) return "生成表格文件";
  return "调用外部工具";
}

function humanizeToolGroupLabel(toolName: string): string {
  const meta = parseMcpToolMeta(toolName);
  if (!meta) return "外部工具任务";
  const toolId = meta.toolId.toLowerCase();
  if (/(browser_|navigate|goto|snapshot|click|fill|type|wait_for|run_code)/.test(toolId)) return "网页任务";
  if (/(create_document|read_doc|document|docx|word)/.test(toolId)) return "Word 文档任务";
  if (/(search|get_page|fetch)/.test(toolId)) return "搜索任务";
  if (/(create_workbook|spreadsheet|worksheet|sheet|excel)/.test(toolId)) return "表格任务";
  return "外部工具任务";
}

function normalizeToolErrorText(raw: unknown): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const missingProp = text.match(/required property ['"]([^'"]+)['"]/i)?.[1];
  if (/Validation failed for tool/i.test(text) && /setTodoList|run_dot_setTodoList|run\.setTodoList/i.test(text) && missingProp === "items") {
    return "待办事项更新失败：缺少任务列表参数 items。";
  }
  if (/Validation failed for tool/i.test(text) && missingProp) {
    return `参数校验失败：缺少 ${missingProp} 字段。`;
  }
  if (/PROJECT_NOT_OPENED/i.test(text)) {
    return "当前没有打开项目文件夹，暂时不能把结果写入本地项目。";
  }
  if (/Another browser context is being closed/i.test(text)) {
    return "浏览器会话正在关闭，请刷新页面后再继续。";
  }
  if (/Ref\s+\S+\s+not found in the current page snapshot/i.test(text)) {
    return "页面快照已过期，需要先重新读取当前页面再继续点击。";
  }
  if (/Request was aborted/i.test(text) || /aborted/i.test(text)) {
    return "本轮已中断，可继续刚才的任务。";
  }
  return text;
}

function formatTodoNote(note?: string): string {
  const raw = String(note ?? "").trim();
  if (!raw) return "";
  const matched = raw.match(/^失败：\s*([^\-]+)\s*-\s*(.+)$/);
  if (matched) {
    const toolName = String(matched[1] ?? "").trim();
    const detail = normalizeToolErrorText(matched[2]);
    if (/setTodoList|run\.setTodoList/i.test(toolName)) return `待办同步失败：${detail}`;
    return `${toolDisplayName(toolName, undefined)}失败：${detail}`;
  }
  return normalizeToolErrorText(raw);
}

export function ChatArea() {
  const steps = useRunStore((s) => s.steps);
  const isRunning = useRunStore((s) => s.isRunning);
  const todoList = useRunStore((s) => s.todoList);
  const mainDoc = useRunStore((s) => s.mainDoc);
  const kbAttachedLibraryIds = useRunStore((s) => s.kbAttachedLibraryIds);
  const ctxRefs = useRunStore((s) => s.ctxRefs);
  const pendingArtifacts = useRunStore((s) => s.pendingArtifacts);
  const mode = useRunStore((s) => s.mode);
  const model = useRunStore((s) => s.model);

  const [suggestText, setSuggestText] = useState<string>("");
  const [todoPanelCollapsed, setTodoPanelCollapsed] = useState(false);
  const controllerRef = useRef<RunController | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const activeConvId = useConversationStore((s) => s.activeConvId);
  const hasMessages = steps.length > 0;
  const hasPendingTodo = useMemo(
    () => todoList.some((item) => item.status !== "done" && item.status !== "skipped"),
    [todoList],
  );
  const showWorkflowTodoPanel = todoList.length > 0 && (isRunning || hasPendingTodo);
  const renderRows = useMemo(() => buildRenderRows(steps), [steps]);

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
    const hasDraftState =
      steps.length > 0 ||
      todoList.length > 0 ||
      pendingArtifacts.length > 0 ||
      ctxRefs.length > 0 ||
      kbAttachedLibraryIds.length > 0 ||
      Object.values(mainDoc ?? {}).some((v) => {
        if (v == null) return false;
        if (typeof v === "string") return Boolean(v.trim());
        if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
        return true;
      });
    if (!hasDraftState) return;
    const timer = setTimeout(() => {
      const snap = buildCurrentSnapshot();
      useConversationStore.getState().setDraftSnapshot(snap);
      const convId = useConversationStore.getState().activeConvId;
      if (convId) {
        useConversationStore.getState().updateConversation(convId, { snapshot: snap });
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [steps, mainDoc, todoList, kbAttachedLibraryIds, ctxRefs, pendingArtifacts, mode, model]);

  // 卸载时取消运行
  useEffect(() => {
    return () => {
      cancelActiveRun("unmount");
      controllerRef.current = null;
    };
  }, []);

  const handleSend = useCallback(
    async (text: string, meta?: { mentions?: Array<{ id: string; label: string; type: string }>; files?: File[]; targetAgentIds?: string[] }) => {
      const imageFiles = (meta?.files ?? []).filter((f) => String(f.type ?? "").startsWith("image/"));
      const images = (
        await Promise.all(imageFiles.map((f) => fileToImageAttachment(f)))
      ).filter((it): it is ImageAttachment => Boolean(it));

      // 运行中发送：先中断当前对话的 run（不影响其他对话的后台 run）
      const preSendConvId = useConversationStore.getState().activeConvId;
      if (preSendConvId) {
        cancelConvRun(preSendConvId, "start_new_turn_or_user_interrupt");
      } else {
        cancelActiveRun("start_new_turn_or_user_interrupt");
      }
      controllerRef.current = null;

      stickRef.current = true;

      // 始终先记录用户消息
      const baseline = {
        project: useProjectStore.getState().snapshot(),
        mainDoc: JSON.parse(JSON.stringify(useRunStore.getState().mainDoc ?? {})),
        todoList: JSON.parse(JSON.stringify(useRunStore.getState().todoList ?? [])),
        ctxRefs: JSON.parse(JSON.stringify(useRunStore.getState().ctxRefs ?? [])),
      };
      const userMentions = meta?.mentions?.length ? meta.mentions : undefined;
      useRunStore.getState().addUser(text, baseline as any, userMentions, images.length ? images : undefined);

      // 首次发送：优先重命名预创建的"新任务"对话；兜底仍支持直接创建
      const convStore = useConversationStore.getState();
      const currentConvId = convStore.activeConvId;
      const titleSeed = text.trim() || (images.length ? "图片消息" : text);
      const title = titleSeed.length > 20 ? titleSeed.slice(0, 20) + "\u2026" : titleSeed;
      if (currentConvId) {
        const currentConv = convStore.conversations.find((c) => c.id === currentConvId);
        if (currentConv?.title === "新任务") {
          convStore.renameConversation(currentConvId, title);
        }
      } else {
        const convId = convStore.addConversation({ title, snapshot: buildCurrentSnapshot() });
        convStore.setActiveConvId(convId);
      }

      if (mode === "agent" && looksLikeKbPanelOnlyIntent(text)) {
        useRunStore.getState().addAssistant(
          "抽卡/语料学习已改为面板操作：请到知识库里选择目标库后执行抽卡。完成后点击下方“我已完成抽卡”，我再继续后续写作或分析。",
          false,
          false,
          { quickActions: ["open_kb_manager", "kb_done_continue"] },
        );
        return;
      }

      if (!model) {
        useRunStore.getState().addAssistant("（未选择模型：请先启动 Gateway 并选择一个模型）");
        return;
      }

      const gatewayUrl = getGatewayBaseUrl();
      const parsed = parseAtMention(text);
      const targetAgentIds = meta?.targetAgentIds ?? (parsed ? [parsed.agentId] : undefined);
      const cleanPromptRaw = !meta?.targetAgentIds && parsed ? parsed.cleanText : text;
      // 纯图片消息时 prompt 不能为空（Gateway schema min(1)），用空格占位
      const cleanPrompt = cleanPromptRaw.trim().length > 0 ? cleanPromptRaw : images.length > 0 ? " " : cleanPromptRaw;
      const activeSkillIds = meta?.mentions?.filter((m) => m.type === "skill").map((m) => m.id);
      const kbMentionIds = meta?.mentions?.filter((m) => m.type === "kb").map((m) => m.id);
      // 读取当前 activeConvId（此时可能刚被 setActiveConvId 更新）
      const runConvId = useConversationStore.getState().activeConvId ?? undefined;
      const c = startGatewayRun({
        gatewayUrl, mode, model, prompt: cleanPrompt,
        ...(images.length ? { images } : {}),
        ...(targetAgentIds?.length ? { targetAgentIds } : {}),
        ...(activeSkillIds?.length ? { activeSkillIds } : {}),
        ...(kbMentionIds?.length ? { kbMentionIds } : {}),
        ...(runConvId ? { convId: runConvId } : {}),
      });
      controllerRef.current = c;
      setActiveRunCancel((reason?: string) => {
        if (controllerRef.current === c) controllerRef.current = null;
        c.cancel(reason);
      });
      void c.done.finally(() => {
        if (controllerRef.current === c) {
          controllerRef.current = null;
          setActiveRunCancel(null);
        }
      });
    },
    [mode, model],
  );

  const handleAssistantQuickAction = useCallback(
    (
      action:
        | "open_kb_manager"
        | "kb_done_continue"
        | "file_op_deny"
        | "file_op_allow_once"
        | "file_op_always_allow",
    ) => {
      if (action === "open_kb_manager") {
        useKbStore.getState().openKbManager();
        return;
      }
      if (action === "kb_done_continue") {
        void handleSend("我已完成抽卡，请继续刚才的任务。");
        return;
      }
      if (action === "file_op_deny") {
        resolveInlineFileOpConfirm("deny");
        return;
      }
      if (action === "file_op_allow_once") {
        resolveInlineFileOpConfirm("allow_once");
        return;
      }
      if (action === "file_op_always_allow") {
        resolveInlineFileOpConfirm("always_allow");
      }
    },
    [handleSend],
  );

  const handleStop = useCallback(() => {
    cancelActiveRun("stop_button");
    controllerRef.current = null;
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
            {renderRows.map((row) => (
              row.kind === "tool_group"
                ? <ToolGroupCard key={row.key} steps={row.steps} />
                : <StepRenderer key={row.key} step={row.step} onAssistantQuickAction={handleAssistantQuickAction} />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      ) : (
        /* 欢迎页 */
        <WelcomePage onSuggest={handleSuggest} />
      )}

      {showWorkflowTodoPanel && (
        <WorkflowTodoPanel
          items={todoList}
          isRunning={isRunning}
          collapsed={todoPanelCollapsed}
          onToggle={() => setTodoPanelCollapsed((prev) => !prev)}
        />
      )}

      {/* 输入栏（始终可见） */}
      <InputBar
        onSend={handleSend}
        onStop={handleStop}
        isRunning={isRunning}
        externalValue={suggestText}
        onExternalValueConsumed={() => setSuggestText("")}
        conversationId={activeConvId}
      />
    </div>
  );
}

function WorkflowTodoPanel({
  items,
  isRunning,
  collapsed,
  onToggle,
}: {
  items: TodoItem[];
  isRunning: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const total = items.length;
  const done = items.filter((item) => item.status === "done" || item.status === "skipped").length;

  return (
    <div className="w-full max-w-[var(--chat-max-width)] mx-auto px-4 pb-2">
      <div className="rounded-2xl border border-border bg-surface shadow-sm">
        <button
          type="button"
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
          onClick={onToggle}
        >
          <div className="flex items-center gap-2 min-w-0">
            {collapsed ? <ChevronRight size={15} className="text-text-faint shrink-0" /> : <ChevronDown size={15} className="text-text-faint shrink-0" />}
            <div className="text-[13px] font-semibold text-text">任务清单</div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-[12px] text-text-muted whitespace-nowrap">
              {done >= total ? ("已完成 " + done + "/" + total + (isRunning ? " · 收尾中" : "")) : ("已完成 " + done + "/" + total)}
            </div>
            <div className="text-[12px] text-text-faint whitespace-nowrap">{collapsed ? "展开" : "收起"}</div>
          </div>
        </button>
        {!collapsed ? (
          <div className="border-t border-border/60 max-h-[220px] overflow-y-auto px-4 py-3 space-y-2.5">
            {items.map((item, index) => {
              const isDone = item.status === "done" || item.status === "skipped";
              const isRunningNow = item.status === "in_progress";
              const isBlocked = item.status === "blocked";
              const icon = isDone ? (
                <CheckCircle2 size={16} className="text-success shrink-0 mt-0.5" />
              ) : isRunningNow ? (
                <Loader2 size={16} className="text-accent shrink-0 mt-0.5 animate-spin" />
              ) : isBlocked ? (
                <XCircle size={16} className="text-error shrink-0 mt-0.5" />
              ) : (
                <span className="shrink-0 mt-[2px] inline-flex items-center justify-center w-4 h-4 rounded-full border border-border text-[10px] text-text-faint">○</span>
              );
              return (
                <div key={item.id || String(index)} className="flex items-start gap-3">
                  {icon}
                  <div className="min-w-0 flex-1">
                    <div className={cn(
                      "text-[13px] leading-6 break-words",
                      isDone ? "text-text-muted line-through" : isBlocked ? "text-error" : "text-text",
                    )}>
                      {index + 1}. {item.text}
                    </div>
                    {item.note ? (
                      <div className="mt-0.5 text-[12px] leading-5 text-text-faint break-words">{formatTodoNote(item.note)}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ─── Step 渲染分发 ─── */

function StepRenderer({
  step,
  onAssistantQuickAction,
}: {
  step: Step;
  onAssistantQuickAction: (
    action:
      | "open_kb_manager"
      | "kb_done_continue"
      | "file_op_deny"
      | "file_op_allow_once"
      | "file_op_always_allow",
  ) => void;
}) {
  switch (step.type) {
    case "user":
      return <UserMessage step={step} />;
    case "assistant":
      return <AssistantMessage step={step} onQuickAction={onAssistantQuickAction} />;
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
        {step.images && step.images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {step.images.map((img, i) => (
              <img
                key={`${step.id}-img-${i}`}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.name || `image-${i + 1}`}
                className="h-8 w-8 object-cover rounded"
              />
            ))}
          </div>
        )}
        {step.text.length > 0 && (
        <div className="text-[14px] text-text leading-relaxed whitespace-pre-wrap break-words">
          {step.text}
        </div>
        )}
      </div>
    </div>
  );
}

/* ─── 助手消息 ─── */

function AssistantMessage({
  step,
  onQuickAction,
}: {
  step: AssistantStep;
  onQuickAction: (
    action:
      | "open_kb_manager"
      | "kb_done_continue"
      | "file_op_deny"
      | "file_op_allow_once"
      | "file_op_always_allow",
  ) => void;
}) {
  if (step.hidden) return null;

  const subAgent = step.agentId
    ? BUILTIN_SUB_AGENTS.find((a) => a.id === step.agentId)
    : null;
  const agentName = usePersonaStore((s) => s.agentName);
  const avatar = subAgent?.avatar;
  const displayName = (subAgent?.name ?? step.agentName ?? agentName) || "Friday";
  const rootDir = useProjectStore((s) => s.rootDir);

  const markdownText = useMemo(
    () => injectFileRefLinksInMarkdown(wrapBareUrlsInMarkdown(step.text)),
    [step.text],
  );

  const openFileRef = useCallback(
    async (relPath: string) => {
      const rd = useProjectStore.getState().rootDir;
      if (!rd) return;
      const absPath = resolveProjectAbsPath(rd, relPath);
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

        {Array.isArray(step.quickActions) && step.quickActions.length > 0 && (
          <div className="flex items-center gap-2 mt-2">
            {step.quickActions.includes("open_kb_manager") && (
              <button
                className="px-2.5 py-1 rounded-md text-[12px] border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                onClick={() => onQuickAction("open_kb_manager")}
                type="button"
              >
                打开知识库
              </button>
            )}
            {step.quickActions.includes("kb_done_continue") && (
              <button
                className="px-2.5 py-1 rounded-md text-[12px] bg-accent text-white hover:opacity-90 transition-opacity"
                onClick={() => onQuickAction("kb_done_continue")}
                type="button"
              >
                我已完成抽卡
              </button>
            )}
            {step.quickActions.includes("file_op_deny") && (
              <button
                className="px-2.5 py-1 rounded-md text-[12px] border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                onClick={() => onQuickAction("file_op_deny")}
                type="button"
              >
                拒绝
              </button>
            )}
            {step.quickActions.includes("file_op_allow_once") && (
              <button
                className="px-2.5 py-1 rounded-md text-[12px] bg-accent text-white hover:opacity-90 transition-opacity"
                onClick={() => onQuickAction("file_op_allow_once")}
                type="button"
              >
                允许
              </button>
            )}
            {step.quickActions.includes("file_op_always_allow") && (
              <button
                className="px-2.5 py-1 rounded-md text-[12px] border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                onClick={() => onQuickAction("file_op_always_allow")}
                type="button"
              >
                总是允许
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── 工具调用卡片（轻量状态行） ─── */

function ToolCallCard({ step }: { step: ToolBlockStep }) {
  const statusIcon = {
    running: <Loader2 size={13} className="animate-spin text-accent" />,
    success: <CheckCircle2 size={13} className="text-success" />,
    failed: <XCircle size={13} className="text-error" />,
    undone: <XCircle size={13} className="text-text-faint" />,
  }[step.status];
  const statusColor = {
    running: "border-accent/20 bg-accent-soft/20",
    success: "border-border-soft bg-surface/70",
    failed: "border-error/20 bg-error/5",
    undone: "border-border-soft bg-surface/60",
  }[step.status];

  const line = formatToolStatusLine(step);

  return (
    <div className={cn("rounded-md border px-3 py-1.5 my-1 ml-10", statusColor)}>
      <div className="flex items-center gap-2 w-full">
        {statusIcon}
        <span className="text-[12px] text-text-muted truncate flex-1">{line}</span>
      </div>
    </div>
  );
}

function ToolGroupCard({ steps }: { steps: ToolBlockStep[] }) {
  const groupStatus: ToolBlockStep["status"] = steps.some((step) => step.status === "failed")
    ? "failed"
    : steps.some((step) => step.status === "running")
      ? "running"
      : steps.every((step) => step.status === "undone")
        ? "undone"
        : "success";
  const [expanded, setExpanded] = useState(groupStatus !== "success");

  useEffect(() => {
    if (groupStatus !== "success") setExpanded(true);
  }, [groupStatus]);

  const statusIcon = {
    running: <Loader2 size={13} className="animate-spin text-accent" />,
    success: <CheckCircle2 size={13} className="text-success" />,
    failed: <XCircle size={13} className="text-error" />,
    undone: <XCircle size={13} className="text-text-faint" />,
  }[groupStatus];
  const statusColor = {
    running: "border-accent/20 bg-accent-soft/20",
    success: "border-border-soft bg-surface/70",
    failed: "border-error/20 bg-error/5",
    undone: "border-border-soft bg-surface/60",
  }[groupStatus];

  const groupLabel = humanizeToolGroupLabel(steps[0]?.toolName ?? "");
  const lastLine = steps.length > 0 ? _trunc(formatToolStatusLine(steps[steps.length - 1]!), 80) : "";
  const summaryLine = groupStatus === "running"
    ? `正在执行${groupLabel}…`
    : groupStatus === "failed"
      ? `${groupLabel} · ${steps.length} 步，存在失败`
      : groupStatus === "undone"
        ? `${groupLabel} · 已撤销`
        : `${groupLabel} · 已完成 ${steps.length} 步`;

  return (
    <div className={cn("rounded-md border px-3 py-2 my-1 ml-10", statusColor)}>
      <div className="flex items-start gap-2 w-full">
        <div className="pt-0.5">{statusIcon}</div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-text-muted truncate">{summaryLine}</div>
          {lastLine ? <div className="mt-0.5 text-[11px] text-text-faint truncate">最近：{lastLine}</div> : null}
        </div>
        <button
          type="button"
          className="shrink-0 mt-0.5 text-text-faint hover:text-text transition-colors"
          onClick={() => setExpanded((prev) => !prev)}
          aria-label={expanded ? "收起工具详情" : "展开工具详情"}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>
      {expanded ? (
        <div className="mt-2 pl-5 space-y-1.5">
          {steps.map((step) => {
            const detailIcon = {
              running: <Loader2 size={12} className="animate-spin text-accent" />,
              success: <CheckCircle2 size={12} className="text-success" />,
              failed: <XCircle size={12} className="text-error" />,
              undone: <XCircle size={12} className="text-text-faint" />,
            }[step.status];
            return (
              <div key={step.id} className="flex items-center gap-2 min-w-0">
                {detailIcon}
                <div className="text-[11px] text-text-faint truncate flex-1">{formatToolStatusLine(step)}</div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ─── 工具状态行格式化 ─── */

function _trunc(v: unknown, max = 48): string {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  return !t ? "" : t.length <= max ? t : t.slice(0, max) + "…";
}

function _asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  "time.now": "读取时间",
  "kb.search": "检索知识库",
  "kb.cite": "引用知识片段",
  "kb.listLibraries": "查看知识库列表",
  "kb.ingest": "录入知识库",
  "kb.learn": "学习素材",
  "kb.import": "导入知识",
  "kb.extract": "提取知识片段",
  "kb.jobStatus": "查看任务进度",
  "web.search": "全网搜索",
  "web.fetch": "读取网页",
  "doc.read": "读取文件",
  "doc.write": "写入文件",
  "doc.previewDiff": "生成修改提案",
  "doc.splitToDir": "拆分并写入文件",
  "doc.applyEdits": "编辑文件",
  "doc.mkdir": "创建目录",
  "doc.renamePath": "重命名文件",
  "doc.deletePath": "删除文件",
  "doc.snapshot": "创建快照",
  "doc.getSelection": "读取选区",
  "doc.replaceSelection": "替换选区",
  "lint.style": "风格校验",
  "lint.copy": "复述风险检查",
  "run.setTodoList": "更新待办事项",
  "run.done": "结束本次任务",
  "run.mainDoc.update": "更新主文档",
  "run.mainDoc.get": "读取主文档",
  "project.listFiles": "浏览项目文件",
  "project.search": "搜索项目文件",
  "project.docRules.get": "读取文档规范",
  "file.open": "打开文件",
  "code.exec": "执行代码",
  "memory": "读写记忆",
  "agent.config": "管理团队配置",
  "agent.config.create": "创建团队成员",
  "agent.config.list": "查看团队成员",
  "agent.config.update": "更新成员配置",
  "agent.config.remove": "移除团队成员",
};

function toolDisplayName(toolName: string, input: unknown): string {
  const mcpLabel = humanizeMcpToolDisplayName(toolName);
  if (mcpLabel) return mcpLabel;
  if (toolName === "agent.delegate") {
    const args = _asRecord(input);
    const agentId = String(args.agentId ?? args.targetAgentId ?? "").trim();
    const agent = BUILTIN_SUB_AGENTS.find((a) => a.id === agentId);
    return agent ? `委派${agent.name}` : agentId ? `委派 ${agentId}` : "委派子 Agent";
  }
  if (toolName === "run.todo" || toolName.startsWith("run.todo.")) return "更新待办事项";
  return TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}

function summarizeToolInput(toolName: string, input: unknown): string {
  const args = _asRecord(input);
  if (toolName === "kb.search" || toolName === "web.search") {
    const q = _trunc(args.query ?? args.q ?? args.keyword, 28);
    return q ? `"${q}"` : "";
  }
  if (toolName === "web.fetch") {
    const raw = String(args.url ?? "").trim();
    if (!raw) return "";
    try { return new URL(raw).hostname; } catch { return _trunc(raw, 28); }
  }
  if (toolName === "doc.read" || toolName === "doc.write" || toolName === "doc.previewDiff" || toolName === "doc.splitToDir" || toolName === "doc.applyEdits") {
    return _trunc(args.path ?? args.filePath ?? args.targetPath, 40);
  }
  if (toolName === "run.setTodoList") {
    const n = Array.isArray(args.items) ? args.items.length : 0;
    return n > 0 ? `${n} 项` : "";
  }
  if (toolName === "agent.config.create") {
    return _trunc(args.name, 20);
  }
  if (toolName === "agent.config.update" || toolName === "agent.config.remove") {
    const agentId = String(args.agentId ?? "").trim();
    const agent = BUILTIN_SUB_AGENTS.find((a) => a.id === agentId);
    return agent?.name ?? agentId;
  }
  return "";
}

function summarizeToolOutput(toolName: string, output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") {
    const docCreated = output.match(/^Document\s+(.+?)\s+created successfully\.?$/i)?.[1];
    if (docCreated) return `已创建文档《${docCreated.trim()}》`;
    return _trunc(normalizeToolErrorText(output), 60);
  }
  if (Array.isArray(output)) return output.length ? `返回 ${output.length} 项` : "";
  const out = _asRecord(output);
  if (toolName === "run.mainDoc.update" && out.ok === true) return "主文档已更新";
  if (toolName === "run.setTodoList" && out.ok === true) return "任务清单已更新";
  if (toolName === "time.now" && (out.nowIso || out.unixMs)) return "已读取当前时间";
  if (out.error) return _trunc(normalizeToolErrorText(out.error), 60);
  const msg = out.message ?? out.note ?? out.summary;
  if (msg) return _trunc(normalizeToolErrorText(msg), 60);
  if (Array.isArray(out.groups)) {
    let hits = 0;
    for (const g of out.groups) {
      if (g && typeof g === "object" && Array.isArray((g as any).hits)) hits += (g as any).hits.length;
    }
    return hits > 0 ? `命中 ${hits} 条` : `${out.groups.length} 组结果`;
  }
  if (Array.isArray(out.results)) return `${out.results.length} 条结果`;
  if (Array.isArray(out.todoList)) return `${out.todoList.length} 项待办`;
  if (Array.isArray(out.agents)) return `${out.agents.length} 位成员`;
  // 兜底：截取 JSON 摘要
  try { return _trunc(JSON.stringify(out), 60); } catch { return ""; }
}

function formatToolStatusLine(step: ToolBlockStep): string {
  const args = _asRecord(step.input);
  if (step.status === "running") {
    return humanizeToolActivity(step.toolName, args);
  }
  const label = toolDisplayName(step.toolName, step.input);
  const inputHint = summarizeToolInput(step.toolName, step.input);
  const action = inputHint ? `${label} — ${inputHint}` : label;
  const statusTag = step.status === "success" ? "已完成" : step.status === "failed" ? "失败" : "已撤销";
  const outputHint = summarizeToolOutput(step.toolName, step.output);
  return outputHint ? `${action} · ${statusTag}：${outputHint}` : `${action} · ${statusTag}`;
}
