import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  X, Users, Plug, Sparkles, ChevronDown, ChevronRight, Plus,
  Bot, BookOpen, FolderOpen, RefreshCw, Pencil, Trash2, Terminal, Globe, Radio,
  Eye, EyeOff, Monitor, ExternalLink, Package,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TeamModal } from "@/components/TeamModal";
import { listRegisteredSkills, type SkillManifest } from "@writing-ide/agent-core";
import { useSkillStore } from "@/state/skillStore";
import { usePersonaStore } from "@/state/personaStore";
import { useKbStore } from "@/state/kbStore";
import { useDialogStore } from "@/state/dialogStore";
import { useMcpStore, type McpServerState } from "@/state/mcpStore";

type Tab = "persona" | "team" | "mcp" | "skill" | "kb";

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "persona", label: "负责人", icon: Bot },
  { id: "kb", label: "知识库", icon: BookOpen },
  { id: "team", label: "团队管理", icon: Users },
  { id: "mcp", label: "MCP", icon: Plug },
  { id: "skill", label: "技能", icon: Sparkles },
];

export function SettingsModal({ onClose, initialTab, kbSelectMode }: {
  onClose: () => void;
  initialTab?: string;
  kbSelectMode?: { onSelect: (id: string) => void };
}) {
  const [tab, setTab] = useState<Tab>(() => {
    const t = initialTab as Tab;
    return TABS.some((x) => x.id === t) ? t : "persona";
  });

  // kbSelectMode 请求到达时强制切换到 KB tab
  useEffect(() => {
    if (kbSelectMode && initialTab === "kb") setTab("kb");
  }, [kbSelectMode, initialTab]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm overflow-y-auto py-8"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[680px] max-h-[calc(100vh-4rem)] bg-surface rounded-2xl border border-border shadow-2xl flex overflow-hidden my-auto">
        {/* Left tabs */}
        <div className="w-[180px] shrink-0 border-r border-border bg-surface-alt py-4 px-2 flex flex-col gap-1">
          <div className="text-[11px] uppercase tracking-wider text-text-faint font-medium px-3 mb-2">
            设置
          </div>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors w-full text-left",
                tab === t.id
                  ? "bg-accent-soft text-accent font-medium"
                  : "text-text-muted hover:bg-surface hover:text-text",
              )}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </div>

        {/* Right content */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <h2 className="text-[16px] font-semibold text-text">
              {TABS.find((t) => t.id === tab)?.label}
            </h2>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-faint hover:text-text hover:bg-surface-alt transition-colors"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            {tab === "persona" && <PersonaTabContent />}
            {tab === "kb" && <KbTabContent kbSelectMode={kbSelectMode} />}
            {tab === "team" && <TeamTabContent />}
            {tab === "mcp" && <McpTabContent />}
            {tab === "skill" && <SkillTabContent />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── Persona Tab ─── */

function PersonaTabContent() {
  const agentName = usePersonaStore((s) => s.agentName);
  const personaPrompt = usePersonaStore((s) => s.personaPrompt);
  const setAgentName = usePersonaStore((s) => s.setAgentName);
  const setPersonaPrompt = usePersonaStore((s) => s.setPersonaPrompt);

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[12px] text-text-muted leading-relaxed">
        个性化你的 AI 负责人，设定它的名字和性格。这不会影响系统能力，只是让体验更亲切。
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-text">
          负责人名称
        </label>
        <input
          type="text"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="Friday"
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-[13px] text-text placeholder:text-text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
        />
        <div className="text-[11px] text-text-faint">
          留空默认为 Friday
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-text">
          个性化描述
        </label>
        <textarea
          value={personaPrompt}
          onChange={(e) => setPersonaPrompt(e.target.value)}
          placeholder="例如：叫我老板，说话干练简洁，用幽默的语气，偏好口语化表达"
          rows={4}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-[13px] text-text placeholder:text-text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors resize-none leading-relaxed"
        />
        <div className="text-[11px] text-text-faint">
          描述你希望的说话风格、称呼方式、性格特点等
        </div>
      </div>
    </div>
  );
}

/* ─── KB Tab ─── */

function KbTabContent({ kbSelectMode }: { kbSelectMode?: { onSelect: (id: string) => void } }) {
  const baseDir = useKbStore((s) => s.baseDir);
  const libraries = useKbStore((s) => s.libraries);
  const refreshLibraries = useKbStore((s) => s.refreshLibraries);
  const createLibrary = useKbStore((s) => s.createLibrary);
  const renameLibrary = useKbStore((s) => s.renameLibrary);
  const deleteLibraryToTrash = useKbStore((s) => s.deleteLibraryToTrash);
  const setCurrentLibrary = useKbStore((s) => s.setCurrentLibrary);

  const handlePickDir = async () => {
    const api = window.desktop?.fs;
    if (!api) return;
    const res = await api.pickDirectory();
    if (!res?.ok || !res.dir) return;
    useKbStore.getState().setBaseDir(res.dir);
    await refreshLibraries().catch(() => void 0);
  };

  const handleCreateLibrary = async () => {
    const name = await useDialogStore.getState().openPrompt({
      title: "新建知识库",
      placeholder: "请输入库名称",
      defaultValue: "",
    });
    if (!name) return;
    const ret = await createLibrary(name);
    if (!ret.ok) return;
    // kbSelectMode 下，新建后直接选中
    if (kbSelectMode && ret.id) {
      setCurrentLibrary(ret.id);
      kbSelectMode.onSelect(ret.id);
    }
  };

  const handleRenameLibrary = async (id: string, oldName: string) => {
    const newName = await useDialogStore.getState().openPrompt({
      title: "重命名知识库",
      placeholder: "请输入新名称",
      defaultValue: oldName,
    });
    if (!newName) return;
    await renameLibrary(id, newName);
  };

  const handleDeleteLibrary = async (id: string, name: string) => {
    const ok = await useDialogStore.getState().openConfirm({
      title: "删除知识库？",
      message: `确认删除「${name}」吗？该库会移入回收站，可在库管理中恢复。`,
      danger: true,
    });
    if (!ok) return;
    await deleteLibraryToTrash(id);
  };

  const handleSelectLibrary = (id: string) => {
    if (!kbSelectMode) return;
    setCurrentLibrary(id);
    kbSelectMode.onSelect(id);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[12px] text-text-muted leading-relaxed">
        {kbSelectMode
          ? "请选择一个目标库用于抽卡入库，也可新建库。选中后将自动继续导入流程。"
          : "知识库存储在本地磁盘，选择目录后自动发现库文件。在输入框 @ 提及库名即可在写作时检索。"}
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-text">库目录</label>
        <div className="flex items-center gap-2">
          <div className={cn(
            "flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-[13px] truncate",
            baseDir ? "text-text" : "text-text-faint",
          )}>
            {baseDir || "未设置"}
          </div>
          <button
            onClick={() => void handlePickDir()}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium bg-accent-soft text-accent hover:bg-accent-soft/80 transition-colors"
          >
            <FolderOpen size={14} />
            {baseDir ? "更换" : "选择目录"}
          </button>
        </div>
      </div>

      {baseDir && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text">
              已发现的库 ({libraries.length})
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleCreateLibrary()}
                className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-accent-soft text-accent hover:bg-accent-soft/80 transition-colors"
              >
                <Plus size={12} />
                新建库
              </button>
              <button onClick={() => void refreshLibraries()} className="text-[11px] text-accent hover:underline">
                刷新
              </button>
            </div>
          </div>
          {libraries.length === 0 ? (
            <div className="text-[12px] text-text-faint py-4 text-center border border-dashed border-border rounded-lg">
              该目录下未发现知识库
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {libraries.map((lib) => (
                <div
                  key={lib.id}
                  onClick={() => handleSelectLibrary(lib.id)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors",
                    "border-border hover:bg-surface-alt/50",
                    kbSelectMode && "cursor-pointer hover:border-accent/40 hover:bg-accent-soft/10",
                  )}
                >
                  <BookOpen size={16} className="text-text-muted" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-text truncate">{lib.name}</div>
                    <div className="text-[11px] text-text-muted">
                      {lib.purpose === "style" ? "风格库" : lib.purpose === "product" ? "产品库" : "素材库"}
                      {" · "}{lib.docCount}{" 篇"}
                      {kbSelectMode ? " · 点击选择" : ""}
                    </div>
                  </div>
                  {!kbSelectMode && (
                    <div className="shrink-0 flex items-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleRenameLibrary(lib.id, lib.name); }}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-muted hover:bg-surface-alt hover:text-text transition-colors"
                      >
                        <Pencil size={12} />
                        重命名
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleDeleteLibrary(lib.id, lib.name); }}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-error hover:bg-error/10 transition-colors"
                      >
                        <Trash2 size={12} />
                        删除
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TeamTabContent() {
  return (
    <div className="-m-6">
      <TeamModal onClose={() => {}} embedded />
    </div>
  );
}

/* ─── Skill Tab（简化版） ─── */

const SKILL_DESCRIPTIONS: Record<string, string> = {
  style_imitate: "绑定风格库后自动启用，在写作时自动检索样例、lint 风格、写入",
};

function SkillTabContent() {
  const skillOverrides = useSkillStore((s) => s.skillOverrides);
  const setSkillEnabled = useSkillStore((s) => s.setSkillEnabled);
  const allSkills = listRegisteredSkills();

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[12px] text-text-muted leading-relaxed">
        技能是 Agent 的增强模块，符合条件时自动激活。内置技能不可删除，仅可开关。
      </div>
      <div className="flex flex-col gap-2">
        {allSkills.map((skill) => {
          const enabled = skillOverrides[skill.id]?.enabled ?? skill.autoEnable;
          const friendlyDesc = SKILL_DESCRIPTIONS[skill.id] ?? skill.description;
          return (
            <div
              key={skill.id}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-lg border transition-all",
                enabled ? "border-accent/30 bg-accent-soft/10" : "border-border opacity-60",
              )}
            >
              <div className="w-2 h-2 rounded-full shrink-0" style={{
                backgroundColor: enabled ? "var(--color-accent)" : "var(--color-text-faint)",
              }} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-text">{skill.name}</div>
                <div className="text-[11px] text-text-muted mt-0.5 leading-relaxed">{friendlyDesc}</div>
              </div>
              <label className="teamToggle shrink-0" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setSkillEnabled(skill.id, e.target.checked)}
                />
                <span className="teamToggleSlider" />
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── MCP Tab ─── */

type TransportType = "stdio" | "streamable-http" | "sse";

const STATUS_COLORS: Record<string, string> = {
  connected: "bg-green-500",
  connecting: "bg-yellow-500 animate-pulse",
  error: "bg-red-500",
  disconnected: "bg-gray-400",
};

const TRANSPORT_ICONS: Record<TransportType, typeof Terminal> = {
  stdio: Terminal,
  "streamable-http": Globe,
  sse: Radio,
};

const TRANSPORT_LABELS: Record<TransportType, string> = {
  stdio: "stdio",
  "streamable-http": "HTTP",
  sse: "SSE",
};

// ── 浏览器状态栏（MCP 标签页顶部） ──────────────────
function BrowserStatusBar() {
  const [info, setInfo] = useState<{ path: string | null; name: string | null; autoDetected: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await (window as any).desktop?.browser?.getInfo?.();
      if (result) setInfo(result);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleResetDetect = async () => {
    setBusy(true);
    try {
      await (window as any).desktop?.browser?.resetDetect?.();
      await load();
    } catch { /* ignore */ }
    setBusy(false);
  };

  const handlePickPath = async () => {
    setBusy(true);
    try {
      const result = await (window as any).desktop?.browser?.pickPath?.();
      if (result?.ok && result.path) {
        await (window as any).desktop?.browser?.setPath?.(result.path);
        await load();
      }
    } catch { /* ignore */ }
    setBusy(false);
  };

  const handleOpenChromeDownload = () => {
    try {
      window.open("https://www.google.com/chrome/", "_blank");
    } catch { /* ignore */ }
  };

  if (!info) return null;

  const found = Boolean(info.path);
  // 截断过长路径
  const shortPath = info.path && info.path.length > 60
    ? "..." + info.path.slice(-55)
    : info.path;

  return (
    <div className={cn(
      "flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border text-[12px]",
      found
        ? "border-border bg-surface"
        : "border-yellow-500/30 bg-yellow-500/5",
    )}>
      <div className="flex items-center gap-2">
        <Monitor size={14} className={found ? "text-green-500" : "text-yellow-500"} />
        <span className="font-medium text-text">
          {found ? `系统浏览器: ${info.name || "Chromium"}` : "未检测到 Chromium 系浏览器"}
        </span>
      </div>
      {found ? (
        <>
          <div className="text-text-faint ml-[22px] truncate" title={info.path ?? ""}>
            {shortPath}
          </div>
          <div className="flex items-center gap-2 ml-[22px]">
            <span className="text-text-faint">{info.autoDetected ? "自动检测" : "手动指定"}</span>
            <span className="text-text-faint">·</span>
            <button
              onClick={handleResetDetect}
              disabled={busy}
              className="text-accent hover:underline disabled:opacity-50"
            >
              重新检测
            </button>
            <button
              onClick={handlePickPath}
              disabled={busy}
              className="text-accent hover:underline disabled:opacity-50"
            >
              手动指定
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="text-text-faint ml-[22px]">
            部分 MCP Server 需要浏览器来抓取动态网页内容
          </div>
          <div className="flex items-center gap-2 ml-[22px]">
            <button
              onClick={handlePickPath}
              disabled={busy}
              className="text-accent hover:underline disabled:opacity-50"
            >
              手动指定路径
            </button>
            <button
              onClick={handleOpenChromeDownload}
              className="flex items-center gap-1 text-accent hover:underline"
            >
              安装 Chrome <ExternalLink size={11} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function McpTabContent() {
  const servers = useMcpStore((s) => s.servers);
  const refresh = useMcpStore((s) => s.refresh);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* 浏览器状态栏 */}
      <BrowserStatusBar />

      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-text">MCP Server</div>
        <button
          onClick={() => { setShowAdd(true); setEditingId(null); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-accent-soft text-accent hover:bg-accent-soft/80 transition-colors"
        >
          <Plus size={14} />
          添加 Server
        </button>
      </div>

      {servers.length === 0 && !showAdd ? (
        <div className="flex flex-col items-center justify-center py-10 text-text-faint">
          <Plug size={32} className="mb-2 opacity-40" />
          <div className="text-[13px]">尚未配置 MCP Server</div>
          <div className="text-[11px] mt-1">点击上方「添加 Server」连接外部工具</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {servers.map((server) => (
            <McpServerCard
              key={server.id}
              server={server}
              expanded={expandedId === server.id}
              onExpand={() => setExpandedId(expandedId === server.id ? null : server.id)}
              onEdit={() => { setEditingId(server.id); setShowAdd(true); }}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <McpAddDialog
          editId={editingId}
          onClose={() => { setShowAdd(false); setEditingId(null); }}
        />
      )}
    </div>
  );
}

function McpServerCard({
  server,
  expanded,
  onExpand,
  onEdit,
}: {
  server: McpServerState;
  expanded: boolean;
  onExpand: () => void;
  onEdit: () => void;
}) {
  const removeServer = useMcpStore((s) => s.removeServer);
  const connect = useMcpStore((s) => s.connect);
  const disconnect = useMcpStore((s) => s.disconnect);
  const refresh = useMcpStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);

  const TIcon = TRANSPORT_ICONS[server.transport] ?? Terminal;
  const statusColor = STATUS_COLORS[server.status] ?? STATUS_COLORS.disconnected;

  const handleToggle = async (enable: boolean) => {
    setBusy(true);
    try {
      if (enable) {
        const api = (window as any).desktop?.mcp;
        if (api) {
          await api.updateServer(server.id, { enabled: true });
          await api.connect(server.id);
        }
      } else {
        const api = (window as any).desktop?.mcp;
        if (api) {
          await api.disconnect(server.id);
          await api.updateServer(server.id, { enabled: false });
        }
      }
      await refresh();
    } catch { /* ignore */ }
    setBusy(false);
  };

  const handleRetry = async () => {
    setBusy(true);
    try { await connect(server.id); } catch { /* ignore */ }
    await refresh();
    setBusy(false);
  };

  const handleDelete = async () => {
    await removeServer(server.id);
  };

  return (
    <div className={cn(
      "border rounded-lg overflow-hidden transition-colors",
      server.status === "connected" ? "border-green-500/30" :
      server.status === "error" ? "border-red-500/30" : "border-border",
    )}>
      {/* Header row */}
      <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-alt/50" onClick={onExpand}>
        <div className={cn("w-2 h-2 rounded-full shrink-0", statusColor)} />
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-medium text-text truncate">{server.name}</span>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-alt text-text-muted shrink-0">
              <TIcon size={10} />
              {TRANSPORT_LABELS[server.transport]}
            </span>
            {server.builtin && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent-soft text-accent shrink-0">
                <Package size={10} />
                内置
              </span>
            )}
          </div>
          {server.status === "connected" && server.tools.length > 0 && (
            <div className="text-[11px] text-text-muted mt-0.5">
              {server.tools.length} 个可用工具
            </div>
          )}
          {server.status === "error" && server.error && (
            <div className="text-[11px] text-red-500 mt-0.5 truncate" title={server.error}>
              {server.error}
            </div>
          )}
          {server.status === "connecting" && (
            <div className="text-[11px] text-yellow-600 dark:text-yellow-400 mt-0.5">
              正在连接...
            </div>
          )}
          {server.status === "disconnected" && !server.enabled && server.configFields?.length && (() => {
            const env = server.config?.env ?? {};
            const missing = server.configFields.filter((f) => f.required && !env[f.envKey]?.trim());
            const anyFilled = server.configFields.some((f) => env[f.envKey]?.trim());
            if (missing.length > 0) return (
              <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                需要配置 {missing.map((f) => f.label).join("、")}
              </div>
            );
            if (!anyFilled && server.configFields.some((f) => !f.required)) return (
              <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                需要至少配置一个 API Key
              </div>
            );
            return null;
          })()}
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {server.status === "error" && (
            <button
              onClick={handleRetry}
              disabled={busy}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-accent hover:bg-accent-soft/50 transition-colors"
              title="重试"
            >
              <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
            </button>
          )}
          <label className="teamToggle shrink-0">
            <input
              type="checkbox"
              checked={server.enabled && server.status !== "disconnected"}
              disabled={busy}
              onChange={(e) => void handleToggle(e.target.checked)}
            />
            <span className="teamToggleSlider" />
          </label>
        </div>
        {expanded ? <ChevronDown size={14} className="text-text-faint shrink-0" /> : <ChevronRight size={14} className="text-text-faint shrink-0" />}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border bg-surface-alt/30">
          {/* Tools list */}
          {server.tools.length > 0 && (
            <div className="mb-2">
              <div className="text-[11px] text-text-faint mb-1">可用工具</div>
              <div className="flex flex-wrap gap-1">
                {server.tools.map((tool) => (
                  <span
                    key={tool.name}
                    className="inline-flex items-center px-2 py-0.5 rounded-md bg-surface text-[11px] text-text-muted font-mono border border-border"
                    title={tool.description}
                  >
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}
          {/* Actions */}
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={onEdit}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-muted hover:text-accent hover:bg-accent-soft/50 transition-colors"
            >
              <Pencil size={11} /> 编辑
            </button>
            {!server.builtin && (
              <button
                onClick={() => void handleDelete()}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 size={11} /> 删除
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── MCP Add/Edit Dialog ─── */

function McpAddDialog({ editId, onClose }: { editId: string | null; onClose: () => void }) {
  const servers = useMcpStore((s) => s.servers);
  const addServer = useMcpStore((s) => s.addServer);
  const updateServer = useMcpStore((s) => s.updateServer);

  const existing = editId ? servers.find((s) => s.id === editId) : null;
  const isBundled = existing?.bundled === true;
  const configFields = existing?.configFields ?? [];
  const hasConfigFields = configFields.length > 0;

  const [transport, setTransport] = useState<TransportType>(existing?.transport ?? "stdio");
  const [name, setName] = useState(existing?.name ?? "");
  const [command, setCommand] = useState(existing?.config?.command ?? "");
  const [args, setArgs] = useState(existing?.config?.args?.join(" ") ?? "");
  const [endpoint, setEndpoint] = useState(existing?.config?.endpoint ?? "");
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string; visible: boolean }>>(
    () => {
      const env = existing?.config?.env;
      const envMap = (env && typeof env === "object") ? env : {};
      // 有 configFields 时，按字段定义初始化（保留用户已填的值）
      if (configFields.length > 0) {
        return configFields.map((f) => ({ key: f.envKey, value: envMap[f.envKey] ?? "", visible: false }));
      }
      if (Object.keys(envMap).length > 0) {
        return Object.entries(envMap).map(([k, v]) => ({ key: k, value: v, visible: false }));
      }
      return [];
    },
  );
  const [saving, setSaving] = useState(false);

  const canSave = name.trim() && (
    isBundled ? true :
    transport === "stdio" ? command.trim() :
    transport === "streamable-http" || transport === "sse" ? endpoint.trim() : false
  );

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    const config: any = {
      name: name.trim(),
      transport,
      enabled: true,
    };
    if (transport === "stdio") {
      if (!isBundled) {
        config.command = command.trim();
      }
      config.args = args.trim() ? args.trim().split(/\s+/) : [];
    } else {
      config.endpoint = endpoint.trim();
    }

    // 环境变量（空值不写入，避免覆盖系统环境变量）
    const envObj: Record<string, string> = {};
    for (const p of envPairs) {
      const k = p.key.trim();
      if (k && p.value.trim()) envObj[k] = p.value.trim();
    }
    if (Object.keys(envObj).length > 0) {
      config.env = envObj;
    }

    if (editId) {
      await updateServer(editId, config);
    } else {
      await addServer(config);
    }
    setSaving(false);
    onClose();
  };

  return (
    <div className="border border-accent/30 rounded-lg bg-surface p-4 flex flex-col gap-3">
      <div className="text-[13px] font-semibold text-text">
        {editId ? "编辑 Server" : "添加 MCP Server"}
      </div>

      {/* Transport selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-text">传输方式</label>
        <div className="flex gap-2">
          {(["stdio", "streamable-http", "sse"] as TransportType[]).map((t) => {
            const TIcon = TRANSPORT_ICONS[t];
            return (
              <button
                key={t}
                onClick={() => !isBundled && setTransport(t)}
                disabled={isBundled}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] border transition-colors",
                  transport === t
                    ? "border-accent bg-accent-soft text-accent font-medium"
                    : "border-border text-text-muted hover:bg-surface-alt",
                  isBundled && "opacity-60 cursor-not-allowed",
                )}
              >
                <TIcon size={13} />
                {TRANSPORT_LABELS[t]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Name */}
      <div className="flex flex-col gap-1">
        <label className="text-[12px] font-medium text-text">名称</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：文件系统助手"
          className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
        />
      </div>

      {/* Transport-specific fields */}
      {transport === "stdio" && (
        <>
          {!isBundled && (
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-text">命令</label>
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="例如：npx -y @anthropic/mcp-server-filesystem"
                className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
              />
            </div>
          )}
          {isBundled && (
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-text-muted">模块（内置，不可修改）</label>
              <div className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface-alt/50 text-[12px] text-text-muted font-mono">
                {existing?.config?.modulePath ?? "bundled"}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-[12px] font-medium text-text">参数（空格分隔）</label>
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="例如：/Users/me/Documents"
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
            />
          </div>
        </>
      )}
      {(transport === "streamable-http" || transport === "sse") && (
        <div className="flex flex-col gap-1">
          <label className="text-[12px] font-medium text-text">Endpoint URL</label>
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://example.com/mcp"
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
          />
        </div>
      )}

      {/* 环境变量 / API Key 配置 */}
      {hasConfigFields ? (
        <div className="flex flex-col gap-2.5">
          <label className="text-[12px] font-medium text-text">API 密钥配置</label>
          {configFields.map((field, idx) => (
            <div key={field.envKey} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-text-muted">{field.label}</label>
                {field.helpUrl && (
                  <a
                    href={field.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-[11px] text-accent hover:underline"
                    onClick={(e) => { e.stopPropagation(); (window as any).desktop?.shell?.openExternal?.(field.helpUrl); e.preventDefault(); }}
                  >
                    {field.helpText || "获取密钥"}
                    <ExternalLink size={10} />
                  </a>
                )}
                {field.required && (
                  <span className="text-[10px] text-red-500/70 font-medium">必填</span>
                )}
              </div>
              <div className="relative">
                <input
                  type={envPairs[idx]?.visible ? "text" : "password"}
                  value={envPairs[idx]?.value ?? ""}
                  onChange={(e) => {
                    const next = [...envPairs];
                    next[idx] = { ...next[idx], value: e.target.value };
                    setEnvPairs(next);
                  }}
                  placeholder={field.placeholder || "请输入..."}
                  className="w-full px-3 py-1.5 pr-8 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = [...envPairs];
                    next[idx] = { ...next[idx], visible: !next[idx]?.visible };
                    setEnvPairs(next);
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-muted transition-colors"
                >
                  {envPairs[idx]?.visible ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-text">环境变量</label>
        {envPairs.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {envPairs.map((pair, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={pair.key}
                  onChange={(e) => {
                    const next = [...envPairs];
                    next[idx] = { ...pair, key: e.target.value };
                    setEnvPairs(next);
                  }}
                  placeholder="KEY"
                  className="w-[40%] px-2.5 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
                />
                <div className="relative flex-1">
                  <input
                    type={pair.visible ? "text" : "password"}
                    value={pair.value}
                    onChange={(e) => {
                      const next = [...envPairs];
                      next[idx] = { ...pair, value: e.target.value };
                      setEnvPairs(next);
                    }}
                    placeholder="value"
                    className="w-full px-2.5 py-1.5 pr-8 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...envPairs];
                      next[idx] = { ...pair, visible: !pair.visible };
                      setEnvPairs(next);
                    }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-muted transition-colors"
                  >
                    {pair.visible ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setEnvPairs(envPairs.filter((_, i) => i !== idx))}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-text-faint hover:text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setEnvPairs([...envPairs, { key: "", value: "", visible: false }])}
          className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-accent transition-colors self-start"
        >
          <Plus size={12} />
          添加环境变量
        </button>
      </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 mt-1">
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg text-[12px] text-text-muted hover:bg-surface-alt transition-colors"
        >
          取消
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={!canSave || saving}
          className={cn(
            "px-4 py-1.5 rounded-lg text-[12px] font-medium transition-colors",
            canSave && !saving
              ? "bg-accent text-white hover:bg-accent/90"
              : "bg-surface-alt text-text-faint cursor-not-allowed",
          )}
        >
          {saving ? "保存中..." : editId ? "保存" : "添加"}
        </button>
      </div>
    </div>
  );
}
