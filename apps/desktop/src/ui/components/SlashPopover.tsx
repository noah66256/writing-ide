import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Sparkles } from "lucide-react";
import { listRegisteredSkills } from "@ohmycrab/agent-core";
import { cn } from "@/lib/utils";
import { useSkillStore } from "@/state/skillStore";
import type { MentionItem } from "./MentionPopover";

type Props = {
  query: string;
  visible: boolean;
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
};

type SlashEntry = {
  key: string;
  item: MentionItem;
  desc?: string;
  searchText: string;
};

export function SlashPopover({ query, visible, onSelect, onClose }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const skillOverrides = useSkillStore((s) => s.skillOverrides);
  const externalSkills = useSkillStore((s) => s.externalSkills);

  const allSkills = useMemo(
    () => [...listRegisteredSkills(), ...externalSkills],
    [externalSkills],
  );
  const enabledSkills = useMemo(
    () =>
      allSkills.filter((sk) =>
        (skillOverrides[sk.id]?.enabled ?? true) &&
        sk.userInvocable !== false,
      ),
    [allSkills, skillOverrides],
  );

  const q = query.toLowerCase().trim();

  const actions = useMemo<SlashEntry[]>(
    () =>
      enabledSkills
        .map((sk) => ({
          key: `skill:${sk.id}`,
          item: {
            id: sk.id,
            type: "skill" as const,
            label: `/${sk.id}`,
            icon: <Sparkles size={14} />,
          },
          desc: `${sk.ui.badge} · ${sk.description}${sk.argumentHint ? ` · 参数：${sk.argumentHint}` : ""}`,
          searchText: `${sk.id} ${sk.name} ${sk.description} ${sk.ui.badge}`.toLowerCase(),
        }))
        .filter((e) => !q || e.searchText.includes(q)),
    [enabledSkills, q],
  );

  // 重置选中
  useEffect(() => { setSelectedIdx(0); }, [query, actions.length]);
  useEffect(() => { if (!visible) setSelectedIdx(0); }, [visible]);

  // 键盘导航（capture phase）
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible || e.isComposing) return;

      if (e.key === "ArrowDown" && actions.length) {
        e.preventDefault(); e.stopImmediatePropagation();
        setSelectedIdx((i) => (i + 1) % actions.length);
      } else if (e.key === "ArrowUp" && actions.length) {
        e.preventDefault(); e.stopImmediatePropagation();
        setSelectedIdx((i) => (i - 1 + actions.length) % actions.length);
      } else if (e.key === "Enter" && actions.length) {
        e.preventDefault(); e.stopImmediatePropagation();
        const a = actions[selectedIdx] ?? actions[0];
        if (a) onSelect(a.item);
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopImmediatePropagation();
        onClose();
      }
    },
    [visible, actions, selectedIdx, onSelect, onClose],
  );

  useEffect(() => {
    if (!visible) return;
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [visible, handleKeyDown]);

  if (!visible || actions.length === 0) return null;

  const selectedKey = actions[selectedIdx]?.key;

  return (
    <div
      className={cn(
        "absolute inset-x-1 bottom-[46px] z-50",
        "max-h-[280px] overflow-hidden",
        "rounded-lg border border-border bg-surface shadow-md",
      )}
    >
      <div className="max-h-[240px] overflow-y-auto py-1.5">
        {actions.map((entry) => (
          <SlashRow key={entry.key} entry={entry} selected={selectedKey === entry.key} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

/* ─── 子组件 ─── */

function SlashRow({ entry, selected, onSelect }: { entry: SlashEntry; selected: boolean; onSelect: (item: MentionItem) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  return (
    <button
      ref={ref}
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-1.5 text-left text-[13px]",
        "transition-colors duration-fast",
        selected ? "bg-accent-soft text-text" : "text-text-muted hover:bg-surface-alt",
      )}
      onClick={() => onSelect(entry.item)}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className={cn("shrink-0", "text-accent")}>{entry.item.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{entry.item.label}</span>
        {entry.desc && <span className="block truncate text-[11px] text-text-faint">{entry.desc}</span>}
      </span>
    </button>
  );
}
