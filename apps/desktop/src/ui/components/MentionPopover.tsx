import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Sparkles, Search, BookOpen, Package, FileText, FolderOpen, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUILTIN_SUB_AGENTS } from "@writing-ide/agent-core";
import { useKbStore } from "@/state/kbStore";

export type MentionItem = {
  id: string;
  type: "skill" | "kb" | "file" | "agent";
  label: string;
  icon: React.ReactNode;
};

type Props = {
  query: string;
  visible: boolean;
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
  /** 锚点位置（输入框上方） */
  anchorBottom: number;
  anchorLeft: number;
};

const SKILL_ITEMS: MentionItem[] = [
  { id: "style_imitate", type: "skill", label: "风格仿写", icon: <Sparkles size={14} /> },
  { id: "web_topic_radar", type: "skill", label: "全网调研", icon: <Search size={14} /> },
  { id: "corpus_ingest", type: "skill", label: "学风格/抽卡", icon: <BookOpen size={14} /> },
  { id: "writing_batch", type: "skill", label: "批量写作", icon: <Package size={14} /> },
];

export function MentionPopover({
  query,
  visible,
  onSelect,
  onClose,
  anchorBottom,
  anchorLeft,
}: Props) {
  const kbLibraries = useKbStore((s) => s.libraries);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // 构建可搜索项
  const kbItems: MentionItem[] = useMemo(
    () =>
      (kbLibraries ?? []).map((lib: any) => ({
        id: String(lib.id ?? ""),
        type: "kb" as const,
        label: String(lib.name ?? lib.id),
        icon: <BookOpen size={14} />,
      })),
    [kbLibraries],
  );

  const agentItems: MentionItem[] = useMemo(
    () => BUILTIN_SUB_AGENTS.filter(a => a.enabled).map(a => ({
      id: a.id,
      type: "agent" as const,
      label: `${a.avatar ?? "🤖"} ${a.name}`,
      icon: <Users size={14} />,
    })),
    [],
  );
  
  const allItems = useMemo(() => [...agentItems, ...SKILL_ITEMS, ...kbItems], [agentItems, kbItems]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return allItems;
    return allItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q),
    );
  }, [query, allItems]);

  // 重置选中
  useEffect(() => {
    setSelectedIdx(0);
  }, [filtered.length, query]);

  // 键盘导航
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter" && filtered.length > 0) {
        e.preventDefault();
        onSelect(filtered[selectedIdx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [visible, filtered, selectedIdx, onSelect, onClose],
  );

  useEffect(() => {
    if (!visible) return;
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [visible, handleKeyDown]);

  if (!visible || filtered.length === 0) return null;

  // 按类别分组
  const agents = filtered.filter((i) => i.type === "agent");
  const skills = filtered.filter((i) => i.type === "skill");
  const kbs = filtered.filter((i) => i.type === "kb");
  const files = filtered.filter((i) => i.type === "file");

  return (
    <div
      className={cn(
        "fixed z-[100] w-[260px] max-h-[320px] overflow-y-auto",
        "rounded-xl border border-border bg-surface shadow-lg backdrop-blur-xl",
        "py-1.5",
      )}
      style={{ bottom: anchorBottom, left: anchorLeft }}
    >
      {agents.length > 0 && (
        <Group label="团队成员">
          {agents.map((item) => (
            <Item
              key={item.id}
              item={item}
              selected={filtered[selectedIdx]?.id === item.id}
              onSelect={onSelect}
              colorClass="text-emerald-500"
            />
          ))}
        </Group>
      )}
      {skills.length > 0 && (
        <Group label="技能">
          {skills.map((item) => (
            <Item
              key={item.id}
              item={item}
              selected={filtered[selectedIdx]?.id === item.id}
              onSelect={onSelect}
              colorClass="text-accent"
            />
          ))}
        </Group>
      )}
      {kbs.length > 0 && (
        <Group label="知识库">
          {kbs.map((item) => (
            <Item
              key={item.id}
              item={item}
              selected={filtered[selectedIdx]?.id === item.id}
              onSelect={onSelect}
              colorClass="text-blue-500"
            />
          ))}
        </Group>
      )}
      {files.length > 0 && (
        <Group label="文件">
          {files.map((item) => (
            <Item
              key={item.id}
              item={item}
              selected={filtered[selectedIdx]?.id === item.id}
              onSelect={onSelect}
              colorClass="text-text-muted"
            />
          ))}
        </Group>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-faint font-medium">
        {label}
      </div>
      {children}
    </div>
  );
}

function Item({
  item,
  selected,
  onSelect,
  colorClass,
}: {
  item: MentionItem;
  selected: boolean;
  onSelect: (item: MentionItem) => void;
  colorClass: string;
}) {
  return (
    <button
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-1.5 text-left text-[13px]",
        "transition-colors duration-fast",
        selected ? "bg-accent-soft text-text" : "text-text-muted hover:bg-surface-alt",
      )}
      onClick={() => onSelect(item)}
      onMouseDown={(e) => e.preventDefault()} // 防止 blur 关闭
    >
      <span className={cn("shrink-0", colorClass)}>{item.icon}</span>
      <span className="truncate">{item.label}</span>
    </button>
  );
}
