import {
  detectPromptCapabilities,
  inferMcpToolClass,
  hasMcpWriteCapability,
  type McpServerCatalogEntry,
  type McpSidecarTool,
} from "./toolCatalog.js";

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
    allowedToolHints: ["project.search", "read", "project.listFiles"],
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
    allowedToolHints: ["write", "mkdir"],
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
  const standaloneDeliveryLike = inferredKinds.some((kind) => kind === "word_delivery" || kind === "spreadsheet_delivery");
  if (!existing && inferredKinds.length < 2 && !standaloneDeliveryLike) return null;

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
  tools?: McpSidecarTool[];
}): string[] {
  if (!args.plan) return [];
  const unfinishedPhases = args.plan.phases.filter((phase) => phase.status !== "done" && phase.status !== "skipped");
  const unfinishedFamilies = new Set(
    unfinishedPhases
      .flatMap((phase) => phase.allowedServerFamilies)
      .map((family) => String(family ?? "").trim())
      .filter(Boolean),
  );
  const names: string[] = [];
  const push = (toolName: string) => {
    const normalized = String(toolName ?? "").trim();
    if (normalized && !names.includes(normalized)) names.push(normalized);
  };
  for (const server of args.serverCatalog) {
    if (!unfinishedFamilies.has(String(server.family ?? "").trim())) continue;
    for (const toolName of server.entryToolNames.slice(0, 2)) push(toolName);
  }

  const tools = Array.isArray(args.tools) ? args.tools : [];
  if (tools.length > 0) {
    const familyByServerId = new Map(args.serverCatalog.map((server) => [String(server.serverId ?? "").trim(), String(server.family ?? "custom").trim()] as const));
    const phasePriority = (phaseKind: CompositeTaskPhaseKind) => {
      if (phaseKind === "word_delivery" || phaseKind === "spreadsheet_delivery") return 500;
      if (phaseKind === "browser_collect") return 320;
      return 120;
    };
    const scored = tools
      .map((tool) => {
        const name = String(tool?.name ?? "").trim();
        const serverId = String(tool?.serverId ?? "").trim();
        const family = familyByServerId.get(serverId) ?? "custom";
        let score = 0;
        for (const phase of unfinishedPhases) {
          if (!phase.allowedServerFamilies.includes(family)) continue;
          score = Math.max(score, phasePriority(phase.kind));
          const toolClass = inferMcpToolClass({
            toolName: String(tool?.originalName ?? name),
            description: String(tool?.description ?? ""),
            serverFamily: family,
          });
          if (phase.kind === "word_delivery" || phase.kind === "spreadsheet_delivery") {
            if (toolClass === "write") score += 220;
            else if (toolClass === "export") score += 180;
            else if (toolClass === "entry") score += 120;
            else if (toolClass === "read") score += 40;
          } else if (phase.kind === "browser_collect") {
            if (toolClass === "entry") score += 140;
            else if (toolClass === "inspect" || toolClass === "read") score += 120;
            else if (toolClass === "write") score += 100;
          }
        }
        return { name, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    for (const item of scored.slice(0, 12)) push(item.name);
  }

  return names.slice(0, 16);
}

export type CompositePhaseCapabilityIssue = {
  phaseId: string;
  phaseKind: CompositeTaskPhaseKind;
  family: string;
  reason: "missing_server" | "missing_write_tool";
  message: string;
  hint: string;
};

export function validateCompositePhaseCapabilities(args: {
  plan: CompositeTaskPlanV1 | null;
  serverCatalog: McpServerCatalogEntry[];
  tools: McpSidecarTool[];
  selectedToolNames: Set<string>;
}): CompositePhaseCapabilityIssue | null {
  if (!args.plan) return null;
  const unfinishedPhases = args.plan.phases.filter((phase) => phase.status !== "done" && phase.status !== "skipped");
  if (!unfinishedPhases.length) return null;
  const familyByServerId = new Map(args.serverCatalog.map((server) => [String(server.serverId ?? "").trim(), String(server.family ?? "custom").trim()] as const));
  for (const phase of unfinishedPhases) {
    const family = phase.kind === "word_delivery"
      ? "word"
      : phase.kind === "spreadsheet_delivery"
        ? "spreadsheet"
        : "";
    if (!family) continue;
    const familyServers = args.serverCatalog.filter((server) => String(server.family ?? "").trim() === family);
    if (familyServers.length === 0) {
      return {
        phaseId: phase.id,
        phaseKind: phase.kind,
        family,
        reason: "missing_server",
        message: family === "word" ? "当前任务需要 Word 交付，但未检测到可用的 Word MCP Server。" : "当前任务需要表格交付，但未检测到可用的 Spreadsheet MCP Server。",
        hint: family === "word" ? "请在 MCP 设置中连接 Word 类 Server，或改为项目内 Markdown/文本交付。" : "请在 MCP 设置中连接 Excel/Spreadsheet 类 Server，或改为项目内 CSV/Markdown 交付。",
      };
    }
    const selectedTools = args.tools.filter((tool) => {
      const serverFamily = familyByServerId.get(String(tool?.serverId ?? "").trim()) ?? "custom";
      return serverFamily === family && args.selectedToolNames.has(String(tool?.name ?? "").trim());
    });
    if (selectedTools.length === 0) {
      return {
        phaseId: phase.id,
        phaseKind: phase.kind,
        family,
        reason: "missing_write_tool",
        message: family === "word" ? "已选中 Word MCP Server，但当前对 Agent 暴露的工具为空，无法完成文档交付。" : "已选中 Spreadsheet MCP Server，但当前对 Agent 暴露的工具为空，无法完成表格交付。",
        hint: "请检查 MCP 设置中的 tool profile / enabledTools / disabledTools，确认交付工具没有被裁掉。",
      };
    }
    const hasWrite = selectedTools.some((tool) => hasMcpWriteCapability({
      toolName: String(tool?.originalName ?? tool?.name ?? ""),
      description: String(tool?.description ?? ""),
      serverFamily: family,
    }));
    if (!hasWrite) {
      const sample = selectedTools.map((tool) => String(tool?.originalName ?? tool?.name ?? "").trim()).filter(Boolean).slice(0, 6).join("、");
      return {
        phaseId: phase.id,
        phaseKind: phase.kind,
        family,
        reason: "missing_write_tool",
        message: family === "word"
          ? `当前 Word MCP 已连接，但对 Agent 暴露的工具缺少正文写入/导出能力（当前可见：${sample || "无"}）。`
          : `当前 Spreadsheet MCP 已连接，但对 Agent 暴露的工具缺少写入/导出能力（当前可见：${sample || "无"}）。`,
        hint: "请在 MCP 设置中切换为更完整的交付 profile，或手动把写入类工具加入 enabledTools。",
      };
    }
  }
  return null;
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
