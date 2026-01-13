import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore, type ProjectFile } from "../state/projectStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useKbStore } from "../state/kbStore";
import { useLayoutStore } from "../state/layoutStore";
import { useRunStore } from "../state/runStore";
import { useUiStore } from "../state/uiStore";

type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string; file: ProjectFile };

const DND_MIME = "application/x-writing-ide-item";
type DndItem = { kind: "file" | "dir"; path: string };

function basename(p: string) {
  const parts = String(p ?? "").split("/");
  return parts[parts.length - 1] ?? p;
}

function dirname(p: string) {
  const parts = String(p ?? "").split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, parts.length - 1).join("/");
}

function joinPath(dir: string, name: string) {
  const d = String(dir ?? "").replaceAll("\\", "/").replaceAll(/\/+$/g, "");
  const n = String(name ?? "").replaceAll("\\", "/").replaceAll(/^\/+/g, "");
  if (!d) return n;
  if (!n) return d;
  return `${d}/${n}`;
}

function ensureMdFileName(nameOrPath: string) {
  const s = String(nameOrPath ?? "").trim();
  if (!s) return "";
  if (s.includes(".")) return s;
  return `${s}.md`;
}

function buildTree(dirs: string[], files: ProjectFile[]) {
  const root: TreeNode = { kind: "dir", name: "", path: "", children: [] };
  const dirMap = new Map<string, TreeNode>();
  dirMap.set("", root);

  const ensureDir = (dirPath: string) => {
    const norm = String(dirPath ?? "").replaceAll("\\", "/").replaceAll(/\/+$/g, "");
    if (dirMap.has(norm)) return dirMap.get(norm) as Extract<TreeNode, { kind: "dir" }>;
    const parent = dirname(norm);
    const name = basename(norm);
    const parentNode = ensureDir(parent);
    const node: TreeNode = { kind: "dir", name, path: norm, children: [] };
    (parentNode as Extract<TreeNode, { kind: "dir" }>).children.push(node);
    dirMap.set(norm, node);
    return node as Extract<TreeNode, { kind: "dir" }>;
  };

  for (const d of dirs) ensureDir(d);
  for (const f of files) {
    const parent = dirname(f.path);
    const parentNode = ensureDir(parent);
    (parentNode as Extract<TreeNode, { kind: "dir" }>).children.push({
      kind: "file",
      name: basename(f.path),
      path: f.path,
      file: f,
    });
  }

  const sortNode = (node: Extract<TreeNode, { kind: "dir" }>) => {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) if (c.kind === "dir") sortNode(c);
  };
  sortNode(root as Extract<TreeNode, { kind: "dir" }>);
  return root as Extract<TreeNode, { kind: "dir" }>;
}

function filterTree(root: Extract<TreeNode, { kind: "dir" }>, termRaw: string) {
  const term = String(termRaw ?? "").trim().toLowerCase();
  if (!term) return root;
  const match = (s: string) => String(s ?? "").toLowerCase().includes(term);

  const walk = (node: TreeNode): TreeNode | null => {
    if (node.kind === "file") {
      return match(node.name) || match(node.path) ? node : null;
    }
    const children = node.children.map(walk).filter(Boolean) as TreeNode[];
    const selfMatch = node.path ? match(node.name) || match(node.path) : false;
    if (selfMatch || children.length) return { ...node, children };
    return null;
  };

  return (walk(root) as Extract<TreeNode, { kind: "dir" }> | null) ?? null;
}

function buildRefToken(item: DndItem) {
  const p = String(item.path ?? "").replaceAll("\\", "/");
  const path = item.kind === "dir" && p && !p.endsWith("/") ? `${p}/` : p;
  return `@{${path}}`;
}

function getDndItem(e: React.DragEvent): DndItem | null {
  const raw = e.dataTransfer.getData(DND_MIME);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    const kind = obj?.kind === "dir" ? "dir" : obj?.kind === "file" ? "file" : null;
    const path = String(obj?.path ?? "").replaceAll("\\", "/");
    if (!kind || !path) return null;
    return { kind, path };
  } catch {
    return null;
  }
}

type CtxMenu = { x: number; y: number; kind: "root" | "dir" | "file"; path: string };
type PromptState = {
  title: string;
  desc?: string;
  placeholder?: string;
  value: string;
  confirmText?: string;
  onConfirm: (value: string) => Promise<void> | void;
};

