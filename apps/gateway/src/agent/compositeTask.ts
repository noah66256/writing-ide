import { detectPromptCapabilities, type McpServerCatalogEntry } from "./toolCatalog.js";

export type CompositeTaskPhaseKind =
  | "browser_collect"
  | "web_research"
  | "kb_research"
  | "project_read"
  | "structured_extract"
  | "word_delivery"
  | "spreadsheet_delivery"
  | "project_delivery"
  | "code_exec_fallback";

export type CompositeTaskPhasePlan = {
  id: string;
  kind: CompositeTaskPhaseKind;
  title: string;
  status: "todo" | "running" | "done" | "blocked" | "skipped";
  allowedServerFamilies: string[];
  allowedServerIds: string[];
  allowedToolHints: string[];
  successCriteria: string[];
  budget: { maxTurns: number; maxToolCalls: number };
};

export type CompositeTaskPendingInput = {
  id: string;
  phaseId: string;
  kind: string;
  question: string;
  replyHint?: string;
};

export type CompositeTaskPlanV1 = {
  v: 1;
  kind: "single_phase" | "multi_phase";
  status: "running" | "waiting_user" | "done" | "blocked";
  goal: string;
  currentPhaseId: string;
  phases: CompositeTaskPhasePlan[];
  pendingInput: CompositeTaskPendingInput | null;
  queuedFollowUps: Array<{ id: string; text: string; createdAt: string }>;
  updatedAt: string;
};

const COMPOSITE_PHASE_SPECS: Record<CompositeTaskPhaseKind, {
  title: string;
  allowedServerFamilies: string[];
  allowedToolHints: string[];
  successCriteria: string[];
  budget: { maxTurns: number; maxToolCalls: number };
}> = {
  browser_collect: {
    title: "浏览采集",
    allowedServerFamilies: ["browser"],
    allowedToolHints: ["mcp.playwright.browser_navigate", "mcp.playwright.browser_snapshot", "mcp.playwright.browser_click", "mcp.playwright.browser_run_code"],
    successCriteria: ["visited_required_pages", "captured_required_metrics"],
    budget: { maxTurns: 14, maxToolCalls: 24 },
  },
  web_research: {
    title: "联网调研",
    allowedServerFamilies: ["search", "browser"],
    allowedToolHints: ["web.search", "web.fetch"],
    successCriteria: ["collected_required_sources"],
    budget: { maxTurns: 10, maxToolCalls: 16 },
  },
  kb_research: {
    title: "知识库检索",
    allowedServerFamilies: [],
    allowedToolHints: ["kb.search"],
    successCriteria: ["collected_required_kb_hits"],
    budget: { maxTurns: 8, maxToolCalls: 10 },
  },
  project_read: {
    title: "项目读取",
    allowedServerFamilies: [],
    allowedToolHints: ["project.search", "doc.read", "project.listFiles"],
    successCriteria: ["read_required_project_context"],
    budget: { maxTurns: 8, maxToolCalls: 12 },
  },
  structured_extract: {
    title: "结构化提炼",
    allowedServerFamilies: [],
    allowedToolHints: ["run.mainDoc.update", "run.mainDoc.get"],
    successCriteria: ["artifact_ready"],
    budget: { maxTurns: 6, maxToolCalls: 6 },
  },
  word_delivery: {
    title: "Word 交付",
    allowedServerFamilies: ["word"],
    allowedToolHints: ["mcp.word.create_document", "mcp.word.read_doc"],
    successCriteria: ["word_exported"],
    budget: { maxTurns: 10, maxToolCalls: 16 },
  },
  spreadsheet_delivery: {
    title: "表格交付",
    allowedServerFamilies: ["spreadsheet"],
    allowedToolHints: ["mcp.excel.create_workbook", "mcp.spreadsheet.create_workbook"],
    successCriteria: ["spreadsheet_exported"],
    budget: { maxTurns: 10, maxToolCalls: 16 },
  },
  project_delivery: {
    title: "项目写入交付",
    allowedServerFamilies: [],
    allowedToolHints: ["doc.write", "doc.mkdir"],
    successCriteria: ["files_written"],
    budget: { maxTurns: 8, maxToolCalls: 10 },
  },
  code_exec_fallback: {
    title: "代码兜底执行",
    allowedServerFamilies: [],
    allowedToolHints: ["code.exec"],
    successCriteria: ["fallback_artifact_ready"],
    budget: { maxTurns: 10, maxToolCalls: 8 },
  },
};

