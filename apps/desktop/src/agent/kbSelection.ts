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
};

type WorkflowSkillsLike = Record<string, { status?: string } | null | undefined>;

export type ResolvedImplicitStyleLibrarySelection = {
  libraryIds: string[];
  error?: KbLibrarySelectionError;
  source: "explicit" | "mentioned" | "attached" | "main_doc" | "unique_style" | "none";
};

function normalizeIds(ids?: string[]) {
  return Array.from(new Set((Array.isArray(ids) ? ids : []).map((x) => String(x ?? "").trim()).filter(Boolean)));
}

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

  const attachedLibraryIds = normalizeIds(args?.attachedLibraryIds);
  if (attachedLibraryIds.length) {
    return { libraryIds: attachedLibraryIds, source: "attached" };
  }

  const fromMainDoc = mainDocStyleLibraryIds(args?.mainDoc, args?.libraries);
  if (fromMainDoc.length) {
    return { libraryIds: [fromMainDoc[0]], source: "main_doc" };
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

function hasStyleSkillSignal(activeSkillIds?: string[]) {
  const ids = normalizeIds(activeSkillIds);
  return ids.some((id) => id === "style_imitate" || id === "style_imitate_v2" || id === "style_imitate_v3");
}

function hasMentionedStyleLibrary(args?: { mentionedLibraryIds?: string[]; libraries?: KbLibraryLike[] }) {
  const mentionedIds = normalizeIds(args?.mentionedLibraryIds);
  if (!mentionedIds.length) return false;
  const metaById = new Map((Array.isArray(args?.libraries) ? args!.libraries : []).map((lib) => [String(lib?.id ?? "").trim(), lib]));
  return mentionedIds.some((id) => String(metaById.get(id)?.purpose ?? "").trim() === "style");
}

function hasActiveStyleWorkflow(args?: { mainDoc?: MainDoc | null | undefined; workflowSkills?: WorkflowSkillsLike }) {
  const workflowKind = String((args?.mainDoc as any)?.workflowV1?.kind ?? "").trim().toLowerCase();
  const workflowStatus = normalizeStatus((args?.mainDoc as any)?.workflowV1?.status);
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
}): boolean {
  return (
    hasStyleSkillSignal(args?.activeSkillIds) ||
    hasMentionedStyleLibrary({ mentionedLibraryIds: args?.mentionedLibraryIds, libraries: args?.libraries }) ||
    hasActiveStyleWorkflow({ mainDoc: args?.mainDoc, workflowSkills: args?.workflowSkills })
  );
}
