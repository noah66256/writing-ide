export type WorkflowStickyValue = {
  v: 1;
  status?: string;
  routeId?: string;
  intentHint?: string;
  kind?: string;
  selectedServerIds: string[];
  preferredToolNames: string[];
  updatedAt: string;
  lastEndReason?: string;
};

const BROWSER_RE = /(playwright|browser|chrom(e|ium)|firefox|webkit)/i;
const STATEFUL_RE = /(playwright|browser|word|doc|excel|spreadsheet|workbook|pdf|ssh|terminal|app-server)/i;

function uniq(list: unknown[], max: number): string[] {
  return Array.from(new Set((Array.isArray(list) ? list : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))).slice(0, max);
}

export function isBrowserLikeMcpExecution(serverId: string, toolName: string): boolean {
  const raw = `${String(serverId ?? "")} ${String(toolName ?? "")}`;
  return BROWSER_RE.test(raw);
}

export function isStatefulMcpExecution(serverId: string, toolName: string): boolean {
  const raw = `${String(serverId ?? "")} ${String(toolName ?? "")}`;
  return STATEFUL_RE.test(raw);
}

export function mergeWorkflowStickyFromMcpSuccess(
  prevWorkflow: unknown,
  args: { serverId: string; toolName: string; nowIso?: string },
): WorkflowStickyValue {
  const prev = prevWorkflow && typeof prevWorkflow === "object" && !Array.isArray(prevWorkflow)
    ? (prevWorkflow as Record<string, unknown>)
    : {};
  const serverId = String(args.serverId ?? "").trim();
  const toolName = String(args.toolName ?? "").trim();
  const selectedServerIds = uniq([...(Array.isArray(prev.selectedServerIds) ? prev.selectedServerIds : []), serverId], 8);
  const preferredToolNames = uniq([...(Array.isArray(prev.preferredToolNames) ? prev.preferredToolNames : []), toolName], 16);
  const isBrowser = isBrowserLikeMcpExecution(serverId, toolName);
  const isStateful = isStatefulMcpExecution(serverId, toolName);

  return {
    ...prev,
    v: 1,
    status: "running",
    routeId: isBrowser ? "web_radar" : (String(prev.routeId ?? "").trim() || (isStateful ? "task_execution" : "")) || undefined,
    intentHint: String(prev.intentHint ?? "").trim() || "ops",
    kind: isBrowser ? "browser_session" : (String(prev.kind ?? "").trim() || (isStateful ? "task_workflow" : "")) || undefined,
    selectedServerIds,
    preferredToolNames,
    updatedAt: String(args.nowIso ?? new Date().toISOString()),
    ...(prev.lastEndReason ? { lastEndReason: String(prev.lastEndReason) } : {}),
  };
}
