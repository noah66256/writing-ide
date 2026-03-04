import { useEffect, useLayoutEffect, useRef } from "react";
import { useDialogStore } from "../state/dialogStore";

function safeFocus(el: HTMLElement | null) {
  try {
    el?.focus();
  } catch {
    // ignore
  }
}

export function DialogHost() {
  const cur = useDialogStore((s) => s.current);
  const setValue = useDialogStore((s) => s.setValue);
  const close = useDialogStore((s) => s.close);
  const resolveOk = useDialogStore((s) => s._resolveOk);
  const resolveCancel = useDialogStore((s) => s._resolveCancel);

  const okBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // Esc 关闭；Enter 确认（prompt/confirm）
  useEffect(() => {
    if (!cur) return;
    const onKey = (e: KeyboardEvent) => {
      if (!cur) return;
      if (e.key === "Escape") {
        e.preventDefault();
        resolveCancel?.();
        close();
        return;
      }
      if (e.key === "Enter") {
        if (cur.kind === "prompt") {
          // multiline: Enter 允许换行（除非 Ctrl/⌘+Enter 提交）
          if (cur.multiline && !(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          resolveOk?.(String(cur.value ?? ""));
          close();
          return;
        }
        if (cur.kind === "confirm") {
          e.preventDefault();
          resolveOk?.();
          close();
          return;
        }
        if (cur.kind === "choice") {
          const options = Array.isArray((cur as any).options) ? ((cur as any).options as any[]) : [];
          const firstId = String(options[0]?.id ?? "").trim();
          if (!firstId) return;
          e.preventDefault();
          resolveOk?.(firstId);
          close();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [close, cur, resolveCancel, resolveOk]);

  useLayoutEffect(() => {
    if (!cur) return;
    // 优先 focus 输入框，其次确认按钮
    if (cur.kind === "prompt") {
      requestAnimationFrame(() => {
        safeFocus(inputRef.current);
        try {
          (inputRef.current as any)?.select?.();
        } catch {
          // ignore
        }
      });
      return;
    }
    requestAnimationFrame(() => safeFocus(okBtnRef.current));
  }, [cur?.id, cur?.kind]);

  if (!cur) return null;

  const title = String(cur.title ?? (cur.kind === "alert" ? "提示" : cur.kind === "confirm" ? "确认" : "输入"));
  const message = String((cur as any).message ?? "");

  const okText = cur.kind === "alert" ? String(cur.okText ?? "确定") : String((cur as any).confirmText ?? "确定");
  const cancelText = cur.kind === "confirm" || cur.kind === "prompt" || cur.kind === "choice" ? String((cur as any).cancelText ?? "取消") : "";
  const danger = Boolean((cur as any).danger);
  const choiceOptions = cur.kind === "choice" && Array.isArray((cur as any).options) ? ((cur as any).options as any[]) : [];

  return (
    <div className="modalMask" role="dialog" aria-modal="true">
      <div className="modal" style={{ width: "min(560px, calc(100vw - 24px))" }}>
        <div className="modalTitle">{title}</div>
        {message ? (
          <div className="modalDesc" style={{ whiteSpace: "pre-wrap" }}>
            {message}
          </div>
        ) : null}

        {cur.kind === "prompt" ? (
          cur.multiline ? (
            <textarea
              ref={(el) => {
                inputRef.current = el;
              }}
              className="modalInput"
              style={{ minHeight: 120, resize: "vertical" }}
              value={String(cur.value ?? "")}
              placeholder={String(cur.placeholder ?? "")}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <input
              ref={(el) => {
                inputRef.current = el;
              }}
              className="modalInput"
              value={String(cur.value ?? "")}
              placeholder={String(cur.placeholder ?? "")}
              onChange={(e) => setValue(e.target.value)}
            />
          )
        ) : null}

        <div className="modalBtns" style={{ marginTop: 12 }}>
          {cur.kind === "confirm" || cur.kind === "prompt" || cur.kind === "choice" ? (
            <button
              ref={cancelBtnRef}
              className="btn"
              type="button"
              onClick={() => {
                resolveCancel?.();
                close();
              }}
            >
              {cancelText}
            </button>
          ) : null}
          {cur.kind === "choice" ? (
            choiceOptions.map((opt, idx) => (
              <button
                key={String(opt?.id ?? idx)}
                ref={idx === 0 ? okBtnRef : null}
                className={`btn ${opt?.danger ? "btnDanger" : "btnPrimary"}`}
                type="button"
                onClick={() => {
                  const id = String(opt?.id ?? "").trim();
                  resolveOk?.(id);
                  close();
                }}
              >
                {String(opt?.label ?? `选项${idx + 1}`)}
              </button>
            ))
          ) : (
            <button
              ref={okBtnRef}
              className={`btn ${danger ? "btnDanger" : "btnPrimary"}`}
              type="button"
              onClick={() => {
                if (cur.kind === "prompt") resolveOk?.(String(cur.value ?? ""));
                else resolveOk?.();
                close();
              }}
            >
              {okText}
            </button>
          )}
        </div>

        {cur.kind === "prompt" && cur.multiline ? (
          <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>
            快捷键：Esc 取消；Ctrl/⌘ + Enter 提交。
          </div>
        ) : null}
      </div>
    </div>
  );
}
