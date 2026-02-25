import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  X, Users, Plug, Sparkles, ChevronDown, ChevronRight, Plus,
  Bot, BookOpen, FolderOpen, Link2, Unlink, RefreshCw, Pencil, Trash2, Terminal, Globe, Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TeamModal } from "@/components/TeamModal";
import { listRegisteredSkills, type SkillManifest } from "@writing-ide/agent-core";
import { useSkillStore } from "@/state/skillStore";
import { usePersonaStore } from "@/state/personaStore";
import { useKbStore } from "@/state/kbStore";
import { useRunStore } from "@/state/runStore";
import { useMcpStore, type McpServerState } from "@/state/mcpStore";

type Tab = "persona" | "team" | "mcp" | "skill" | "kb";

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "persona", label: "负责人", icon: Bot },
  { id: "kb", label: "知识库", icon: BookOpen },
  { id: "team", label: "团队管理", icon: Users },
  { id: "mcp", label: "MCP", icon: Plug },
  { id: "skill", label: "技能", icon: Sparkles },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("persona");

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
            {tab === "kb" && <KbTabContent />}
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

function KbTabContent() {
  const baseDir = useKbStore((s) => s.baseDir);
  const libraries = useKbStore((s) => s.libraries);
  const refreshLibraries = useKbStore((s) => s.refreshLibraries);
  const kbAttachedIds = useRunStore((s) => s.kbAttachedLibraryIds);
  const setKbAttached = useRunStore((s) => s.setKbAttachedLibraries);

  const handlePickDir = async () => {
    const api = window.desktop?.fs;
    if (!api) return;
    const res = await api.pickDirectory();
    if (!res?.ok || !res.dir) return;
    useKbStore.getState().setBaseDir(res.dir);
    await refreshLibraries().catch(() => void 0);
  };

  const toggleAttach = (libId: string, purpose: string) => {
    const cur = kbAttachedIds;
    if (cur.includes(libId)) {
      setKbAttached(cur.filter((x) => x !== libId));
    } else {
      if (purpose === "style") {
        const styleIds = new Set(libraries.filter((l) => l.purpose === "style").map((l) => l.id));
        const keep = cur.filter((x) => !styleIds.has(x));
        setKbAttached([...keep, libId]);
      } else {
        setKbAttached([...cur, libId]);
      }
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[12px] text-text-muted leading-relaxed">
        知识库存储在本地磁盘，选择目录后自动发现库文件。关联后，Agent 的 kb.search 会自动搜索这些库，也可在输入框 @ 提及。
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
            <button onClick={() => void refreshLibraries()} className="text-[11px] text-accent hover:underline">
              刷新
            </button>
          </div>
          {libraries.length === 0 ? (
            <div className="text-[12px] text-text-faint py-4 text-center border border-dashed border-border rounded-lg">
              该目录下未发现知识库
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {libraries.map((lib) => {
                const attached = kbAttachedIds.includes(lib.id);
                return (
                  <div
                    key={lib.id}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors",
                      attached ? "border-accent/40 bg-accent-soft/20" : "border-border hover:bg-surface-alt/50",
                    )}
                  >
                    <BookOpen size={16} className={attached ? "text-accent" : "text-text-muted"} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-text truncate">{lib.name}</div>
                      <div className="text-[11px] text-text-muted">
                        {lib.purpose === "style" ? "风格库" : lib.purpose === "product" ? "产品库" : "素材库"}
                        {" · "}{lib.docCount}{" 篇"}
                      </div>
                    </div>
                    <button
                      onClick={() => toggleAttach(lib.id, lib.purpose)}
                      className={cn(
                        "shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors",
                        attached
                          ? "bg-accent/10 text-accent hover:bg-error/10 hover:text-error"
                          : "bg-surface-alt text-text-muted hover:bg-accent-soft hover:text-accent",
                      )}
                    >
                      {attached ? <><Unlink size={12} />取消关联</> : <><Link2 size={12} />关联</>}
                    </button>
                  </div>
                );
              })}
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
  corpus_ingest: "识别到「抽卡/学风格/导入语料」时自动启用导入流程",
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

function McpTabContent() {
  const servers = useMcpStore((s) => s.servers);
  const refresh = useMcpStore((s) => s.refresh);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  return (
    <div className="flex flex-col gap-4">
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
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-text truncate">{server.name}</span>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-alt text-text-muted shrink-0">
              <TIcon size={10} />
              {TRANSPORT_LABELS[server.transport]}
            </span>
          </div>
          {server.status === "connected" && server.tools.length > 0 && (
            <div className="text-[11px] text-text-muted mt-0.5">
              {server.tools.length} 个可用工具
            </div>
          )}
          {server.status === "error" && server.error && (
            <div className="text-[11px] text-red-500 mt-0.5 truncate">
              {server.error}
            </div>
          )}
          {server.status === "connecting" && (
            <div className="text-[11px] text-yellow-600 dark:text-yellow-400 mt-0.5">
              正在连接...
            </div>
          )}
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
            <button
              onClick={() => void handleDelete()}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={11} /> 删除
            </button>
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

  const [transport, setTransport] = useState<TransportType>(existing?.transport ?? "stdio");
  const [name, setName] = useState(existing?.name ?? "");
  const [command, setCommand] = useState(existing?.config?.command ?? "");
  const [args, setArgs] = useState(existing?.config?.args?.join(" ") ?? "");
  const [endpoint, setEndpoint] = useState(existing?.config?.endpoint ?? "");
  const [saving, setSaving] = useState(false);

  const canSave = name.trim() && (
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
      config.command = command.trim();
      config.args = args.trim() ? args.trim().split(/\s+/) : [];
    } else {
      config.endpoint = endpoint.trim();
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
                onClick={() => setTransport(t)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] border transition-colors",
                  transport === t
                    ? "border-accent bg-accent-soft text-accent font-medium"
                    : "border-border text-text-muted hover:bg-surface-alt",
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