export function normalizeCompositeTaskPlan(input: unknown): CompositeTaskPlanV1 | null {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as any) : null;
  if (!raw) return null;
  const rawPhases = Array.isArray(raw.phases) ? raw.phases : [];
  const phases = rawPhases
    .map((phase: any, index: number) => {
      const kind = String(phase?.kind ?? "").trim() as CompositeTaskPhaseKind;
      if (!kind || !(kind in COMPOSITE_PHASE_SPECS)) return null;
      const spec = COMPOSITE_PHASE_SPECS[kind];
      const statusRaw = String(phase?.status ?? "todo").trim().toLowerCase();
      const status = ["todo", "running", "done", "blocked", "skipped"].includes(statusRaw)
        ? (statusRaw as CompositeTaskPhasePlan["status"])
        : "todo";
      return {
        id: String(phase?.id ?? `phase_${index + 1}_${kind}`),
        kind,
        title: String(phase?.title ?? spec.title),
        status,
        allowedServerFamilies: Array.isArray(phase?.allowedServerFamilies)
          ? phase.allowedServerFamilies.map((item: any) => String(item ?? "").trim()).filter(Boolean)
          : spec.allowedServerFamilies,
        allowedServerIds: Array.isArray(phase?.allowedServerIds)
          ? phase.allowedServerIds.map((item: any) => String(item ?? "").trim()).filter(Boolean)
          : [],
        allowedToolHints: Array.isArray(phase?.allowedToolHints)
          ? phase.allowedToolHints.map((item: any) => String(item ?? "").trim()).filter(Boolean)
          : spec.allowedToolHints,
        successCriteria: Array.isArray(phase?.successCriteria)
          ? phase.successCriteria.map((item: any) => String(item ?? "").trim()).filter(Boolean)
          : spec.successCriteria,
        budget: {
          maxTurns: Number.isFinite(Number(phase?.budget?.maxTurns))
            ? Math.max(1, Math.min(24, Math.floor(Number(phase.budget.maxTurns))))
            : spec.budget.maxTurns,
          maxToolCalls: Number.isFinite(Number(phase?.budget?.maxToolCalls))
            ? Math.max(0, Math.min(40, Math.floor(Number(phase.budget.maxToolCalls))))
            : spec.budget.maxToolCalls,
        },
      } as CompositeTaskPhasePlan;
    })
    .filter(Boolean) as CompositeTaskPhasePlan[];
  if (!phases.length) return null;

  const currentPhaseIdRaw = String(raw.currentPhaseId ?? "").trim();
  const unfinishedPhase = phases.find((phase) => phase.status !== "done" && phase.status !== "skipped") ?? phases[phases.length - 1];
  const currentPhaseId = phases.some((phase) => phase.id === currentPhaseIdRaw) ? currentPhaseIdRaw : unfinishedPhase.id;
  const statusRaw = String(raw.status ?? "running").trim().toLowerCase();
  const status = ["running", "waiting_user", "done", "blocked"].includes(statusRaw)
    ? (statusRaw as CompositeTaskPlanV1["status"])
    : "running";
  const pendingRaw = raw.pendingInput && typeof raw.pendingInput === "object" && !Array.isArray(raw.pendingInput)
    ? raw.pendingInput
    : null;

  return {
    v: 1,
    kind: phases.length > 1 ? "multi_phase" : "single_phase",
    status,
    goal: String(raw.goal ?? "").trim(),
    currentPhaseId,
    phases,
    pendingInput: pendingRaw
      ? {
          id: String(pendingRaw.id ?? `pending_${currentPhaseId}`).trim(),
          phaseId: String(pendingRaw.phaseId ?? currentPhaseId).trim() || currentPhaseId,
          kind: String(pendingRaw.kind ?? "question").trim() || "question",
          question: String(pendingRaw.question ?? "").trim(),
          replyHint: String(pendingRaw.replyHint ?? "").trim() || undefined,
        }
      : null,
    queuedFollowUps: Array.isArray(raw.queuedFollowUps)
      ? raw.queuedFollowUps
          .map((item: any, index: number) => ({
            id: String(item?.id ?? `queued_${index + 1}`).trim(),
            text: String(item?.text ?? "").trim(),
            createdAt: String(item?.createdAt ?? new Date().toISOString()).trim() || new Date().toISOString(),
          }))
          .filter((item: any) => item.id && item.text)
      : [],
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()).trim() || new Date().toISOString(),
  };
}

