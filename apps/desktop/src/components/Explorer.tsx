import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore, type ProjectFile } from "../state/projectStore";
import { useWorkspaceStore } from "../state/workspaceStore";

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
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const promptInputRef = useRef<HTMLInputElement | null>(null);

  const tree = useMemo(() => buildTree(dirs ?? [], files ?? []), [dirs, files]);
  const filtered = useMemo(() => filterTree(tree, filter), [tree, filter]);

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
    const onDown = () => setCtx(null);
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
    useProjectStore.getState().deleteFile(targetPath);
  };

  const isDirOpen = (p: string) => (p ? !!expanded[p] : true);

  const renderNode = (node: TreeNode, depth: number) => {
    const pad = 8 + depth * 14;
    if (node.kind === "dir") {
      const open = filter.trim() ? true : isDirOpen(node.path);
      return (
        <div key={`dir:${node.path}`}>
          {node.path ? (
            <div
              className="treeRow treeDir"
              style={{ paddingLeft: pad }}
              title={node.path}
              onClick={() => setExpanded((p) => ({ ...p, [node.path]: !open }))}
              draggable
              onDragStart={(e) => {
                const payload: DndItem = { kind: "dir", path: node.path };
                e.dataTransfer.effectAllowed = "copyMove";
                e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
                e.dataTransfer.setData("text/plain", node.path);
              }}
              onDragOver={(e) => {
                const item = getDndItem(e);
                if (!item) return;
                // 允许将任意文件/目录拖到目录上进行移动
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
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
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtx({ x: e.clientX, y: e.clientY, kind: "dir", path: node.path });
              }}
            >
              <span className="treeCaret">{open ? "▾" : "▸"}</span>
              <span className="treeLabel">{node.name}</span>
            </div>
          ) : null}
          {open ? node.children.map((c) => renderNode(c, node.path ? depth + 1 : depth)) : null}
        </div>
      );
    }
    const dirty = node.file?.dirty;
    const active = activePath === node.path;
    return (
      <div
        key={`file:${node.path}`}
        className={`treeRow treeFile ${active ? "treeActive" : ""}`}
        style={{ paddingLeft: pad }}
        title={node.path}
        onClick={() => openFilePreview(node.path)}
        onDoubleClick={() => openFilePinned(node.path)}
        draggable
        onDragStart={(e) => {
          const payload: DndItem = { kind: "file", path: node.path };
          e.dataTransfer.effectAllowed = "copyMove";
          e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
          e.dataTransfer.setData("text/plain", node.path);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtx({ x: e.clientX, y: e.clientY, kind: "file", path: node.path });
        }}
      >
        <span className="treeKind">MD</span>
        <span className="treeLabel">{node.name}</span>
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
          className="tree"
          onDragOver={(e) => {
            const item = getDndItem(e);
            if (!item) return;
            // 拖到空白处：移动到根目录
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
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

          {filtered ? (
            (filtered.children.length ? filtered.children : []).map((c) => renderNode(c, 0))
          ) : (
            <div className="explorerHint">无匹配结果</div>
          )}
        </div>
      ) : null}

      {ctx ? (
        <div className="ctxMenu" style={{ left: ctx.x, top: ctx.y }}>
          {ctx.kind === "root" ? null : null}
          {ctx.kind === "dir" ? (
            <>
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
              <div className="ctxSep" />
              <button className="ctxItem" type="button" onClick={() => (setCtx(null), void doRefresh())}>
                刷新
              </button>
            </>
          ) : null}
          {ctx.kind === "file" ? (
            <>
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


