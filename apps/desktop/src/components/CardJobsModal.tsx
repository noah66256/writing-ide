import { useMemo } from "react";
import { useKbStore, type KbCardJob } from "../state/kbStore";

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
  const open = useKbStore((s) => s.cardModalOpen);
  const status = useKbStore((s) => s.cardJobStatus);
  const jobs = useKbStore((s) => s.cardJobs);
  const close = useKbStore((s) => s.closeCardJobsModal);
  const start = useKbStore((s) => s.startCardJobs);
  const pause = useKbStore((s) => s.pauseCardJobs);
  const resume = useKbStore((s) => s.resumeCardJobs);
  const cancel = useKbStore((s) => s.cancelCardJobs);
  const clearFinished = useKbStore((s) => s.clearFinishedCardJobs);
  const retryFailed = useKbStore((s) => s.retryFailedCardJobs);

  const summary = useMemo(() => {
    const total = jobs.length;
    const done = jobs.filter((j) => j.status === "success" || j.status === "skipped").length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const cancelled = jobs.filter((j) => j.status === "cancelled").length;
    const running = jobs.find((j) => j.status === "running");
    return { total, done, failed, cancelled, running };
  }, [jobs]);

  if (!open) return null;

  return (
    <div
      className="modalMask"
      onMouseDown={(e) => {
        // 点击遮罩关闭
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal" style={{ width: "min(860px, calc(100vw - 24px))" }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div className="modalTitle" style={{ marginBottom: 0 }}>
            抽卡任务
          </div>
          <button className="btn btnIcon" type="button" onClick={close}>
            关闭
          </button>
        </div>

        <div className="modalDesc" style={{ marginTop: 10 }}>
          抽卡需要联网与 LLM 配置；遇到 429/上游繁忙会自动重试（指数退避）。你可以随时暂停/继续/取消。
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <span className="ctxPill">状态：{status === "idle" ? "空闲" : status === "running" ? "运行中" : "已暂停"}</span>
          <span className="ctxPill">
            进度：{summary.done}/{summary.total}
          </span>
          {summary.failed ? <span className="ctxPill">失败：{summary.failed}</span> : null}
          {summary.cancelled ? <span className="ctxPill">取消：{summary.cancelled}</span> : null}
          {summary.running ? <span className="ctxPill">当前：{summary.running.docTitle}</span> : null}
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
          {jobs.length ? (
            jobs.map((j) => (
              <div key={j.id} style={{ display: "grid", gap: 4, paddingBottom: 8, borderBottom: "1px dashed var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span style={{ color: statusColor(j.status), fontWeight: 600 }}>{statusLabel(j.status)}</span>
                    <span style={{ color: "var(--muted)" }}> · </span>
                    <span style={{ color: "var(--text)" }}>{j.docTitle}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
                    {typeof j.extractedCards === "number" ? `卡片 +${j.extractedCards}` : ""}
                  </div>
                </div>
                {j.error ? <div style={{ fontSize: 12, color: "rgba(220, 38, 38, 0.95)", whiteSpace: "pre-wrap" }}>{j.error}</div> : null}
              </div>
            ))
          ) : (
            <div className="explorerHint">队列为空：从 Explorer 右键“导入并抽卡”，或在 KB 面板导入语料后会自动加入队列。</div>
          )}
        </div>

        <div className="modalBtns" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btnIcon" type="button" onClick={clearFinished} disabled={!jobs.length}>
              清理已完成
            </button>
            <button className="btn btnIcon" type="button" onClick={retryFailed} disabled={!jobs.some((j) => j.status === "failed")}>
              重试失败
            </button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btnIcon" type="button" onClick={() => void start()} disabled={status !== "idle" || !jobs.some((j) => j.status === "pending")}>
              开始
            </button>
            <button className="btn btnIcon" type="button" onClick={pause} disabled={status !== "running"}>
              暂停
            </button>
            <button className="btn btnIcon" type="button" onClick={() => void resume()} disabled={status !== "paused"}>
              继续
            </button>
            <button className="btn btnDanger btnIcon" type="button" onClick={cancel} disabled={status === "idle" && !jobs.some((j) => j.status === "pending" || j.status === "running")}>
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}



