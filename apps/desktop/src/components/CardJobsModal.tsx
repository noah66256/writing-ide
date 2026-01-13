import { useEffect, useMemo, useRef, useState } from "react";
import { useKbStore, type KbCardJob } from "../state/kbStore";
import { useRunStore } from "../state/runStore";
import { FACET_PACKS, facetPackLabel } from "../kb/facets";
import { RichText } from "./RichText";

function statusLabel(s: KbCardJob["status"]) {
  if (s === "pending") return "等待";
  if (s === "running") return "进行中";
  if (s === "success") return "完成";
  if (s === "skipped") return "跳过（已抽过/无内容）";
  if (s === "failed") return "失败";
  if (s === "cancelled") return "已取消";
  return s;
}

function statusColor(s: KbCardJob["status"]) {
  if (s === "running") return "rgba(37, 99, 235, 0.95)";
  if (s === "success") return "rgba(22, 163, 74, 0.95)";
  if (s === "skipped") return "rgba(100, 116, 139, 0.95)";
  if (s === "failed") return "rgba(220, 38, 38, 0.95)";
  if (s === "cancelled") return "rgba(100, 116, 139, 0.95)";
  return "var(--muted)";
}

export function CardJobsModal() {
  const open = useKbStore((s) => s.kbManagerOpen);
  const tab = useKbStore((s) => s.kbManagerTab);
  const notice = useKbStore((s) => s.kbManagerNotice);
  const status = useKbStore((s) => s.cardJobStatus);
  const jobs = useKbStore((s) => s.cardJobs);
  const playbookJobs = useKbStore((s) => s.playbookJobs);
  const close = useKbStore((s) => s.closeKbManager);
  const start = useKbStore((s) => s.startCardJobs);
  const pause = useKbStore((s) => s.pauseCardJobs);
  const resume = useKbStore((s) => s.resumeCardJobs);
  const cancel = useKbStore((s) => s.cancelCardJobs);
  const clearFinished = useKbStore((s) => s.clearFinishedCardJobs);
  const retryFailed = useKbStore((s) => s.retryFailedCardJobs);

  const libraries = useKbStore((s) => s.libraries);
  const trash = useKbStore((s) => s.trashLibraries);
  const currentLibraryId = useKbStore((s) => s.currentLibraryId);
  const setCurrentLibrary = useKbStore((s) => s.setCurrentLibrary);
  const refreshLibraries = useKbStore((s) => s.refreshLibraries);
  const createLibrary = useKbStore((s) => s.createLibrary);
  const renameLibrary = useKbStore((s) => s.renameLibrary);
  const setLibraryFacetPack = useKbStore((s) => s.setLibraryFacetPack);
  const enqueuePlaybookJob = useKbStore((s) => s.enqueuePlaybookJob);
  const deleteLibraryToTrash = useKbStore((s) => s.deleteLibraryToTrash);
  const restoreLibraryFromTrash = useKbStore((s) => s.restoreLibraryFromTrash);
  const purgeLibrary = useKbStore((s) => s.purgeLibrary);
  const emptyTrash = useKbStore((s) => s.emptyTrash);
  const openKbManager = useKbStore((s) => s.openKbManager);

  const attached = useRunStore((s) => s.kbAttachedLibraryIds);
  const toggleAttach = useRunStore((s) => s.toggleKbAttachedLibrary);

  const listCardsForLibrary = useKbStore((s) => s.listCardsForLibrary);

  type PromptState = {
    title: string;
    desc?: string;
    placeholder?: string;
    value: string;
    confirmText?: string;
    onConfirm: (value: string) => Promise<void> | void;
  };
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  const ask = (p: Omit<PromptState, "value"> & { value?: string }) => setPrompt({ ...p, value: p.value ?? "" });

  // 窗口拖动（不限制边界；可双击标题栏回到居中）
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<null | { startX: number; startY: number; baseX: number; baseY: number; pointerId: number }>(null);

  useEffect(() => {
    if (!open) return;
    void refreshLibraries().catch(() => void 0);
  }, [open, refreshLibraries]);

  useEffect(() => {
    if (!prompt) return;
    const t = window.setTimeout(() => promptInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [prompt]);

  const summary = useMemo(() => {
    const total = jobs.length + playbookJobs.length;
    const done =
      jobs.filter((j) => j.status === "success" || j.status === "skipped").length +
      playbookJobs.filter((j) => j.status === "success").length;
    const failed = jobs.filter((j) => j.status === "failed").length + playbookJobs.filter((j) => j.status === "failed").length;
    const cancelled =
      jobs.filter((j) => j.status === "cancelled").length + playbookJobs.filter((j) => j.status === "cancelled").length;
    const runningCard = jobs.find((j) => j.status === "running");
    const runningPlaybook = playbookJobs.find((j) => j.status === "running");
    const runningLabel = runningCard?.docTitle ?? (runningPlaybook ? `【风格手册】${runningPlaybook.libraryName ?? runningPlaybook.libraryId}` : null);
    return { total, done, failed, cancelled, runningLabel };
  }, [jobs, playbookJobs]);

  const currentLibrary = useMemo(() => {
    const id = String(currentLibraryId ?? "").trim();
    if (!id) return null;
    return libraries.find((l) => l.id === id) ?? null;
  }, [libraries, currentLibraryId]);

  // 库内卡片浏览（轻量）
  const [viewLibId, setViewLibId] = useState<string | null>(null);
  const [cardsQuery, setCardsQuery] = useState("");
  const [cardsType, setCardsType] = useState<string>("__all__");
  const [cardsLoading, setCardsLoading] = useState(false);
  const [cardsErr, setCardsErr] = useState<string | null>(null);
  const [cardsTotal, setCardsTotal] = useState(0);
  const [cards, setCards] = useState<Array<{ artifact: any; sourceDoc: any }>>([]);

  useEffect(() => {
    if (!open) return;
    if (tab !== "libraries") return;
    if (!viewLibId) return;
    void (async () => {
      setCardsLoading(true);
      setCardsErr(null);
      const r = await listCardsForLibrary({
        libraryId: viewLibId,
        limit: 240,
        cardTypes: cardsType === "__all__" ? undefined : [cardsType],
        query: cardsQuery.trim() ? cardsQuery.trim() : undefined,
      });
      if (!r.ok) {
        setCardsErr(r.error ?? "LOAD_FAILED");
        setCards([] as any);
        setCardsTotal(0);
      } else {
        setCards(r.cards as any);
        setCardsTotal(r.total);
      }
      setCardsLoading(false);
    })();
  }, [open, tab, viewLibId, cardsQuery, cardsType, listCardsForLibrary]);

  if (!open) return null;

  return (
    <div
      className="modalMask"
      onMouseDown={(e) => {
        // 点击遮罩关闭
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="modal"
        style={{
          width: "min(920px, calc(100vw - 24px))",
          transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
          willChange: dragRef.current ? "transform" : undefined,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            userSelect: "none",
            cursor: dragRef.current ? "grabbing" : "grab",
          }}
          title="拖动：按住标题栏拖动；双击回到居中"
          onDoubleClick={() => setPos({ x: 0, y: 0 })}
          onPointerDown={(e) => {
            // 仅左键拖动
            if (e.button !== 0) return;
            // 避免在按钮上触发拖动
            const target = e.target as HTMLElement | null;
            if (target && (target.closest("button") || target.closest("input") || target.closest("select") || target.closest("textarea"))) return;
            dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y, pointerId: e.pointerId };
            try {
              (e.currentTarget as any)?.setPointerCapture?.(e.pointerId);
            } catch {
              // ignore
            }
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            if (!d) return;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            setPos({ x: d.baseX + dx, y: d.baseY + dy });
          }}
          onPointerUp={(e) => {
            const d = dragRef.current;
            if (!d) return;
            dragRef.current = null;
            try {
              (e.currentTarget as any)?.releasePointerCapture?.(d.pointerId);
            } catch {
              // ignore
            }
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
        >
          <div className="modalTitle" style={{ marginBottom: 0 }}>
            知识库管理
          </div>
          <button className="btn btnIcon" type="button" onClick={close} onPointerDown={(e) => e.stopPropagation()}>
            关闭
          </button>
        </div>

        <div className="modalDesc" style={{ marginTop: 10 }}>
          这里统一管理「库 / 抽卡任务 / 回收站」。为避免误操作，导入语料前必须先选择当前库。
        </div>

        <div className="dockTabs" style={{ padding: 0, borderBottom: "none", marginBottom: 10 }}>
          <div className={`dockTab ${tab === "libraries" ? "dockTabActive" : ""}`} onClick={() => openKbManager("libraries")}>
            库
          </div>
          <div className={`dockTab ${tab === "jobs" ? "dockTabActive" : ""}`} onClick={() => openKbManager("jobs")}>
            抽卡任务
          </div>
          <div className={`dockTab ${tab === "trash" ? "dockTabActive" : ""}`} onClick={() => openKbManager("trash")}>
            回收站
          </div>
        </div>

        {notice ? (
          <div className="explorerHint" style={{ marginBottom: 10 }}>
            {notice}
          </div>
        ) : null}

        {tab === "libraries" ? (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                className="btn btnIcon"
                type="button"
                onClick={() => {
                  ask({
                    title: "新建库",
                    desc: "请输入库名称（例如：写法库/产品库/营销库）",
                    placeholder: "例如：写法库",
                    confirmText: "创建",
                    onConfirm: async (v) => {
                      const r = await createLibrary(v);
                      if (!r.ok) window.alert(`创建失败：${r.error ?? "unknown"}`);
                      await refreshLibraries().catch(() => void 0);
                    },
                  });
                }}
              >
                新建库
              </button>
              <button className="btn btnIcon" type="button" onClick={() => void refreshLibraries()}>
                刷新
              </button>
              <span className="ctxPill">当前库：{currentLibraryId ? currentLibraryId : "（未选择）"}</span>
            </div>

            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 12,
                background: "var(--panel)",
                padding: 10,
                maxHeight: "min(52vh, 520px)",
                overflow: "auto",
                display: "grid",
                gap: 10,
              }}
            >
              {libraries.length ? (
                libraries.map((l) => {
                  const isCur = l.id === currentLibraryId;
                  const isAttached = attached.includes(l.id);
                  return (
                    <div key={l.id} style={{ borderBottom: "1px dashed var(--border)", paddingBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                        <div style={{ minWidth: 0 }}>
                          <button
                            type="button"
                            className="btn"
                            style={{
                              padding: "4px 8px",
                              fontSize: 13,
                              fontWeight: 700,
                              color: "var(--text)",
                              maxWidth: 420,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title="查看该库卡片（在下方展示）"
                            onClick={() => setViewLibId((prev) => (prev === l.id ? null : l.id))}
                          >
                            {l.name}
                          </button>
                          <div style={{ fontSize: 12, color: "var(--muted)" }}>
                            文档 {l.docCount} 篇 · 更新 {new Date(l.updatedAt).toLocaleString()} · 标签 {facetPackLabel(l.facetPackId)}
                          </div>
                          <div style={{ fontSize: 12, color: "var(--muted)" }}>id: {l.id}</div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <button
                            className={`btn btnIcon ${isCur ? "btnPrimary" : ""}`}
                            type="button"
                            onClick={() => setCurrentLibrary(isCur ? null : l.id)}
                            title={isCur ? "再次点击可取消当前库" : "设为当前库"}
                          >
                            {isCur ? "当前库" : "设为当前"}
                          </button>
                          <button className={`btn btnIcon ${isAttached ? "btnPrimary" : ""}`} type="button" onClick={() => toggleAttach(l.id)}>
                            {isAttached ? "已关联右侧" : "关联到右侧"}
                          </button>
                          <button
                            className="btn btnIcon"
                            type="button"
                            onClick={() => {
                              ask({
                                title: "重命名库",
                                desc: `当前：${l.name}`,
                                placeholder: "新的库名称",
                                value: l.name,
                                confirmText: "保存",
                                onConfirm: async (v) => {
                                  const r = await renameLibrary(l.id, v);
                                  if (!r.ok) window.alert(`重命名失败：${r.error ?? "unknown"}`);
                                  await refreshLibraries().catch(() => void 0);
                                },
                              });
                            }}
                          >
                            重命名
                          </button>
                          <button
                            className="btn btnDanger btnIcon"
                            type="button"
                            onClick={() => {
                              const ok = window.confirm(`删除库「${l.name}」？\n\n将进入回收站，可恢复；也可在回收站彻底删除/清空。`);
                              if (!ok) return;
                              void (async () => {
                                const r = await deleteLibraryToTrash(l.id);
                                if (!r.ok) window.alert(`删除失败：${r.error ?? "unknown"}`);
                                await refreshLibraries().catch(() => void 0);
                              })();
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="explorerHint">还没有库。先点「新建库」，然后设为当前库再导入语料。</div>
              )}
            </div>

            {viewLibId ? (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  background: "var(--panel)",
                  padding: 10,
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <div className="sectionTitle" style={{ padding: 0 }}>
                      卡片（库内预览）
                    </div>
                    <span className="ctxPill">共 {cardsTotal} 条</span>
                    {cardsLoading ? <span className="ctxPill">加载中…</span> : null}
                    {cardsErr ? <span className="ctxPill" style={{ color: "rgba(220, 38, 38, 0.95)" }}>{cardsErr}</span> : null}
                  </div>
                  <button className="btn btnIcon" type="button" onClick={() => setViewLibId(null)}>
                    收起
                  </button>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    className="modalInput"
                    style={{ maxWidth: 360 }}
                    value={cardsQuery}
                    placeholder="搜索卡片（标题/内容/类型/文档名）…"
                    onChange={(e) => setCardsQuery(e.target.value)}
                  />
                  <select className="btn" value={cardsType} onChange={(e) => setCardsType(String(e.target.value ?? "__all__"))} title="按卡片类型过滤">
                    <option value="__all__">全部类型</option>
                    <option value="hook">hook</option>
                    <option value="thesis">thesis</option>
                    <option value="ending">ending</option>
                    <option value="one_liner">one_liner</option>
                    <option value="outline">outline</option>
                    <option value="other">other</option>
                    <option value="style_profile">style_profile</option>
                    <option value="playbook_facet">playbook_facet</option>
                  </select>
                </div>

                <div
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    background: "var(--panel2)",
                    padding: 10,
                    maxHeight: "min(44vh, 420px)",
                    overflow: "auto",
                    display: "grid",
                    gap: 10,
                  }}
                >
                  {!cardsLoading && !cards.length ? (
                    <div className="explorerHint">暂无卡片（可能还没抽卡/没生成风格手册，或筛选条件无结果）。</div>
                  ) : null}
                  {cards.map((it) => {
                    const t = String(it?.artifact?.cardType ?? "");
                    const title = String(it?.artifact?.title ?? "").trim() || "（无标题）";
                    const content = String(it?.artifact?.content ?? "").trim();
                    const docTitle = String(it?.sourceDoc?.title ?? "");
                    return (
                      <div key={String(it?.artifact?.id ?? Math.random())} style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--panel)", padding: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                          <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            <span className="ctxPill" style={{ marginRight: 8 }}>
                              {t || "card"}
                            </span>
                            <span style={{ fontWeight: 700 }}>{title}</span>
                            {docTitle ? <span style={{ color: "var(--muted)" }}>{` · 文档：${docTitle}`}</span> : null}
                          </div>
                        </div>
                        {content ? (
                          <div style={{ marginTop: 8 }}>
                            <RichText text={content} />
                          </div>
                        ) : (
                          <div style={{ marginTop: 8, color: "var(--muted)", fontSize: 12 }}>（无内容）</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "trash" ? (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                className="btn btnDanger btnIcon"
                type="button"
                onClick={() => {
                  const ok = window.confirm("清空回收站？\n\n将永久删除回收站内所有库及其全部内容（文档/段落/卡片）。不可恢复。");
                  if (!ok) return;
                  void (async () => {
                    const r = await emptyTrash();
                    if (!r.ok) window.alert(`清空失败：${r.error ?? "unknown"}`);
                    else window.alert(`已清空：删除库 ${r.removedLibraries} 个，文档 ${r.removedDocs} 篇，片段 ${r.removedArtifacts} 条。`);
                  })();
                }}
                disabled={!trash.length}
              >
                清空回收站（永久删除）
              </button>
              <button className="btn btnIcon" type="button" onClick={() => void refreshLibraries()}>
                刷新
              </button>
            </div>

            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 12,
                background: "var(--panel)",
                padding: 10,
                maxHeight: "min(52vh, 520px)",
                overflow: "auto",
                display: "grid",
                gap: 10,
              }}
            >
              {trash.length ? (
                trash.map((l) => (
                  <div key={l.id} style={{ borderBottom: "1px dashed var(--border)", paddingBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {l.name}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>
                          文档 {l.docCount} 篇 · 删除于 {new Date(l.deletedAt).toLocaleString()}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>id: {l.id}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        <button
                          className="btn btnIcon"
                          type="button"
                          onClick={() => {
                            void (async () => {
                              const r = await restoreLibraryFromTrash(l.id);
                              if (!r.ok) window.alert(`恢复失败：${r.error ?? "unknown"}`);
                              await refreshLibraries().catch(() => void 0);
                            })();
                          }}
                        >
                          恢复
                        </button>
                        <button
                          className="btn btnDanger btnIcon"
                          type="button"
                          onClick={() => {
                            const ok = window.confirm(`彻底删除库「${l.name}」？\n\n将永久删除该库及其全部内容（文档/段落/卡片）。不可恢复。`);
                            if (!ok) return;
                            void (async () => {
                              const r = await purgeLibrary(l.id);
                              if (!r.ok) window.alert(`删除失败：${r.error ?? "unknown"}`);
                              else window.alert(`已删除：文档 ${r.removedDocs} 篇，片段 ${r.removedArtifacts} 条。`);
                            })();
                          }}
                        >
                          彻底删除
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="explorerHint">回收站为空。</div>
              )}
            </div>
          </div>
        ) : null}

        {tab === "jobs" ? (
          <>
            <div className="explorerHint" style={{ marginBottom: 10 }}>
              抽卡任务说明：导入后先入队，需点击 ▶ 开始；为每篇文档生成最终要素卡（hook/thesis/ending/one_liner/outline），用于后续生成库级 21+1 风格手册；已抽过会自动跳过。
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              <span className="ctxPill">当前库：{currentLibrary ? currentLibrary.name : "（未选择）"}</span>
              <span className="ctxPill">处理集（Facet Pack）：</span>
              <select
                className="btn"
                value={currentLibrary?.facetPackId ?? ""}
                disabled={!currentLibrary || status !== "idle"}
                title={
                  !currentLibrary
                    ? "请先在“库”里设为当前库"
                    : status !== "idle"
                      ? "抽卡运行/暂停中不可切换处理集"
                      : "选择抽卡使用的处理集（第一轮前选；第二轮沿用）"
                }
                onChange={(e) => {
                  const lib = currentLibrary;
                  if (!lib) return;
                  const next = String(e.target.value ?? "").trim();
                  if (!next || next === lib.facetPackId) return;
                  const ok = window.confirm(
                    `切换当前库「${lib.name}」的处理集为「${facetPackLabel(next)}」？\n\n` +
                      "- 第一轮抽卡将按新的处理集打维度标签（facetIds）\n" +
                      "- 第二轮生成风格手册会沿用该处理集\n\n" +
                      "提示：若该库已抽过卡，切换后可能需要重抽才能保持一致。",
                  );
                  if (!ok) return;
                  void (async () => {
                    const r = await setLibraryFacetPack(lib.id, next);
                    if (!r.ok) window.alert(`设置失败：${r.error ?? "unknown"}`);
                    await refreshLibraries().catch(() => void 0);
                  })();
                }}
              >
                {FACET_PACKS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              {currentLibrary ? <span className="ctxPill">标签：{facetPackLabel(currentLibrary.facetPackId)}</span> : null}
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              <span className="ctxPill">状态：{status === "idle" ? "空闲" : status === "running" ? "运行中" : "已暂停"}</span>
              <span className="ctxPill">
                进度：{summary.done}/{summary.total}
              </span>
              {summary.failed ? <span className="ctxPill">失败：{summary.failed}</span> : null}
              {summary.cancelled ? <span className="ctxPill">取消：{summary.cancelled}</span> : null}
              {summary.runningLabel ? <span className="ctxPill">当前：{summary.runningLabel}</span> : null}
            </div>

            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 12,
                background: "var(--panel)",
                maxHeight: "min(52vh, 520px)",
                overflow: "auto",
                padding: 10,
                display: "grid",
                gap: 8,
              }}
            >
              {jobs.length || playbookJobs.length ? (
                <>
                  {jobs.length
                    ? jobs.map((j) => (
                        <div key={j.id} style={{ display: "grid", gap: 4, paddingBottom: 8, borderBottom: "1px dashed var(--border)" }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                            <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              <span style={{ color: statusColor(j.status), fontWeight: 600 }}>{statusLabel(j.status)}</span>
                              <span style={{ color: "var(--muted)" }}> · </span>
                              <span style={{ color: "var(--text)" }}>{j.docTitle}</span>
                              {j.libraryName ? <span style={{ color: "var(--muted)" }}>{` · 库：${j.libraryName}`}</span> : null}
                            </div>
                            <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
                              {typeof j.extractedCards === "number" ? `卡片 +${j.extractedCards}` : ""}
                            </div>
                          </div>
                          {j.error ? (
                            <div style={{ fontSize: 12, color: "rgba(220, 38, 38, 0.95)", whiteSpace: "pre-wrap" }}>{j.error}</div>
                          ) : null}
                        </div>
                      ))
                    : null}

                  {playbookJobs.length ? (
                    <>
                      {jobs.length ? (
                        <div className="explorerHint" style={{ paddingTop: 6 }}>
                          风格手册任务
                        </div>
                      ) : null}
                      {playbookJobs.map((j) => (
                        <div key={j.id} style={{ display: "grid", gap: 4, paddingBottom: 8, borderBottom: "1px dashed var(--border)" }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                            <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              <span style={{ color: statusColor(j.status), fontWeight: 600 }}>{statusLabel(j.status)}</span>
                              <span style={{ color: "var(--muted)" }}> · </span>
                              <span style={{ color: "var(--text)" }}>{`【风格手册】${j.libraryName ?? j.libraryId}`}</span>
                            </div>
                            <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
                              {typeof j.generatedFacets === "number" ? `维度卡 +${j.generatedFacets}` : ""}
                            </div>
                          </div>
                          {j.error ? (
                            <div style={{ fontSize: 12, color: "rgba(220, 38, 38, 0.95)", whiteSpace: "pre-wrap" }}>{j.error}</div>
                          ) : null}
                        </div>
                      ))}
                    </>
                  ) : null}
                </>
              ) : (
                <div className="explorerHint">队列为空：导入语料后会自动加入抽卡队列；风格手册需点击“生成风格手册”入队。</div>
              )}
            </div>

            <div className="modalBtns" style={{ marginTop: 12, justifyContent: "space-between" }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btnIcon" type="button" onClick={clearFinished} disabled={!jobs.length && !playbookJobs.length}>
                  清理已完成
                </button>
                <button
                  className="btn btnIcon"
                  type="button"
                  onClick={retryFailed}
                  disabled={!jobs.some((j) => j.status === "failed") && !playbookJobs.some((j) => j.status === "failed")}
                >
                  重试失败
                </button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className={`btn btnIcon ${status === "running" ? "btnPrimary" : ""}`}
                  type="button"
                  title={status === "running" ? "暂停" : status === "paused" ? "继续" : "开始"}
                  disabled={status === "idle" && !jobs.some((j) => j.status === "pending") && !playbookJobs.some((j) => j.status === "pending")}
                  onClick={() => {
                    if (status === "running") {
                      pause();
                      return;
                    }
                    if (status === "paused") {
                      void resume();
                      return;
                    }
                    void start();
                  }}
                >
                  {status === "running" ? "⏸" : "▶"}
                </button>
                <button
                  className="btn btnDanger btnIcon"
                  type="button"
                  title="停止（取消队列）"
                  onClick={cancel}
                  disabled={
                    status === "idle" &&
                    !jobs.some((j) => j.status === "pending" || j.status === "running") &&
                    !playbookJobs.some((j) => j.status === "pending" || j.status === "running")
                  }
                >
                  ■
                </button>
                <button
                  className="btn btnIcon"
                  type="button"
                  disabled={!currentLibrary || status !== "idle" || (currentLibrary?.docCount ?? 0) <= 0}
                  title={
                    !currentLibrary
                      ? "请先选择当前库"
                      : status !== "idle"
                        ? "请先停止/暂停抽卡任务"
                        : (currentLibrary.docCount ?? 0) <= 0
                          ? "该库暂无文档"
                          : "生成库级风格手册（Style Profile + 21+1）"
                  }
                  onClick={() => {
                    const lib = currentLibrary;
                    if (!lib) return;
                    const pendingInLib = jobs.filter((j) => j.libraryId === lib.id && (j.status === "pending" || j.status === "running")).length;
                    const msg =
                      `为当前库「${lib.name}」入队生成风格手册（21+1）？\n\n` +
                      "- 会读取该库已抽出的单篇要素卡（hook/thesis/ending/one_liner/outline）\n" +
                      "- 并生成 1 张 Style Profile + 每个维度 1 张写法手册卡\n" +
                      "- 产物会落到一个“【仿写手册】”虚拟文档下，可被右侧 Agent 直接使用\n" +
                      "- 点击“确定”只会入队，不会自动开始；需要你点击 ▶ 执行\n\n" +
                      (pendingInLib > 0 ? `提示：该库还有 ${pendingInLib} 个抽卡任务未完成，生成的手册可能不完整。\n\n` : "");
                    const ok = window.confirm(msg);
                    if (!ok) return;
                    void (async () => {
                      const r = await enqueuePlaybookJob(lib.id, { open: true });
                      if (!r.ok) window.alert(`入队失败：${r.error ?? "unknown"}`);
                    })();
                  }}
                >
                  生成风格手册
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {prompt ? (
        <div
          className="modalMask"
          role="dialog"
          aria-modal="true"
          style={{ zIndex: 100000 }}
          onMouseDown={(e) => {
            // 仅点击遮罩空白处关闭，避免点击输入框/按钮时被误关
            if (e.target === e.currentTarget) setPrompt(null);
          }}
        >
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalTitle">{prompt.title}</div>
            {prompt.desc ? <div className="modalDesc">{prompt.desc}</div> : null}
            <input
              ref={promptInputRef}
              className="modalInput"
              autoFocus
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




