import { Fragment, useState, useEffect, useCallback, useMemo } from "react";
import { ChevronLeft, ChevronRight, FileText, Folder, FolderOpen, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTeamStore, getEffectiveAgents } from "@/state/teamStore";
import { useProjectStore } from "@/state/projectStore";

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
};

type ActiveGroup = null | "agents" | "files";

/** 统一 action 模型：键盘导航不区分分组入口 / 目录 / mention 选项 */
type PopoverAction =
  | { key: string; kind: "group"; group: "agents" | "files" }
  | { key: string; kind: "dir"; path: string }
  | { key: string; kind: "mention"; item: MentionItem };

/* ─── 路径工具 ─── */

function normRel(s: string) {
  return String(s ?? "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
function baseName(p: string) {
  const s = normRel(p);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}
function parentOf(p: string) {
  const s = normRel(p);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(0, i) : "";
}

/** 从 files + dirs 构造完整目录集合（含父级补全） */
function buildDirSet(filePaths: string[], rawDirs: string[]): Set<string> {
  const out = new Set<string>();
  const addWithParents = (p: string) => {
    const parts = normRel(p).split("/");
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  };
  for (const d of rawDirs) addWithParents(d);
  for (const f of filePaths) { const p = parentOf(f); if (p) addWithParents(p); }
  return out;
}

/** 当前层级的子目录+子文件 */
function levelEntries(dir: string, filePaths: string[], dirSet: Set<string>) {
  const prefix = dir ? `${dir}/` : "";
  const depth = dir ? dir.split("/").length + 1 : 1;

  const subDirs: Array<{ kind: "dir"; path: string; name: string }> = [];
  for (const d of dirSet) {
    if (d.startsWith(prefix) && d.split("/").length === depth) {
      subDirs.push({ kind: "dir", path: d, name: baseName(d) });
    }
  }

  const subFiles: Array<{ kind: "file"; path: string; name: string }> = [];
  for (const f of filePaths) {
    if (f.startsWith(prefix) && f.split("/").length === depth) {
      subFiles.push({ kind: "file", path: f, name: baseName(f) });
    }
  }

  subDirs.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  subFiles.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return [...subDirs, ...subFiles];
}

/* ─── MentionPopover ─── */

export function MentionPopover({ query, visible, onSelect, onClose }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [activeGroup, setActiveGroup] = useState<ActiveGroup>(null);
  const [currentDir, setCurrentDir] = useState("");

  // 数据源
  const rootDir = useProjectStore((s) => s.rootDir);
  const storeFiles = useProjectStore((s) => s.files);
  const storeDirs = useProjectStore((s) => s.dirs);
  const agentOverrides = useTeamStore((s) => s.agentOverrides);
  const customAgentsKeys = useTeamStore((s) => Object.keys(s.customAgents).join(","));

  const agentItems = useMemo<MentionItem[]>(
    () =>
      getEffectiveAgents()
        .filter((a) => a.effectiveEnabled)
        .map((a) => ({
          id: a.id,
          type: "agent" as const,
          label: `${a.avatar ?? "🤖"} ${a.name}`,
          icon: <Users size={14} />,
        })),
    [agentOverrides, customAgentsKeys],
  );

  const filePaths = useMemo(() => {
    if (!rootDir) return [];
    return Array.from(new Set(storeFiles.map((f) => normRel(f.path)).filter(Boolean))).sort();
  }, [rootDir, storeFiles]);

  const rawDirs = useMemo(() => {
    if (!rootDir) return [];
    return Array.from(new Set(storeDirs.map((d) => normRel(d)).filter(Boolean))).sort();
  }, [rootDir, storeDirs]);

  const dirSet = useMemo(() => buildDirSet(filePaths, rawDirs), [filePaths, rawDirs]);

  // 搜索
  const q = query.toLowerCase().trim();
  const searching = q.length > 0;

  const searchAgents = useMemo(
    () => (searching ? agentItems.filter((it) => it.label.toLowerCase().includes(q) || it.id.toLowerCase().includes(q)) : []),
    [searching, q, agentItems],
  );
  const searchFiles = useMemo(
    () =>
      searching && rootDir
        ? filePaths
            .filter((p) => p.toLowerCase().includes(q) || baseName(p).toLowerCase().includes(q))
            .map((p): MentionItem => ({ id: p, type: "file", label: baseName(p), icon: <FileText size={14} /> }))
        : [],
    [searching, rootDir, q, filePaths],
  );

  // 根级分组入口
  const groupEntries = useMemo(
    () =>
      [
        ...(agentItems.length ? [{ group: "agents" as const, label: "团队成员", desc: `${agentItems.length} 位成员`, icon: <Users size={14} />, color: "text-emerald-500" }] : []),
        ...(rootDir ? [{ group: "files" as const, label: "项目文件", desc: "浏览项目目录", icon: <FolderOpen size={14} />, color: "text-amber-500" }] : []),
      ],
    [agentItems.length, rootDir],
  );

  // 当前目录层级
  const curEntries = useMemo(
    () => (rootDir && activeGroup === "files" ? levelEntries(currentDir, filePaths, dirSet) : []),
    [rootDir, activeGroup, currentDir, filePaths, dirSet],
  );

  // 面包屑
  const breadcrumbs = useMemo(() => {
    const parts = currentDir ? currentDir.split("/") : [];
    const out: Array<{ label: string; path: string }> = [{ label: "根目录", path: "" }];
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      out.push({ label: p, path: acc });
    }
    return out;
  }, [currentDir]);

  // 统一 action 列表（键盘用）
  const actions = useMemo<PopoverAction[]>(() => {
    if (searching) {
      return [
        ...searchAgents.map((it) => ({ key: `m:${it.type}:${it.id}`, kind: "mention" as const, item: it })),
        ...searchFiles.map((it) => ({ key: `m:${it.type}:${it.id}`, kind: "mention" as const, item: it })),
      ];
    }
    if (activeGroup === null) {
      return groupEntries.map((e) => ({ key: `g:${e.group}`, kind: "group" as const, group: e.group }));
    }
    if (activeGroup === "agents") {
      return agentItems.map((it) => ({ key: `m:${it.type}:${it.id}`, kind: "mention" as const, item: it }));
    }
    // files
    return curEntries.map((e) =>
      e.kind === "dir"
        ? { key: `d:${e.path}`, kind: "dir" as const, path: e.path }
        : { key: `m:file:${e.path}`, kind: "mention" as const, item: { id: e.path, type: "file" as const, label: e.name, icon: <FileText size={14} /> } },
    );
  }, [searching, searchAgents, searchFiles, activeGroup, groupEntries, agentItems, curEntries]);

  // 重置选中
  useEffect(() => { setSelectedIdx(0); }, [query, activeGroup, currentDir, actions.length]);
  // 关闭时重置
  useEffect(() => { if (!visible) { setSelectedIdx(0); setActiveGroup(null); setCurrentDir(""); } }, [visible]);

  const runAction = useCallback(
    (a: PopoverAction) => {
      if (a.kind === "group") { setActiveGroup(a.group); setCurrentDir(""); return; }
      if (a.kind === "dir") { setActiveGroup("files"); setCurrentDir(a.path); return; }
      onSelect(a.item);
    },
    [onSelect],
  );

  const goBack = useCallback(() => {
    if (activeGroup === "files" && currentDir) { setCurrentDir(parentOf(currentDir)); return; }
    setActiveGroup(null);
    setCurrentDir("");
  }, [activeGroup, currentDir]);

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
        if (a) runAction(a);
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopImmediatePropagation();
        onClose();
      } else if (e.key === "Backspace" && !searching && activeGroup !== null) {
        e.preventDefault(); e.stopImmediatePropagation();
        goBack();
      }
    },
    [visible, actions, selectedIdx, onClose, runAction, searching, activeGroup, goBack],
  );

  useEffect(() => {
    if (!visible) return;
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [visible, handleKeyDown]);

  // 渲染条件
  if (!visible) return null;
  if (searching && actions.length === 0) return null;
  if (!searching && activeGroup === null && groupEntries.length === 0) return null;

  const selectedKey = actions[selectedIdx]?.key;

  return (
    <div
      className={cn(
        "absolute inset-x-1 bottom-[46px] z-50",
        "max-h-[280px] overflow-hidden",
        "rounded-lg border border-border bg-surface shadow-md",
      )}
    >
      {/* 面包屑导航栏 */}
      {!searching && activeGroup !== null && (
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <button
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-surface-alt text-text-muted"
            onClick={goBack}
            onMouseDown={(e) => e.preventDefault()}
          >
            <ChevronLeft size={14} />
          </button>
          {activeGroup === "agents" ? (
            <span className="text-[12px] font-medium text-text-muted">团队成员</span>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              {breadcrumbs.map((crumb, idx) => {
                const isLast = idx === breadcrumbs.length - 1;
                return (
                  <Fragment key={crumb.path || "root"}>
                    {idx > 0 && <ChevronRight size={12} className="shrink-0 text-text-faint" />}
                    <button
                      className={cn(
                        "max-w-[120px] truncate text-[12px]",
                        isLast ? "text-text-muted font-medium" : "text-text-faint hover:text-text-muted",
                      )}
                      disabled={isLast}
                      onClick={() => setCurrentDir(crumb.path)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      {crumb.label}
                    </button>
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 列表区 */}
      <div className="max-h-[240px] overflow-y-auto py-1.5">
        {searching ? (
          <>
            {searchAgents.length > 0 && (
              <SectionLabel text="团队成员" />
            )}
            {searchAgents.map((item) => (
              <MentionRow key={item.id} item={item} selected={selectedKey === `m:${item.type}:${item.id}`} onSelect={onSelect} colorClass="text-emerald-500" />
            ))}
            {searchFiles.length > 0 && (
              <SectionLabel text="项目文件" />
            )}
            {searchFiles.map((item) => (
              <MentionRow key={item.id} item={item} selected={selectedKey === `m:${item.type}:${item.id}`} onSelect={onSelect} colorClass="text-text-muted" />
            ))}
          </>
        ) : activeGroup === null ? (
          groupEntries.map((entry) => (
            <DrawerRow
              key={entry.group}
              label={entry.label}
              desc={entry.desc}
              icon={entry.icon}
              selected={selectedKey === `g:${entry.group}`}
              colorClass={entry.color}
              onClick={() => runAction({ key: `g:${entry.group}`, kind: "group", group: entry.group })}
            />
          ))
        ) : activeGroup === "agents" ? (
          agentItems.length > 0 ? (
            agentItems.map((item) => (
              <MentionRow key={item.id} item={item} selected={selectedKey === `m:${item.type}:${item.id}`} onSelect={onSelect} colorClass="text-emerald-500" />
            ))
          ) : (
            <EmptyHint text="暂无可用成员" />
          )
        ) : curEntries.length > 0 ? (
          curEntries.map((entry) =>
            entry.kind === "dir" ? (
              <DrawerRow
                key={entry.path}
                label={entry.name}
                icon={<Folder size={14} />}
                selected={selectedKey === `d:${entry.path}`}
                colorClass="text-amber-500"
                onClick={() => runAction({ key: `d:${entry.path}`, kind: "dir", path: entry.path })}
              />
            ) : (
              <MentionRow
                key={entry.path}
                item={{ id: entry.path, type: "file", label: entry.name, icon: <FileText size={14} /> }}
                selected={selectedKey === `m:file:${entry.path}`}
                onSelect={onSelect}
                colorClass="text-text-muted"
              />
            ),
          )
        ) : (
          <EmptyHint text="当前目录为空" />
        )}
      </div>
    </div>
  );
}

/* ─── 子组件 ─── */

function SectionLabel({ text }: { text: string }) {
  return <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-faint font-medium">{text}</div>;
}

function MentionRow({ item, selected, onSelect, colorClass }: { item: MentionItem; selected: boolean; onSelect: (item: MentionItem) => void; colorClass: string }) {
  return (
    <button
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-1.5 text-left text-[13px]",
        "transition-colors duration-fast",
        selected ? "bg-accent-soft text-text" : "text-text-muted hover:bg-surface-alt",
      )}
      onClick={() => onSelect(item)}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className={cn("shrink-0", colorClass)}>{item.icon}</span>
      <span className="truncate">{item.label}</span>
    </button>
  );
}

function DrawerRow({ label, desc, icon, selected, colorClass, onClick }: { label: string; desc?: string; icon: React.ReactNode; selected: boolean; colorClass: string; onClick: () => void }) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px]",
        "transition-colors duration-fast",
        selected ? "bg-accent-soft text-text" : "text-text-muted hover:bg-surface-alt",
      )}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className={cn("shrink-0", colorClass)}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {desc && <span className="block truncate text-[11px] text-text-faint">{desc}</span>}
      </span>
      <ChevronRight size={14} className="shrink-0 text-text-faint" />
    </button>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="px-3 py-2 text-[12px] text-text-faint">{text}</div>;
}
