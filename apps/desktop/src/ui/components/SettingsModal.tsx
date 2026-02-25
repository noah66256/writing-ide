import { useState } from "react";
import { createPortal } from "react-dom";
import { X, Users, Plug, Sparkles, ChevronDown, ChevronRight, Plus, Info, Bot, BookOpen, FolderOpen, Link2, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";
import { TeamModal } from "@/components/TeamModal";
import { SKILL_MANIFESTS_V1, type SkillManifest, type TriggerRule } from "@writing-ide/agent-core";
import { useSkillStore } from "@/state/skillStore";
import { usePersonaStore } from "@/state/personaStore";
import { useKbStore } from "@/state/kbStore";
import { useRunStore } from "@/state/runStore";

type Tab = "persona" | "team" | "mcp" | "skill" | "kb";

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "persona", label: "\u8d1f\u8d23\u4eba", icon: Bot },
  { id: "kb", label: "\u77e5\u8bc6\u5e93", icon: BookOpen },
  { id: "team", label: "\u56e2\u961f\u7ba1\u7406", icon: Users },
  { id: "mcp", label: "MCP", icon: Plug },
  { id: "skill", label: "\u6280\u80fd", icon: Sparkles },
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
            {"\u8bbe\u7f6e"}
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
        {"\u4e2a\u6027\u5316\u4f60\u7684 AI \u8d1f\u8d23\u4eba\uff0c\u8bbe\u5b9a\u5b83\u7684\u540d\u5b57\u548c\u6027\u683c\u3002\u8fd9\u4e0d\u4f1a\u5f71\u54cd\u7cfb\u7edf\u80fd\u529b\uff0c\u53ea\u662f\u8ba9\u4f53\u9a8c\u66f4\u4eb2\u5207\u3002"}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-text">
          {"\u8d1f\u8d23\u4eba\u540d\u79f0"}
        </label>
        <input
          type="text"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="Friday"
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-[13px] text-text placeholder:text-text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
        />
        <div className="text-[11px] text-text-faint">
          {"\u7559\u7a7a\u9ed8\u8ba4\u4e3a Friday"}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-text">
          {"\u4e2a\u6027\u5316\u63cf\u8ff0"}
        </label>
        <textarea
          value={personaPrompt}
          onChange={(e) => setPersonaPrompt(e.target.value)}
          placeholder={"\u4f8b\u5982\uff1a\u53eb\u6211\u8001\u677f\uff0c\u8bf4\u8bdd\u5e72\u7ec3\u7b80\u6d01\uff0c\u7528\u5e7d\u9ed8\u7684\u8bed\u6c14\uff0c\u504f\u597d\u53e3\u8bed\u5316\u8868\u8fbe"}
          rows={4}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-[13px] text-text placeholder:text-text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors resize-none leading-relaxed"
        />
        <div className="text-[11px] text-text-faint">
          {"\u63cf\u8ff0\u4f60\u5e0c\u671b\u7684\u8bf4\u8bdd\u98ce\u683c\u3001\u79f0\u547c\u65b9\u5f0f\u3001\u6027\u683c\u7279\u70b9\u7b49"}
        </div>
      </div>
    </div>
  );
}

/* ─── KB Tab ─── */