function inferCompositePhaseKinds(args: {
  userPrompt: string;
  routeId: string;
  projectDir?: string | null;
}): CompositeTaskPhaseKind[] {
  const prompt = String(args.userPrompt ?? "").trim();
  const routeId = String(args.routeId ?? "").trim().toLowerCase();
  const promptCaps = detectPromptCapabilities(prompt);
  const kinds: CompositeTaskPhaseKind[] = [];
  const push = (kind: CompositeTaskPhaseKind) => {
    if (!kinds.includes(kind)) kinds.push(kind);
  };

  const browserLike = routeId === "web_radar" || promptCaps.has("browser_open");
  const webResearchLike = promptCaps.has("web_search") && !browserLike;
  const kbResearchLike = promptCaps.has("kb_search");
  const projectReadLike = routeId === "project_search";
  const wantsReportishOutput = /(报告|汇报|总结|汇总|罗列|整理|提炼|分析一下|给我个报告|结构化|形成结论)/.test(prompt);
  const wantsWord = promptCaps.has("mcp_word_doc");
  const wantsSheet = promptCaps.has("mcp_spreadsheet");
  const wantsProjectWrite = Boolean(String(args.projectDir ?? "").trim()) && /(写入项目|保存到项目|落盘|生成文件|写成md|markdown|md文件|文档文件)/i.test(prompt);

  if (browserLike) push("browser_collect");
  if (webResearchLike) push("web_research");
  if (kbResearchLike) push("kb_research");
  if (projectReadLike) push("project_read");

  const hasCollectPhase = kinds.some((kind) => ["browser_collect", "web_research", "kb_research", "project_read"].includes(kind));
  if (hasCollectPhase && (wantsReportishOutput || wantsWord || wantsSheet || wantsProjectWrite)) {
    push("structured_extract");
  }
  if (wantsWord) push("word_delivery");
  if (wantsSheet) push("spreadsheet_delivery");
  if (wantsProjectWrite) push("project_delivery");
  if (promptCaps.has("code_exec") && !wantsWord && !wantsSheet) push("code_exec_fallback");

  return kinds;
}

export function deriveCompositeTaskPlanV1(args: {
  userPrompt: string;
  routeId: string;
  mainDoc?: unknown;
  projectDir?: string | null;
}): CompositeTaskPlanV1 | null {
  const prompt = String(args.userPrompt ?? "").trim();
  const routeId = String(args.routeId ?? "").trim().toLowerCase();
  const mainDoc = args.mainDoc && typeof args.mainDoc === "object" && !Array.isArray(args.mainDoc) ? (args.mainDoc as any) : null;
  const existing = normalizeCompositeTaskPlan(mainDoc?.compositeTaskV1);
  const inferredKinds = inferCompositePhaseKinds({
    userPrompt: prompt,
    routeId,
    projectDir: args.projectDir,
  });
  if (!existing && inferredKinds.length < 2) return null;

  const mergedKinds: CompositeTaskPhaseKind[] = existing ? existing.phases.map((phase) => phase.kind) : [];
  for (const kind of inferredKinds) {
    if (!mergedKinds.includes(kind)) mergedKinds.push(kind);
  }
  if (!mergedKinds.length) return existing;

  const continuationLike = /^(继续|下一步|已登录|我已登录|A|B|C|D|\d{1,2}|[一二三四])\b/i.test(prompt);
  const existingByKind = new Map((existing?.phases ?? []).map((phase) => [phase.kind, phase]));
  const phases = mergedKinds.map((kind, index) => {
    const prev = existingByKind.get(kind);
    const spec = COMPOSITE_PHASE_SPECS[kind];
    const status = prev?.status ?? (index === 0 ? "running" : "todo");
    return {
      id: prev?.id ?? `phase_${index + 1}_${kind}`,
      kind,
      title: prev?.title ?? spec.title,
      status,
      allowedServerFamilies: prev?.allowedServerFamilies?.length ? prev.allowedServerFamilies : spec.allowedServerFamilies,
      allowedServerIds: prev?.allowedServerIds ?? [],
      allowedToolHints: prev?.allowedToolHints?.length ? prev.allowedToolHints : spec.allowedToolHints,
      successCriteria: prev?.successCriteria?.length ? prev.successCriteria : spec.successCriteria,
      budget: prev?.budget ?? spec.budget,
    } as CompositeTaskPhasePlan;
  });

  const unfinishedPhase = phases.find((phase) => phase.status !== "done" && phase.status !== "skipped") ?? phases[phases.length - 1];
  const currentPhaseId = existing?.currentPhaseId && phases.some((phase) => phase.id === existing.currentPhaseId)
    ? existing.currentPhaseId
    : unfinishedPhase.id;

  return {
    v: 1,
    kind: phases.length > 1 ? "multi_phase" : "single_phase",
    status: existing?.status === "done" ? "done" : continuationLike ? "running" : (existing?.status ?? "running"),
    goal: String(mainDoc?.goal ?? prompt).trim() || prompt,
    currentPhaseId,
    phases,
    pendingInput: continuationLike ? null : (existing?.pendingInput ?? null),
    queuedFollowUps: existing?.queuedFollowUps ?? [],
    updatedAt: new Date().toISOString(),
  };
}