export function Explorer() {
  const files = useProjectStore((s) => s.files);
  const dirs = useProjectStore((s) => s.dirs);
  const activePath = useProjectStore((s) => s.activePath);
  const openFilePreview = useProjectStore((s) => s.openFilePreview);
  const openFilePinned = useProjectStore((s) => s.openFilePinned);
  const rootDir = useProjectStore((s) => s.rootDir);
  const isLoading = useProjectStore((s) => s.isLoading);
  const error = useProjectStore((s) => s.error);
  const recentProjectDirs = useWorkspaceStore((s) => s.recentProjectDirs);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<null | { kind: "root" | "dir"; path: string; valid: boolean }>(null);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  const isDirOpen = (p: string) => (p ? !!expanded[p] : true);

  const tree = useMemo(() => buildTree(dirs ?? [], files ?? []), [dirs, files]);
  const filtered = useMemo(() => filterTree(tree, filter), [tree, filter]);

  const visibleOrder = useMemo(() => {
    const out: string[] = [];
    const walk = (node: TreeNode) => {
      if (node.kind === "dir") {
        if (node.path) out.push(node.path);
        const open = filter.trim() ? true : isDirOpen(node.path);
        if (open) node.children.forEach(walk);
        return;
      }
      out.push(node.path);
    };
    if (filtered) filtered.children.forEach(walk);
    return out;
  }, [filtered, expanded, filter]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const isSelected = (p: string) => selectedSet.has(p);

  const selectOnly = (p: string) => {
    setSelected([p]);
    setAnchor(p);
  };
  const toggleSelect = (p: string) => {
    setSelected((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
    setAnchor(p);
  };
  const selectRange = (p: string) => {
    const a = anchor ?? p;
    const i1 = visibleOrder.indexOf(a);
    const i2 = visibleOrder.indexOf(p);
    if (i1 < 0 || i2 < 0) {
      selectOnly(p);
      return;
    }
    const [s, e] = i1 <= i2 ? [i1, i2] : [i2, i1];
    setSelected(visibleOrder.slice(s, e + 1));
  };

  const clearSelection = () => setSelected([]);

  const highlight = (text: string) => {
    const term = filter.trim();
    if (!term) return text;
    const t = text;
    const lower = t.toLowerCase();
    const q = term.toLowerCase();
    const parts: any[] = [];
    let i = 0;
    while (true) {
      const idx = lower.indexOf(q, i);
      if (idx < 0) break;
      if (idx > i) parts.push(t.slice(i, idx));
      parts.push(
        <span key={`${idx}-${q}`} className="hl">
          {t.slice(idx, idx + q.length)}
        </span>,
      );
      i = idx + q.length;
      if (parts.length > 30) break;
    }
    if (!parts.length) return t;
    if (i < t.length) parts.push(t.slice(i));
    return <>{parts}</>;
  };

  useEffect(() => {
    if (!rootDir || !activePath) return;
    const parts = activePath.split("/").filter(Boolean);
    if (parts.length <= 1) return;
    let cur = "";
    const patch: Record<string, boolean> = {};
    for (let i = 0; i < parts.length - 1; i += 1) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      patch[cur] = true;
    }
    setExpanded((prev) => ({ ...prev, ...patch }));
  }, [activePath, rootDir]);

  useEffect(() => {
    if (!ctx) return;
    const onDown = (e: MouseEvent) => {
      const el = ctxMenuRef.current;
      const target = e.target as Node | null;
      if (el && target && el.contains(target)) return;
      setCtx(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [ctx]);

  useEffect(() => {
    if (!prompt) return;
    const t = window.setTimeout(() => promptInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [prompt]);

  const openProject = async () => {
    const api = window.desktop?.fs;
    if (!api) return;
    const res = await api.pickDirectory();
    if (!res.ok || !res.dir) return;
    useWorkspaceStore.getState().addRecentProjectDir(res.dir);
    await useProjectStore.getState().loadProjectFromDisk(res.dir);
  };

  const openRecent = async (dir: string) => {
    if (!dir) return;
    useWorkspaceStore.getState().addRecentProjectDir(dir);
    await useProjectStore.getState().loadProjectFromDisk(dir);
  };

  const doRefresh = async () => {
    await useProjectStore.getState().refreshFromDisk("manual");
  };

  const ask = (p: Omit<PromptState, "value"> & { value?: string }) =>
    setPrompt({ ...p, value: p.value ?? "" });

  const actionImportToKb = (paths: string[]) => {
    const run = useRunStore.getState();
    const kb = useKbStore.getState();
    try {
      // dev 下自动切到 Logs，方便用户立刻看到“点了之后发生了什么”
      const isDev = Boolean((import.meta as any).env?.DEV);
      if (isDev) useUiStore.getState().setDockTab("logs");

      run.log("info", "kb.import.click", {
        rawPaths: Array.isArray(paths) ? paths : [],
        baseDir: kb.baseDir,
        currentLibraryId: kb.currentLibraryId,
      });

      const s = useProjectStore.getState();
      const norm = normalizeSelection(paths);
      const out = new Set<string>();
      for (const p of norm) {
        const isDir = s.dirs.includes(p) || s.files.some((f) => f.path.startsWith(`${p}/`));
        if (isDir) {
          for (const f of s.files) if (f.path.startsWith(`${p}/`)) out.add(f.path);
        } else {
          out.add(p);
        }
      }

      const list = Array.from(out).filter((p) => {
        const ext = p.toLowerCase();
        return ext.endsWith(".md") || ext.endsWith(".mdx") || ext.endsWith(".txt");
      });

      run.log("info", "kb.import.filter", {
        norm,
        expandedCount: out.size,
        listCount: list.length,
        sample: list.slice(0, 20),
      });

      if (!list.length) {
        run.log("warn", "kb.import.no_text_files", { expandedCount: out.size, norm });
        window.alert("未找到可导入的文本文件（仅支持 .md/.mdx/.txt）。");
        return;
      }
      if (!kb.baseDir) {
        run.log("warn", "kb.import.no_base_dir", { listCount: list.length });
        // 引导用户先选择 KB 目录
        useLayoutStore.getState().openSection("kb");
        window.alert("请先在左侧 KB 面板选择 KB 目录，然后再导入。");
        return;
      }
      if (!kb.currentLibraryId) {
        run.log("warn", "kb.import.no_library_selected", { listCount: list.length });
        useLayoutStore.getState().openSection("kb");
        // 兼容 HMR/旧 state：动作不存在时不阻塞
        const setPending = (kb as any).setPendingImport;
        if (typeof setPending === "function") setPending({ kind: "project", paths: list });
        else run.log("error", "kb.import.missing_setPendingImport", {});
        kb.openKbManager(
          "libraries",
          `请先选择一个库（强制）。已暂存待导入 ${list.length} 个文件，选库后会自动继续导入并加入抽卡队列（不会自动开始，需在“抽卡任务”里点 ▶）。`,
        );
        window.alert("请先在“库管理”里选择一个库；选择后会自动继续导入并入队，需手动点 ▶ 开始抽卡。");
        return;
      }

      void (async () => {
        run.log("info", "kb.import.start", { listCount: list.length, libraryId: kb.currentLibraryId });
        const ret = await kb.importProjectPaths(list);
        run.log("info", "kb.import.done", { ...ret, docIdCount: ret.docIds.length, sample: ret.docIds.slice(0, 6) });

        if (!ret.docIds.length) {
          run.log("warn", "kb.import.no_docs_created", ret);
          kb.openKbManager("libraries", "导入完成，但没有生成任何文档（可能是文件为空/读取失败/被判定为重复）。请打开底部 Logs 查看 kb.import.* 详情。");
          window.alert("导入完成，但没有生成任何文档。请打开底部 DockPanel → Logs 查看详情。");
          return;
        }

        // 导入完成后：加入抽卡队列并打开弹窗（不自动开始，避免误触）
        await kb.enqueueCardJobs(ret.docIds, { open: true, autoStart: false });
        run.log("info", "kb.import.enqueue_jobs", { docIdCount: ret.docIds.length });
      })().catch((e: any) => {
        run.log("error", "kb.import.async_failed", { error: String(e?.message ?? e) });
        window.alert(`导入失败：${String(e?.message ?? e)}`);
      });
    } catch (e: any) {
      run.log("error", "kb.import.click_failed", { error: String(e?.message ?? e) });
      window.alert(`导入触发异常：${String(e?.message ?? e)}`);
    }
  };

  const actionNewFile = (baseDir: string) => {
    ask({
      title: "新建文件",
      desc: baseDir ? `在 ${baseDir}/ 下新建` : "在项目根目录下新建",
      placeholder: "例如：test.md（不写后缀默认 .md）",
      confirmText: "创建",
      onConfirm: async (v) => {
        const name = ensureMdFileName(v);
        if (!name) return;
        const rel = joinPath(baseDir, name);
        useProjectStore.getState().createFile(rel, `# ${basename(rel).replace(/\.mdx?$/i, "")}\n\n`);
      },
    });
  };

  const actionNewFolder = (baseDir: string) => {
    ask({
      title: "新建文件夹",
      desc: baseDir ? `在 ${baseDir}/ 下新建` : "在项目根目录下新建",
      placeholder: "例如：drafts/2026 或 notes",
      confirmText: "创建",
      onConfirm: async (v) => {
        const rel = String(v ?? "").trim().replaceAll("\\", "/");
        if (!rel) return;
        const dir = joinPath(baseDir, rel);
        await useProjectStore.getState().mkdir(dir);
      },
    });
  };

  const actionRename = (kind: "file" | "dir", targetPath: string) => {
    const base = basename(targetPath);
    const parent = dirname(targetPath);
    ask({
      title: kind === "file" ? "重命名文件" : "重命名文件夹",
      desc: `当前：${targetPath}`,
      placeholder: "请输入新名称（不含路径）",
      value: base,
      confirmText: "重命名",
      onConfirm: async (v) => {
        const name = String(v ?? "").trim();
        if (!name) return;
        const to = joinPath(parent, name);
        await useProjectStore.getState().renamePath(targetPath, to);
      },
    });
  };

  const actionMove = (targetPath: string) => {
    ask({
      title: "移动/改路径",
      desc: `当前：${targetPath}`,
      placeholder: "请输入新的相对路径（例如：drafts/new-name.md 或 folder/）",
      value: targetPath,
      confirmText: "移动",
      onConfirm: async (v) => {
        const to = String(v ?? "").trim().replaceAll("\\", "/");
        if (!to) return;
        await useProjectStore.getState().renamePath(targetPath, to);
      },
    });
  };

  const actionDeleteFile = (targetPath: string) => {
    const ok = window.confirm(`确认删除文件？\n\n${targetPath}\n\n（此操作会删除磁盘文件）`);
    if (!ok) return;
    void useProjectStore.getState().deletePath(targetPath);
  };

  const actionDeleteDir = (dirPath: string) => {
    const ok = window.confirm(`确认删除文件夹？\n\n${dirPath}/\n\n（此操作会递归删除磁盘目录及其文件）`);
    if (!ok) return;
    void useProjectStore.getState().deletePath(dirPath);
  };

  const normalizeSelection = (paths: string[]) => {
    const s = useProjectStore.getState();
    const dirsSel = paths.filter((p) => s.dirs.includes(p)).sort((a, b) => a.length - b.length);
    const filesSel = paths.filter((p) => !s.dirs.includes(p));
    // 如果某个目录已选，则其子项不再重复选择
    const isCovered = (p: string) => dirsSel.some((d) => p === d || p.startsWith(`${d}/`));
    const dirsOut: string[] = [];
    for (const d of dirsSel) {
      if (dirsOut.some((x) => d === x || d.startsWith(`${x}/`))) continue;
      dirsOut.push(d);
    }
    const filesOut = filesSel.filter((f) => !isCovered(f));
    return [...dirsOut, ...filesOut];
  };

  const actionMoveSelected = () => {
    const items = normalizeSelection(selected);
    if (!items.length) return;
    ask({
      title: "批量移动",
      desc: `将 ${items.length} 项移动到目标目录（留空=根目录）`,
      placeholder: "例如：drafts/2026（必须存在；不存在可先新建文件夹）",
      confirmText: "移动",
      onConfirm: async (v) => {
        const targetDir = String(v ?? "").trim().replaceAll("\\", "/").replace(/\/+$/g, "");
        const s = useProjectStore.getState();
        if (targetDir && !s.dirs.includes(targetDir)) {
          window.alert("目标目录不存在：请先创建该文件夹。");
          return;
        }
        for (const p of items) {
          const dest = targetDir ? joinPath(targetDir, basename(p)) : basename(p);
          if (!dest || dest === p) continue;
          await s.renamePath(p, dest);
        }
        clearSelection();
      },
    });
  };

  const actionDeleteSelected = () => {
    const items = normalizeSelection(selected);
    if (!items.length) return;
    const shown = items.slice(0, 8);
    const more = items.length > shown.length ? `\n…以及另外 ${items.length - shown.length} 项` : "";
    const ok = window.confirm(`确认删除所选 ${items.length} 项？\n\n${shown.join("\n")}${more}\n\n（此操作会删除磁盘文件/目录）`);
    if (!ok) return;
    void (async () => {
      const s = useProjectStore.getState();
      for (const p of items) await s.deletePath(p);
      clearSelection();
    })();
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const pad = 8 + depth * 14;
    if (node.kind === "dir") {
      const open = filter.trim() ? true : isDirOpen(node.path);
      const sel = node.path && isSelected(node.path);
      const isDropOver = dragOver?.kind === "dir" && dragOver.path === node.path;
      const dropCls = isDropOver ? (dragOver?.valid ? "treeDropOver" : "treeDropOver treeDropInvalid") : "";
      return (
        <div key={`dir:${node.path}`}>
          {node.path ? (
            <div
              className={`treeRow treeDir ${sel ? "treeSelected" : ""} ${dropCls}`}
              style={{ paddingLeft: pad }}
              title={node.path}
              onClick={(e) => {
                if (e.shiftKey) {
                  selectRange(node.path);
                  return;
                }
                if (e.ctrlKey || e.metaKey) {
                  toggleSelect(node.path);
                  return;
                }
                selectOnly(node.path);
                setExpanded((p) => ({ ...p, [node.path]: !open }));
              }}
              draggable
              onDragStart={(e) => {
                const payload: DndItem = { kind: "dir", path: node.path };
                e.dataTransfer.effectAllowed = "copyMove";
                e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
                e.dataTransfer.setData("text/plain", node.path);
                setDragOver(null);
              }}
              onDragEnd={() => setDragOver(null)}
              onDragOver={(e) => {
                const item = getDndItem(e);
                if (!item) return;
                // 允许将任意文件/目录拖到目录上进行移动
                const targetDir = node.path;
                const src = item.path;
                const dest = joinPath(targetDir, basename(src));
                const s = useProjectStore.getState();
                const existsFile = !!s.files.find((f) => f.path === dest);
                const existsDir = dest && s.dirs.includes(dest);
                const invalidSelf = item.kind === "dir" && (targetDir === src || targetDir.startsWith(`${src}/`));
                const valid = !!dest && dest !== src && !existsFile && !existsDir && !invalidSelf;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOver({ kind: "dir", path: node.path, valid });
              }}
              onDragLeave={() => {
                if (dragOver?.kind === "dir" && dragOver.path === node.path) setDragOver(null);
              }}
              onDrop={(e) => {
                const item = getDndItem(e);
                if (!item) return;
                e.preventDefault();
                e.stopPropagation();
                const targetDir = node.path;
                if (!targetDir) return;

                const src = item.path;
                // 禁止把目录拖进自己或子目录
                if (item.kind === "dir") {
                  if (targetDir === src || targetDir.startsWith(`${src}/`)) return;
                }
                const dest = joinPath(targetDir, basename(src));
                if (!dest || dest === src) return;
                // 冲突检测：目标已存在则不做（避免不可控 merge）
                const s = useProjectStore.getState();
                const existsFile = !!s.files.find((f) => f.path === dest);
                const existsDir = dest && s.dirs.includes(dest);
                if (existsFile || existsDir) return;
                void s.renamePath(src, dest);
                setDragOver(null);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!sel) selectOnly(node.path);
                setCtx({ x: e.clientX, y: e.clientY, kind: "dir", path: node.path });
              }}
            >
              <span className="treeCaret">{open ? "▾" : "▸"}</span>
              <span className="treeLabel">{highlight(node.name)}</span>
            </div>
          ) : null}
          {open ? node.children.map((c) => renderNode(c, node.path ? depth + 1 : depth)) : null}
        </div>
      );
    }
    const dirty = node.file?.dirty;
    const active = activePath === node.path;
    const sel = isSelected(node.path);
    return (
      <div
        key={`file:${node.path}`}
        className={`treeRow treeFile ${active ? "treeActive" : ""} ${sel ? "treeSelected" : ""}`}
        style={{ paddingLeft: pad }}
        title={node.path}
        onClick={(e) => {
          if (e.shiftKey) {
            selectRange(node.path);
            return;
          }
          if (e.ctrlKey || e.metaKey) {
            toggleSelect(node.path);
            return;
          }
          selectOnly(node.path);
          openFilePreview(node.path);
        }}
        onDoubleClick={() => openFilePinned(node.path)}
        draggable
        onDragStart={(e) => {
          const payload: DndItem = { kind: "file", path: node.path };
          e.dataTransfer.effectAllowed = "copyMove";
          e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
          e.dataTransfer.setData("text/plain", node.path);
          setDragOver(null);
        }}
        onDragEnd={() => setDragOver(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!sel) selectOnly(node.path);
          setCtx({ x: e.clientX, y: e.clientY, kind: "file", path: node.path });
        }}
      >
        <span className="treeKind">MD</span>
        <span className="treeLabel">{highlight(node.name)}</span>
        {dirty ? <span className="treeDirty" title="未保存">●</span> : null}
      </div>
    );
  };

  return (
    <div className="list">
      <div className="explorerHeader">
        <div className="explorerRoot" title={rootDir ?? "未打开项目"}>
          {rootDir ? rootDir : "（未打开项目：当前为内存草稿）"}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn btnIcon" type="button" onClick={openProject} disabled={isLoading}>
            打开
          </button>
          {rootDir ? (
            <>
              <button className="btn btnIcon" type="button" onClick={() => actionNewFile("")} disabled={isLoading}>
                新建文件
              </button>
              <button className="btn btnIcon" type="button" onClick={() => actionNewFolder("")} disabled={isLoading}>
                新建文件夹
              </button>
              <button className="btn btnIcon" type="button" onClick={() => void doRefresh()} disabled={isLoading}>
                刷新
              </button>
            </>
          ) : null}
        </div>
      </div>

      {!rootDir && recentProjectDirs.length > 0 ? (
        <div className="recentBox">
          <div className="recentTitle">最近项目</div>
          <div className="recentList">
            {recentProjectDirs.slice(0, 6).map((d) => (
              <button
                key={d}
                className="recentItem"
                type="button"
                onClick={() => void openRecent(d)}
                title={d}
                disabled={isLoading}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <div className="explorerError">打开失败：{error}</div> : null}
      {isLoading ? <div className="explorerHint">正在加载文件…</div> : null}

      {rootDir ? (
        <div
          className={`tree ${dragOver?.kind === "root" ? (dragOver.valid ? "treeDropRoot" : "treeDropRoot treeDropInvalid") : ""}`}
          onDragOver={(e) => {
            const item = getDndItem(e);
            if (!item) return;
            // 拖到空白处：移动到根目录
            const src = item.path;
            const dest = basename(src);
            const s = useProjectStore.getState();
            const existsFile = !!s.files.find((f) => f.path === dest);
            const existsDir = dest && s.dirs.includes(dest);
            const valid = !!dest && dest !== src && !existsFile && !existsDir;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOver({ kind: "root", path: "", valid });
          }}
          onDragLeave={() => {
            if (dragOver?.kind === "root") setDragOver(null);
          }}
          onDrop={(e) => {
            const item = getDndItem(e);
            if (!item) return;
            e.preventDefault();
            e.stopPropagation();
            const src = item.path;
            const dest = basename(src);
            if (!dest || dest === src) return;
            const s = useProjectStore.getState();
            const existsFile = !!s.files.find((f) => f.path === dest);
            const existsDir = dest && s.dirs.includes(dest);
            if (existsFile || existsDir) return;
            void s.renamePath(src, dest);
            setDragOver(null);
          }}
        >
          <div className="treeSearchRow">
            <input
              className="treeSearch"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索文件/目录…"
            />
            {filter.trim() ? (
              <button className="btn btnIcon" type="button" onClick={() => setFilter("")}>
                清除
              </button>
            ) : null}
          </div>

          {selected.length ? (
            <div className="selBar">
              <div className="selCount">已选 {selected.length} 项</div>
              <button className="btn btnIcon" type="button" onClick={() => actionImportToKb(selected)}>
                导入并抽卡
              </button>
              <button className="btn btnIcon" type="button" onClick={actionMoveSelected}>
                批量移动
              </button>
              <button className="btn btnDanger btnIcon" type="button" onClick={actionDeleteSelected}>
                批量删除
              </button>
              <button className="btn btnIcon" type="button" onClick={clearSelection}>
                清空
              </button>
            </div>
          ) : null}

          {filtered ? (
            (filtered.children.length ? filtered.children : []).map((c) => renderNode(c, 0))
          ) : (
            <div className="explorerHint">无匹配结果</div>
          )}
        </div>
      ) : null}

      {ctx ? (
        <div ref={ctxMenuRef} className="ctxMenu" style={{ left: ctx.x, top: ctx.y }}>
          {ctx.kind === "root" ? null : null}
          {selected.length > 1 ? (
            <>
              <button className="ctxItem" type="button" onClick={() => (setCtx(null), actionMoveSelected())}>
                移动所选…
              </button>
              <button className="ctxItem ctxDanger" type="button" onClick={() => (setCtx(null), actionDeleteSelected())}>
                删除所选
              </button>
              <div className="ctxSep" />
            </>
          ) : null}
          {ctx.kind === "dir" ? (
            <>
              <button className="ctxItem" type="button" onClick={() => (setCtx(null), actionImportToKb([ctx.path]))}>
                导入到知识库（并抽卡）
              </button>
              <div className="ctxSep" />
              <button className="ctxItem" type="button" onClick={() => (setCtx(null), actionNewFile(ctx.path))}>
                新建文件…
              </button>
              <button className="ctxItem" type="button" onClick={() => (setCtx(null), actionNewFolder(ctx.path))}>
                新建文件夹…
              </button>
              <div className="ctxSep" />
              <button className="ctxItem" type="button" onClick={() => (setCtx(null), actionRename("dir", ctx.path))}>
                重命名…
              </button>
              <button className="ctxItem" type="button" onClick={() => (setCtx(null), actionMove(ctx.path))}>
                移动/改路径…
              </button>
              <button className="ctxItem ctxDanger" type="button" onClick={() => (setCtx(null), actionDeleteDir(ctx.path))}>
                删除
              </button>
              <div className="ctxSep" />
              <button className="ctxItem" type="button" onClick={() => (setCtx(null), void doRefresh())}>
                刷新
              </button>
            </>
          ) : null}
          {ctx.kind === "file" ? (
            <>
              <button className="ctxItem" type="button" onClick={() => (setCtx(null), actionImportToKb([ctx.path]))}>
                导入到知识库（并抽卡）
              </button>
              <div className="ctxSep" />
              <button className="ctxItem" type="button" onClick={() => (setCtx(null), actionRename("file", ctx.path))}>
                重命名…
              </button>
              <button className="ctxItem" type="button" onClick={() => (setCtx(null), actionMove(ctx.path))}>
                移动/改路径…
              </button>
              <div className="ctxSep" />
              <button className="ctxItem ctxDanger" type="button" onClick={() => (setCtx(null), actionDeleteFile(ctx.path))}>
                删除
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {prompt ? (
        <div className="modalMask" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalTitle">{prompt.title}</div>
            {prompt.desc ? <div className="modalDesc">{prompt.desc}</div> : null}
            <input
              ref={promptInputRef}
              className="modalInput"
              value={prompt.value}
              placeholder={prompt.placeholder ?? ""}
              onChange={(e) => setPrompt((p) => (p ? { ...p, value: e.target.value } : p))}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setPrompt(null);
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  const val = String(prompt.value ?? "").trim();
                  void Promise.resolve(prompt.onConfirm(val)).finally(() => setPrompt(null));
                }
              }}
            />
            <div className="modalBtns" style={{ marginTop: 12 }}>
              <button className="btn" type="button" onClick={() => setPrompt(null)}>
                取消
              </button>
              <button
                className="btn btnPrimary"
                type="button"
                onClick={() => {
                  const val = String(prompt.value ?? "").trim();
                  void Promise.resolve(prompt.onConfirm(val)).finally(() => setPrompt(null));
                }}
              >
                {prompt.confirmText ?? "确定"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


