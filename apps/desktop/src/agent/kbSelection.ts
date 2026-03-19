import type { KbLibrarySelectionError } from "../state/kbStore";
import type { MainDoc } from "../state/runStore";

type KbLibraryLike = {
  id: string;
  purpose?: string;
};

type ResolveImplicitStyleLibrarySelectionArgs = {
  preferredLibraryIds?: string[];
  mentionedLibraryIds?: string[];
  attachedLibraryIds?: string[];
  libraries?: KbLibraryLike[];
  mainDoc?: MainDoc | null | undefined;
  allowHistoricalFallback?: boolean;
};

type WorkflowSkillsLike = Record<string, { status?: string } | null | undefined>;
type ThreadLike = {
  waitingFor?: string;
  activeSkillRefs?: Array<{ id?: string }>;
  taskState?: {
    workflow?: { kind?: string; status?: string } | null;
  } | null;
};

export type ResolvedImplicitStyleLibrarySelection = {
  libraryIds: string[];
  error?: KbLibrarySelectionError;
  source: "explicit" | "mentioned" | "attached" | "main_doc" | "unique_style" | "none";
};

function normalizeIds(ids?: string[]) {
  return Array.from(new Set((Array.isArray(ids) ? ids : []).map((x) => String(x ?? "").trim()).filter(Boolean)));
}

const STYLE_SKILL_IDS = new Set(["style_imitate"]);

function mainDocStyleLibraryIds(mainDoc?: MainDoc | null, libraries?: KbLibraryLike[]) {
  const metaById = new Map((Array.isArray(libraries) ? libraries : []).map((lib) => [String(lib?.id ?? "").trim(), lib]));
  return normalizeIds([
    String((mainDoc as any)?.styleContractV1?.libraryId ?? "").trim(),
    String((mainDoc as any)?.stylePlanV1?.libraryId ?? "").trim(),
  ]).filter((id) => {
    const purpose = String(metaById.get(id)?.purpose ?? "").trim();
    return !purpose || purpose === "style";
  });
}

export function resolveImplicitStyleLibrarySelection(
  args?: ResolveImplicitStyleLibrarySelectionArgs,
): ResolvedImplicitStyleLibrarySelection {
  const preferredLibraryIds = normalizeIds(args?.preferredLibraryIds);
  if (preferredLibraryIds.length) {
    return { libraryIds: preferredLibraryIds, source: "explicit" };
  }

  const mentionedLibraryIds = normalizeIds(args?.mentionedLibraryIds);
  if (mentionedLibraryIds.length) {
    return { libraryIds: mentionedLibraryIds, source: "mentioned" };
  }

  const allowHistoricalFallback = args?.allowHistoricalFallback !== false;
  if (allowHistoricalFallback) {
    const attachedLibraryIds = normalizeIds(args?.attachedLibraryIds);
    if (attachedLibraryIds.length) {
      return { libraryIds: attachedLibraryIds, source: "attached" };
    }

    const fromMainDoc = mainDocStyleLibraryIds(args?.mainDoc, args?.libraries);
    if (fromMainDoc.length) {
      return { libraryIds: [fromMainDoc[0]], source: "main_doc" };
    }
  }

  const styleLibraryIds = normalizeIds(
    (Array.isArray(args?.libraries) ? args!.libraries : [])
      .filter((lib) => String(lib?.purpose ?? "").trim() === "style")
      .map((lib) => String(lib?.id ?? "").trim()),
  );
  if (styleLibraryIds.length === 1) {
    return { libraryIds: styleLibraryIds, source: "unique_style" };
  }
  if (styleLibraryIds.length > 1) {
    return { libraryIds: [], error: "STYLE_LIBRARY_AMBIGUOUS", source: "none" };
  }
  return { libraryIds: [], source: "none" };
}

export function resolveImplicitStyleLibraryIds(args?: ResolveImplicitStyleLibrarySelectionArgs): string[] {
  return resolveImplicitStyleLibrarySelection(args).libraryIds;
}

function normalizeStatus(v: unknown) {
  return String(v ?? "").trim().toLowerCase();
}

function hasStyleSkillSignal(activeSkillIds?: string[], thread?: ThreadLike | null) {
  const threadIds = normalizeIds((Array.isArray(thread?.activeSkillRefs) ? thread!.activeSkillRefs : []).map((item) => String(item?.id ?? "").trim()));
  const ids = normalizeIds([...(activeSkillIds ?? []), ...threadIds]);
  return ids.some((id) => STYLE_SKILL_IDS.has(id));
}

function hasMentionedStyleLibrary(args?: { mentionedLibraryIds?: string[]; libraries?: KbLibraryLike[] }) {
  const mentionedIds = normalizeIds(args?.mentionedLibraryIds);
  if (!mentionedIds.length) return false;
  const metaById = new Map((Array.isArray(args?.libraries) ? args!.libraries : []).map((lib) => [String(lib?.id ?? "").trim(), lib]));
  return mentionedIds.some((id) => String(metaById.get(id)?.purpose ?? "").trim() === "style");
}

function hasActiveStyleWorkflow(args?: { mainDoc?: MainDoc | null | undefined; workflowSkills?: WorkflowSkillsLike; thread?: ThreadLike | null }) {
  const threadWorkflow = args?.thread?.taskState?.workflow && typeof args.thread.taskState.workflow === "object"
    ? (args.thread.taskState.workflow as any)
    : null;
  const workflowKind = String(threadWorkflow?.kind ?? (args?.mainDoc as any)?.taskStateV2?.workflow?.kind ?? "").trim().toLowerCase();
  const waitingFor = String(args?.thread?.waitingFor ?? "").trim().toLowerCase();
  const workflowStatus = normalizeStatus(
    waitingFor === "user"
      ? "waiting_user"
      : waitingFor === "approval"
        ? "waiting_approval"
        : threadWorkflow?.status ?? (args?.mainDoc as any)?.taskStateV2?.workflow?.status,
  );
  if (/style_imitate/.test(workflowKind) && ["running", "waiting", "waiting_user", "clarify_waiting", "proposal_waiting"].includes(workflowStatus)) {
    return true;
  }
  const styleWorkflow = args?.workflowSkills?.["style_imitate.v1"];
  const styleWorkflowStatus = normalizeStatus(styleWorkflow?.status);
  return styleWorkflowStatus === "in_progress" || styleWorkflowStatus === "degraded";
}

export function isStyleWorkflowRequestedForRun(args?: {
  activeSkillIds?: string[];
  mentionedLibraryIds?: string[];
  libraries?: KbLibraryLike[];
  mainDoc?: MainDoc | null | undefined;
  workflowSkills?: WorkflowSkillsLike;
  thread?: ThreadLike | null;
}): boolean {
  return (
    hasStyleSkillSignal(args?.activeSkillIds, args?.thread) ||
    hasMentionedStyleLibrary({ mentionedLibraryIds: args?.mentionedLibraryIds, libraries: args?.libraries }) ||
    hasActiveStyleWorkflow({ mainDoc: args?.mainDoc, workflowSkills: args?.workflowSkills, thread: args?.thread })
  );
}

export function shouldAllowHistoricalStyleFallback(args?: {
  activeSkillIds?: string[];
  mentionedLibraryIds?: string[];
}): boolean {
  const activeSkillIds = normalizeIds(args?.activeSkillIds);
  const mentionedLibraryIds = normalizeIds(args?.mentionedLibraryIds);
  const explicitStyleSkillRequested = activeSkillIds.some((id) => STYLE_SKILL_IDS.has(id));
  if (explicitStyleSkillRequested && mentionedLibraryIds.length === 0) {
    return false;
  }
  return true;
}
