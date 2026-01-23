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
    // 重要：这里用数组维护“选择顺序”（用于 stage 的备用模型优先级）。
    // - 选中：追加到末尾
    // - 取消：删除该项
    const idx = selectedIds.indexOf(id);
    if (idx >= 0) onChange(selectedIds.filter((x) => x !== id));
    else onChange([...selectedIds, id]);
  };

  const selectAllFiltered = () => {
    const next = selectedIds.slice();
    const set = new Set(next);
    for (const o of filtered) {
      if (o.disabled) continue;
      if (!o.id) continue;
      if (set.has(o.id)) continue;
      set.add(o.id);
      next.push(o.id);
    }
    onChange(next);
  };

  const clearAll = () => {
    // 保留 locked（顺序保持不变）
    onChange(selectedIds.filter((id) => locked.has(id)));
  };

  const removeOne = (id: string) => {
    if (!id) return;
    if (locked.has(id)) return;
    onChange(selectedIds.filter((x) => x !== id));
  };

  const moveOne = (id: string, dir: -1 | 1) => {
    if (!id) return;
    if (locked.has(id)) return;
    const idx = selectedIds.indexOf(id);
    if (idx < 0) return;
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= selectedIds.length) return;
    // 不允许跨过 locked（默认）项
    if (locked.has(selectedIds[nextIdx]!)) return;
    const next = selectedIds.slice();
    const tmp = next[idx]!;
    next[idx] = next[nextIdx]!;
    next[nextIdx] = tmp;
    onChange(next);
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
                    onClick={() => moveOne(o.id, -1)}
                    title={isLocked ? "默认模型锁定" : "上移（提高优先级）"}
                    style={{ marginLeft: 4 }}
                  >
                    ↑
                  </button>
                  <button
                    className="multiPickTagX"
                    type="button"
                    disabled={isLocked}
                    onClick={() => moveOne(o.id, 1)}
                    title={isLocked ? "默认模型锁定" : "下移（降低优先级）"}
                    style={{ marginLeft: 2 }}
                  >
                    ↓
                  </button>
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



