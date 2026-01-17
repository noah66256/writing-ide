import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown } from "./Icons";

export type PillOption = {
  value: string;
  label: string;
};

export function PillSelect(props: {
  value: string;
  options: PillOption[];
  onChange: (value: string) => void;
  title?: string;
  minWidth?: number;
  maxWidth?: number;
}) {
  const { value, options, onChange } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<null | { left: number; bottom: number; width: number }>(
    null,
  );

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? options[0],
    [options, value],
  );

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const root = rootRef.current;
      const menu = menuRef.current;
      if (!root) return;
      const target = e.target as Node;
      if (root.contains(target)) return;
      if (menu && menu.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const computeMenuPos = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const width = Math.max(rect.width, 180);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    // 默认向上弹出：bottom = 视口底部到按钮顶部的距离 + gap
    const bottom = Math.max(8, window.innerHeight - rect.top + 8);
    setMenuPos({ left, bottom, width });
  };

  useEffect(() => {
    if (!open) return;
    computeMenuPos();
    const onResize = () => computeMenuPos();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div
      className="pillSelect"
      ref={rootRef}
      style={{
        // 允许在窄宽时继续收缩（避免把右侧“发送/停止”顶出屏幕）
        minWidth: props.minWidth ?? 0,
        maxWidth: props.maxWidth ?? 220,
      }}
      title={props.title}
    >
      <button
        className="pillBtn"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        ref={btnRef}
        onClick={() =>
          setOpen((x) => {
            const next = !x;
            if (next) computeMenuPos();
            return next;
          })
        }
      >
        <span className="pillLabel">{selected?.label ?? value}</span>
        <span className={`pillChevron ${open ? "pillChevronOpen" : ""}`}>
          <IconChevronDown />
        </span>
      </button>

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className="pillMenu"
            role="listbox"
            aria-label="选择"
            style={{
              position: "fixed",
              left: menuPos.left,
              bottom: menuPos.bottom,
              width: menuPos.width,
              zIndex: 9999,
            }}
          >
            {options.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  className={`pillOption ${active ? "pillOptionActive" : ""}`}
                  role="option"
                  aria-selected={active}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  title={o.label}
                >
                  {o.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}


