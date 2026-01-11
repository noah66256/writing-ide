import { useEffect, useMemo, useRef, useState } from "react";
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

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? options[0],
    [options, value],
  );

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (root.contains(e.target as Node)) return;
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

  return (
    <div
      className="pillSelect"
      ref={rootRef}
      style={{
        minWidth: props.minWidth ?? 96,
        maxWidth: props.maxWidth ?? 220,
      }}
      title={props.title}
    >
      <button
        className="pillBtn"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        <span className="pillLabel">{selected?.label ?? value}</span>
        <span className={`pillChevron ${open ? "pillChevronOpen" : ""}`}>
          <IconChevronDown />
        </span>
      </button>

      {open && (
        <div className="pillMenu" role="listbox" aria-label="选择">
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
        </div>
      )}
    </div>
  );
}


