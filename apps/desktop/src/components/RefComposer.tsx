import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";

export type RefItem = { kind: "file" | "dir"; path: string };

export type RefComposerHandle = {
  focus: () => void;
  getValue: () => string;
  setValue: (value: string) => void;
  insertRef: (item: RefItem) => void;
};

const REF_CLASS = "refChip";
const DND_MIME = "application/x-writing-ide-item";

function normalizePath(p: string) {
  let s = String(p ?? "").trim().replaceAll("\\", "/");
  s = s.replace(/\/+/g, "/");
  s = s.replace(/^\.\//, "");
  return s;
}

function tokenFor(item: RefItem) {
  const p = normalizePath(item.path);
  const path = item.kind === "dir" && p && !p.endsWith("/") ? `${p}/` : p;
  return `@{${path}}`;
}

function parseTokenValue(raw: string): RefItem | null {
  const s = String(raw ?? "").trim();
  if (!s.startsWith("@{") || !s.endsWith("}")) return null;
  let inner = s.slice(2, -1).trim();
  if (!inner) return null;
  inner = normalizePath(inner);
  const isDir = inner.endsWith("/");
  if (isDir) inner = inner.replace(/\/+$/g, "");
  return { kind: isDir ? "dir" : "file", path: inner };
}

function buildChip(item: RefItem) {
  const el = document.createElement("span");
  el.className = REF_CLASS;
  el.contentEditable = "false";
  el.dataset.kind = item.kind;
  el.dataset.path = normalizePath(item.path);
  el.title = el.dataset.path ?? "";

  const label = document.createElement("span");
  label.className = "refChipLabel";
  label.textContent = item.kind === "dir" ? `${el.dataset.path}/` : el.dataset.path ?? "";

  const close = document.createElement("span");
  close.className = "refChipClose";
  close.textContent = "×";
  close.title = "移除引用";

  el.appendChild(label);
  el.appendChild(close);
  return el;
}

function serialize(root: HTMLElement) {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    if (el.classList.contains(REF_CLASS)) {
      const kind = (el.dataset.kind === "dir" ? "dir" : "file") as RefItem["kind"];
      const path = normalizePath(el.dataset.path ?? "");
      return tokenFor({ kind, path });
    }
    const tag = el.tagName;
    if (tag === "BR") return "\n";
    let out = "";
    for (const child of Array.from(el.childNodes)) out += walk(child);
    if (tag === "DIV" || tag === "P") {
      if (out && !out.endsWith("\n")) out += "\n";
    }
    return out;
  };

  let out = "";
  for (const child of Array.from(root.childNodes)) out += walk(child);
  // 清理末尾多余换行
  out = out.replace(/\n+$/g, "");
  return out;
}

function setFromValue(root: HTMLElement, value: string) {
  root.innerHTML = "";
  const s = String(value ?? "");
  const re = /@\{[^}]+\}/g;
  let last = 0;
  let m: RegExpExecArray | null = null;

  const appendText = (text: string) => {
    if (!text) return;
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i]) root.appendChild(document.createTextNode(parts[i]));
      if (i < parts.length - 1) root.appendChild(document.createElement("br"));
    }
  };

  while ((m = re.exec(s)) !== null) {
    const before = s.slice(last, m.index);
    appendText(before);
    const tok = m[0];
    const item = parseTokenValue(tok);
    if (item) root.appendChild(buildChip(item));
    else appendText(tok);
    // token 后追加一个空格，便于继续输入
    root.appendChild(document.createTextNode(" "));
    last = m.index + tok.length;
  }
  appendText(s.slice(last));
}

function isSelectionInside(root: HTMLElement, sel: Selection | null) {
  if (!sel || sel.rangeCount === 0) return false;
  const r = sel.getRangeAt(0);
  const sc = r.startContainer;
  return root === sc || root.contains(sc);
}

function getRefItemFromDataTransfer(dt: DataTransfer | null): RefItem | null {
  if (!dt) return null;
  const raw = dt.getData(DND_MIME);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    const kind = obj?.kind === "dir" ? "dir" : obj?.kind === "file" ? "file" : null;
    const path = normalizePath(String(obj?.path ?? ""));
    if (!kind || !path) return null;
    return { kind, path };
  } catch {
    return null;
  }
}

function rangeFromPoint(x: number, y: number): Range | null {
  const doc: any = document as any;
  if (typeof doc.caretRangeFromPoint === "function") {
    try {
      return doc.caretRangeFromPoint(x, y) as Range;
    } catch {
      // ignore
    }
  }
  if (typeof doc.caretPositionFromPoint === "function") {
    try {
      const pos = doc.caretPositionFromPoint(x, y);
      if (!pos) return null;
      const r = document.createRange();
      r.setStart(pos.offsetNode, pos.offset);
      r.collapse(true);
      return r;
    } catch {
      // ignore
    }
  }
  return null;
}

export const RefComposer = forwardRef<
  RefComposerHandle,
  {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    onEnterSend?: () => void;
    disabled?: boolean;
    className?: string;
    "aria-label"?: string;
  }
