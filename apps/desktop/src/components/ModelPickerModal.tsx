import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { ProviderLogo, resolveProviderBrand } from "@/components/ProviderLogo";

export type ModelPickerItem = {
  id: string;
  label: string;
  providerName?: string | null;
  providerId?: string | null;
};

function getBrand(item: ModelPickerItem) {
  return resolveProviderBrand({
    providerId: item.providerId,
    providerName: item.providerName,
    modelId: item.id,
    label: item.label,
  });
}

function groupName(m: ModelPickerItem): string {
  return getBrand(m).label;
}

export function ModelPickerModal(props: {
  open: boolean;
  title?: string;
  items: ModelPickerItem[];
  value: string;
  onChange: (id: string) => void;
  onClose: () => void;
}) {
  const { open, items, value } = props;
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    if (!open) return;
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, props]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const base = Array.isArray(items) ? items : [];
    if (!qq) return base;
    return base.filter((m) => {
      const a = String(m.label || "").toLowerCase();
      const b = String(m.providerName || "").toLowerCase();
      const c = String(m.providerId || "").toLowerCase();
      const d = getBrand(m).label.toLowerCase();
      return a.includes(qq) || b.includes(qq) || c.includes(qq) || d.includes(qq);
    });
  }, [items, q]);

  const groups = useMemo(() => {
    const map = new Map<string, ModelPickerItem[]>();
    for (const m of filtered) {
      const g = groupName(m);
      const arr = map.get(g) || [];
      arr.push(m);
      map.set(g, arr);
    }
    const keys = Array.from(map.keys());
    keys.sort((a, b) => a.localeCompare(b));
    return keys.map((k) => {
      const arr = map.get(k) || [];
      arr.sort((a, b) => a.label.localeCompare(b.label));
      return { name: k, items: arr, brand: getBrand(arr[0] ?? { id: k, label: k }) };
    });
  }, [filtered]);

  if (!open) return null;

  return (
    <div className="modalMask" role="dialog" aria-modal="true" onMouseDown={() => props.onClose()}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div className="modalTitle">{props.title || "选择模型"}</div>
          <button className="btn" type="button" onClick={() => props.onClose()}>
            关闭
          </button>
        </div>

        <input
          ref={inputRef}
          className="modalInput"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索模型或厂商…"
        />

        <div style={{ marginTop: 10 }}>
          {groups.length ? (
            groups.map((g) => (
              <div key={g.name} style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: "var(--muted)", margin: "8px 0 6px", display: "flex", alignItems: "center", gap: 8 }}>
                  <ProviderLogo brand={g.brand} size={18} />
                  <span>{g.name}</span>
                </div>
                <div className="refList" style={{ maxHeight: 360 }}>
                  {g.items.map((m) => {
                    const active = m.id === value;
                    const brand = getBrand(m);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className="refItem"
                        style={
                          active
                            ? { borderColor: "rgba(37, 99, 235, 0.6)", boxShadow: "0 0 0 2px rgba(37, 99, 235, 0.10)" }
                            : undefined
                        }
                        onClick={() => {
                          props.onChange(m.id);
                          props.onClose();
                        }}
                        title={m.label}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, width: "100%" }}>
                          <ProviderLogo brand={brand} size={22} />
                          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{m.label}</div>
                            <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
                              <span>{brand.label}</span>
                              <span>·</span>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{m.id}</span>
                            </div>
                          </div>
                          {active ? <Check size={16} color="var(--color-accent, #2563eb)" /> : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          ) : (
            <div className="muted" style={{ marginTop: 10 }}>
              未找到匹配模型
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
