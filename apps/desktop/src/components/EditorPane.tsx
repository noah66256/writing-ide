import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEffect, useMemo, useState } from "react";
import { useProjectStore } from "../state/projectStore";
import { markdownToHtml, wrapHtmlDocument } from "../utils/markdownHtml";
import { markdownToClipboardHtml, type ClipboardPlatform } from "../utils/clipboardHtml";

function basename(p: string) {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

function stripFrontmatter(md: string) {
  const s = String(md ?? "");
  if (!s.startsWith("---\n")) return s;
  const end = s.indexOf("\n---", 4);
  if (end === -1) return s;
  const after = s.indexOf("\n", end + 1);
  return after === -1 ? "" : s.slice(after + 1);
}

function markdownToTeleprompterText(md: string) {
  // 目标：生成“纯文本兜底”（用于平台粘贴兜底/简单念稿）。
  // 尽量保留段落与换行，去掉大多数 markdown 标记。
  let s = stripFrontmatter(md);
  // code fence：保留内容，去掉围栏
  s = s.replace(/```[^\n]*\n([\s\S]*?)\n```/g, (_m, body) => String(body ?? ""));
  // headings/list/quote markers
  s = s.replace(/^\s*#{1,6}\s+/gm, "");
  s = s.replace(/^\s*>\s+/gm, "");
  s = s.replace(/^\s*-\s+/gm, "• ");
  s = s.replace(/^\s*\d+\.\s+/gm, "");
  // inline markers
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  // links: [text](url) -> text（url）
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）");
  return s.trim();
}

export function EditorPane() {
  const openPaths = useProjectStore((s) => s.openPaths);
  const activePath = useProjectStore((s) => s.activePath);
  const previewPath = useProjectStore((s) => s.previewPath);
  const setActivePath = useProjectStore((s) => s.setActivePath);
  const closeTab = useProjectStore((s) => s.closeTab);
  const updateFile = useProjectStore((s) => s.updateFile);
  const getFileByPath = useProjectStore((s) => s.getFileByPath);
  const setEditorRef = useProjectStore((s) => s.setEditorRef);
  const editorRef = useProjectStore((s) => s.editorRef);
  const rootDir = useProjectStore((s) => s.rootDir);

  const activeFile = getFileByPath(activePath);
  const [copyPlatform, setCopyPlatform] = useState<ClipboardPlatform>("xiaohongshu");
  const [selectedText, setSelectedText] = useState<string | null>(null);

  useEffect(() => {
    const ed = editorRef;
    if (!ed) return;

    const sync = () => {
      try {
        const model = ed.getModel();
        const sel = ed.getSelection();
        if (!model || !sel || sel.isEmpty()) {
          setSelectedText(null);
          return;
        }
        setSelectedText(model.getValueInRange(sel));
      } catch {
        setSelectedText(null);
      }
    };

    sync();
    const d = ed.onDidChangeCursorSelection(() => sync());
    return () => {
      try {
        d.dispose();
      } catch {
        // ignore
      }
    };
  }, [editorRef, activePath]);

  const stats = useMemo(() => {
    const t = String((selectedText ?? activeFile?.content) ?? "");
    const chars = t.length;
    const words = t.trim() ? t.trim().split(/\s+/g).filter(Boolean).length : 0;
    const lines = t ? t.split("\n").length : 0;
    return { chars, words, lines };
  }, [activeFile?.content, selectedText]);

  const exportHtml = async () => {
    const api = window.desktop?.fs;
    if (!api || !rootDir) return;
    const name = basename(activePath || "document.md").replace(/\.[^.]+$/, "");
    const outPath = `exports/${name || "document"}.html`;
    const bodyHtml = markdownToHtml(activeFile?.content ?? "");
    const doc = wrapHtmlDocument({ title: name || "document", bodyHtml });
    await api.mkdir?.(rootDir, "exports").catch(() => void 0);
    await api.writeFile(rootDir, outPath, doc);
    // 让用户能在文件树里看到
    void useProjectStore.getState().refreshFromDisk("export.html");
    useProjectStore.getState().openFilePinned(outPath);
  };

  const getSelectedOrAllText = () => {
    try {
      const ed = editorRef;
      const model = ed?.getModel();
      const sel = ed?.getSelection();
      if (ed && model && sel && !sel.isEmpty()) {
        return model.getValueInRange(sel);
      }
    } catch {
      // ignore
    }
    return String(activeFile?.content ?? "");
  };

  const copyRichText = async () => {
    const md = getSelectedOrAllText();
    const plain = markdownToTeleprompterText(md);
    const html = markdownToClipboardHtml(stripFrontmatter(md), copyPlatform);

    // 1) 优先走浏览器 ClipboardItem（能同时写 text/html + text/plain）
    try {
      const nav: any = navigator as any;
      if (nav?.clipboard?.write && typeof (window as any).ClipboardItem !== "undefined") {
        const item = new (window as any).ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        });
        await nav.clipboard.write([item]);
        return;
      }
    } catch {
      // ignore, fallback to IPC
    }

    // 2) fallback：Electron clipboard
    try {
      const api = window.desktop?.clipboard;
      if (api?.writeRichText) {
        await api.writeRichText({ html, text: plain });
        return;
      }
    } catch {
      // ignore
    }

    // 3) ultimate fallback：纯文本
    try {
      await navigator.clipboard.writeText(plain);
    } catch {
      const api = window.desktop?.clipboard;
      await api?.writeText?.(plain).catch(() => void 0);
    }
  };

  return (
    <div className="editorRoot">
      <div className="tabBar">
        <div className="tabBarTabs">
          {openPaths.map((p) => (
            <div
              key={p}
              className={`tab ${p === activePath ? "tabActive" : ""} ${p === previewPath ? "tabPreview" : ""}`}
              onClick={() => setActivePath(p)}
              title={p}
            >
              <span className="tabLabel">{basename(p)}</span>
              <button
                className="tabClose"
                type="button"
                aria-label={`关闭 ${basename(p)}`}
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(p);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="tabBarRight">
          <span className="tag" title={selectedText === null ? "全文：行 / 词 / 字符" : "选中：行 / 词 / 字符"}>
            {selectedText === null ? "全文" : "选中"} 行 {stats.lines} · 词 {stats.words} · 字符 {stats.chars}
          </span>
          <select
            className="select selectSmall"
            value={copyPlatform}
            onChange={(e) => setCopyPlatform(e.target.value as ClipboardPlatform)}
            title="选择复制富文本时的目标平台样式预设（默认小红书）"
          >
            <option value="xiaohongshu">小红书</option>
            <option value="wechat">公众号</option>
            <option value="zhihu">知乎</option>
            <option value="feishu">飞书</option>
          </select>
          <button
            className="btn"
            type="button"
            onClick={() => void copyRichText()}
            title="复制选区为富文本（同时写入纯文本兜底）。无选区则复制全文。优先适配：小红书/公众号/知乎/飞书"
          >
            复制富文本
          </button>
          <button className="btn" type="button" onClick={() => void exportHtml()} title="导出当前文件为 HTML（写入 exports/）">
            Export:HTML
          </button>
        </div>
      </div>

      <div className="editorContainer">
        <Editor
          height="100%"
          language="markdown"
          theme="vs"
          value={activeFile?.content ?? ""}
          onMount={(ed: editor.IStandaloneCodeEditor) => setEditorRef(ed)}
          onChange={(value) => updateFile(activePath, value ?? "")}
          options={{
            // 关键：当拖动左右分割条 / Dock 分割条 / 窗口缩放时，Monaco 自动重新 layout，
            // 避免“编辑器输入区被 Dock/面板遮挡（其实是尺寸没刷新）”。
            automaticLayout: true,
            minimap: { enabled: false },
            wordWrap: "on",
            fontSize: 14,
            padding: { top: 12, bottom: 12 },
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </div>
  );
}