function KbTabContent() {
  const baseDir = useKbStore((s) => s.baseDir);
  const libraries = useKbStore((s) => s.libraries);
  const pickBaseDir = useKbStore((s) => s.pickBaseDir);
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
      // style library: single-select (replace other style libs)
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
        {"\u77e5\u8bc6\u5e93\u5b58\u50a8\u5728\u672c\u5730\u78c1\u76d8\uff0c\u9009\u62e9\u76ee\u5f55\u540e\u81ea\u52a8\u53d1\u73b0\u5e93\u6587\u4ef6\u3002\u5173\u8054\u540e\uff0cAgent \u7684 kb.search \u4f1a\u81ea\u52a8\u641c\u7d22\u8fd9\u4e9b\u5e93\uff0c\u4e5f\u53ef\u5728\u8f93\u5165\u6846 @ \u63d0\u53ca\u3002"}
      </div>

      {/* Directory picker */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-text">
          {"\u5e93\u76ee\u5f55"}
        </label>
        <div className="flex items-center gap-2">
          <div className={cn(
            "flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-[13px] truncate",
            baseDir ? "text-text" : "text-text-faint",
          )}>
            {baseDir || "\u672a\u8bbe\u7f6e"}
          </div>
          <button
            onClick={() => void handlePickDir()}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium bg-accent-soft text-accent hover:bg-accent-soft/80 transition-colors"
          >
            <FolderOpen size={14} />
            {baseDir ? "\u66f4\u6362" : "\u9009\u62e9\u76ee\u5f55"}
          </button>
        </div>
      </div>

      {/* Library list */}
      {baseDir && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text">
              {"\u5df2\u53d1\u73b0\u7684\u5e93"} ({libraries.length})
            </span>
            <button
              onClick={() => void refreshLibraries()}
              className="text-[11px] text-accent hover:underline"
            >
              {"\u5237\u65b0"}
            </button>
          </div>

          {libraries.length === 0 ? (
            <div className="text-[12px] text-text-faint py-4 text-center border border-dashed border-border rounded-lg">
              {"\u8be5\u76ee\u5f55\u4e0b\u672a\u53d1\u73b0\u77e5\u8bc6\u5e93"}
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
                        {lib.purpose === "style" ? "\u98ce\u683c\u5e93" : lib.purpose === "product" ? "\u4ea7\u54c1\u5e93" : "\u7d20\u6750\u5e93"}
                        {" \u00b7 "}{lib.docCount}{" \u7bc7"}
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
                      {attached ? <><Unlink size={12} />{"\u53d6\u6d88\u5173\u8054"}</> : <><Link2 size={12} />{"\u5173\u8054"}</>}
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

/* ─── Skill Tab ─── */

const BADGE_COLORS: Record<string, string> = {
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  purple: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  orange: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  teal: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  green: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
};

function triggerSummary(rule: TriggerRule): string {
  const w = rule.when;
  const a = rule.args as Record<string, unknown>;
  if (w === "mode_in") {
    const modes = Array.isArray(a?.modes) ? a.modes.join("/") : "";
    return `\u6a21\u5f0f: ${modes}`;
  }
  if (w === "has_style_library") return "\u5df2\u7ed1\u5b9a\u98ce\u683c\u5e93";
  if (w === "run_intent_in") {
    const intents = Array.isArray(a?.intents) ? a.intents.join("/") : "";
    return `\u610f\u56fe: ${intents}`;
  }
  if (w === "text_regex") return "\u6587\u672c\u6b63\u5219\u5339\u914d";
  return w;
}

function SkillTabContent() {
  const skillOverrides = useSkillStore((s) => s.skillOverrides);
  const setSkillEnabled = useSkillStore((s) => s.setSkillEnabled);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-text">
          {"\u5185\u7f6e\u6280\u80fd"} ({SKILL_MANIFESTS_V1.length})
        </div>
      </div>
      <div className="text-[12px] text-text-muted leading-relaxed">
        {"\u6280\u80fd\u662f\u5bf9 Agent \u884c\u4e3a\u7684\u589e\u5f3a\u6a21\u5757\uff0c\u901a\u8fc7\u6761\u4ef6\u89e6\u53d1\u81ea\u52a8\u6fc0\u6d3b\u3002\u5f00\u542f\u540e\uff0c\u7b26\u5408\u6761\u4ef6\u65f6\u4f1a\u81ea\u52a8\u6ce8\u5165 prompt \u7247\u6bb5\u5e76\u63a7\u5236\u5de5\u5177\u6743\u9650\u3002"}
      </div>
      <div className="flex flex-col gap-2">
        {SKILL_MANIFESTS_V1.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            enabled={skillOverrides[skill.id]?.enabled ?? skill.autoEnable}
            expanded={expandedId === skill.id}
            onToggle={(v) => setSkillEnabled(skill.id, v)}
            onExpand={() => setExpandedId(expandedId === skill.id ? null : skill.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SkillCard({
  skill,
  enabled,
  expanded,
  onToggle,
  onExpand,
}: {
  skill: SkillManifest;
  enabled: boolean;
  expanded: boolean;
  onToggle: (v: boolean) => void;
  onExpand: () => void;
}) {
  const badgeColor = BADGE_COLORS[skill.ui.color ?? "blue"] ?? BADGE_COLORS.blue;

  return (
    <div className={cn("border border-border rounded-lg overflow-hidden transition-opacity", !enabled && "opacity-55")}>
      <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-alt/50" onClick={onExpand}>
        {expanded ? <ChevronDown size={14} className="text-text-faint shrink-0" /> : <ChevronRight size={14} className="text-text-faint shrink-0" />}
        <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide shrink-0", badgeColor)}>
          {skill.ui.badge}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-text truncate">{skill.name}</div>
          <div className="text-[11px] text-text-muted truncate">{skill.description}</div>
        </div>
        <label className="teamToggle shrink-0" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="teamToggleSlider" />
        </label>
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border bg-surface-alt/30">
          <div className="grid grid-cols-[80px_1fr] gap-y-1.5 text-[12px]">
            <span className="text-text-faint">{"\u4f18\u5148\u7ea7"}</span>
            <span className="text-text">{skill.priority}</span>

            <span className="text-text-faint">{"\u89e6\u53d1\u6761\u4ef6"}</span>
            <span className="text-text">{skill.triggers.map(triggerSummary).join(" + ")}</span>

            {skill.conflicts?.length ? (
              <>
                <span className="text-text-faint">{"\u4e92\u65a5"}</span>
                <span className="text-text">{skill.conflicts.join(", ")}</span>
              </>
            ) : null}

            {skill.requires?.length ? (
              <>
                <span className="text-text-faint">{"\u4f9d\u8d56"}</span>
                <span className="text-text">{skill.requires.join(", ")}</span>
              </>
            ) : null}

            {skill.toolCaps?.allowTools?.length ? (
              <>
                <span className="text-text-faint">{"\u5141\u8bb8\u5de5\u5177"}</span>
                <span className="text-text font-mono text-[11px]">{skill.toolCaps.allowTools.join(", ")}</span>
              </>
            ) : null}

            {skill.toolCaps?.denyTools?.length ? (
              <>
                <span className="text-text-faint">{"\u7981\u7528\u5de5\u5177"}</span>
                <span className="text-text font-mono text-[11px]">{skill.toolCaps.denyTools.join(", ")}</span>
              </>
            ) : null}

            <span className="text-text-faint">{"\u7248\u672c"}</span>
            <span className="text-text">{skill.version ?? "1.0.0"}</span>

            <span className="text-text-faint">Stage</span>
            <span className="text-text font-mono text-[11px]">{skill.stageKey}</span>
          </div>
          {skill.promptFragments.system && (
            <div className="mt-2">
              <div className="text-[11px] text-text-faint mb-1">System Prompt</div>
              <div className="text-[11px] text-text-muted bg-surface rounded px-2 py-1.5 max-h-[100px] overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed">
                {skill.promptFragments.system.slice(0, 300)}{skill.promptFragments.system.length > 300 ? "..." : ""}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── MCP Tab ─── */

function McpTabContent() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-text">MCP Server</div>
        <button
          disabled
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-accent-soft text-accent opacity-50 cursor-not-allowed"
        >
          <Plus size={14} />
          {"\u6dfb\u52a0 Server"}
        </button>
      </div>

      <div className="flex items-start gap-3 p-3 rounded-lg bg-surface-alt/50 border border-border">
        <Info size={16} className="text-accent shrink-0 mt-0.5" />
        <div className="text-[12px] text-text-muted leading-relaxed">
          <p className="font-medium text-text mb-1">
            {"\u4ec0\u4e48\u662f MCP\uff1f"}
          </p>
          <p>
            {"MCP (Model Context Protocol) \u662f Anthropic \u63d0\u51fa\u7684\u6a21\u578b\u4e0a\u4e0b\u6587\u534f\u8bae\uff0c\u5141\u8bb8 AI \u5e94\u7528\u901a\u8fc7\u6807\u51c6\u5316\u63a5\u53e3\u8fde\u63a5\u5916\u90e8\u5de5\u5177\u548c\u6570\u636e\u6e90\u3002\u914d\u7f6e MCP Server \u540e\uff0c\u5176\u63d0\u4f9b\u7684\u5de5\u5177\u4f1a\u81ea\u52a8\u6ce8\u5165 Agent \u53ef\u7528\u5de5\u5177\u6c60\u3002"}
          </p>
        </div>
      </div>

      <div className="text-[12px] text-text-muted leading-relaxed">
        <p className="font-medium text-text mb-1.5">
          {"\u652f\u6301\u7684\u4f20\u8f93\u6a21\u5f0f"}
        </p>
        <div className="grid grid-cols-3 gap-2">
          <TransportCard
            label="stdio"
            desc={"\u672c\u5730\u5b50\u8fdb\u7a0b\uff0c\u901a\u8fc7 JSON-RPC \u901a\u4fe1"}
          />
          <TransportCard
            label="HTTP"
            desc={"Streamable HTTP\uff0c\u9002\u5408\u8fdc\u7a0b\u670d\u52a1"}
          />
          <TransportCard
            label="SSE"
            desc={"Server-Sent Events\uff0c\u5b9e\u65f6\u63a8\u9001"}
          />
        </div>
      </div>

      <div className="flex flex-col items-center justify-center py-8 text-text-faint">
        <Plug size={32} className="mb-2 opacity-40" />
        <div className="text-[13px]">{"\u5c1a\u672a\u914d\u7f6e MCP Server"}</div>
        <div className="text-[11px] mt-1">{"\u5f85 MCP Client \u5b9e\u88c5\u540e\u53ef\u5728\u6b64\u6dfb\u52a0\u548c\u7ba1\u7406"}</div>
      </div>
    </div>
  );
}

function TransportCard({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="border border-border rounded-lg px-2.5 py-2">
      <div className="text-[12px] font-medium text-text font-mono">{label}</div>
      <div className="text-[11px] text-text-muted mt-0.5">{desc}</div>
    </div>
  );
}
