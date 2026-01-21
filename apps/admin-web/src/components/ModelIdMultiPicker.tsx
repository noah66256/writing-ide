import { useMemo, useState } from "react";

export type MultiPickTag = { text: string; className?: string; title?: string };
export type MultiPickOption = {
  id: string;
  label: string;
  subLabel?: string;
  disabled?: boolean;
  tags?: MultiPickTag[];
};

type Props = {
  options: MultiPickOption[];
  selectedIds: string[];
  lockedIds?: string[];
  onChange: (nextIds: string[]) => void;
  placeholder?: string;
};

export function ModelIdMultiPicker({ options, selectedIds, lockedIds, onChange, placeholder }: Props) {
  const [q, setQ] = useState("");
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const locked = useMemo(() => new Set((lockedIds ?? []).filter(Boolean)), [lockedIds]);

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    if (!key) return options;
    return options.filter((o) => {
      const a = String(o.label ?? "").toLowerCase();
      const b = String(o.subLabel ?? "").toLowerCase();
      return a.includes(key) || b.includes(key);
    });
  }, [options, q]);

  const toggle = (id: string) => {
    if (!id) return;
    if (locked.has(id)) return;
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  const selectAllFiltered = () => {
    const next = new Set(selectedIds);
    for (const o of filtered) {
      if (o.disabled) continue;
      next.add(o.id);
    }
    onChange(Array.from(next));
  };

  const clearAll = () => {
    const next = new Set<string>();
    for (const id of selectedIds) if (locked.has(id)) next.add(id);
    onChange(Array.from(next));
  };

  const removeOne = (id: string) => {
    if (!id) return;
    if (locked.has(id)) return;
    const next = new Set(selectedIds);
    next.delete(id);
    onChange(Array.from(next));
  };

  const selectedOptions = useMemo(() => {
    const map = new Map(options.map((o) => [o.id, o] as const));
    return selectedIds.map((id) => map.get(id)).filter(Boolean) as MultiPickOption[];
  }, [options, selectedIds]);

  return (
    <div className="multiPick">
      <div className="multiPickTop">
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder ?? "搜索模型…"} />
        <div className="multiPickBtns">
          <button className="btn" type="button" onClick={selectAllFiltered}>
            全选
          </button>
          <button className="btn" type="button" onClick={clearAll}>
            清空
          </button>
        </div>
      </div>

      <div className="multiPickSelected">
        <div className="muted" style={{ fontSize: 12 }}>
          已选 {selectedIds.length} 个{lockedIds?.length ? "（含默认锁定）" : ""}
        </div>
        <div className="multiPickTags">
          {selectedOptions.length ? (
            selectedOptions.map((o) => {
              const isLocked = locked.has(o.id);
              return (
                <span key={o.id} className="tag tagBlue" title={o.subLabel || o.label}>
                  {o.label}
                  <button
                    className="multiPickTagX"
                    type="button"
                    disabled={isLocked}
                    onClick={() => removeOne(o.id)}
                    title={isLocked ? "默认模型锁定，不能移除" : "移除"}
                  >
                    ×
                  </button>
                </span>
              );
            })
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              未选择（将等价于“不限制”）
            </span>
          )}
        </div>
      </div>

      <div className="multiPickList">
        {filtered.map((o) => {
          const checked = selected.has(o.id);
          const isLocked = locked.has(o.id);
          return (
            <label key={o.id} className={`multiPickItem ${o.disabled ? "multiPickItemDisabled" : ""}`}>
              <input type="checkbox" checked={checked} disabled={o.disabled || isLocked} onChange={() => toggle(o.id)} />
              <div className="multiPickItemMain">
                <div className="multiPickItemTitle">
                  {o.label}
                  {isLocked ? (
                    <span className="tag tagPurple" style={{ marginLeft: 8 }}>
                      默认
                    </span>
                  ) : null}
                </div>
                {o.subLabel ? (
                  <div className="muted" style={{ fontSize: 12 }}>
                    {o.subLabel}
                  </div>
                ) : null}
                {o.tags?.length ? (
                  <div className="multiPickItemTags">
                    {o.tags.map((t, i) => (
                      <span key={`${o.id}-${i}`} className={`tag ${t.className ?? ""}`} title={t.title ?? ""}>
                        {t.text}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}