>(function RefComposer(props, ref) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastValueRef = useRef<string>(String(props.value ?? ""));
  const lastRangeRef = useRef<Range | null>(null);

  const placeholder = useMemo(() => props.placeholder ?? "", [props.placeholder]);

  const syncToState = () => {
    const el = rootRef.current;
    if (!el) return;
    const v = serialize(el);
    lastValueRef.current = v;
    props.onChange(v);
  };

  const saveSelection = () => {
    const el = rootRef.current;
    if (!el) return;
    const sel = document.getSelection();
    if (!isSelectionInside(el, sel)) return;
    try {
      lastRangeRef.current = sel?.getRangeAt(0)?.cloneRange?.() ?? null;
    } catch {
      lastRangeRef.current = null;
    }
  };

  const restoreSelection = () => {
    const el = rootRef.current;
    const r = lastRangeRef.current;
    if (!el || !r) return;
    try {
      const sel = document.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(r);
    } catch {
      // ignore
    }
  };

  const insertRef = (item: RefItem) => {
    const el = rootRef.current;
    if (!el) return;
    el.focus();
    restoreSelection();
    const sel = document.getSelection();
    if (!sel) return;
    let range: Range | null = null;
    try {
      if (sel.rangeCount > 0) range = sel.getRangeAt(0);
    } catch {
      range = null;
    }
    if (!range || !isSelectionInside(el, sel)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // 插入 chip + 空格
    const chip = buildChip(item);
    range.deleteContents();
    range.insertNode(document.createTextNode(" "));
    range.insertNode(chip);
    range.setStartAfter(chip.nextSibling ?? chip);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    saveSelection();
    syncToState();
  };

  const setValue = (value: string) => {
    const el = rootRef.current;
    if (!el) return;
    lastValueRef.current = String(value ?? "");
    setFromValue(el, lastValueRef.current);
    syncToState();
  };

  useImperativeHandle(
    ref,
    () => ({
      focus: () => rootRef.current?.focus(),
      getValue: () => serialize(rootRef.current ?? document.createElement("div")),
      setValue,
      insertRef,
    }),
    [],
  );

  // 外部 value 变化时同步到 DOM（比如发送后清空、从历史回填）
  useEffect(() => {
    const next = String(props.value ?? "");
    if (next === lastValueRef.current) return;
    const el = rootRef.current;
    if (!el) return;
    lastValueRef.current = next;
    setFromValue(el, next);
  }, [props.value]);

  return (
    <div
      ref={rootRef}
      className={`composerTextarea composerEditable ${props.className ?? ""}`}
      contentEditable={!props.disabled}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      aria-label={props["aria-label"] ?? "输入"}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement | null;
        if (!t) return;
        if (t.classList?.contains?.("refChipClose")) {
          e.preventDefault();
          e.stopPropagation();
          const chip = t.closest?.(`.${REF_CLASS}`) as HTMLElement | null;
          chip?.remove();
          syncToState();
        }
      }}
      onDragOver={(e) => {
        const item = getRefItemFromDataTransfer(e.dataTransfer);
        if (!item) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        const item = getRefItemFromDataTransfer(e.dataTransfer);
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        const el = rootRef.current;
        if (!el) return;
        const r = rangeFromPoint(e.clientX, e.clientY);
        if (r) {
          try {
            const sel = document.getSelection();
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(r);
            }
            lastRangeRef.current = r.cloneRange();
          } catch {
            // ignore
          }
        }
        insertRef(item);
      }}
      onInput={() => syncToState()}
      onKeyUp={() => saveSelection()}
      onMouseUp={() => saveSelection()}
      onFocus={() => saveSelection()}
      onBlur={() => {
        // 把用户手输/粘贴的 @{} token 转成 chip（失焦时做一次，不影响打字体验）
        const el = rootRef.current;
        if (!el) return;
        const v = serialize(el);
        lastValueRef.current = v;
        props.onChange(v);
        setFromValue(el, v);
      }}
      onKeyDown={(e) => {
        if ((e as any).isComposing) return;
        if (e.key === "Enter" && props.onEnterSend) {
          if (e.shiftKey || e.ctrlKey || e.metaKey) return; // Shift/Ctrl/⌘ + Enter：换行（默认行为）
          e.preventDefault();
          props.onEnterSend();
          return;
        }

        // Backspace/Delete：一键删除 chip
        if (e.key === "Backspace" || e.key === "Delete") {
          const el = rootRef.current;
          const sel = document.getSelection();
          if (!el || !sel || sel.rangeCount === 0) return;
          const r = sel.getRangeAt(0);
          if (!r.collapsed) return; // 有选区就交给浏览器

          const container = r.startContainer;
          const offset = r.startOffset;
          const isBack = e.key === "Backspace";

          const removeChip = (chip: HTMLElement) => {
            e.preventDefault();
            chip.remove();
            syncToState();
          };

          const findPrev = (): HTMLElement | null => {
            if (container.nodeType === Node.TEXT_NODE) {
              if (isBack && offset !== 0) return null;
              const prev = (container as any).previousSibling as Node | null;
              return prev && prev.nodeType === Node.ELEMENT_NODE ? (prev as HTMLElement) : null;
            }
            if (container.nodeType === Node.ELEMENT_NODE) {
              const elc = container as Element;
              const idx = isBack ? offset - 1 : offset;
              const node = elc.childNodes.item(idx);
              return node && node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : null;
            }
            return null;
          };

          const chip = findPrev();
          if (chip && chip.classList?.contains?.(REF_CLASS)) {
            removeChip(chip);
          }
        }
      }}
    />
  );
});


