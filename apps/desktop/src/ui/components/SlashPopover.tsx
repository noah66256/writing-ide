import { useState, useEffect, useCallback, useMemo } from "react";
import { BookOpen, Sparkles } from "lucide-react";
import { listRegisteredSkills } from "@writing-ide/agent-core";
import { cn } from "@/lib/utils";
import { useKbStore } from "@/state/kbStore";
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
  group: "skills" | "kb";
  item: MentionItem;
  desc?: string;
  searchText: string;
};

const PURPOSE_LABEL: Record<string, string> = {
  material: "素材库",
  style: "风格库",
  product: "产品库",
};

export function SlashPopover({ query, visible, onSelect, onClose }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const libraries = useKbStore((s) => s.libraries);
  const skillOverrides = useSkillStore((s) => s.skillOverrides);
  const externalSkills = useSkillStore((s) => s.externalSkills);

  const allSkills = useMemo(
    () => [...listRegisteredSkills(), ...externalSkills],
    [externalSkills],
  );
  const enabledSkills = useMemo(
    () => allSkills.filter((sk) => skillOverrides[sk.id]?.enabled ?? sk.autoEnable),
    [allSkills, skillOverrides],
  );

  const q = query.toLowerCase().trim();

  const skillEntries = useMemo<SlashEntry[]>(
    () =>
      enabledSkills
        .map((sk) => ({
          key: `skill:${sk.id}`,
          group: "skills" as const,
          item: {
            id: sk.id,
            type: "skill" as const,
            label: sk.name,
            icon: <Sparkles size={14} />,
          },
          desc: `${sk.ui.badge} · ${sk.description}`,
          searchText: `${sk.id} ${sk.name} ${sk.description} ${sk.ui.badge}`.toLowerCase(),
        }))
        .filter((e) => !q || e.searchText.includes(q)),
    [enabledSkills, q],
  );

  const kbEntries = useMemo<SlashEntry[]>(
    () =>
      libraries
        .map((lib) => {
          const purpose = PURPOSE_LABEL[lib.purpose] ?? lib.purpose;
          return {
            key: `kb:${lib.id}`,
            group: "kb" as const,
            item: {
              id: lib.id,
              type: "kb" as const,
              label: lib.name,
              icon: <BookOpen size={14} />,
            },
            desc: `${purpose} · ${lib.docCount} 篇文档`,
            searchText: `${lib.id} ${lib.name} ${lib.purpose} ${purpose}`.toLowerCase(),
          };
        })
        .filter((e) => !q || e.searchText.includes(q)),
    [libraries, q],
  );

  const actions = useMemo(() => [...skillEntries, ...kbEntries], [skillEntries, kbEntries]);

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
        {skillEntries.length > 0 && <SectionLabel text="技能" />}
        {skillEntries.map((entry) => (
          <SlashRow key={entry.key} entry={entry} selected={selectedKey === entry.key} colorClass="text-accent" onSelect={onSelect} />
        ))}

        {kbEntries.length > 0 && <SectionLabel text="知识库" />}
        {kbEntries.map((entry) => (
          <SlashRow key={entry.key} entry={entry} selected={selectedKey === entry.key} colorClass="text-blue-500" onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

/* ─── 子组件 ─── */

function SectionLabel({ text }: { text: string }) {
  return <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-faint font-medium">{text}</div>;
}

function SlashRow({ entry, selected, colorClass, onSelect }: { entry: SlashEntry; selected: boolean; colorClass: string; onSelect: (item: MentionItem) => void }) {
  return (
    <button
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-1.5 text-left text-[13px]",
        "transition-colors duration-fast",
        selected ? "bg-accent-soft text-text" : "text-text-muted hover:bg-surface-alt",
      )}
      onClick={() => onSelect(entry.item)}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className={cn("shrink-0", colorClass)}>{entry.item.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{entry.item.label}</span>
        {entry.desc && <span className="block truncate text-[11px] text-text-faint">{entry.desc}</span>}
      </span>
    </button>
  );
}
