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