export function getCompositeServerSelectionBudget(plan: CompositeTaskPlanV1 | null): number {
  if (!plan) return 2;
  const families = Array.from(new Set(
    plan.phases
      .filter((phase) => phase.status !== "done" && phase.status !== "skipped")
      .flatMap((phase) => phase.allowedServerFamilies)
      .map((family) => String(family ?? "").trim())
      .filter(Boolean),
  ));
  return Math.max(2, Math.min(4, families.length || 2));
}

export function getCompositePreferredToolNames(args: {
  plan: CompositeTaskPlanV1 | null;
  serverCatalog: McpServerCatalogEntry[];
}): string[] {
  if (!args.plan) return [];
  const unfinishedFamilies = new Set(
    args.plan.phases
      .filter((phase) => phase.status !== "done" && phase.status !== "skipped")
      .flatMap((phase) => phase.allowedServerFamilies)
      .map((family) => String(family ?? "").trim())
      .filter(Boolean),
  );
  const names: string[] = [];
  for (const server of args.serverCatalog) {
    if (!unfinishedFamilies.has(String(server.family ?? "").trim())) continue;
    for (const toolName of server.entryToolNames.slice(0, 2)) {
      if (!names.includes(toolName)) names.push(toolName);
    }
  }
  return names.slice(0, 12);
}

export function getCompositePreferredServerIds(args: {
  plan: CompositeTaskPlanV1 | null;
  serverCatalog: McpServerCatalogEntry[];
  rankingSample?: Array<{ serverId: string; score: number }>;
  maxServers?: number;
}): string[] {
  if (!args.plan) return [];
  const families = Array.from(new Set(
    args.plan.phases
      .filter((phase) => phase.status !== "done" && phase.status !== "skipped")
      .flatMap((phase) => phase.allowedServerFamilies)
      .map((family) => String(family ?? "").trim())
      .filter(Boolean),
  ));
  if (!families.length) return [];
  const rankingScore = new Map(
    (Array.isArray(args.rankingSample) ? args.rankingSample : []).map((item) => [String(item?.serverId ?? "").trim(), Number(item?.score ?? 0)]),
  );
  const maxServers = Math.max(1, Math.min(4, Math.floor(Number(args.maxServers ?? families.length) || families.length)));
  const out: string[] = [];
  for (const family of families) {
    const candidate = args.serverCatalog
      .filter((server) => String(server.family ?? "").trim() === family && String(server.status ?? "connected").trim() === "connected")
      .sort((left, right) => {
        const scoreDiff = (rankingScore.get(String(right.serverId ?? "").trim()) ?? 0) - (rankingScore.get(String(left.serverId ?? "").trim()) ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        if (right.entryToolNames.length !== left.entryToolNames.length) return right.entryToolNames.length - left.entryToolNames.length;
        return String(left.serverId ?? "").localeCompare(String(right.serverId ?? ""));
      })[0];
    const serverId = String(candidate?.serverId ?? "").trim();
    if (serverId && !out.includes(serverId)) out.push(serverId);
    if (out.length >= maxServers) break;
  }
  return out.slice(0, maxServers);
}

export function summarizeCompositeTaskPlan(plan: CompositeTaskPlanV1 | null): string {
  if (!plan) return "";
  const currentPhase = plan.phases.find((phase) => phase.id === plan.currentPhaseId) ?? plan.phases[0];
  const upcoming = plan.phases
    .filter((phase) => phase.id !== currentPhase.id && phase.status !== "done" && phase.status !== "skipped")
    .map((phase) => phase.title)
    .slice(0, 4);
  const currentFamilies = currentPhase.allowedServerFamilies.length ? currentPhase.allowedServerFamilies.join("/") : "system_only";
  return (
    `当前任务为复合任务，请按阶段推进，不要把所有事情压在一个阶段里硬做。\n` +
    `- 当前阶段：${currentPhase.title}（kind=${currentPhase.kind}，serverFamilies=${currentFamilies}）\n` +
    `- 本阶段目标：${currentPhase.successCriteria.join("、")}\n` +
    `- 本阶段优先工具：${currentPhase.allowedToolHints.join("、") || "run.*"}\n` +
    (upcoming.length ? `- 后续阶段：${upcoming.join(" → ")}\n` : "") +
    `- 如需等待用户输入，请把等待信息写入 pendingInput/主文档，而不是只留在自由文本里。`
  );
}
