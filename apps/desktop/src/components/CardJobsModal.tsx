import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useKbStore, type KbCardJob, type KbCardJobArticle, type KbLibraryFingerprintSnapshot, type KbTextSpanRefV1 } from "../state/kbStore";
import { useDialogStore } from "../state/dialogStore";
import { FACET_PACKS, facetPackLabel, getFacetPack } from "../kb/facets";
import { RichText } from "./RichText";
import { cn } from "@/lib/utils";

function statusLabel(s: KbCardJob["status"]) {
  if (s === "pending") return "等待";
  if (s === "running") return "进行中";
  if (s === "success") return "完成";
  if (s === "skipped") return "跳过（已抽过/无内容）";
  if (s === "failed") return "失败";
  if (s === "cancelled") return "已取消";
  return s;
}

function statusColorClass(s: KbCardJob["status"]) {
  if (s === "running") return "text-blue-600";
  if (s === "success") return "text-green-600";
  if (s === "skipped") return "text-slate-500";
  if (s === "failed") return "text-red-600";
  if (s === "cancelled") return "text-slate-500";
  return "text-text-muted";
}

function formatDuration(ms: number) {
  const x = Math.max(0, Math.floor(ms));
  const sec = Math.floor(x / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

function articleStatusIcon(status: KbCardJobArticle["status"]) {
  if (status === "done") return "text-green-600";
  if (status === "running") return "text-blue-600";
  if (status === "failed") return "text-red-600";
  return "text-text-faint";
}

function articleStatusText(a: KbCardJobArticle) {
  if (a.status === "done") return "已完成";
  if (a.status === "failed") return "失败";
  if (a.status === "running") {
    if (a.chunks > 1) return `处理中（块 ${Math.min(a.chunksDone + 1, a.chunks)}/${a.chunks}）`;
    return "处理中";
  }
  return "等待中";
}

export function CardJobsModal() {
  const open = useKbStore((s) => s.kbManagerOpen);
  const tab = useKbStore((s) => s.kbManagerTab);
  const notice = useKbStore((s) => s.kbManagerNotice);
  const viewLibIdFromStore = useKbStore((s) => s.kbManagerViewLibId);
  const isLoading = useKbStore((s) => s.isLoading);
  const status = useKbStore((s) => s.cardJobStatus);
  const jobs = useKbStore((s) => s.cardJobs);
  const playbookJobs = useKbStore((s) => s.playbookJobs);
  const runStartedAtMs = useKbStore((s) => s.cardJobRunStartedAtMs);
  const runElapsedMs = useKbStore((s) => s.cardJobRunElapsedMs);
  const close = useKbStore((s) => s.closeKbManager);
  const start = useKbStore((s) => s.startCardJobs);
  const pause = useKbStore((s) => s.pauseCardJobs);
  const resume = useKbStore((s) => s.resumeCardJobs);
  const cancel = useKbStore((s) => s.cancelCardJobs);
  const clearFinished = useKbStore((s) => s.clearFinishedCardJobs);
  const retryFailed = useKbStore((s) => s.retryFailedCardJobs);
  const forceReextractSkipped = useKbStore((s) => s.forceReextractSkippedJobs);
  const importRawText = useKbStore((s) => s.importRawText);
  const importExternalFiles = useKbStore((s) => s.importExternalFiles);
  const [ingestMenuOpen, setIngestMenuOpen] = useState(false);
  const ingestMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ingestMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (ingestMenuRef.current && !ingestMenuRef.current.contains(e.target as Node)) setIngestMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ingestMenuOpen]);

  const libraries = useKbStore((s) => s.libraries);
  const trash = useKbStore((s) => s.trashLibraries);
  const currentLibraryId = useKbStore((s) => s.currentLibraryId);
  const setCurrentLibrary = useKbStore((s) => s.setCurrentLibrary);
  const refreshLibraries = useKbStore((s) => s.refreshLibraries);
  const createLibrary = useKbStore((s) => s.createLibrary);
  const renameLibrary = useKbStore((s) => s.renameLibrary);
  const setLibraryPurpose = useKbStore((s) => s.setLibraryPurpose);
  const setLibraryFacetPack = useKbStore((s) => s.setLibraryFacetPack);
  const enqueuePlaybookJob = useKbStore((s) => s.enqueuePlaybookJob);
  const enqueueCardJobs = useKbStore((s) => s.enqueueCardJobs);
  const importUrls = useKbStore((s) => s.importUrls);
  const deleteLibraryToTrash = useKbStore((s) => s.deleteLibraryToTrash);
  const restoreLibraryFromTrash = useKbStore((s) => s.restoreLibraryFromTrash);
  const purgeLibrary = useKbStore((s) => s.purgeLibrary);
  const emptyTrash = useKbStore((s) => s.emptyTrash);
  const openKbManager = useKbStore((s) => s.openKbManager);

  const uiAlert = useDialogStore((s) => s.openAlert);
  const uiConfirm = useDialogStore((s) => s.openConfirm);
  const uiPrompt = useDialogStore((s) => s.openPrompt);

  const listCardsForLibrary = useKbStore((s) => s.listCardsForLibrary);
  const getLatestLibraryFingerprint = useKbStore((s) => s.getLatestLibraryFingerprint);
  const computeLibraryFingerprint = useKbStore((s) => s.computeLibraryFingerprint);
  const compareLatestLibraryFingerprints = useKbStore((s) => s.compareLatestLibraryFingerprints);
  const saveLibraryStyleAnchorsFromSegments = useKbStore((s) => s.saveLibraryStyleAnchorsFromSegments);
  const clearLibraryStyleAnchors = useKbStore((s) => s.clearLibraryStyleAnchors);
  const getLibraryStyleConfig = useKbStore((s) => s.getLibraryStyleConfig);
  const setLibraryStyleClusterLabel = useKbStore((s) => s.setLibraryStyleClusterLabel);
  const setLibraryStyleDefaultCluster = useKbStore((s) => s.setLibraryStyleDefaultCluster);
  const setLibraryStyleClusterRules = useKbStore((s) => (s as any).setLibraryStyleClusterRules);
  const generateLibraryClusterRulesV1 = useKbStore((s) => (s as any).generateLibraryClusterRulesV1);

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
  // 需要在 Esc handler useEffect 之前声明，避免 TDZ（Cannot access before initialization）
  const [anchorPickerOpen, setAnchorPickerOpen] = useState(false);
  const [rulesEditor, setRulesEditor] = useState<null | { clusterId: string; title: string; value: string }>(null);
  const [rulesEditorErr, setRulesEditorErr] = useState<string | null>(null);
  const [rulesEvidenceSource, setRulesEvidenceSource] = useState<"cluster_evidence" | "cluster_anchors">("cluster_evidence");
  const [rulesEvidenceTarget, setRulesEvidenceTarget] = useState<
    | "values.principles"
    | "values.priorities"
    | "values.moralAccounting"
    | "values.tabooFrames"
    | "values.epistemicNorms"
    | "values.templates"
    | "analysisLenses"
  >("values.principles");
  const [rulesEvidenceIndex, setRulesEvidenceIndex] = useState<string>("0");
  const [rulesEvidenceFilter, setRulesEvidenceFilter] = useState<string>("");

  // Esc 关闭（避免 modalMask 挡住输入框）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 优先关内层 anchors 选择器
      if (anchorPickerOpen) {
        e.preventDefault();
        setAnchorPickerOpen(false);
        setAnchorPickerNotice(null);
        return;
      }
      // 其次关内层 rules editor
      if (rulesEditor) {
        e.preventDefault();
        setRulesEditor(null);
        setRulesEditorErr(null);
        return;
      }
      // 优先关内层 prompt，其次关整个 KB 管理
      if (prompt) {
        e.preventDefault();
        setPrompt(null);
        return;
      }
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, anchorPickerOpen, rulesEditor, prompt, close]);

  // 进度/耗时估算：每秒刷新一次
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [open]);

  // 窗口拖动（不限制边界；可双击标题栏回到居中）
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<null | { startX: number; startY: number; baseX: number; baseY: number; pointerId: number }>(null);

  useEffect(() => {
    if (!open) return;
    void refreshLibraries().catch(() => void 0);
  }, [open, refreshLibraries]);

  // 从 store 同步 viewLibId（设置页点击库跳转过来时自动展开目标库）
  useEffect(() => {
    if (!open || tab !== "libraries" || !viewLibIdFromStore) return;
    setViewLibId(viewLibIdFromStore);
    setViewTab("health");
    setFpAdvanced(false);
  }, [open, tab, viewLibIdFromStore]);

  // 关键：确保内层 prompt 打开后立刻可输入（避免"弹窗出现但焦点仍在编辑器，打不了字"）
  useLayoutEffect(() => {
    if (!prompt) return;
    try {
      promptInputRef.current?.focus();
      promptInputRef.current?.select?.();
    } catch {
      // ignore
    }
  }, [prompt?.title]);

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
    const runningNote = runningCard?.progressNote ?? null;
    const chunksDone = runningCard?.chunksDone;
    const chunksTotal = runningCard?.chunksTotal;
    const runningArticles = runningCard?.articles;
    return { total, done, failed, cancelled, runningLabel, runningNote, chunksDone, chunksTotal, runningArticles };
  }, [jobs, playbookJobs]);

  const progress = useMemo(() => {
    // 总体进度条：把"抽卡=按文档计数" + "风格手册=StyleProfile(1)+facet(N)"统一成"单元"计数
    const libById = new Map(libraries.map((l) => [l.id, l]));

    const cardTotal = jobs.length;
    const cardDone = jobs.filter((j) => j.status !== "pending" && j.status !== "running").length;

    const playbookTotal = playbookJobs.reduce((sum, j) => {
      const lib = libById.get(j.libraryId);
      const facets = typeof j.totalFacets === "number" ? j.totalFacets : getFacetPack(lib?.facetPackId).facets.length;
      return sum + 1 + Math.max(0, facets);
    }, 0);

    const playbookDone = playbookJobs.reduce((sum, j) => {
      const lib = libById.get(j.libraryId);
      const facets = typeof j.totalFacets === "number" ? j.totalFacets : getFacetPack(lib?.facetPackId).facets.length;
      const facetsDone = Math.max(0, Math.min(Math.max(0, facets), Number(j.generatedFacets ?? 0)));
      const styleDone = j.generatedStyleProfile ? 1 : 0;
      if (j.status === "success") return sum + 1 + Math.max(0, facets);
      if (j.status === "pending") return sum;
      return sum + styleDone + facetsDone;
    }, 0);

    const totalUnits = cardTotal + playbookTotal;
    const doneUnits = cardDone + playbookDone;

    const nowMs = Date.now();
    const elapsedMs =
      (typeof runElapsedMs === "number" ? runElapsedMs : 0) +
      (status === "running" && typeof runStartedAtMs === "number" ? Math.max(0, nowMs - runStartedAtMs) : 0);

    const done = Math.max(0, Math.min(totalUnits, doneUnits));
    const remaining = Math.max(0, totalUnits - done);
    const pct = totalUnits > 0 ? Math.max(0, Math.min(1, done / totalUnits)) : 0;
    const etaMs = done >= 1 && remaining > 0 && elapsedMs >= 3000 ? Math.round((elapsedMs / done) * remaining) : null;

    return { totalUnits, doneUnits: done, pct, elapsedMs, etaMs };
  }, [tick, status, runStartedAtMs, runElapsedMs, jobs, playbookJobs, libraries]);

  const currentLibrary = useMemo(() => {
    const id = String(currentLibraryId ?? "").trim();
    if (!id) return null;
    return libraries.find((l) => l.id === id) ?? null;
  }, [libraries, currentLibraryId]);
  const currentLibraryIsStyle = String((currentLibrary as any)?.purpose ?? "material").trim() === "style";
  const pendingJobsInCurrentLibrary = useMemo(() => {
    if (!currentLibrary?.id) return 0;
    return jobs.filter((j) => j.libraryId === currentLibrary.id && (j.status === "pending" || j.status === "running")).length;
  }, [jobs, currentLibrary?.id]);

  // 库内卡片浏览（轻量）
  const [viewLibId, setViewLibId] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<"health" | "cards">("health");
  const [cardsQuery, setCardsQuery] = useState("");
  const [cardsType, setCardsType] = useState<string>("__all__");
  const [cardsLoading, setCardsLoading] = useState(false);
  const [cardsErr, setCardsErr] = useState<string | null>(null);
  const [cardsTotal, setCardsTotal] = useState(0);
  const [cards, setCards] = useState<Array<{ artifact: any; sourceDoc: any }>>([]);

  // 库体检（Fingerprint）
  const [fpLoading, setFpLoading] = useState(false);
  const [fpErr, setFpErr] = useState<string | null>(null);
  const [fp, setFp] = useState<KbLibraryFingerprintSnapshot | null>(null);
  const [fpAdvanced, setFpAdvanced] = useState(false);
  const [fpCompare, setFpCompare] = useState<null | { diff: any; olderAt: string; newerAt: string }>(null);
  const [deepCloneLoading, setDeepCloneLoading] = useState(false);

  // M1：anchors（黄金样本，仅风格库）
  const [anchorsLoading, setAnchorsLoading] = useState(false);
  const [anchorsErr, setAnchorsErr] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<KbTextSpanRefV1[]>([]);
  const [defaultClusterId, setDefaultClusterId] = useState<string | null>(null);
  const [clusterLabels, setClusterLabels] = useState<Record<string, string> | null>(null);
  const [clusterRules, setClusterRules] = useState<Record<string, any> | null>(null);
  const [anchorPickerAdvanced, setAnchorPickerAdvanced] = useState(false);
  const [anchorPickerNotice, setAnchorPickerNotice] = useState<string | null>(null);
  const [anchorPickerSelected, setAnchorPickerSelected] = useState<Record<string, boolean>>({});
  const [anchorPickerClusterId, setAnchorPickerClusterId] = useState<string | null>(null);
  const [segmentFilter, setSegmentFilter] = useState<string>("");
  // rules auto-generate：按 cluster 记录状态，避免"点一个全都显示生成中"的 UI 误导
  const [rulesGenLoadingByCluster, setRulesGenLoadingByCluster] = useState<Record<string, boolean>>({});
  const [rulesGenErrByCluster, setRulesGenErrByCluster] = useState<Record<string, string>>({});

  const viewLib = useMemo(() => libraries.find((x) => x.id === viewLibId) ?? null, [libraries, viewLibId]);
  const isStyleLib = (viewLib as any)?.purpose === "style";

  const humanizeKbErr = (err: string | null | undefined) => {
    const e = String(err ?? "").trim();
    if (!e) return "";
    if (e === "LIBRARY_IN_TRASH") return "该库在回收站：请先到「回收站」恢复后再进行库体检/生成指纹。";
    if (e === "LIBRARY_NOT_FOUND") return "该库不存在（可能已删除/切换 KB 目录/切换账号）。请刷新库列表后重试。";
    if (e === "LIBRARY_ID_REQUIRED") return "未选择库：请先展开一个库再操作。";
    if (e === "NO_DOCS_IN_LIBRARY") return "该库没有可用于体检的文档：先导入语料并完成抽卡/切分。";
    return e;
  };

  // 兜底：若正在查看的库已被删除/进入回收站（不在当前库列表），自动收起，避免继续使用旧 id 导致"library not found"
  useEffect(() => {
    if (!open) return;
    if (tab !== "libraries") return;
    if (!viewLibId) return;
    const exists = libraries.some((l) => l.id === viewLibId);
    if (exists) return;
    setViewLibId(null);
    setViewTab("health");
    setFp(null);
    setFpErr(null);
    setFpCompare(null);
    setAnchors([]);
    setAnchorsErr(null);
    setAnchorsLoading(false);
    setDefaultClusterId(null);
    setClusterLabels(null);
    setAnchorPickerOpen(false);
    openKbManager("libraries", "当前查看的库已不存在或已进入回收站，已自动收起「库体检」。");
  }, [open, tab, viewLibId, libraries, openKbManager]);

  const fpSegments = useMemo(() => {
    const list = Array.isArray((fp as any)?.perSegment) ? ((fp as any).perSegment as any[]) : [];
    return list.filter(Boolean);
  }, [fp]);

  const fpClusters = useMemo(() => {
    const list = Array.isArray((fp as any)?.clustersV1) ? ((fp as any).clustersV1 as any[]) : [];
    return list.filter(Boolean);
  }, [fp]);
  const genreNeedsRefresh = useMemo(() => {
    const label = String((fp as any)?.genres?.primary?.label ?? "").trim().toLowerCase();
    const why = String((fp as any)?.genres?.primary?.why ?? "").trim().toLowerCase();
    if (!label) return false;
    return (
      label === "unknown_open_set" ||
      label === "unknown" ||
      why.includes("invalid_model_output") ||
      why.includes("未识别") ||
      why.includes("未返回合法 json")
    );
  }, [fp]);

  const fpSegmentById = useMemo(() => {
    const m = new Map<string, any>();
    for (const s of fpSegments) {
      const id = String((s as any)?.segmentId ?? "").trim();
      if (!id) continue;
      m.set(id, s);
    }
    return m;
  }, [fpSegments]);

  const anchorClusterCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of anchors) {
      const seg = fpSegmentById.get(String(a.segmentId ?? "").trim());
      const cid = String((seg as any)?.clusterId ?? "").trim();
      if (!cid) continue;
      m.set(cid, (m.get(cid) ?? 0) + 1);
    }
    return m;
  }, [anchors, fpSegmentById]);

  const recommendedClusterId = useMemo(() => {
    // 1) 若 anchors 已覆盖某簇：优先 anchors 最多的簇
    if (anchorClusterCounts.size > 0) {
      let bestId = "";
      let bestN = -1;
      for (const [cid, n] of anchorClusterCounts.entries()) {
        if (n > bestN) {
          bestN = n;
          bestId = cid;
        }
      }
      if (bestId) return bestId;
    }
    // 2) 否则按簇稳定性优先（high>medium>low），再按覆盖率
    const rank = (s: string) => (s === "high" ? 3 : s === "medium" ? 2 : 1);
    let best: any = null;
    for (const c of fpClusters) {
      const st = String((c as any)?.stability ?? "");
      const cov = Number((c as any)?.docCoverageRate ?? 0) || 0;
      const score = rank(st) * 10_000 + cov * 100;
      if (!best || score > best.score) best = { id: String((c as any)?.id ?? ""), score };
    }
    return best?.id ? String(best.id) : null;
  }, [anchorClusterCounts, fpClusters]);

  const openAnchorPicker = (opts?: { clusterId?: string | null }) => {
    setAnchorPickerNotice(null);
    const clusterId = String(opts?.clusterId ?? "").trim() || null;
    setAnchorPickerClusterId(clusterId);
    if (!fpSegments.length) {
      // 兼容旧快照：可能只有 clustersV1（含 evidence），但没有 perSegment 段列表
      if (clusterId) {
        const c = fpClusters.find((x: any) => String(x?.id ?? "").trim() === clusterId);
        const ev = Array.isArray((c as any)?.evidence) ? ((c as any).evidence as KbTextSpanRefV1[]) : [];
        const segs = ev
          .map((a: any) => ({
            segmentId: String(a?.segmentId ?? "").trim(),
            sourceDocId: String(a?.sourceDocId ?? "").trim(),
            paragraphIndexStart: typeof a?.paragraphIndexStart === "number" ? a.paragraphIndexStart : null,
            quote: String(a?.quote ?? "").trim(),
          }))
          .filter((s: any) => s.segmentId && s.sourceDocId)
          .slice(0, 5);
        if (!segs.length) {
          void uiAlert({
            title: "无法采纳 anchors",
            message: "当前指纹快照缺少段列表（perSegment），且该簇也没有可用的代表样例（evidence）。\n\n建议：点击「生成：声音指纹（数字版）」刷新后再试。",
          });
          return;
        }
        void (async () => {
          if (!viewLibId) return;
          setAnchorsLoading(true);
          setAnchorsErr(null);
          const r = await saveLibraryStyleAnchorsFromSegments({ libraryId: viewLibId, segments: segs as any });
          if (!r.ok) setAnchorsErr(r.error ?? "SAVE_FAILED");
          else {
            setAnchors(Array.isArray(r.anchors) ? r.anchors : []);
            void uiAlert({
              title: "已采纳 anchors（代表样例兜底）",
              message: `当前指纹快照缺少段列表（perSegment），已从「${clusterId}」代表样例中采纳 ${segs.length} 段作为 anchors。\n\n建议：重新生成声音指纹以获得完整段落列表（便于精细挑选）。`,
            });
          }
          setAnchorsLoading(false);
        })();
        return;
      }

      void uiAlert({
        title: "没有样本段数据",
        message: "当前指纹快照缺少段列表（perSegment）。请先点「生成：声音指纹（数字版）」刷新后再采纳 anchors。",
      });
      return;
    }

    const existing = anchors.map((a) => String(a.segmentId ?? "").trim()).filter(Boolean);
    const pickRecommended = () => {
      const items = fpSegments
        .map((s) => ({
          ...s,
          _chars: Number((s as any)?.chars ?? 0) || 0,
          _doc: String((s as any)?.sourceDocId ?? "").trim(),
          _preview: String((s as any)?.preview ?? "").trim(),
          _clusterId: String((s as any)?.clusterId ?? "").trim(),
        }))
        .filter((s) => s._doc && s._chars >= 400 && (!clusterId || s._clusterId === clusterId))
        .sort((a, b) => Math.abs(a._chars - 1600) - Math.abs(b._chars - 1600));
      const picked: string[] = [];
      const perDoc = new Map<string, number>();
      for (const s of items) {
        if (picked.length >= 5) break;
        const id = String((s as any)?.segmentId ?? "").trim();
        if (!id) continue;
        const docId = s._doc;
        const cnt = perDoc.get(docId) ?? 0;
        if (cnt >= 2) continue;
        perDoc.set(docId, cnt + 1);
        picked.push(id);
      }
      // 兜底：样本太少时就按原顺序补满
      if (picked.length < 5) {
        const perDoc2 = new Map(perDoc);
        for (const s of fpSegments) {
          if (picked.length >= 5) break;
          const id = String((s as any)?.segmentId ?? "").trim();
          const docId = String((s as any)?.sourceDocId ?? "").trim();
          const cid = String((s as any)?.clusterId ?? "").trim();
          if (!id || !docId) continue;
          if (clusterId && cid !== clusterId) continue;
          if (picked.includes(id)) continue;
          const cnt = perDoc2.get(docId) ?? 0;
          if (cnt >= 2) continue;
          perDoc2.set(docId, cnt + 1);
          picked.push(id);
        }
      }
      return picked;
    };

    const selectedIds = existing.length ? existing : pickRecommended();
    const next: Record<string, boolean> = {};
    for (const id of selectedIds) next[id] = true;
    setAnchorPickerSelected(next);
    setAnchorPickerAdvanced(selectedIds.length > 5);
    // 默认把筛选框填成簇 id（避免"我点了某簇采纳，但列表里看不出"）
    if (clusterId) setSegmentFilter(clusterId);
    if (clusterId && selectedIds.length === 0) {
      setAnchorPickerNotice("该簇没有可选样本段（可能样本过短/未分簇）。建议更新体检或改选其他簇。");
    }
    setAnchorPickerOpen(true);
  };

  const closeAnchorPicker = () => {
    setAnchorPickerOpen(false);
    setAnchorPickerNotice(null);
    setAnchorPickerClusterId(null);
  };

  const toggleAnchorPick = (segmentId: string) => {
    const id = String(segmentId ?? "").trim();
    if (!id) return;
    const seg = fpSegmentById.get(id);
    if (!seg) return;
    const maxPick = anchorPickerAdvanced ? 8 : 5;
    const docId = String((seg as any)?.sourceDocId ?? "").trim();
    if (!docId) return;

    setAnchorPickerSelected((prev) => {
      const was = Boolean(prev[id]);
      if (was) return { ...prev, [id]: false };

      const selectedIds = Object.keys(prev).filter((k) => prev[k]);
      if (selectedIds.length >= maxPick) {
        setAnchorPickerNotice(`最多选择 ${maxPick} 段。`);
        return prev;
      }
      const perDoc = new Map<string, number>();
      for (const sid of selectedIds) {
        const s2 = fpSegmentById.get(sid);
        if (!s2) continue;
        const d2 = String((s2 as any)?.sourceDocId ?? "").trim();
        if (!d2) continue;
        perDoc.set(d2, (perDoc.get(d2) ?? 0) + 1);
      }
      if ((perDoc.get(docId) ?? 0) >= 2) {
        setAnchorPickerNotice("同一篇文档最多选择 2 段。");
        return prev;
      }
      setAnchorPickerNotice(null);
      return { ...prev, [id]: true };
    });
  };

  const saveAnchorsFromSelected = async () => {
    if (!viewLibId) return;
    const selectedIds = Object.keys(anchorPickerSelected).filter((k) => anchorPickerSelected[k]);
    const anchorById = new Map(anchors.map((a) => [String(a.segmentId ?? "").trim(), a]));
    const segs = selectedIds
      .map((id) => {
        const s = fpSegmentById.get(id);
        if (s) {
          return {
            segmentId: String((s as any)?.segmentId ?? "").trim(),
            sourceDocId: String((s as any)?.sourceDocId ?? "").trim(),
            paragraphIndexStart: typeof (s as any)?.paragraphIndexStart === "number" ? Number((s as any).paragraphIndexStart) : null,
            quote: String((s as any)?.preview ?? "").trim(),
          };
        }
        const a = anchorById.get(String(id ?? "").trim());
        if (!a) return null;
        return {
          segmentId: String(a.segmentId ?? "").trim(),
          sourceDocId: String(a.sourceDocId ?? "").trim(),
          paragraphIndexStart: typeof a.paragraphIndexStart === "number" ? a.paragraphIndexStart : null,
          quote: String(a.quote ?? "").trim(),
        };
      })
      .filter(Boolean)
      .filter((s: any) => s.segmentId && s.sourceDocId) as any;

    setAnchorsLoading(true);
    setAnchorsErr(null);
    const r = await saveLibraryStyleAnchorsFromSegments({ libraryId: viewLibId, segments: segs });
    if (!r.ok) {
      setAnchorsErr(r.error ?? "SAVE_FAILED");
    } else {
      setAnchors(Array.isArray(r.anchors) ? r.anchors : []);
      closeAnchorPicker();
    }
    setAnchorsLoading(false);
  };

  const clearAnchors = async () => {
    if (!viewLibId) return;
    setAnchorsLoading(true);
    setAnchorsErr(null);
    const r = await clearLibraryStyleAnchors(viewLibId);
    if (!r.ok) setAnchorsErr(r.error ?? "CLEAR_FAILED");
    else setAnchors([]);
    setAnchorsLoading(false);
  };

  const removeAnchor = async (segmentId: string) => {
    if (!viewLibId) return;
    const id = String(segmentId ?? "").trim();
    if (!id) return;
    const remain = anchors.filter((a) => String(a.segmentId ?? "").trim() !== id);
    setAnchorsLoading(true);
    setAnchorsErr(null);
    const r = await saveLibraryStyleAnchorsFromSegments({
      libraryId: viewLibId,
      segments: remain.map((a) => ({
        segmentId: String(a.segmentId ?? "").trim(),
        sourceDocId: String(a.sourceDocId ?? "").trim(),
        paragraphIndexStart: typeof a.paragraphIndexStart === "number" ? a.paragraphIndexStart : null,
        quote: String(a.quote ?? "").trim(),
      })),
    });
    if (!r.ok) setAnchorsErr(r.error ?? "SAVE_FAILED");
    else setAnchors(Array.isArray(r.anchors) ? r.anchors : []);
    setAnchorsLoading(false);
  };

  useEffect(() => {
    if (!open) return;
    if (tab !== "libraries") return;
    if (!viewLibId) return;
    if (viewTab !== "cards") return;
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
  }, [open, tab, viewLibId, viewTab, cardsQuery, cardsType, listCardsForLibrary]);

  useEffect(() => {
    if (!open) return;
    if (tab !== "libraries") return;
    if (!viewLibId) return;
    if (viewTab !== "health") return;
    void (async () => {
      setFpLoading(true);
      setFpErr(null);
      setFpCompare(null);
      const r = await getLatestLibraryFingerprint(viewLibId);
      if (!r.ok) {
        setFpErr(r.error ?? "LOAD_FAILED");
        setFp(null);
      } else {
        setFp(r.snapshot ?? null);
      }
      setFpLoading(false);
    })();
  }, [open, tab, viewLibId, viewTab, getLatestLibraryFingerprint]);

  useEffect(() => {
    if (!open) return;
    if (tab !== "libraries") return;
    if (!viewLibId) return;
    if (viewTab !== "health") return;
    // 仅风格库展示 style config（anchors/default/labels）
    if (!isStyleLib) {
      setAnchors([]);
      setAnchorsErr(null);
      setAnchorsLoading(false);
      setDefaultClusterId(null);
      setClusterLabels(null);
      setClusterRules(null);
      setAnchorPickerOpen(false);
      setRulesEditor(null);
      setRulesEditorErr(null);
      setRulesGenLoadingByCluster({});
      setRulesGenErrByCluster({});
      return;
    }
    void (async () => {
      setAnchorsLoading(true);
      setAnchorsErr(null);
      const r = await getLibraryStyleConfig(viewLibId);
      if (!r.ok) {
        setAnchorsErr(r.error ?? "LOAD_FAILED");
        setAnchors([]);
        setDefaultClusterId(null);
        setClusterLabels(null);
        setClusterRules(null);
        setRulesGenErrByCluster({});
      } else {
        setAnchors(Array.isArray(r.anchors) ? r.anchors : []);
        setDefaultClusterId(r.defaultClusterId ? String(r.defaultClusterId) : null);
        setClusterLabels(r.clusterLabelsV1 && typeof r.clusterLabelsV1 === "object" ? (r.clusterLabelsV1 as any) : null);
        setClusterRules(r.clusterRulesV1 && typeof r.clusterRulesV1 === "object" ? (r.clusterRulesV1 as any) : null);
        setRulesGenErrByCluster({});
      }
      setAnchorsLoading(false);
    })();
  }, [open, tab, viewLibId, viewTab, isStyleLib, getLibraryStyleConfig]);

  const openRulesEditor = (clusterId: string, label: string) => {
    const cid = String(clusterId ?? "").trim();
    if (!cid) return;
    const existing = clusterRules && typeof clusterRules === "object" ? (clusterRules as any)[cid] : undefined;
    const initial = (() => {
      if (existing !== undefined) {
        try {
          return JSON.stringify(existing, null, 2);
        } catch {
          return String(existing ?? "");
        }
      }
      const tpl = {
        v: 1,
        updatedAt: new Date().toISOString(),
        values: {
          scope: "author",
          principles: [{ text: "", evidence: [] }],
          priorities: [],
          moralAccounting: [],
          tabooFrames: [],
          epistemicNorms: [],
          templates: [],
          checks: [],
        },
        analysisLenses: [],
      };
      return JSON.stringify(tpl, null, 2);
    })();
    setRulesEditorErr(null);
    setRulesEvidenceSource("cluster_evidence");
    setRulesEvidenceTarget("values.principles");
    setRulesEvidenceIndex("0");
    setRulesEvidenceFilter("");
    setRulesEditor({ clusterId: cid, title: `规则手册（${label || cid}）`, value: initial });
  };

  const rulesEvidenceCandidates = useMemo(() => {
    if (!rulesEditor) return [];
    const cid = String(rulesEditor.clusterId ?? "").trim();
    if (!cid) return [];
    const q = String(rulesEvidenceFilter ?? "").trim();

    const fromClusterEvidence = (() => {
      const c = fpClusters.find((x: any) => String(x?.id ?? "").trim() === cid);
      const list = Array.isArray((c as any)?.evidence) ? ((c as any).evidence as KbTextSpanRefV1[]) : [];
      return list.filter(Boolean);
    })();

    const fromClusterAnchors = (() => {
      const list = anchors.filter((a) => {
        const seg = fpSegmentById.get(String((a as any)?.segmentId ?? "").trim());
        return String((seg as any)?.clusterId ?? "").trim() === cid;
      });
      return list.filter(Boolean);
    })();

    const list = (rulesEvidenceSource === "cluster_anchors" ? fromClusterAnchors : fromClusterEvidence).slice();
    const filtered = q ? list.filter((x) => String((x as any)?.quote ?? "").includes(q)) : list;

    // 去重：按 segmentId
    const uniq: KbTextSpanRefV1[] = [];
    const seen = new Set<string>();
    for (const r of filtered) {
      const id = String((r as any)?.segmentId ?? "").trim();
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      uniq.push(r);
    }
    return uniq.slice(0, 12);
  }, [rulesEditor, rulesEvidenceSource, rulesEvidenceFilter, fpClusters, anchors, fpSegmentById]);

  const appendEvidenceToRules = (ref: KbTextSpanRefV1) => {
    const target = rulesEvidenceTarget;
    const idx = (() => {
      const n = Number(String(rulesEvidenceIndex ?? "").trim());
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(99, Math.floor(n)));
    })();
    const normRef = (ref ?? null) as any;
    if (!normRef || typeof normRef !== "object") return;
    const segId = String(normRef.segmentId ?? "").trim();
    if (!segId) return;

    setRulesEditor((prev) => {
      if (!prev) return prev;
      let parsed: any = null;
      try {
        parsed = JSON.parse(String(prev.value ?? "").trim() || "null");
      } catch (e: any) {
        setRulesEditorErr(`JSON 解析失败：${String(e?.message ?? e)}`);
        return prev;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setRulesEditorErr("规则手册必须是 JSON object（不能是数组/字符串）。");
        return prev;
      }

      const ensureObj = (x: any) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
      const ensureArr = (o: any, k: string) => {
        if (!o || typeof o !== "object" || Array.isArray(o)) return [];
        if (!Array.isArray(o[k])) o[k] = [];
        return o[k] as any[];
      };
      const ensureTextEvidenceItem = (raw: any) => {
        if (typeof raw === "string") return { text: raw, evidence: [] as any[] };
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { text: String(raw ?? ""), evidence: [] as any[] };
        const o = raw as any;
        if (typeof o.text !== "string") o.text = String(o.text ?? "");
        if (!Array.isArray(o.evidence)) o.evidence = [];
        return o;
      };
      const ensureLensItem = (raw: any) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return { label: String(raw ?? ""), whenToUse: "", questions: [], templates: [], evidence: [], checks: [] as any[] };
        }
        const o = raw as any;
        if (typeof o.label !== "string") o.label = String(o.label ?? "");
        if (typeof o.whenToUse !== "string") o.whenToUse = String(o.whenToUse ?? "");
        if (!Array.isArray(o.questions)) o.questions = [];
        if (!Array.isArray(o.templates)) o.templates = [];
        if (!Array.isArray(o.evidence)) o.evidence = [];
        if (!Array.isArray(o.checks)) o.checks = [];
        return o;
      };

      const pushRef = (arr: any[]) => {
        const exists = arr.some((x) => String(x?.segmentId ?? "").trim() === segId);
        if (!exists) arr.push(normRef);
      };

      if (target.startsWith("values.")) {
        const key = target.replace(/^values\./, "");
        parsed.values = ensureObj(parsed.values);
        const arr = ensureArr(parsed.values, key);
        while (arr.length <= idx) arr.push({ text: "", evidence: [] });
        arr[idx] = ensureTextEvidenceItem(arr[idx]);
        pushRef((arr[idx] as any).evidence);
      } else if (target === "analysisLenses") {
        if (!Array.isArray(parsed.analysisLenses)) parsed.analysisLenses = [];
        while (parsed.analysisLenses.length <= idx) parsed.analysisLenses.push({ label: "", whenToUse: "", questions: [], templates: [], evidence: [], checks: [] });
        parsed.analysisLenses[idx] = ensureLensItem(parsed.analysisLenses[idx]);
        pushRef((parsed.analysisLenses[idx] as any).evidence);
      }

      setRulesEditorErr(null);
      return { ...prev, value: JSON.stringify(parsed, null, 2) };
    });
  };

  const queuePlaybookForLibrary = async (libraryId: string, opts?: { source?: "libraries" | "jobs" }) => {
    const libId = String(libraryId ?? "").trim();
    const lib = libraries.find((x) => x.id === libId);
    if (!lib || !libId) return;
    const ok = await uiConfirm({
      title: "确认入队生成风格手册？",
      message:
        `为库「${lib.name}」入队生成风格手册（22+1）？\n\n` +
        "- 会读取该库已抽出的单篇要素卡（hook/thesis/ending/one_liner/outline）\n" +
        "- 并生成 1 张 Style Profile + 每个维度 1 张写法手册卡\n" +
        "- 产物会落到一个「【仿写手册】」虚拟文档下，可被右侧 Agent 直接使用\n\n" +
        "提示：生成手册是异步队列任务，需到「抽卡任务」Tab 点击 ▶ 执行。",
      confirmText: "入队",
      cancelText: "取消",
    });
    if (!ok) return;
    const r = await enqueuePlaybookJob(libId, { open: true });
    if (!r.ok) void uiAlert({ title: "入队失败", message: `入队失败：${r.error ?? "unknown"}` });
    else {
      const note =
        opts?.source === "jobs"
          ? "已入队：风格手册（第二步）。执行完成后可点「第三步：深度克隆」。"
          : "已入队：风格手册（第二步）。请点击 ▶ 开始执行。";
      openKbManager("jobs", note);
    }
  };

  const computeFingerprintForLibrary = async (libraryId: string) => {
    const libId = String(libraryId ?? "").trim();
    if (!libId) return false;
    const syncView = viewLibId === libId;
    setFpLoading(true);
    if (syncView) {
      setFpErr(null);
      setFpCompare(null);
    }
    await refreshLibraries().catch(() => void 0);
    const latestLibs = useKbStore.getState().libraries ?? [];
    const exists = latestLibs.some((x: any) => String(x?.id ?? "").trim() === libId);
    if (!exists) {
      if (syncView) {
        setFp(null);
        setFpErr(null);
        setFpCompare(null);
      }
      setFpLoading(false);
      if (syncView) setViewLibId(null);
      openKbManager("libraries", "该库已不存在或已进入回收站，无法生成指纹：请先恢复/重新选择库。");
      return false;
    }

    const r = await computeLibraryFingerprint({ libraryId: libId, useLlm: true });
    if (!r.ok) {
      const msg = humanizeKbErr(r.error ?? "COMPUTE_FAILED");
      if (r.error === "LIBRARY_IN_TRASH" || r.error === "LIBRARY_NOT_FOUND") {
        if (syncView) setViewLibId(null);
        openKbManager("libraries", msg || "该库已不可用：请先恢复/重新选择库。");
      } else {
        if (syncView) setFpErr(msg || "COMPUTE_FAILED");
        else void uiAlert({ title: "声音指纹更新失败", message: msg || "COMPUTE_FAILED" });
      }
      setFpLoading(false);
      return false;
    }
    if (syncView) setFp(r.snapshot ?? null);
    setFpLoading(false);
    return true;
  };

  const runDeepCloneForLibrary = async (libraryId: string) => {
    const libId = String(libraryId ?? "").trim();
    if (!libId) return;
    const lib = libraries.find((x) => x.id === libId);
    if (!lib) return;
    const isStylePurpose = String((lib as any)?.purpose ?? "material").trim() === "style";
    const ok = await uiConfirm({
      title: "确认执行深度克隆（第三步）？",
      message:
        `为库「${lib.name}」执行深度克隆？\n\n` +
        "- 步骤 A：生成/更新声音指纹（数字版）\n" +
        "- 步骤 B：基于指纹簇自动生成规则手册（cluster rules，仅风格库）\n\n" +
        "说明：如果某些簇证据不足，会只更新已满足条件的簇。",
      confirmText: "执行",
      cancelText: "取消",
    });
    if (!ok) return;
    setDeepCloneLoading(true);
    setAnchorsErr(null);
    try {
      const fpOk = await computeFingerprintForLibrary(libId);
      if (!fpOk) return;
      if (!isStylePurpose) {
        void uiAlert({ title: "执行完成", message: "当前是非风格库，已完成声音指纹更新。" });
        return;
      }
      const genRet = await generateLibraryClusterRulesV1({ libraryId: libId });
      if (!genRet.ok) {
        setAnchorsErr(`深度克隆失败：${genRet.error ?? "GENERATE_FAILED"}`);
        return;
      }
      const cfg = await getLibraryStyleConfig(libId);
      if (cfg?.ok && viewLibId === libId) {
        setClusterRules(cfg.clusterRulesV1 && typeof cfg.clusterRulesV1 === "object" ? (cfg.clusterRulesV1 as any) : null);
      }
      void uiAlert({
        title: "深度克隆完成",
        message: `声音指纹已更新，规则手册更新 ${Number(genRet.updated ?? 0)} 个簇。`,
      });
    } finally {
      setDeepCloneLoading(false);
    }
  };

  const queuePlaybookForViewLib = async () => {
    if (!viewLibId) return;
    await queuePlaybookForLibrary(viewLibId, { source: "libraries" });
  };

  const computeFingerprintForViewLib = async () => {
    if (!viewLibId) return false;
    return computeFingerprintForLibrary(viewLibId);
  };

  const runDeepCloneForViewLib = async () => {
    if (!viewLibId) return;
    await runDeepCloneForLibrary(viewLibId);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="w-[920px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-4rem)] bg-surface rounded-2xl border border-border shadow-2xl flex flex-col overflow-hidden p-5"
        style={{
          transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
          willChange: dragRef.current ? "transform" : undefined,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className={cn("flex items-center justify-between gap-2 select-none px-1", dragRef.current ? "cursor-grabbing" : "cursor-grab")}
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
          onPointerCancel={(e) => {
            const d = dragRef.current;
            dragRef.current = null;
            try {
              // 某些情况下（切后台/窗口失焦）只会触发 cancel，不会触发 up
              (e.currentTarget as any)?.releasePointerCapture?.(d?.pointerId ?? e.pointerId);
            } catch {
              // ignore
            }
          }}
          onLostPointerCapture={(e) => {
            const d = dragRef.current;
            dragRef.current = null;
            try {
              (e.currentTarget as any)?.releasePointerCapture?.(d?.pointerId ?? e.pointerId);
            } catch {
              // ignore
            }
          }}
        >
          <div className="text-base font-semibold text-text">
            知识库管理
          </div>
          <button className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors" type="button" onClick={close} onPointerDown={(e) => e.stopPropagation()}>
            关闭
          </button>
        </div>

        <div className="text-sm text-text-muted mt-2.5 px-1">
          这里统一管理「库 / 抽卡任务 / 回收站」。为避免误操作，导入语料前必须先选择当前库。
        </div>

        <div className="flex gap-1 mt-2.5 mb-2.5">
          {(["libraries", "jobs", "trash"] as const).map((t) => (
            <button
              key={t}
              className={cn(
                "px-3 py-1.5 text-sm rounded-lg transition-colors cursor-pointer",
                tab === t ? "bg-accent-soft text-accent font-medium" : "text-text-muted hover:bg-surface-alt hover:text-text",
              )}
              onClick={() => openKbManager(t)}
            >
              {t === "libraries" ? "库" : t === "jobs" ? "抽卡任务" : "回收站"}
            </button>
          ))}
        </div>

        {notice ? (
          <div className="text-xs text-text-faint mb-2.5 px-1">
            {notice}
          </div>
        ) : null}

        {tab === "libraries" ? (
          <div className="grid gap-2.5">
            <div className="flex gap-2 flex-wrap items-center">
              <button
                className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                type="button"
                onClick={() => {
                  ask({
                    title: "新建库",
                    desc: "请输入库名称（例如：写法库/产品库/营销库）",
                    placeholder: "例如：写法库",
                    confirmText: "创建",
                    onConfirm: async (v) => {
                      const r = await createLibrary(v);
                      if (!r.ok) void uiAlert({ title: "创建失败", message: `创建失败：${r.error ?? "unknown"}` });
                      await refreshLibraries().catch(() => void 0);
                    },
                  });
                }}
              >
                新建库
              </button>
              <button className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors" type="button" onClick={() => void refreshLibraries()}>
                刷新
              </button>
              <div className="relative" ref={ingestMenuRef}>
                <button
                  className="px-3 py-1.5 text-xs rounded-lg border border-accent bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50 flex items-center gap-1"
                  type="button"
                  disabled={!currentLibraryId || isLoading}
                  title={!currentLibraryId ? "请先设为当前库，再开始抽卡" : "导入语料并开始抽卡"}
                  onClick={() => setIngestMenuOpen((v) => !v)}
                >
                  开始抽卡 ▾
                </button>
                {ingestMenuOpen && (
                  <div className="absolute left-0 top-full mt-1 z-50 w-32 rounded-lg border border-border bg-surface shadow-lg py-1 flex flex-col">
                    {([{ label: "粘贴文本", key: "text" }, { label: "选择文件", key: "file" }, { label: "导入 URL", key: "url" }] as const).map(({ label, key }) => (
                      <button
                        key={key}
                        className="px-3 py-2 text-xs text-left hover:bg-surface-alt text-text transition-colors"
                        type="button"
                        onClick={() => {
                          setIngestMenuOpen(false);
                          void (async () => {
                            if (!currentLibraryId) {
                              void uiAlert({ title: "提示", message: "请先选择一个库并设为「当前库」，再导入语料。" });
                              return;
                            }
                            let docIds: string[] = [];
                            if (key === "text") {
                              const v = await uiPrompt({ title: "粘贴文本", message: "将文本粘贴到下方，直接入库并抽卡。", placeholder: "粘贴课程记录、文章、资料……", confirmText: "导入并抽卡", multiline: true });
                              if (!v) return;
                              const ret = await importRawText(v);
                              docIds = ret.docIds;
                            } else if (key === "file") {
                              const picked = await window.desktop?.kb?.pickFiles({ title: "选择语料文件", multi: true });
                              if (!picked?.ok || !picked.files?.length) return;
                              const ret = await importExternalFiles(picked.files);
                              docIds = ret.docIds ?? [];
                            } else {
                              const v = await uiPrompt({ title: "导入 URL", message: "每行一个 URL（仅支持 http/https）。", placeholder: "https://example.com/article", confirmText: "导入并抽卡", multiline: true });
                              if (!v) return;
                              const list = String(v).split(/\r?\n/g).map((s) => s.trim()).filter(Boolean);
                              if (!list.length) return;
                              const ret = await importUrls(list);
                              docIds = ret.docIds ?? [];
                            }
                            if (!docIds.length) {
                              void uiAlert({ title: "导入结果", message: "未导入任何新内容（可能已存在或内容为空）。" });
                              return;
                            }
                            // 若已有任务在跑，只追加队列不重启（避免中断）；否则自动开始
                            const isRunning = useKbStore.getState().cardJobStatus === "running";
                            await enqueueCardJobs(docIds, { open: true, autoStart: !isRunning });
                            openKbManager("jobs");
                          })();
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">当前库：{currentLibraryId ? currentLibraryId : "（未选择）"}</span>
            </div>

            <div className="border border-border rounded-xl bg-surface p-2.5 max-h-[min(52vh,520px)] overflow-auto grid gap-2.5">
              {libraries.length ? (
                libraries.map((l) => {
                  const isCur = l.id === currentLibraryId;
                  return (
                    <div key={l.id} className={cn("border-b border-dashed border-border pb-2.5 last:border-b-0 rounded-lg px-1.5 -mx-1.5 transition-colors", viewLibId === l.id && "bg-accent/5")}>
                      <div className="flex justify-between gap-2.5 items-center">
                        <div
                          className="min-w-0 cursor-pointer"
                          role="button"
                          tabIndex={0}
                          title="展开该库（库体检/卡片预览）"
                          onClick={() => {
                            if (viewLibId !== l.id) {
                              setViewTab("health");
                              setFpAdvanced(false);
                            }
                            setViewLibId(l.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              if (viewLibId !== l.id) {
                                setViewTab("health");
                                setFpAdvanced(false);
                              }
                              setViewLibId(l.id);
                            }
                          }}
                        >
                          <span className="block text-[13px] font-bold text-text max-w-[420px] overflow-hidden text-ellipsis whitespace-nowrap hover:text-accent transition-colors text-left">
                            {l.name}
                          </span>
                          <div className="text-xs text-text-muted">
                            文档 {l.docCount} 篇 · 更新 {new Date(l.updatedAt).toLocaleString()} · 标签 {facetPackLabel(l.facetPackId)} · 用途{" "}
                            {l.purpose === "style" ? "风格库" : l.purpose === "product" ? "产品库" : "素材库"}
                          </div>
                          {l.fingerprint ? (
                            <div className="mt-1.5 flex gap-1.5 flex-wrap">
                              <span
                                className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft"
                                title={`体裁/声音识别置信度：${Math.round((l.fingerprint.confidence ?? 0) * 100)}% · 体检时间：${new Date(
                                  l.fingerprint.computedAt,
                                ).toLocaleString()}`}
                              >
                                像：{l.fingerprint.primaryLabel}
                              </span>
                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">
                                稳定：
                                {l.fingerprint.stability === "high" ? "高" : l.fingerprint.stability === "medium" ? "中" : "低"}
                              </span>
                            </div>
                          ) : null}
                          <div className="text-xs text-text-muted">id: {l.id}</div>
                        </div>
                        <div className="flex gap-2 flex-wrap justify-end shrink-0">
                          <select
                            className="px-2 py-1 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors cursor-pointer"
                            value={l.purpose ?? "material"}
                            title="库用途：只有「风格库」会触发写作时默认先 kb.search 拉样例的策略"
                            onChange={(e) => {
                              const next = String(e.target.value ?? "material") as any;
                              void (async () => {
                                const r = await setLibraryPurpose(l.id, next);
                                if (!r.ok) void uiAlert({ title: "设置失败", message: `设置失败：${r.error ?? "unknown"}` });
                                await refreshLibraries().catch(() => void 0);
                              })();
                            }}
                          >
                            <option value="material">素材库</option>
                            <option value="style">风格库</option>
                            <option value="product">产品库</option>
                          </select>
                          <button
                            className={cn(
                              "px-3 py-1.5 text-xs rounded-lg border transition-colors",
                              isCur
                                ? "border-accent bg-accent text-white hover:bg-accent-hover"
                                : "border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text"
                            )}
                            type="button"
                            onClick={() => setCurrentLibrary(isCur ? null : l.id)}
                            title={isCur ? "再次点击可取消当前库" : "设为当前库"}
                          >
                            {isCur ? "当前库" : "设为当前"}
                          </button>
                          <button
                            className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
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
                                  if (!r.ok) void uiAlert({ title: "重命名失败", message: `重命名失败：${r.error ?? "unknown"}` });
                                  await refreshLibraries().catch(() => void 0);
                                },
                              });
                            }}
                          >
                            重命名
                          </button>
                          <button
                            className="px-3 py-1.5 text-xs rounded-lg border border-error/30 text-error hover:bg-error/10 transition-colors"
                            type="button"
                            onClick={() => {
                              void (async () => {
                                const ok = await uiConfirm({
                                  title: "确认删除库？",
                                  message: `删除库「${l.name}」？\n\n将进入回收站，可恢复；也可在回收站彻底删除/清空。`,
                                  confirmText: "删除",
                                  cancelText: "取消",
                                  danger: true,
                                });
                                if (!ok) return;
                                const r = await deleteLibraryToTrash(l.id);
                                if (!r.ok) void uiAlert({ title: "删除失败", message: `删除失败：${r.error ?? "unknown"}` });
                                await refreshLibraries().catch(() => void 0);
                                // 若正在查看该库，自动收起，避免继续"库体检/指纹"报错
                                setViewLibId((prev) => {
                                  if (prev && prev === l.id) {
                                    setFp(null);
                                    setFpErr(null);
                                    setFpCompare(null);
                                    setAnchors([]);
                                    setAnchorsErr(null);
                                    setDefaultClusterId(null);
                                    setClusterLabels(null);
                                    setAnchorPickerOpen(false);
                                    openKbManager("libraries", `已删除「${l.name}」到回收站（可恢复）。`);
                                    return null;
                                  }
                                  return prev;
                                });
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
                <div className="text-xs text-text-faint">还没有库。先点「新建库」，然后设为当前库再导入语料。</div>
              )}
            </div>

            {viewLibId ? (
              <div className="border border-border rounded-xl bg-surface p-2.5 grid gap-2.5 max-h-[min(62vh,620px)] overflow-y-auto">
                <div className="flex gap-2 flex-wrap items-center justify-between">
                  <div className="flex gap-2 flex-wrap items-center">
                    <button
                      className={cn(
                        "px-3 py-1.5 text-xs rounded-lg border transition-colors",
                        viewTab === "health"
                          ? "border-accent bg-accent text-white hover:bg-accent-hover"
                          : "border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text"
                      )}
                      type="button"
                      onClick={() => setViewTab("health")}
                      title="像什么 / 稳不稳 / 怎么修"
                    >
                      库体检
                    </button>
                    <button
                      className={cn(
                        "px-3 py-1.5 text-xs rounded-lg border transition-colors",
                        viewTab === "cards"
                          ? "border-accent bg-accent text-white hover:bg-accent-hover"
                          : "border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text"
                      )}
                      type="button"
                      onClick={() => setViewTab("cards")}
                      title="浏览该库抽出的卡片"
                    >
                      卡片预览
                    </button>
                    {viewTab === "health" ? (
                      <>
                        {fpLoading ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">加载中…</span> : null}
                        {fpErr ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-red-600 border border-border-soft">{fpErr}</span> : null}
                        {fp?.computedAt ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">体检：{new Date(fp.computedAt).toLocaleString()}</span> : null}
                      </>
                    ) : (
                      <>
                        <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">共 {cardsTotal} 条</span>
                        {cardsLoading ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">加载中…</span> : null}
                        {cardsErr ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-red-600 border border-border-soft">{cardsErr}</span> : null}
                      </>
                    )}
                  </div>
                  <button className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors" type="button" onClick={() => setViewLibId(null)}>
                    收起
                  </button>
                </div>

                {viewTab === "health" ? (
                  <>
                    {isStyleLib ? (
                      <div className="border border-border rounded-xl bg-surface-alt p-2.5 grid gap-2.5">
                        <div className="font-bold">推荐流程（同一 UI）</div>
                        <div className="text-xs text-text-muted">抽卡完成后按 2 → 3 执行：先产出风格手册，再做深度克隆（声音指纹 + 规则手册）。</div>
                        <div className="grid gap-2.5 md:grid-cols-3">
                          <div className="border border-border rounded-xl bg-surface p-2.5">
                            <div className="text-xs text-text-faint">步骤 1</div>
                            <div className="mt-1 text-sm font-bold">抽卡</div>
                            <div className="mt-1 text-xs text-text-muted">把文档转成可复用要素卡。</div>
                            <button
                              className="mt-2 px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                              type="button"
                              onClick={() => openKbManager("jobs")}
                            >
                              前往抽卡任务
                            </button>
                          </div>
                          <div className="border border-border rounded-xl bg-surface p-2.5">
                            <div className="text-xs text-text-faint">步骤 2</div>
                            <div className="mt-1 text-sm font-bold">风格手册</div>
                            <div className="mt-1 text-xs text-text-muted">生成 22+1 维度手册卡。</div>
                            <button
                              className="mt-2 px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors disabled:opacity-50"
                              type="button"
                              disabled={fpLoading || deepCloneLoading}
                              onClick={() => void queuePlaybookForViewLib()}
                            >
                              入队风格手册
                            </button>
                          </div>
                          <div className="border border-accent/35 rounded-xl bg-surface p-2.5">
                            <div className="text-xs text-text-faint">步骤 3</div>
                            <div className="mt-1 text-sm font-bold">深度克隆</div>
                            <div className="mt-1 text-xs text-text-muted">一键执行声音指纹 + 规则手册。</div>
                            <button
                              className="mt-2 px-3 py-1.5 text-xs rounded-lg border border-accent bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                              type="button"
                              disabled={fpLoading || deepCloneLoading || anchorsLoading}
                              onClick={() => void runDeepCloneForViewLib()}
                            >
                              {deepCloneLoading ? "深度克隆执行中…" : "执行深度克隆"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    <div className="flex gap-2 flex-wrap items-center justify-between">
                      <div className="flex gap-2 flex-wrap items-center">
                        {isStyleLib ? (
                          <button
                            className="px-3 py-1.5 text-xs rounded-lg border border-accent bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                            type="button"
                            disabled={fpLoading || deepCloneLoading || anchorsLoading}
                            onClick={() => void runDeepCloneForViewLib()}
                          >
                            {deepCloneLoading ? "深度克隆中…" : "深度克隆（第三步）"}
                          </button>
                        ) : null}
                        {isStyleLib ? (
                          <button
                            className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors disabled:opacity-50"
                            type="button"
                            disabled={fpLoading || deepCloneLoading}
                            onClick={() => void queuePlaybookForViewLib()}
                          >
                            入队：风格手册（第二步）
                          </button>
                        ) : null}
                        <button
                          className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors disabled:opacity-50"
                          type="button"
                          disabled={fpLoading || deepCloneLoading}
                          onClick={() => {
                            void (async () => {
                              const ok = await uiConfirm({
                                title: "确认仅更新声音指纹？",
                                message:
                                  "仅执行声音指纹（数字版）更新，不生成规则手册。\n\n" +
                                  "- 会统计「率/分布/n-gram」，并尝试用 Gateway 做开集体裁识别\n" +
                                  "- 产物只写入本地 KB，不会改动原文\n",
                                confirmText: "更新",
                                cancelText: "取消",
                              });
                              if (!ok) return;
                              await computeFingerprintForViewLib();
                            })();
                          }}
                        >
                          仅更新：声音指纹{fpLoading ? "…" : ""}
                        </button>
                        <button
                          className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                          type="button"
                          disabled={fpLoading || deepCloneLoading}
                          onClick={() => {
                            void (async () => {
                              setFpLoading(true);
                              setFpErr(null);
                              const r = await compareLatestLibraryFingerprints(viewLibId);
                              if (!r.ok) {
                                setFpCompare(null);
                                setFpErr(r.error === "NOT_ENOUGH_HISTORY" ? "不足两次体检历史：先更新两次声音指纹" : r.error ?? "COMPARE_FAILED");
                              } else {
                                setFpCompare({
                                  diff: r.diff,
                                  olderAt: r.older.computedAt,
                                  newerAt: r.newer.computedAt,
                                });
                              }
                              setFpLoading(false);
                            })();
                          }}
                        >
                          对比：上次 vs 这次
                        </button>
                      </div>
                      <button className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors" type="button" onClick={() => setFpAdvanced((v) => !v)}>
                        {fpAdvanced ? "收起细节" : "我懂点，展开细节"}
                      </button>
                    </div>

                    {!fpLoading && !fp ? (
                      <div className="text-xs text-text-faint">还没有体检数据。点「深度克隆（第三步）」或「仅更新：声音指纹」开始。</div>
                    ) : null}

                    {fp ? (
                      <div className="grid gap-2.5">
                        <div className="grid gap-2.5 grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
                          <div className="border border-border rounded-xl bg-surface-alt p-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-bold">像什么（最重要）</div>
                              {genreNeedsRefresh ? (
                                <button
                                  className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors disabled:opacity-50"
                                  type="button"
                                  title="刷新体裁识别"
                                  disabled={fpLoading || deepCloneLoading}
                                  onClick={() => {
                                    void computeFingerprintForViewLib();
                                  }}
                                >
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
                                    <path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                    <path d="M20 4v4h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </button>
                              ) : null}
                            </div>
                            <div className="mt-1.5 text-base font-black">
                              {fp.genres?.primary?.label ?? "unknown"}（{Math.round((fp.genres?.primary?.confidence ?? 0) * 100)}%）
                            </div>
                            <div className="mt-1.5 text-xs text-text-muted whitespace-pre-wrap">
                              {fp.genres?.primary?.why ?? ""}
                            </div>
                            {Array.isArray(fp.genres?.candidates) && fp.genres.candidates.length > 1 ? (
                              <div className="mt-2 text-xs text-text-muted">
                                也可能像：
                                {fp.genres.candidates
                                  .slice(1, 4)
                                  .map((c) => `${c.label}（${Math.round((c.confidence ?? 0) * 100)}%）`)
                                  .join(" / ")}
                              </div>
                            ) : null}
                          </div>

                          <div className="border border-border rounded-xl bg-surface-alt p-2.5">
                            <div className="font-bold">稳不稳（风格一致性）</div>
                            <div className="mt-1.5 text-base font-black">
                              {fp.stability?.level === "high" ? "稳定：高" : fp.stability?.level === "medium" ? "稳定：中" : "稳定：低"}
                            </div>
                            <div className="mt-1.5 text-xs text-text-muted whitespace-pre-wrap">{fp.stability?.note ?? ""}</div>
                            {Array.isArray(fp.stability?.outlierDocIds) && fp.stability.outlierDocIds.length ? (
                              <div className="mt-2 text-xs text-text-muted">
                                离群文档（建议先修/分库）：{fp.stability.outlierDocIds.join(", ")}
                              </div>
                            ) : null}
                          </div>

                          <div className="border border-border rounded-xl bg-surface-alt p-2.5">
                            <div className="font-bold">怎么修（只给按钮）</div>
                            <div className="mt-2 text-xs text-text-muted whitespace-pre-wrap">
                              - 推荐流程：抽卡 → 风格手册（第二步）→ 深度克隆（第三步）\n- 深度克隆会同时更新声音指纹 + 规则手册\n- 如果稳定性低：建议分库或先补同体裁语料
                            </div>
                          </div>
                        </div>

                        {isStyleLib ? (
                          <>
                            <div className="border border-border rounded-xl bg-surface-alt p-2.5 grid gap-2.5">
                              <div className="flex items-center justify-between gap-2.5">
                                <div className="font-bold">深度克隆结果（声音指纹 + 规则手册）</div>
                                <div className="flex gap-2 flex-wrap justify-end">
                                  {defaultClusterId ? (
                                    <button
                                      className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                                      type="button"
                                      disabled={anchorsLoading}
                                      onClick={() => {
                                        if (!viewLibId) return;
                                        void (async () => {
                                          setAnchorsLoading(true);
                                          setAnchorsErr(null);
                                          const r = await setLibraryStyleDefaultCluster({ libraryId: viewLibId, clusterId: null });
                                          if (!r.ok) setAnchorsErr(r.error ?? "SAVE_FAILED");
                                          else setDefaultClusterId(null);
                                          setAnchorsLoading(false);
                                        })();
                                      }}
                                      title="取消「仅对该库生效」的默认写法"
                                    >
                                      取消默认
                                    </button>
                                  ) : null}
                                </div>
                              </div>

                              {!fpClusters.length ? (
                                <div className="text-xs text-text-faint">样本不足或未生成子簇：先点「生成：声音指纹（数字版）」刷新。</div>
                              ) : (
                                <div className="grid gap-2.5">
                                  {fpClusters.map((c: any) => {
                                    const cid = String(c?.id ?? "").trim();
                                    if (!cid) return null;
                                    const label = String((clusterLabels as any)?.[cid] ?? c?.label ?? cid).trim() || cid;
                                    const isDefault = defaultClusterId === cid;
                                    const isRec = recommendedClusterId === cid;
                                    const st = String(c?.stability ?? "");
                                    const docCovCount = Number(c?.docCoverageCount ?? 0) || 0;
                                    const docCovRate = Number(c?.docCoverageRate ?? 0) || 0;
                                    const anchorN = anchorClusterCounts.get(cid) ?? 0;
                                    const sr = (c?.softRanges ?? {}) as any;
                                    const fmtRange = (r: any) => (Array.isArray(r) && r.length === 2 ? `${r[0]}~${r[1]}` : "-");
                                    const evidenceAll = Array.isArray(c?.evidence) ? (c.evidence as any[]) : [];
                                    const evidence = evidenceAll.slice(0, 4);
                                    const evidenceN = evidenceAll.length;
                                    const gen = clusterRules && typeof clusterRules === "object" ? (clusterRules as any)[cid] : null;
                                    const genUpdatedAt = (() => {
                                      const t = gen && typeof gen === "object" ? String((gen as any)?.updatedAt ?? "").trim() : "";
                                      return t ? t.slice(0, 19).replace("T", " ") : "";
                                    })();
                                    const isGenLoading = Boolean((rulesGenLoadingByCluster as any)?.[cid]);
                                    const genErr = String((rulesGenErrByCluster as any)?.[cid] ?? "").trim();
                                    const anyGenLoading = Object.values(rulesGenLoadingByCluster ?? {}).some(Boolean);
                                    const isTinyCluster = docCovCount <= 1 || docCovRate < 0.05;
                                    const canAutoGenerate = anchorN + evidenceN >= 2;

                                    return (
                                      <div key={cid} className="border border-border rounded-xl bg-surface p-2.5">
                                        <div className="flex justify-between gap-2.5 items-start">
                                          <div className="min-w-0">
                                            <div className="flex gap-1.5 flex-wrap items-center">
                                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">{cid}</span>
                                              {isRec ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">Recommended</span> : null}
                                              {isDefault ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">默认写法</span> : null}
                                              {st ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">稳定：{st === "high" ? "高" : st === "medium" ? "中" : "低"}</span> : null}
                                              {isTinyCluster ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft" title="样本很少：建议不要设为默认；规则手册也可能无法自动生成">小簇</span> : null}
                                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">
                                                覆盖 {docCovCount}/{Number(fp?.corpus?.docs ?? 0) || 0} 篇 · {Math.round(docCovRate * 100)}%
                                              </span>
                                              {anchorN ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">anchors：{anchorN}</span> : null}
                                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft" title="该簇规则手册（clusterRulesV1）是否已生成">
                                                {gen ? `规则手册：已生成${genUpdatedAt ? `（${genUpdatedAt}）` : ""}` : "规则手册：未生成"}
                                              </span>
                                            </div>
                                            <div className="mt-1.5 text-sm font-black text-text">{label}</div>
                                            <div className="mt-1.5 flex gap-1.5 flex-wrap">
                                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft" title="平均句长">
                                                句长 {fmtRange(sr.avgSentenceLen)}
                                              </span>
                                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft" title="问句率（每100句）">
                                                问句 {fmtRange(sr.questionRatePer100Sentences)}
                                              </span>
                                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft" title="数字密度（每1000字符）">
                                                数字 {fmtRange(sr.digitPer1kChars)}
                                              </span>
                                            </div>
                                          </div>
                                          <div className="flex gap-2 flex-wrap justify-end">
                                            <button
                                              className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                                              type="button"
                                              disabled={anchorsLoading}
                                              onClick={() => {
                                                if (!viewLibId) return;
                                                ask({
                                                  title: "重命名写法",
                                                  desc: `clusterId: ${cid}`,
                                                  placeholder: "例如：直男财经·算账长文",
                                                  value: label,
                                                  confirmText: "保存",
                                                  onConfirm: async (v) => {
                                                    setAnchorsLoading(true);
                                                    setAnchorsErr(null);
                                                    const r = await setLibraryStyleClusterLabel({ libraryId: viewLibId, clusterId: cid, label: v });
                                                    if (!r.ok) setAnchorsErr(r.error ?? "SAVE_FAILED");
                                                    else setClusterLabels((prev) => ({ ...(prev ?? {}), [cid]: String(v ?? "").trim() }));
                                                    setAnchorsLoading(false);
                                                  },
                                                });
                                              }}
                                            >
                                              改名
                                            </button>
                                            <button
                                              className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                                              type="button"
                                              disabled={anchorsLoading}
                                              title="编辑该写法簇的 V2 规则手册（values / analysis lenses 等），写作时会注入 styleContractV1"
                                              onClick={() => openRulesEditor(cid, label)}
                                            >
                                              规则手册
                                            </button>
                                            <button
                                              className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                                              type="button"
                                              disabled={anchorsLoading || isGenLoading || !canAutoGenerate}
                                              title={
                                                canAutoGenerate
                                                  ? "自动生成该簇规则手册（values/lens/templates），并绑定证据（来自本簇 anchors/代表样例）"
                                                  : `样本不足：该簇当前证据=${evidenceN}，anchors=${anchorN}（至少需要 2 条才能生成规则手册）`
                                              }
                                              onClick={() => {
                                                if (!viewLibId) return;
                                                void (async () => {
                                                  setRulesGenLoadingByCluster((prev) => ({ ...(prev ?? {}), [cid]: true }));
                                                  setRulesGenErrByCluster((prev) => {
                                                    const next = { ...(prev ?? {}) };
                                                    delete (next as any)[cid];
                                                    return next;
                                                  });
                                                  const r = await generateLibraryClusterRulesV1({ libraryId: viewLibId, clusterId: cid });
                                                  if (!r?.ok) {
                                                    setRulesGenErrByCluster((prev) => ({ ...(prev ?? {}), [cid]: r?.error ?? "GENERATE_FAILED" }));
                                                  } else {
                                                    const cfg = await getLibraryStyleConfig(viewLibId);
                                                    if (cfg?.ok) setClusterRules(cfg.clusterRulesV1 && typeof cfg.clusterRulesV1 === "object" ? (cfg.clusterRulesV1 as any) : null);
                                                  }
                                                  setRulesGenLoadingByCluster((prev) => ({ ...(prev ?? {}), [cid]: false }));
                                                })();
                                              }}
                                            >
                                              {isGenLoading ? "生成中…" : anyGenLoading ? "等待…" : "自动生成规则手册"}
                                            </button>
                                            <button
                                              className={cn("px-3 py-1.5 text-xs rounded-lg border transition-colors", isDefault ? "border-accent bg-accent text-white hover:bg-accent-hover" : "border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text")}
                                              type="button"
                                              disabled={anchorsLoading}
                                              onClick={() => {
                                                if (!viewLibId) return;
                                                void (async () => {
                                                  setAnchorsLoading(true);
                                                  setAnchorsErr(null);
                                                  const nextId = isDefault ? null : cid;
                                                  const r = await setLibraryStyleDefaultCluster({ libraryId: viewLibId, clusterId: nextId });
                                                  if (!r.ok) setAnchorsErr(r.error ?? "SAVE_FAILED");
                                                  else setDefaultClusterId(nextId);
                                                  setAnchorsLoading(false);
                                                })();
                                              }}
                                              title={isDefault ? "点击取消默认写法（仅本库）" : "设为默认写法（仅本库）"}
                                            >
                                              {isDefault ? "默认（点击取消）" : "设为默认"}
                                            </button>
                                            <button
                                              className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                                              type="button"
                                              disabled={anchorsLoading || (!fpSegments.length && evidenceN === 0)}
                                              title={
                                                anchorsLoading
                                                  ? "加载/保存中…"
                                                  : fpSegments.length
                                                    ? "采纳该簇推荐段落作为 anchors（黄金样本）"
                                                    : evidenceN
                                                      ? "该指纹快照缺少段列表（perSegment），将从代表样例中兜底采纳 anchors；建议重新生成声音指纹以便精细挑选"
                                                      : "没有段列表（perSegment）且该簇无代表样例：请先生成声音指纹（数字版）"
                                              }
                                              onClick={() => openAnchorPicker({ clusterId: cid })}
                                            >
                                              采纳 anchors（本簇）
                                            </button>
                                          </div>
                                        </div>

                                        {evidence.length ? (
                                          <div className="mt-2 grid gap-1.5">
                                            <div className="font-bold text-xs text-text-muted">代表样例（证据）</div>
                                            {evidence.map((e: any) => (
                                              <div key={String(e?.segmentId ?? Math.random())} className="text-xs text-text-muted whitespace-pre-wrap">
                                                - {String(e?.quote ?? "").trim()}
                                              </div>
                                            ))}
                                          </div>
                                        ) : null}
                                        {!canAutoGenerate && !genErr ? (
                                          <div className="mt-2 text-xs text-text-muted whitespace-pre-wrap">
                                            样本偏少：该簇当前证据={evidenceN}，anchors={anchorN}（至少需要 2 条）——建议先点「采纳 anchors（本簇）」或补更多同体裁样本后再生成规则手册。
                                          </div>
                                        ) : null}
                                        {genErr ? (
                                          <div className="mt-2 text-xs text-red-600 whitespace-pre-wrap">
                                            规则手册生成失败：{genErr}
                                          </div>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>

                            <div className="border border-border rounded-xl bg-surface-alt p-2.5 grid gap-2.5">
                              <div className="flex items-center justify-between gap-2.5">
                                <div className="font-bold">Anchors（黄金样本）</div>
                                <div className="flex gap-2 flex-wrap justify-end">
                                  <button
                                    className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                                    type="button"
                                    disabled={anchorsLoading || fpSegments.length === 0}
                                    onClick={() => (anchorPickerOpen ? closeAnchorPicker() : openAnchorPicker())}
                                    title={fpSegments.length ? "采纳推荐段落作为「本库口味代表作」" : "需要先生成声音指纹（数字版）"}
                                  >
                                    {anchorPickerOpen ? "收起选择" : "采纳 anchors（推荐5段）"}
                                  </button>
                                  <button className="px-3 py-1.5 text-xs rounded-lg border border-error/30 text-error hover:bg-error/10 transition-colors" type="button" disabled={anchorsLoading || anchors.length === 0} onClick={() => void clearAnchors()}>
                                    清空
                                  </button>
                                </div>
                              </div>

                              <div className="text-xs text-text-faint">
                                已选 {anchors.length} 段（默认 5；高级最多 8；同文档最多 2 段；仅对该库生效）
                              </div>

                              {anchorsErr ? <div className="text-xs text-red-600">配置错误：{anchorsErr}</div> : null}
                              {anchorsLoading ? <div className="text-xs text-text-faint">加载/保存中…</div> : null}

                              {anchors.length ? (
                                <div className="grid gap-2">
                                  {anchors.map((a) => {
                                    const imp: any = (a as any)?.importedFrom;
                                    const path = imp?.kind === "project" ? String(imp.relPath ?? "") : imp?.kind === "file" ? String(imp.absPath ?? "") : "";
                                    const title = path || String(a.sourceDocId ?? "");
                                    const seg = fpSegmentById.get(String(a.segmentId ?? "").trim());
                                    const cid = String((seg as any)?.clusterId ?? "").trim();
                                    return (
                                      <div
                                        key={`${a.segmentId}`}
                                        className="border border-border rounded-xl bg-surface p-2.5"
                                      >
                                        <div className="flex justify-between gap-2.5 items-start">
                                          <div className="min-w-0">
                                            <div className="flex gap-1.5 flex-wrap items-center">
                                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft" title={title}>
                                                {title ? title.replaceAll("\\", "/").split("/").slice(-1)[0] : a.sourceDocId}
                                              </span>
                                              {cid ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">{cid}</span> : <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">未分簇</span>}
                                              {typeof a.paragraphIndexStart === "number" ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">段落#{a.paragraphIndexStart}</span> : null}
                                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">{a.segmentId}</span>
                                            </div>
                                            <div className="mt-1.5 text-xs text-text-muted whitespace-pre-wrap">
                                              {String(a.quote ?? "").trim() || "（空）"}
                                            </div>
                                          </div>
                                          <button className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors" type="button" disabled={anchorsLoading} onClick={() => void removeAnchor(a.segmentId)}>
                                            移除
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="text-xs text-text-faint">还没有 anchors。建议先采纳推荐 5 段，再按需要微调。</div>
                              )}

                              {anchorPickerOpen ? (
                                <div className="border border-dashed border-border rounded-xl bg-surface p-2.5 grid gap-2.5">
                                  <div className="flex items-center justify-between gap-2.5 flex-wrap">
                                    <div className="flex gap-2 flex-wrap items-center">
                                      <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">选择 anchors</span>
                                      {anchorPickerClusterId ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">限定：{anchorPickerClusterId}</span> : null}
                                      <button
                                        className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                                        type="button"
                                        onClick={() => {
                                          setAnchorPickerNotice(null);
                                          setAnchorPickerAdvanced((v) => {
                                            const next = !v;
                                            if (!next) {
                                              // 从高级回到默认（最多5段）：简单截断
                                              setAnchorPickerSelected((prev) => {
                                                const ids = Object.keys(prev).filter((k) => prev[k]).slice(0, 5);
                                                const m: Record<string, boolean> = {};
                                                for (const id of ids) m[id] = true;
                                                return m;
                                              });
                                            }
                                            return next;
                                          });
                                        }}
                                        title="高级模式：最多选择 8 段"
                                      >
                                        {anchorPickerAdvanced ? "退出高级（最多5段）" : "高级（最多8段）"}
                                      </button>
                                    </div>
                                    <div className="flex gap-2 flex-wrap">
                                      <button className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors" type="button" disabled={anchorsLoading} onClick={() => void saveAnchorsFromSelected()}>
                                        确认采纳
                                      </button>
                                      <button className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors" type="button" onClick={() => closeAnchorPicker()}>
                                        取消
                                      </button>
                                    </div>
                                  </div>

                                  {anchorPickerNotice ? <div className="text-xs text-text-faint">{anchorPickerNotice}</div> : null}

                                  <div className="flex gap-2 flex-wrap items-center">
                                    <input
                                      className="w-full max-w-[360px] px-3 py-2 text-sm rounded-lg border border-border bg-surface text-text placeholder:text-text-faint outline-none focus:border-accent transition-colors"
                                      value={segmentFilter}
                                      placeholder="筛选段落（文件名/预览）…"
                                      onChange={(e) => setSegmentFilter(e.target.value)}
                                    />
                                    <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">
                                      已选 {Object.keys(anchorPickerSelected).filter((k) => anchorPickerSelected[k]).length} / {anchorPickerAdvanced ? 8 : 5}
                                    </span>
                                  </div>

                                  <div className="max-h-[min(32vh,320px)] overflow-auto grid gap-2">
                                    {fpSegments
                                      .filter((s: any) => {
                                        const cid = String(s?.clusterId ?? "").trim();
                                        if (anchorPickerClusterId && cid !== anchorPickerClusterId) return false;
                                        const q = segmentFilter.trim();
                                        if (!q) return true;
                                        const path = String(s?.sourceDocPath ?? s?.sourceDocTitle ?? "");
                                        const preview = String(s?.preview ?? "");
                                        return (path + "\n" + preview).toLowerCase().includes(q.toLowerCase());
                                      })
                                      .slice(0, 120)
                                      .map((s: any) => {
                                        const id = String(s?.segmentId ?? "");
                                        const checked = Boolean(anchorPickerSelected[id]);
                                        const path = String(s?.sourceDocPath ?? s?.sourceDocTitle ?? "");
                                        const file = path ? path.replaceAll("\\", "/").split("/").slice(-1)[0] : String(s?.sourceDocTitle ?? "");
                                        const cid = String(s?.clusterId ?? "").trim();
                                        return (
                                          <label
                                            key={id}
                                            className="border border-border rounded-xl bg-surface-alt p-2.5 flex gap-2.5 items-start cursor-pointer"
                                          >
                                            <input
                                              type="checkbox"
                                              checked={checked}
                                              onChange={() => toggleAnchorPick(id)}
                                              className="mt-0.5"
                                            />
                                            <div className="min-w-0">
                                              <div className="flex gap-1.5 flex-wrap items-center">
                                                <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft" title={path || file || id}>
                                                  {file || id}
                                                </span>
                                                {cid ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">{cid}</span> : null}
                                                {typeof s?.paragraphIndexStart === "number" ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">段落#{s.paragraphIndexStart}</span> : null}
                                                <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">{id}</span>
                                              </div>
                                              <div className="mt-1.5 text-xs text-text-muted whitespace-pre-wrap">
                                                {String(s?.preview ?? "").trim() || "（旧快照无预览：建议重新生成声音指纹）"}
                                              </div>
                                            </div>
                                          </label>
                                        );
                                      })}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </>
                        ) : null}

                        {fpCompare ? (
                          <div className="border border-border rounded-xl bg-surface-alt p-2.5">
                            <div className="flex items-center justify-between gap-2.5">
                              <div className="font-bold">对比结果</div>
                              <div className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">
                                {new Date(fpCompare.olderAt).toLocaleString()} → {new Date(fpCompare.newerAt).toLocaleString()}
                              </div>
                            </div>
                            <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(fpCompare.diff, null, 2)}</pre>
                          </div>
                        ) : null}

                        {fpAdvanced ? (
                          <div className="border border-border rounded-xl bg-surface-alt p-2.5 grid gap-2.5">
                            <div className="flex gap-2 flex-wrap items-center">
                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">
                                样本：{fp.corpus?.docs ?? 0} 篇{(fp.corpus as any)?.segments ? ` · ${(fp.corpus as any).segments} 段` : ""}
                              </span>
                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">字数：{fp.corpus?.chars ?? 0}</span>
                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">句子：{fp.corpus?.sentences ?? 0}</span>
                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">证据覆盖（卡片）：{Math.round((fp.evidence?.cardsWithEvidenceRate ?? 0) * 100)}%</span>
                              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">证据覆盖（手册）：{Math.round((fp.evidence?.playbookCardsWithEvidenceRate ?? 0) * 100)}%</span>
                            </div>

                            <div className="grid gap-2">
                              <div className="font-bold">核心指标（可解释、可量化）</div>
                              <pre className="m-0 whitespace-pre-wrap">{JSON.stringify(fp.stats ?? {}, null, 2)}</pre>
                            </div>

                            <div className="grid gap-2">
                              <div className="font-bold">高频短语（n‑gram Top）</div>
                              <div className="grid gap-1.5">
                                {(fp.topNgrams ?? []).map((ng) => (
                                  <div key={`${ng.n}:${ng.text}`} className="flex gap-2 flex-wrap items-center">
                                    {(() => {
                                      const totalUnits =
                                        (fp.corpus as any)?.segments && Number((fp.corpus as any).segments) > 0
                                          ? Number((fp.corpus as any).segments)
                                          : Number(fp.corpus?.docs ?? 0);
                                      const unitLabel = (fp.corpus as any)?.segments && Number((fp.corpus as any).segments) > 0 ? "段" : "篇";
                                      const covCount =
                                        typeof (ng as any)?.docCoverageCount === "number"
                                          ? Number((ng as any).docCoverageCount)
                                          : Number((ng as any)?.docCoverage ?? 0);
                                      const covRate =
                                        typeof (ng as any)?.docCoverageCount === "number"
                                          ? Number((ng as any)?.docCoverage ?? 0)
                                          : totalUnits
                                            ? covCount / totalUnits
                                            : 0;
                                      return (
                                        <>
                                    <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">{ng.n}-gram</span>
                                    <span className="font-bold">{ng.text}</span>
                                    <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">每千字 {ng.per1kChars}</span>
                                    <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">
                                      覆盖 {covCount}/{totalUnits}
                                      {unitLabel} · {Math.round(covRate * 100)}%
                                    </span>
                                        </>
                                      );
                                    })()}
                                  </div>
                                ))}
                              </div>
                            </div>

                            {fpSegments.length ? (
                              <div className="grid gap-2">
                                <div className="flex gap-2.5 flex-wrap items-center justify-between">
                                  <div className="font-bold">样本段级（segments，更适合找"混合体裁/离群"）</div>
                                  <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">共 {fpSegments.length} 段（展示前 120）</span>
                                </div>
                                <div className="flex gap-2 flex-wrap items-center">
                                  <input
                                    className="w-full max-w-[360px] px-3 py-2 text-sm rounded-lg border border-border bg-surface text-text placeholder:text-text-faint outline-none focus:border-accent transition-colors"
                                    value={segmentFilter}
                                    placeholder="筛选段落（文件名/预览）…"
                                    onChange={(e) => setSegmentFilter(e.target.value)}
                                  />
                                </div>
                                <div className="max-h-[min(28vh,280px)] overflow-auto grid gap-2">
                                  {fpSegments
                                    .filter((s: any) => {
                                      const q = segmentFilter.trim();
                                      if (!q) return true;
                                      const path = String(s?.sourceDocPath ?? s?.sourceDocTitle ?? "");
                                      const preview = String(s?.preview ?? "");
                                      return (path + "\n" + preview).toLowerCase().includes(q.toLowerCase());
                                    })
                                    .slice(0, 120)
                                    .map((s: any) => {
                                      const id = String(s?.segmentId ?? "");
                                      const path = String(s?.sourceDocPath ?? s?.sourceDocTitle ?? "");
                                      const file = path ? path.replaceAll("\\", "/").split("/").slice(-1)[0] : String(s?.sourceDocTitle ?? "");
                                      return (
                                        <div
                                          key={id}
                                          className="border border-border rounded-xl bg-surface-alt p-2.5"
                                        >
                                          <div className="flex gap-1.5 flex-wrap items-center">
                                            <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft" title={path || file || id}>
                                              {file || id}
                                            </span>
                                            {typeof s?.paragraphIndexStart === "number" ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">段落#{s.paragraphIndexStart}</span> : null}
                                            <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">{id}</span>
                                          </div>
                                          <div className="mt-1.5 text-xs text-text-muted whitespace-pre-wrap">
                                            {String(s?.preview ?? "").trim() || "（旧快照无预览：建议重新生成声音指纹）"}
                                          </div>
                                        </div>
                                      );
                                    })}
                                </div>
                              </div>
                            ) : null}

                            <div className="grid gap-2">
                              <div className="font-bold">源文档级（找离群/混合体裁）</div>
                              <pre className="m-0 whitespace-pre-wrap">{JSON.stringify(fp.perDoc ?? [], null, 2)}</pre>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="flex gap-2 flex-wrap items-center">
                      <input
                        className="w-full max-w-[360px] px-3 py-2 text-sm rounded-lg border border-border bg-surface text-text placeholder:text-text-faint outline-none focus:border-accent transition-colors"
                        value={cardsQuery}
                        placeholder="搜索卡片（标题/内容/类型/文档名）…"
                        onChange={(e) => setCardsQuery(e.target.value)}
                      />
                      <select className="px-2 py-1 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors cursor-pointer" value={cardsType} onChange={(e) => setCardsType(String(e.target.value ?? "__all__"))} title="按卡片类型过滤">
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

                    <div className="border border-border rounded-xl bg-surface-alt p-2.5 max-h-[min(44vh,420px)] overflow-auto grid gap-2.5">
                      {!cardsLoading && !cards.length ? (
                        <div className="text-xs text-text-faint">暂无卡片（可能还没抽卡/没生成风格手册，或筛选条件无结果）。</div>
                      ) : null}
                      {cards.map((it) => {
                        const t = String(it?.artifact?.cardType ?? "");
                        const title = String(it?.artifact?.title ?? "").trim() || "（无标题）";
                        const content = String(it?.artifact?.content ?? "").trim();
                        const docTitle = String(it?.sourceDoc?.title ?? "");
                        return (
                          <div
                            key={String(it?.artifact?.id ?? Math.random())}
                            className="border border-border rounded-xl bg-surface p-2.5"
                          >
                            <div className="flex justify-between gap-2.5 items-center">
                              <div className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                                <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft mr-2">
                                  {t || "card"}
                                </span>
                                <span className="font-bold">{title}</span>
                                {docTitle ? <span className="text-text-muted">{` · 文档：${docTitle}`}</span> : null}
                              </div>
                            </div>
                            {content ? (
                              <div className="mt-2">
                                <RichText text={content} />
                              </div>
                            ) : (
                              <div className="mt-2 text-xs text-text-muted">（无内容）</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "trash" ? (
          <div className="grid gap-2.5">
            <div className="flex gap-2 flex-wrap items-center">
              <button
                className="px-3 py-1.5 text-xs rounded-lg border border-error/30 text-error hover:bg-error/10 transition-colors"
                type="button"
                onClick={() => {
                  void (async () => {
                    const ok = await uiConfirm({
                      title: "确认清空回收站？",
                      message: "清空回收站？\n\n将永久删除回收站内所有库及其全部内容（文档/段落/卡片）。不可恢复。",
                      confirmText: "清空",
                      cancelText: "取消",
                      danger: true,
                    });
                    if (!ok) return;
                    const r = await emptyTrash();
                    if (!r.ok) void uiAlert({ title: "清空失败", message: `清空失败：${r.error ?? "unknown"}` });
                    else
                      void uiAlert({
                        title: "已清空",
                        message: `已清空：删除库 ${r.removedLibraries} 个，文档 ${r.removedDocs} 篇，片段 ${r.removedArtifacts} 条。`,
                      });
                  })();
                }}
                disabled={!trash.length}
              >
                清空回收站（永久删除）
              </button>
              <button className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors" type="button" onClick={() => void refreshLibraries()}>
                刷新
              </button>
            </div>

            <div className="border border-border rounded-xl bg-surface p-2.5 max-h-[min(52vh,520px)] overflow-auto grid gap-2.5">
              {trash.length ? (
                trash.map((l) => (
                  <div key={l.id} className="border-b border-dashed border-border pb-2.5">
                    <div className="flex justify-between gap-2.5 items-center">
                      <div className="min-w-0">
                        <div className="text-[13px] font-bold text-text overflow-hidden text-ellipsis whitespace-nowrap">
                          {l.name}
                        </div>
                        <div className="text-xs text-text-muted">
                          文档 {l.docCount} 篇 · 删除于 {new Date(l.deletedAt).toLocaleString()}
                        </div>
                        <div className="text-xs text-text-muted">id: {l.id}</div>
                      </div>
                      <div className="flex gap-2 flex-wrap justify-end">
                        <button
                          className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                          type="button"
                          onClick={() => {
                            void (async () => {
                              const r = await restoreLibraryFromTrash(l.id);
                              if (!r.ok) void uiAlert({ title: "恢复失败", message: `恢复失败：${r.error ?? "unknown"}` });
                              await refreshLibraries().catch(() => void 0);
                            })();
                          }}
                        >
                          恢复
                        </button>
                        <button
                          className="px-3 py-1.5 text-xs rounded-lg border border-error/30 text-error hover:bg-error/10 transition-colors"
                          type="button"
                          onClick={() => {
                            void (async () => {
                              const ok = await uiConfirm({
                                title: "确认彻底删除？",
                                message: `彻底删除库「${l.name}」？\n\n将永久删除该库及其全部内容（文档/段落/卡片）。不可恢复。`,
                                confirmText: "彻底删除",
                                cancelText: "取消",
                                danger: true,
                              });
                              if (!ok) return;
                              const r = await purgeLibrary(l.id);
                              if (!r.ok) void uiAlert({ title: "删除失败", message: `删除失败：${r.error ?? "unknown"}` });
                              else
                                void uiAlert({
                                  title: "已删除",
                                  message: `已删除：文档 ${r.removedDocs} 篇，片段 ${r.removedArtifacts} 条。`,
                                });
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
                <div className="text-xs text-text-faint">回收站为空。</div>
              )}
            </div>
          </div>
        ) : null}

        {tab === "jobs" ? (
          <>
            <div className="text-xs text-text-faint mb-2.5">
              抽卡任务说明：导入后先入队，需点击 ▶ 开始；为每篇文档生成最终要素卡（hook/thesis/ending/one_liner/outline），用于后续生成库级 22+1 风格手册；已抽过会自动跳过。
            </div>

            <div className="flex gap-2.5 items-center flex-wrap mb-2.5">
              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">当前库：{currentLibrary ? currentLibrary.name : "（未选择）"}</span>
              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">处理集（Facet Pack）：</span>
              <select
                className="px-2 py-1 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors cursor-pointer"
                value={currentLibrary?.facetPackId ?? ""}
                disabled={!currentLibrary || status !== "idle"}
                title={
                  !currentLibrary
                    ? "请先在「库」里设为当前库"
                    : status !== "idle"
                      ? "抽卡运行/暂停中不可切换处理集"
                      : "选择抽卡使用的处理集（第一轮前选；第二轮沿用）"
                }
                onChange={(e) => {
                  const lib = currentLibrary;
                  if (!lib) return;
                  const next = String(e.target.value ?? "").trim();
                  if (!next || next === lib.facetPackId) return;
                  void (async () => {
                    const ok = await uiConfirm({
                      title: "确认切换处理集？",
                      message:
                        `切换当前库「${lib.name}」的处理集为「${facetPackLabel(next)}」？\n\n` +
                        "- 第一轮抽卡将按新的处理集打维度标签（facetIds）\n" +
                        "- 第二轮生成风格手册会沿用该处理集\n\n" +
                        "提示：若该库已抽过卡，切换后可能需要重抽才能保持一致。",
                      confirmText: "切换",
                      cancelText: "取消",
                    });
                    if (!ok) return;
                    const r = await setLibraryFacetPack(lib.id, next);
                    if (!r.ok) void uiAlert({ title: "设置失败", message: `设置失败：${r.error ?? "unknown"}` });
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
              {currentLibrary ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">标签：{facetPackLabel(currentLibrary.facetPackId)}</span> : null}
            </div>

            <div className="flex gap-2.5 items-center flex-wrap mb-2.5">
              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">状态：{status === "idle" ? "空闲" : status === "running" ? "运行中" : "已暂停"}</span>
              <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">
                进度：{summary.done}/{summary.total}
              </span>
              {summary.failed ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">失败：{summary.failed}</span> : null}
              {summary.cancelled ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">取消：{summary.cancelled}</span> : null}
              {summary.runningLabel ? (
                <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">
                  当前：{summary.runningLabel}
                  {summary.runningNote ? ` · ${summary.runningNote}` : ""}
                  {typeof summary.chunksDone === "number" && typeof summary.chunksTotal === "number" && summary.chunksTotal > 1 ? `（块 ${summary.chunksDone}/${summary.chunksTotal}）` : ""}
                </span>
              ) : null}
            </div>

            {progress.totalUnits ? (
              <div className="grid gap-1.5 mb-2.5">
                <div className="flex items-center gap-2.5">
                  <div className="flex-1 h-2 rounded-full bg-border overflow-hidden">
                    <div
                      className={cn(
                        "h-full transition-[width] duration-200",
                        progress.pct >= 1 ? "bg-success" : "bg-accent"
                      )}
                      style={{ width: `${Math.round(progress.pct * 100)}%` }}
                    />
                  </div>
                  <div className="text-xs text-text-muted whitespace-nowrap">
                    {Math.round(progress.pct * 100)}%
                  </div>
                </div>
                <div className="text-xs text-text-muted">
                  估算：{progress.doneUnits}/{progress.totalUnits} · 已用 {formatDuration(progress.elapsedMs)}
                  {progress.etaMs ? ` · 预计剩余 ~${formatDuration(progress.etaMs)}` : ""}
                </div>
              </div>
            ) : null}

            {currentLibrary && status === "idle" ? (
              <div className="mb-2.5 border border-border rounded-xl bg-surface-alt p-2.5 grid gap-2">
                <div className="font-bold text-sm">下一步</div>
                <div className="text-xs text-text-muted">
                  推荐顺序：抽卡完成后先做第二步风格手册，再做第三步深度克隆（声音指纹 + 规则手册）。
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button
                    className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors disabled:opacity-50"
                    type="button"
                    disabled={!currentLibraryIsStyle || deepCloneLoading || fpLoading}
                    title={
                      !currentLibraryIsStyle
                        ? "仅风格库支持风格手册"
                        : pendingJobsInCurrentLibrary > 0
                          ? `该库还有 ${pendingJobsInCurrentLibrary} 个抽卡任务未完成，手册可能不完整`
                          : "入队第二步：风格手册"
                    }
                    onClick={() => void queuePlaybookForLibrary(currentLibrary.id, { source: "jobs" })}
                  >
                    第二步：入队风格手册
                  </button>
                  <button
                    className="px-3 py-1.5 text-xs rounded-lg border border-accent bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                    type="button"
                    disabled={!currentLibraryIsStyle || deepCloneLoading || fpLoading}
                    title={!currentLibraryIsStyle ? "仅风格库支持第三步深度克隆" : "执行第三步：声音指纹 + 规则手册"}
                    onClick={() => void runDeepCloneForLibrary(currentLibrary.id)}
                  >
                    {deepCloneLoading ? "第三步执行中…" : "第三步：深度克隆"}
                  </button>
                </div>
              </div>
            ) : null}

            {summary.runningArticles && summary.runningArticles.length > 0 ? (
              <div className="mb-2.5 rounded-lg border border-border-soft bg-surface-alt/40 px-3 py-2">
                <div className="text-[11px] text-text-faint mb-1">分篇进度</div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                  {summary.runningArticles.map((a) => (
                    <div key={a.label} className={cn("text-xs", articleStatusIcon(a.status))}>
                      <span className="font-medium">{a.label}</span>
                      <span className="ml-1">{articleStatusText(a)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="border border-border rounded-xl bg-surface max-h-[min(52vh,520px)] overflow-auto p-2.5 grid gap-2">
              {jobs.length || playbookJobs.length ? (
                <>
                  {jobs.length
                    ? jobs.map((j) => (
                        <div key={j.id} className="grid gap-1 pb-2 border-b border-dashed border-border">
                          <div className="flex items-center justify-between gap-2.5">
                            <div className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                              <span className={cn("font-semibold", statusColorClass(j.status))}>{statusLabel(j.status)}</span>
                              <span className="text-text-muted"> · </span>
                              <span className="text-text">{j.docTitle}</span>
                              {j.libraryName ? <span className="text-text-muted">{` · 库：${j.libraryName}`}</span> : null}
                            </div>
                            <div className="text-xs text-text-muted whitespace-nowrap">
                              {typeof j.extractedCards === "number" ? `卡片 +${j.extractedCards}` : ""}
                            </div>
                          </div>
                          {j.error ? (
                            <div className="text-xs text-red-600 whitespace-pre-wrap">{j.error}</div>
                          ) : null}
                          {j.status === "running" && j.progressNote ? (
                            <div className="text-xs text-text-faint">{j.progressNote}</div>
                          ) : null}
                        </div>
                      ))
                    : null}

                  {playbookJobs.length ? (
                    <>
                      {jobs.length ? (
                        <div className="text-xs text-text-faint pt-1.5">
                          风格手册任务
                        </div>
                      ) : null}
                      {playbookJobs.map((j) => (
                        <div key={j.id} className="grid gap-1 pb-2 border-b border-dashed border-border">
                          <div className="flex items-center justify-between gap-2.5">
                            <div className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                              <span className={cn("font-semibold", statusColorClass(j.status))}>{statusLabel(j.status)}</span>
                              <span className="text-text-muted"> · </span>
                              <span className="text-text">{`【风格手册】${j.libraryName ?? j.libraryId}`}</span>
                            </div>
                            <div className="text-xs text-text-muted whitespace-nowrap">
                              {typeof j.totalFacets === "number"
                                ? `画像 ${j.generatedStyleProfile ? "✔" : "…"} · 维度 ${Math.max(
                                    0,
                                    Math.min(j.totalFacets, Number(j.generatedFacets ?? 0)),
                                  )}/${j.totalFacets}`
                                : typeof j.generatedFacets === "number"
                                  ? `维度卡 +${j.generatedFacets}`
                                  : ""}
                            </div>
                          </div>
                          {j.error ? (
                            <div className="text-xs text-red-600 whitespace-pre-wrap">{j.error}</div>
                          ) : null}
                        </div>
                      ))}
                    </>
                  ) : null}
                </>
              ) : (
                <div className="text-xs text-text-faint">队列为空：导入语料后会自动加入抽卡队列；风格手册需点击"生成风格手册"入队。</div>
              )}
            </div>

            <div className="flex gap-2 items-center justify-between mt-3">
              <div className="flex gap-2">
                <button className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors" type="button" onClick={clearFinished} disabled={!jobs.length && !playbookJobs.length}>
                  清理已完成
                </button>
                <button
                  className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                  type="button"
                  onClick={retryFailed}
                  disabled={!jobs.some((j) => j.status === "failed") && !playbookJobs.some((j) => j.status === "failed")}
                >
                  重试失败
                </button>
                <button
                  className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                  type="button"
                  title="清除旧卡并重新抽卡（用于内容有误或被跳过的文档）"
                  onClick={() => { forceReextractSkipped(); if (status !== "running") void start(); }}
                  disabled={!jobs.some((j) => j.status === "skipped")}
                >
                  强制重抽
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  className={cn("px-3 py-1.5 text-xs rounded-lg border transition-colors", status === "running" ? "border-accent bg-accent text-white hover:bg-accent-hover" : "border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text")}
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
                  className="px-3 py-1.5 text-xs rounded-lg border border-error/30 text-error hover:bg-error/10 transition-colors"
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
                  className="px-3 py-1.5 text-xs rounded-lg border border-accent bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                  type="button"
                  disabled={!currentLibrary || !currentLibraryIsStyle || status !== "idle" || deepCloneLoading || fpLoading}
                  title={
                    !currentLibrary
                      ? "请先选择当前库"
                      : !currentLibraryIsStyle
                        ? "仅风格库支持第三步深度克隆"
                        : status !== "idle"
                          ? "请先停止/暂停抽卡任务"
                          : "第三步：声音指纹 + 规则手册"
                  }
                  onClick={() => {
                    const lib = currentLibrary;
                    if (!lib) return;
                    void runDeepCloneForLibrary(lib.id);
                  }}
                >
                  {deepCloneLoading ? "深度克隆中…" : "第三步：深度克隆"}
                </button>
                <button
                  className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                  type="button"
                  disabled={!currentLibrary || !currentLibraryIsStyle || status !== "idle" || (currentLibrary?.docCount ?? 0) <= 0 || deepCloneLoading || fpLoading}
                  title={
                    !currentLibrary
                      ? "请先选择当前库"
                      : !currentLibraryIsStyle
                        ? "仅风格库支持风格手册"
                      : status !== "idle"
                        ? "请先停止/暂停抽卡任务"
                        : (currentLibrary.docCount ?? 0) <= 0
                          ? "该库暂无文档"
                          : "第二步：生成库级风格手册（Style Profile + 22+1）"
                  }
                  onClick={() => {
                    const lib = currentLibrary;
                    if (!lib) return;
                    void queuePlaybookForLibrary(lib.id, { source: "jobs" });
                  }}
                >
                  第二步：风格手册
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {prompt ? (
        <div
          className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPrompt(null);
          }}
        >
          <div
            className="w-[480px] max-w-[calc(100vw-24px)] bg-surface rounded-2xl border border-border shadow-2xl p-5"
            onMouseDown={(e) => {
              e.stopPropagation();
              // 兜底：如果因为某些原因未聚焦，点弹窗任意位置也让输入框可输入
              try {
                promptInputRef.current?.focus();
              } catch {
                // ignore
              }
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              try {
                promptInputRef.current?.focus();
              } catch {
                // ignore
              }
            }}
          >
            <div className="text-base font-semibold text-text">{prompt.title}</div>
            {prompt.desc ? <div className="text-sm text-text-muted mt-2.5">{prompt.desc}</div> : null}
            <input
              ref={promptInputRef}
              className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-surface text-text placeholder:text-text-faint outline-none focus:border-accent transition-colors"
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
            <div className="flex gap-2 items-center justify-end mt-3">
              <button className="px-2 py-1 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors cursor-pointer" type="button" onClick={() => setPrompt(null)}>
                取消
              </button>
              <button
                className="px-3 py-1.5 text-xs rounded-lg border border-accent bg-accent text-white hover:bg-accent-hover transition-colors"
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

      {rulesEditor ? (
        <div
          className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setRulesEditor(null);
              setRulesEditorErr(null);
            }
          }}
        >
          <div className="w-[860px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-4rem)] bg-surface rounded-2xl border border-border shadow-2xl p-5 flex flex-col overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
            <div className="text-base font-semibold text-text">{rulesEditor.title}</div>
            <div className="text-sm text-text-muted mt-2.5 whitespace-pre-wrap">
              - 这是"仅对该库生效"的写法簇规则手册（建议放 values / analysisLenses / must/avoid/templates/checks 等）。{"\n"}
              - 写作时会随 `mainDoc.styleContractV1` 注入，影响模型"站队/归因/战场"。{"\n"}
              - 当前先做最小闭环：手动编辑保存；后续再补"从 anchors/segments 自动抽取"。
            </div>
            <textarea
              className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-surface text-text placeholder:text-text-faint outline-none focus:border-accent transition-colors h-[min(52vh,520px)] font-mono"
              value={rulesEditor.value}
              onChange={(e) => setRulesEditor((p) => (p ? { ...p, value: e.target.value } : p))}
            />

            <div className="mt-2.5 border border-border rounded-xl bg-surface p-2.5 grid gap-2.5">
              <div className="flex justify-between gap-2.5 flex-wrap items-center">
                <div className="font-black">证据绑定（anchors/segments）</div>
                <div className="flex gap-2 flex-wrap justify-end">
                  <select className="px-2 py-1 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors cursor-pointer" value={rulesEvidenceSource} onChange={(e) => setRulesEvidenceSource(e.target.value as any)} title="证据来源：来自体检簇证据，或来自你采纳的 anchors">
                    <option value="cluster_evidence">本簇证据（体检代表样例）</option>
                    <option value="cluster_anchors">本簇 anchors（已采纳）</option>
                  </select>
                  <select className="px-2 py-1 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors cursor-pointer" value={rulesEvidenceTarget} onChange={(e) => setRulesEvidenceTarget(e.target.value as any)} title="把证据写到哪个维度下">
                    <option value="values.principles">values.principles[i].evidence</option>
                    <option value="values.priorities">values.priorities[i].evidence</option>
                    <option value="values.moralAccounting">values.moralAccounting[i].evidence</option>
                    <option value="values.tabooFrames">values.tabooFrames[i].evidence</option>
                    <option value="values.epistemicNorms">values.epistemicNorms[i].evidence</option>
                    <option value="values.templates">values.templates[i].evidence</option>
                    <option value="analysisLenses">analysisLenses[i].evidence</option>
                  </select>
                  <input
                    className="w-[90px] h-[34px] px-3 py-2 text-sm rounded-lg border border-border bg-surface text-text placeholder:text-text-faint outline-none focus:border-accent transition-colors"
                    value={rulesEvidenceIndex}
                    onChange={(e) => setRulesEvidenceIndex(e.target.value)}
                    placeholder="i=0"
                    title="写入第几个条目（0-based）"
                  />
                  <input
                    className="w-[160px] h-[34px] px-3 py-2 text-sm rounded-lg border border-border bg-surface text-text placeholder:text-text-faint outline-none focus:border-accent transition-colors"
                    value={rulesEvidenceFilter}
                    onChange={(e) => setRulesEvidenceFilter(e.target.value)}
                    placeholder="过滤（命中 quote）"
                    title="按 quote 过滤候选证据"
                  />
                </div>
              </div>

              {rulesEvidenceCandidates.length === 0 ? (
                <div className="text-xs text-text-faint">
                  没有可用证据。提示：先在「库体检」里生成声音指纹（数字版），或先采纳 anchors；并确保当前簇有代表样例。
                </div>
              ) : (
                <div className="grid gap-2 max-h-[220px] overflow-auto">
                  {rulesEvidenceCandidates.map((r) => {
                    const segId = String((r as any)?.segmentId ?? "").trim();
                    const docId = String((r as any)?.sourceDocId ?? "").trim();
                    const quote = String((r as any)?.quote ?? "").trim();
                    return (
                      <div key={segId} className="border border-dashed border-border rounded-[10px] p-2 grid gap-1.5">
                        <div className="flex justify-between gap-2.5 flex-wrap">
                          <div className="flex gap-1.5 flex-wrap">
                            {segId ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft">{segId}</span> : null}
                            {docId ? <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md bg-surface-alt text-text-muted border border-border-soft" title="sourceDocId">{docId}</span> : null}
                          </div>
                          <div className="flex gap-2 flex-wrap justify-end">
                            <button className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors" type="button" onClick={() => appendEvidenceToRules(r)} title="将该证据追加到目标路径的 evidence[]">
                              添加到 evidence
                            </button>
                            <button
                              className="px-3 py-1.5 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors"
                              type="button"
                              onClick={() => {
                                const txt = JSON.stringify(r, null, 2);
                                const cb = (navigator as any)?.clipboard;
                                if (cb?.writeText) {
                                  void cb.writeText(txt);
                                  return;
                                }
                                void (async () => {
                                  const v = await uiPrompt({
                                    title: "复制证据 JSON",
                                    message: "提示：点击「复制」会写入剪贴板；也可以手动选中复制。",
                                    defaultValue: txt,
                                    multiline: true,
                                    confirmText: "复制",
                                    cancelText: "关闭",
                                  });
                                  if (v === null) return;
                                  try {
                                    await navigator.clipboard.writeText(v);
                                  } catch {
                                    const api = window.desktop?.clipboard;
                                    await api?.writeText?.(v).catch(() => void 0);
                                  }
                                })();
                              }}
                              title="复制该证据对象 JSON（可手工粘贴到任意位置）"
                            >
                              复制 JSON
                            </button>
                          </div>
                        </div>
                        <div className="text-xs text-text-muted whitespace-pre-wrap">{quote || "（空 quote）"}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {rulesEditorErr ? (
              <div className="mt-2 text-xs text-red-600 whitespace-pre-wrap">{rulesEditorErr}</div>
            ) : null}
            <div className="flex gap-2 items-center justify-between mt-3">
              <button
                className="px-3 py-1.5 text-xs rounded-lg border border-error/30 text-error hover:bg-error/10 transition-colors"
                type="button"
                onClick={() => {
                  if (!viewLibId) return;
                  const cid = String(rulesEditor.clusterId ?? "").trim();
                  if (!cid) return;
                  void (async () => {
                    const ok = await uiConfirm({
                      title: "确认清空该簇规则手册？",
                      message: `清空该簇规则手册？\n\nclusterId=${cid}\n\n（仅删除本库 prefs，不影响体检快照）`,
                      confirmText: "清空",
                      cancelText: "取消",
                      danger: true,
                    });
                    if (!ok) return;
                    setRulesEditorErr(null);
                    const r = await setLibraryStyleClusterRules({ libraryId: viewLibId, clusterId: cid, rules: null });
                    if (!r?.ok) {
                      setRulesEditorErr(r?.error ?? "SAVE_FAILED");
                      return;
                    }
                    setClusterRules((prev) => {
                      const next = { ...(prev ?? {}) } as any;
                      delete next[cid];
                      return next;
                    });
                    setRulesEditor(null);
                  })();
                }}
              >
                清空
              </button>
              <div className="flex gap-2">
                <button className="px-2 py-1 text-xs rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-muted hover:text-text transition-colors cursor-pointer" type="button" onClick={() => (setRulesEditor(null), setRulesEditorErr(null))}>
                  取消
                </button>
                <button
                  className="px-3 py-1.5 text-xs rounded-lg border border-accent bg-accent text-white hover:bg-accent-hover transition-colors"
                  type="button"
                  onClick={() => {
                    if (!viewLibId) return;
                    const cid = String(rulesEditor.clusterId ?? "").trim();
                    if (!cid) return;
                    let parsed: any = null;
                    try {
                      parsed = JSON.parse(String(rulesEditor.value ?? "").trim() || "null");
                    } catch (e: any) {
                      setRulesEditorErr(`JSON 解析失败：${String(e?.message ?? e)}`);
                      return;
                    }
                    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                      setRulesEditorErr("规则手册必须是 JSON object（不能是数组/字符串）。");
                      return;
                    }
                    parsed.updatedAt = new Date().toISOString();
                    void (async () => {
                      setRulesEditorErr(null);
                      const r = await setLibraryStyleClusterRules({ libraryId: viewLibId, clusterId: cid, rules: parsed });
                      if (!r?.ok) {
                        setRulesEditorErr(r?.error ?? "SAVE_FAILED");
                        return;
                      }
                      setClusterRules((prev) => ({ ...(prev ?? {}), [cid]: parsed }));
                      setRulesEditor(null);
                    })();
                  }}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
