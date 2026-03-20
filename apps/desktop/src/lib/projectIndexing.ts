import type { ContextSegmentV1 } from "@ohmycrab/shared";

export type RawIndexedFile = {
  path: string;
  size: number;
  mtime: number;
  type: "text" | "binary" | "other";
};

export type IndexedFileV2 = {
  path: string;
  name: string;
  size: number;
  mtime: number;
  type: "text" | "binary" | "other";
  ext: string;
  depth: number;
  parentDir: string;
};

export type IndexedDirV2 = {
  path: string;
  name: string;
  depth: number;
  parentDir: string;
  fileCount: number;
  subdirCount: number;
  latestMtime: number;
  role: string | null;
};

export type ProjectIndexV2 = {
  version: 2;
  rootDir: string;
  updatedAt: number;
  files: IndexedFileV2[];
  dirs: IndexedDirV2[];
  stats: {
    totalFiles: number;
    totalDirs: number;
    extTop: Array<{ ext: string; count: number }>;
  };
};

export type ProjectPathMatch = {
  path: string;
  kind: "file" | "dir";
  score: number;
  reasons: string[];
  ext?: string;
  role?: string | null;
  parentDir?: string;
};

export type ProjectKind = "content" | "code" | "hybrid";

export type DirSummaryV1 = {
  path: string;
  parentDir: string;
  depth: number;
  role: string;
  summary: string;
  keyFiles: string[];
  fileCount: number;
  subdirCount: number;
  latestMtime: number;
  keywords: string[];
};

export type FileSummaryV1 = {
  path: string;
  dirPath: string;
  ext: string;
  kind: "doc" | "code" | "config" | "data" | "asset" | "output" | "other";
  role: string;
  title: string;
  summary: string;
  updatedAt: number;
  keywords: string[];
};

export type ProjectSummaryIndexesV1 = {
  version: 1;
  rootDir: string;
  updatedAt: number;
  projectKind: ProjectKind;
  dirs: DirSummaryV1[];
  files: FileSummaryV1[];
};

export type DirSummariesFileV1 = {
  version: 1;
  rootDir: string;
  updatedAt: number;
  projectKind: ProjectKind;
  dirs: DirSummaryV1[];
};

export type FileSummariesFileV1 = {
  version: 1;
  rootDir: string;
  updatedAt: number;
  projectKind: ProjectKind;
  files: FileSummaryV1[];
};

export type DirSummaryMatch = DirSummaryV1 & {
  score: number;
  reasons: string[];
};

export type FileSummaryMatch = FileSummaryV1 & {
  score: number;
  reasons: string[];
};

function normalizeRelPath(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function splitPath(pathValue: string): string[] {
  return normalizeRelPath(pathValue).split("/").filter(Boolean);
}

function getParentDir(pathValue: string): string {
  const parts = splitPath(pathValue);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function getBaseName(pathValue: string): string {
  const parts = splitPath(pathValue);
  return parts[parts.length - 1] ?? "";
}

function getDepth(pathValue: string): number {
  return splitPath(pathValue).length;
}

function getExt(pathValue: string): string {
  const m = getBaseName(pathValue).toLowerCase().match(/(\.[a-z0-9]{1,16})$/);
  return m ? m[1] : "(none)";
}

function inferDirRole(pathValue: string): string | null {
  const parts = splitPath(pathValue).map((part) => part.toLowerCase());
  const leaf = parts[parts.length - 1] ?? "";
  const top = parts[0] ?? "";
  const hit = leaf || top;
  if (!hit) return null;
  if (["apps", "app"].includes(hit)) return "applications";
  if (["packages", "package"].includes(hit)) return "packages";
  if (["docs", "doc"].includes(hit)) return "documentation";
  if (["specs", "research"].includes(hit)) return "knowledge";
  if (["src", "lib"].includes(hit)) return "source";
  if (["components", "pages", "ui"].includes(hit)) return "ui";
  if (["assets", "images", "public", "static"].includes(hit)) return "assets";
  if (["scripts", "bin"].includes(hit)) return "automation";
  if (["test", "tests", "__tests__", "spec"].includes(hit)) return "tests";
  if (["content", "materials", "input"].includes(hit)) return "content";
  if (["output", "dist", "build", ".next"].includes(hit)) return "output";
  if (["kb", "knowledge", "memory"].includes(hit)) return "knowledge";
  if (["config", ".github", ".vscode"].includes(hit)) return "config";
  return null;
}

function inferProjectKind(extTop: Array<{ ext: string; count: number }>): ProjectKind {
  const codeExts = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".mjs", ".cjs"]);
  const docExts = new Set([".md", ".mdx", ".txt", ".docx", ".csv", ".json", ".yaml", ".yml"]);
  let codeCount = 0;
  let docCount = 0;
  for (const item of extTop) {
    if (codeExts.has(item.ext)) codeCount += item.count;
    if (docExts.has(item.ext)) docCount += item.count;
  }
  if (codeCount > 0 && docCount > 0) return "hybrid";
  if (codeCount > 0) return "code";
  return "content";
}

function sortByPath<T extends { path: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => a.path.localeCompare(b.path));
}

function coerceProjectKind(raw: unknown): ProjectKind | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "content" || value === "code" || value === "hybrid") return value;
  return null;
}

function coerceStringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
}

export function buildProjectIndexV2(args: {
  rootDir: string;
  files: RawIndexedFile[];
  dirs?: string[] | null;
  updatedAt?: number | null;
}): ProjectIndexV2 {
  const rootDir = String(args.rootDir ?? "").trim();
  const files = Array.isArray(args.files) ? args.files : [];
  const dirSeed = Array.isArray(args.dirs) ? args.dirs : [];

  const normalizedFiles: IndexedFileV2[] = sortByPath(
    files
      .map((file) => {
        const path = normalizeRelPath(file?.path);
        if (!path) return null;
        return {
          path,
          name: getBaseName(path),
          size: Number.isFinite(Number(file?.size)) ? Math.max(0, Math.floor(Number(file.size))) : 0,
          mtime: Number.isFinite(Number(file?.mtime)) ? Math.max(0, Math.floor(Number(file.mtime))) : 0,
          type: file?.type === "text" || file?.type === "binary" ? file.type : "other",
          ext: getExt(path),
          depth: getDepth(path),
          parentDir: getParentDir(path),
        } satisfies IndexedFileV2;
      })
      .filter((item): item is IndexedFileV2 => Boolean(item)),
  );

  const dirSet = new Set<string>();
  for (const dir of dirSeed) {
    const normalized = normalizeRelPath(dir);
    if (normalized) dirSet.add(normalized);
  }
  for (const file of normalizedFiles) {
    let cursor = file.parentDir;
    while (cursor) {
      dirSet.add(cursor);
      cursor = getParentDir(cursor);
    }
  }

  const fileCountByDir = new Map<string, number>();
  const latestMtimeByDir = new Map<string, number>();
  const childDirsByDir = new Map<string, Set<string>>();
  const extCount = new Map<string, number>();

  for (const file of normalizedFiles) {
    extCount.set(file.ext, (extCount.get(file.ext) ?? 0) + 1);
    let cursor = file.parentDir;
    while (cursor) {
      fileCountByDir.set(cursor, (fileCountByDir.get(cursor) ?? 0) + 1);
      latestMtimeByDir.set(cursor, Math.max(latestMtimeByDir.get(cursor) ?? 0, file.mtime));
      cursor = getParentDir(cursor);
    }
  }

  for (const dir of dirSet) {
    const parentDir = getParentDir(dir);
    if (!parentDir) continue;
    const bucket = childDirsByDir.get(parentDir) ?? new Set<string>();
    bucket.add(dir);
    childDirsByDir.set(parentDir, bucket);
  }

  const dirs: IndexedDirV2[] = sortByPath(
    Array.from(dirSet).map((dir) => ({
      path: dir,
      name: getBaseName(dir),
      depth: getDepth(dir),
      parentDir: getParentDir(dir),
      fileCount: fileCountByDir.get(dir) ?? 0,
      subdirCount: childDirsByDir.get(dir)?.size ?? 0,
      latestMtime: latestMtimeByDir.get(dir) ?? 0,
      role: inferDirRole(dir),
    })),
  );

  const extTop = Array.from(extCount.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([ext, count]) => ({ ext, count }));

  return {
    version: 2,
    rootDir,
    updatedAt: Number.isFinite(Number(args.updatedAt)) ? Math.max(0, Math.floor(Number(args.updatedAt))) : Date.now(),
    files: normalizedFiles,
    dirs,
    stats: {
      totalFiles: normalizedFiles.length,
      totalDirs: dirs.length,
      extTop,
    },
  };
}

export function coerceProjectIndexV2(raw: unknown, expectedRootDir?: string | null): ProjectIndexV2 | null {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : null;
  if (!data) return null;
  const rootDir = String(expectedRootDir ?? data.rootDir ?? "").trim();
  if (!rootDir) return null;
  if (String(data.rootDir ?? "").trim() && String(data.rootDir ?? "").trim() !== rootDir) return null;

  const filesRaw = Array.isArray(data.files) ? data.files : [];
  const dirsRaw = Array.isArray(data.dirs)
    ? data.dirs.map((item: any) => (typeof item === "string" ? item : String(item?.path ?? ""))).filter(Boolean)
    : [];

  return buildProjectIndexV2({
    rootDir,
    files: filesRaw.map((item: any) => ({
      path: String(item?.path ?? ""),
      size: Number(item?.size ?? 0),
      mtime: Number(item?.mtime ?? 0),
      type: item?.type === "text" || item?.type === "binary" ? item.type : "other",
    })),
    dirs: dirsRaw,
    updatedAt: Number(data.updatedAt ?? Date.now()),
  });
}

export function coerceDirSummariesFileV1(raw: unknown, expectedRootDir?: string | null): DirSummariesFileV1 | null {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : null;
  if (!data) return null;
  const rootDir = String(expectedRootDir ?? data.rootDir ?? "").trim();
  if (!rootDir) return null;
  if (String(data.rootDir ?? "").trim() && String(data.rootDir ?? "").trim() !== rootDir) return null;
  const projectKind = coerceProjectKind(data.projectKind) ?? "content";
  const dirsRaw = Array.isArray(data.dirs) ? data.dirs : [];
  const dirs = sortByPath<DirSummaryV1>(
    dirsRaw
      .map((item: any) => {
        const path = normalizeRelPath(item?.path);
        if (!path) return null;
        const normalized: DirSummaryV1 = {
          path,
          parentDir: normalizeRelPath(item?.parentDir) || getParentDir(path),
          depth: Number.isFinite(Number(item?.depth)) ? Math.max(0, Math.floor(Number(item.depth))) : getDepth(path),
          role: String(item?.role ?? "").trim() || "folder",
          summary: String(item?.summary ?? "").trim(),
          keyFiles: coerceStringArray(item?.keyFiles).map((one) => normalizeRelPath(one)).filter(Boolean),
          fileCount: Number.isFinite(Number(item?.fileCount)) ? Math.max(0, Math.floor(Number(item.fileCount))) : 0,
          subdirCount: Number.isFinite(Number(item?.subdirCount)) ? Math.max(0, Math.floor(Number(item.subdirCount))) : 0,
          latestMtime: Number.isFinite(Number(item?.latestMtime)) ? Math.max(0, Math.floor(Number(item.latestMtime))) : 0,
          keywords: coerceStringArray(item?.keywords),
        };
        return normalized;
      })
      .filter((item: DirSummaryV1 | null): item is DirSummaryV1 => Boolean(item)),
  );
  return {
    version: 1,
    rootDir,
    updatedAt: Number.isFinite(Number(data.updatedAt)) ? Math.max(0, Math.floor(Number(data.updatedAt))) : 0,
    projectKind,
    dirs,
  };
}

export function coerceFileSummariesFileV1(raw: unknown, expectedRootDir?: string | null): FileSummariesFileV1 | null {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : null;
  if (!data) return null;
  const rootDir = String(expectedRootDir ?? data.rootDir ?? "").trim();
  if (!rootDir) return null;
  if (String(data.rootDir ?? "").trim() && String(data.rootDir ?? "").trim() !== rootDir) return null;
  const projectKind = coerceProjectKind(data.projectKind) ?? "content";
  const validKinds = new Set(["doc", "code", "config", "data", "asset", "output", "other"]);
  const filesRaw = Array.isArray(data.files) ? data.files : [];
  const files = sortByPath<FileSummaryV1>(
    filesRaw
      .map((item: any) => {
        const path = normalizeRelPath(item?.path);
        if (!path) return null;
        const kindRaw = String(item?.kind ?? "").trim();
        const kind = validKinds.has(kindRaw) ? (kindRaw as FileSummaryV1["kind"]) : "other";
        const normalized: FileSummaryV1 = {
          path,
          dirPath: normalizeRelPath(item?.dirPath) || getParentDir(path),
          ext: String(item?.ext ?? "").trim() || getExt(path),
          kind,
          role: String(item?.role ?? "").trim() || kind,
          title: String(item?.title ?? "").trim() || humanizeStem(getBaseName(path)) || getBaseName(path),
          summary: String(item?.summary ?? "").trim(),
          updatedAt: Number.isFinite(Number(item?.updatedAt)) ? Math.max(0, Math.floor(Number(item.updatedAt))) : 0,
          keywords: coerceStringArray(item?.keywords),
        };
        return normalized;
      })
      .filter((item: FileSummaryV1 | null): item is FileSummaryV1 => Boolean(item)),
  );
  return {
    version: 1,
    rootDir,
    updatedAt: Number.isFinite(Number(data.updatedAt)) ? Math.max(0, Math.floor(Number(data.updatedAt))) : 0,
    projectKind,
    files,
  };
}

function compactJsonWithinLimit<T extends Record<string, unknown>>(payload: T, maxChars: number, shrinkKeys?: string[]) {
  const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const shrinkList = shrinkKeys ?? ["recentFiles", "hotFiles", "hotDirs", "roleHints", "topDirs", "extTop"];
  let json = JSON.stringify(clone, null, 2);
  const fullLength = json.length;
  while (json.length > maxChars) {
    let shrunk = false;
    for (const key of shrinkList) {
      const arr = clone[key];
      if (Array.isArray(arr) && arr.length > 1) {
        arr.pop();
        shrunk = true;
        break;
      }
    }
    if (!shrunk) break;
    json = JSON.stringify(clone, null, 2);
  }
  return { content: json, truncated: fullLength > json.length };
}

export function buildProjectMapSegmentV2(args: {
  rootDir: string | null;
  index: ProjectIndexV2 | null;
}): ContextSegmentV1 | null {
  const rootDir = String(args.rootDir ?? "").trim();
  const index = args.index;
  if (!rootDir || !index || index.rootDir !== rootDir || !Array.isArray(index.files) || index.files.length === 0) return null;

  const rootName = rootDir.replace(/\\/g, "/").split("/").filter(Boolean).slice(-1)[0] || rootDir;
  const topDirs = index.dirs
    .filter((dir) => dir.depth === 1)
    .sort((a, b) => b.fileCount - a.fileCount || b.subdirCount - a.subdirCount || a.path.localeCompare(b.path))
    .slice(0, 8)
    .map((dir) => ({ path: dir.path, fileCount: dir.fileCount, subdirCount: dir.subdirCount, role: dir.role ?? undefined }));

  const hotDirs = index.dirs
    .filter((dir) => dir.depth <= 2)
    .sort((a, b) => b.latestMtime - a.latestMtime || b.fileCount - a.fileCount || a.path.localeCompare(b.path))
    .slice(0, 6)
    .map((dir) => ({ path: dir.path, latestMtime: dir.latestMtime || undefined, role: dir.role ?? undefined }));

  const rootAnchors = [
    /^README(\..+)?$/i,
    /^package\.json$/i,
    /^tsconfig\.json$/i,
    /^Cargo\.toml$/i,
    /^pyproject\.toml$/i,
    /^requirements\.txt$/i,
    /^go\.mod$/i,
    /^pom\.xml$/i,
    /^Dockerfile$/i,
    /^Makefile$/i,
    /^\.env\.example$/i,
    /^\.env\.sample$/i,
  ];
  const anchorHits = index.files
    .filter((file) => file.depth === 1 && rootAnchors.some((re) => re.test(file.name)))
    .slice(0, 10)
    .map((file) => ({ path: file.path, reason: "root_anchor" }));

  const entryPatterns = [
    /(^|\/)src\/(index|main)\.[a-z0-9]+$/i,
    /(^|\/)(app|server|cli)\.[a-z0-9]+$/i,
    /(^|\/)electron\/main\.[a-z0-9]+$/i,
  ];
  const entryHits = index.files
    .filter((file) => entryPatterns.some((re) => re.test(file.path)))
    .slice(0, 10)
    .map((file) => ({ path: file.path, reason: "entry_pattern" }));

  const recentFiles = [...index.files]
    .filter((file) => file.mtime > 0)
    .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
    .slice(0, 6)
    .map((file) => ({ path: file.path, mtime: file.mtime }));

  const hotFileMap = new Map<string, { path: string; reason: string }>();
  for (const item of [...anchorHits, ...entryHits, ...recentFiles.map((file) => ({ path: file.path, reason: "recent_mtime" }))]) {
    if (!hotFileMap.has(item.path)) hotFileMap.set(item.path, item);
    if (hotFileMap.size >= 10) break;
  }

  const roleHints = topDirs
    .filter((dir) => typeof dir.role === "string" && dir.role)
    .slice(0, 8)
    .map((dir) => ({ path: dir.path, role: dir.role }));

  const payload = {
    v: 2,
    project: {
      rootName,
      totalFiles: index.stats.totalFiles,
      totalDirs: index.stats.totalDirs,
      projectKind: inferProjectKind(index.stats.extTop),
      updatedAt: index.updatedAt,
    },
    topDirs,
    hotDirs,
    hotFiles: Array.from(hotFileMap.values()),
    recentFiles,
    extTop: index.stats.extTop.slice(0, 6),
    roleHints,
  };

  const compact = compactJsonWithinLimit(payload, 1200);
  return {
    id: "PROJECT_MAP_V2",
    name: "PROJECT_MAP_V2",
    kind: "taskState",
    priority: "p3",
    trusted: true,
    format: "JSON",
    content: compact.content,
    meta: { source: "desktop", truncated: compact.truncated },
  } satisfies ContextSegmentV1;
}

function simplifyForSubsequence(input: string): string {
  return String(input ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return false;
  let i = 0;
  for (const ch of haystack) {
    if (needle[i] === ch) i += 1;
    if (i >= needle.length) return true;
  }
  return i >= needle.length;
}

function humanizeStem(raw: string): string {
  const stem = String(raw ?? "").trim().replace(/\.[^.]+$/g, "");
  if (!stem) return "";
  const normalized = stem
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

function tokenizeHumanText(raw: string): string[] {
  const lower = String(raw ?? "").toLowerCase().trim();
  if (!lower) return [];
  return lower
    .split(/[^a-z0-9\u4e00-\u9fa5]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function uniqueTokens(tokens: string[]): string[] {
  return Array.from(new Set(tokens.map((token) => String(token ?? "").trim()).filter(Boolean)));
}

function extractSearchTokens(raw: string): string[] {
  const text = String(raw ?? "").toLowerCase().trim();
  if (!text) return [];
  const stop = new Set([
    "帮我",
    "一下",
    "这个",
    "那个",
    "哪个",
    "哪里",
    "在哪",
    "怎么",
    "什么",
    "看看",
    "给我",
    "当前",
    "项目",
    "目录",
    "文件",
  ]);
  const out: string[] = [];
  const parts = text.match(/[a-z0-9_.-]+|[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const part of parts) {
    const token = String(part ?? "").trim();
    if (!token) continue;
    if (/^[a-z0-9_.-]+$/.test(token)) {
      if (token.length >= 2) out.push(token);
      continue;
    }
    if (token.length <= 4) {
      out.push(token);
      continue;
    }
    out.push(token);
    for (let win = 2; win <= 4; win += 1) {
      for (let i = 0; i + win <= token.length; i += 1) {
        out.push(token.slice(i, i + win));
      }
    }
  }
  return uniqueTokens(out.filter((token) => token.length >= 2 && !stop.has(token))).slice(0, 24);
}

function inferFileKind(file: IndexedFileV2): FileSummaryV1["kind"] {
  const ext = file.ext;
  const pathLower = file.path.toLowerCase();
  if ([".md", ".mdx", ".txt", ".docx"].includes(ext)) return "doc";
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".mjs", ".cjs", ".jsonl"].includes(ext)) return "code";
  if ([".json", ".yaml", ".yml", ".toml", ".ini", ".env", "(none)"].includes(ext)) return pathLower.includes("/output/") ? "output" : "config";
  if ([".csv", ".tsv", ".xlsx", ".xls", ".parquet"].includes(ext)) return "data";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf", ".mp3", ".mp4", ".mov"].includes(ext)) return "asset";
  if (/(^|\/)(dist|build|out|output|coverage|\.next)(\/|$)/i.test(pathLower)) return "output";
  return "other";
}

function inferFileRole(file: IndexedFileV2): string {
  const pathLower = file.path.toLowerCase();
  const base = file.name.toLowerCase();
  if (/^readme(\..+)?$/i.test(base)) return "readme";
  if (/^skill\.md$/i.test(base)) return "skill";
  if (/(^|\/)docs\/specs\//i.test(pathLower)) return "spec";
  if (/(^|\/)docs\/research\//i.test(pathLower)) return "research";
  if (/(^|\/)(draft|drafts)\//i.test(pathLower) || /\bdraft\b/i.test(base)) return "draft";
  if (/(直播|口播|话术|脚本|直播稿)/i.test(file.path)) return "live-script";
  if (/(style|风格|imitate|仿写)/i.test(file.path)) return "style-guide";
  if (/package\.json$|tsconfig\.json$|pyproject\.toml$|cargo\.toml$|go\.mod$/i.test(base)) return "manifest";
  if (/(^|\/)(src\/)?(index|main)\.[a-z0-9]+$/i.test(pathLower) || /(^|\/)(app|server|cli)\.[a-z0-9]+$/i.test(pathLower)) return "entry";
  if (/component|ui|widget/i.test(pathLower)) return "component";
  if (/service|store|model|runtime|agent/i.test(pathLower)) return "service";
  if (/test|spec\./i.test(pathLower)) return "test";
  if (/config|\.env|settings|vite\.config|electron-builder/i.test(pathLower)) return "config";
  if (/output|dist|build|generated/i.test(pathLower)) return "output";
  if (/kb|memory|knowledge/i.test(pathLower)) return "knowledge";
  return inferFileKind(file);
}

function rolePriority(role: string): number {
  switch (role) {
    case "entry": return 100;
    case "readme": return 96;
    case "spec": return 94;
    case "research": return 92;
    case "live-script": return 90;
    case "draft": return 88;
    case "style-guide": return 86;
    case "manifest": return 84;
    case "skill": return 82;
    case "service": return 80;
    case "component": return 78;
    case "config": return 76;
    default: return 50;
  }
}

function inferDirRoleFromChildren(args: {
  dir: IndexedDirV2;
  directFiles: IndexedFileV2[];
  childDirs: IndexedDirV2[];
}): string {
  if (args.dir.role) return args.dir.role;
  const directFiles = Array.isArray(args.directFiles) ? args.directFiles : [];
  const childDirs = Array.isArray(args.childDirs) ? args.childDirs : [];
  const pathLower = args.dir.path.toLowerCase();
  if (/(^|\/)(draft|drafts)(\/|$)/i.test(pathLower)) return "content";
  if (/(^|\/)(docs|doc)(\/|$)/i.test(pathLower)) return "documentation";
  const docCount = directFiles.filter((file) => inferFileKind(file) === "doc").length;
  const codeCount = directFiles.filter((file) => inferFileKind(file) === "code").length;
  const configCount = directFiles.filter((file) => inferFileKind(file) === "config").length;
  const roles = directFiles.map((file) => inferFileRole(file));
  if (roles.some((role) => role === "spec" || role === "research")) return "knowledge";
  if (roles.some((role) => role === "live-script" || role === "draft")) return "content";
  if (roles.some((role) => role === "style-guide")) return "knowledge";
  if (docCount > 0 && docCount >= codeCount) return childDirs.length > 0 ? "documentation" : "content";
  if (codeCount > 0 && codeCount >= docCount) return "source";
  if (configCount > 0) return "config";
  return "folder";
}

function describeDirRole(role: string): string {
  switch (role) {
    case "applications": return "应用目录，通常承载独立端或服务。";
    case "packages": return "公共包目录，通常存放共享能力或基础模块。";
    case "documentation": return "文档目录，通常存放说明、指南或产品文档。";
    case "knowledge": return "知识/规范目录，通常存放 specs、research、style 或 memory 材料。";
    case "source": return "源码目录，通常存放实现代码或业务逻辑。";
    case "ui": return "界面目录，通常存放组件、页面或布局。";
    case "assets": return "素材目录，通常存放图片、媒体或静态资源。";
    case "automation": return "自动化目录，通常存放脚本、命令或辅助流程。";
    case "tests": return "测试目录，通常存放测试代码或样例。";
    case "content": return "内容目录，通常存放稿件、素材、参考文案或输入输出文件。";
    case "output": return "输出目录，通常存放构建产物或生成结果。";
    case "config": return "配置目录，通常存放配置、环境或工程设置。";
    default: return "目录导航摘要，用于先判断这一层大致负责什么。";
  }
}

function describeFileRole(kind: FileSummaryV1["kind"], role: string, dirPath: string): string {
  switch (role) {
    case "readme": return "说明文档，通常用于介绍目录/项目用途与使用方式。";
    case "skill": return "Skill 说明文件，通常描述触发条件、工作流和可用资源。";
    case "spec": return "规格文档，通常描述功能目标、约束、方案与验收口径。";
    case "research": return "调研文档，通常记录外部对照组、方案比较和结论。";
    case "draft": return "写作草稿，通常用于继续改写、润色或扩写。";
    case "live-script": return "直播/口播相关文档，通常用于直播稿、话术或脚本创作。";
    case "style-guide": return "风格/仿写相关文档，通常用于风格库、规则卡或写法模板。";
    case "manifest": return "工程清单/配置入口文件，通常用于声明依赖、脚本或工程设置。";
    case "entry": return "入口文件，通常是应用、服务或运行时的起点。";
    case "component": return "界面/组件文件，通常负责局部 UI 或交互。";
    case "service": return "服务/运行时文件，通常负责状态、流程或业务逻辑。";
    case "test": return "测试文件，通常用于校验功能或回归行为。";
    case "config": return "配置文件，通常用于环境、构建或运行参数。";
    case "knowledge": return "知识/记忆相关文件，通常用于规则、记忆或知识材料。";
    case "output": return "输出结果文件，通常由流程生成。";
    default:
      switch (kind) {
        case "doc": return `文档文件，位于 ${dirPath || "项目根目录"}。`;
        case "code": return `代码文件，位于 ${dirPath || "项目根目录"}。`;
        case "config": return `配置文件，位于 ${dirPath || "项目根目录"}。`;
        case "data": return `数据文件，位于 ${dirPath || "项目根目录"}。`;
        case "asset": return `素材文件，位于 ${dirPath || "项目根目录"}。`;
        case "output": return `输出文件，位于 ${dirPath || "项目根目录"}。`;
        default: return `项目文件，位于 ${dirPath || "项目根目录"}。`;
      }
  }
}

function buildFileKeywords(file: IndexedFileV2, role: string, title: string): string[] {
  const tokens = [
    ...splitPath(file.path),
    role,
    file.ext,
    title,
    ...tokenizeHumanText(title),
    ...tokenizeHumanText(file.name),
  ];
  return uniqueTokens(tokens);
}

function summarizeFile(file: IndexedFileV2): FileSummaryV1 {
  const kind = inferFileKind(file);
  const role = inferFileRole(file);
  const title = humanizeStem(file.name) || file.name;
  const summary = describeFileRole(kind, role, file.parentDir);
  return {
    path: file.path,
    dirPath: file.parentDir,
    ext: file.ext,
    kind,
    role,
    title,
    summary,
    updatedAt: file.mtime,
    keywords: buildFileKeywords(file, role, title),
  };
}

export function buildProjectSummaryIndexesV1(args: {
  index: ProjectIndexV2 | null;
}): ProjectSummaryIndexesV1 | null {
  const index = args.index;
  if (!index) return null;
  const projectKind = inferProjectKind(index.stats.extTop);
  const fileSummaries = sortByPath(index.files.map((file) => summarizeFile(file)));
  const fileSummaryByPath = new Map(fileSummaries.map((item) => [item.path, item] as const));
  const filesByDir = new Map<string, IndexedFileV2[]>();
  for (const file of index.files) {
    const bucket = filesByDir.get(file.parentDir) ?? [];
    bucket.push(file);
    filesByDir.set(file.parentDir, bucket);
  }
  const childDirsByDir = new Map<string, IndexedDirV2[]>();
  for (const dir of index.dirs) {
    const bucket = childDirsByDir.get(dir.parentDir) ?? [];
    bucket.push(dir);
    childDirsByDir.set(dir.parentDir, bucket);
  }

  const dirSummaries = sortByPath(
    index.dirs.map((dir) => {
      const directFiles = [...(filesByDir.get(dir.path) ?? [])]
        .sort((a, b) => {
          const roleDelta = rolePriority(inferFileRole(b)) - rolePriority(inferFileRole(a));
          if (roleDelta !== 0) return roleDelta;
          const mtimeDelta = b.mtime - a.mtime;
          if (mtimeDelta !== 0) return mtimeDelta;
          return a.path.localeCompare(b.path);
        });
      const childDirs = childDirsByDir.get(dir.path) ?? [];
      const role = inferDirRoleFromChildren({ dir, directFiles, childDirs });
      const keyFiles = directFiles.slice(0, 5).map((file) => file.path);
      const keyFileRoles = keyFiles
        .map((path) => fileSummaryByPath.get(path)?.role ?? "")
        .filter(Boolean)
        .slice(0, 3);
      const keyFileLabel = keyFiles.length
        ? `关键文件：${keyFiles.map((path) => getBaseName(path)).join("、")}。`
        : "";
      const summary = [
        describeDirRole(role),
        `包含 ${dir.fileCount} 个文件${dir.subdirCount > 0 ? `、${dir.subdirCount} 个子目录` : ""}。`,
        keyFileRoles.length ? `常见文件角色：${uniqueTokens(keyFileRoles).join("、")}。` : "",
        keyFileLabel,
      ].filter(Boolean).join(" ");
      const keywords = uniqueTokens([
        ...splitPath(dir.path),
        role,
        ...keyFiles.flatMap((path) => tokenizeHumanText(path)),
        ...keyFileRoles,
      ]);
      return {
        path: dir.path,
        parentDir: dir.parentDir,
        depth: dir.depth,
        role,
        summary,
        keyFiles,
        fileCount: dir.fileCount,
        subdirCount: dir.subdirCount,
        latestMtime: dir.latestMtime,
        keywords,
      } satisfies DirSummaryV1;
    }),
  );

  return {
    version: 1,
    rootDir: index.rootDir,
    updatedAt: index.updatedAt,
    projectKind,
    dirs: dirSummaries,
    files: fileSummaries,
  };
}

function computeKeywordScore(args: {
  query: string;
  path: string;
  title?: string;
  role?: string | null;
  summary?: string;
  keywords?: string[];
  extraTexts?: string[];
  kind: "file" | "dir";
  depth: number;
}): { score: number; reasons: string[] } | null {
  const pathScore = computePathScore(args.query, {
    path: args.path,
    name: getBaseName(args.path),
    depth: args.depth,
  }, args.kind);
  const queryLower = String(args.query ?? "").trim().toLowerCase();
  const tokens = extractSearchTokens(args.query);
  const texts = [
    String(args.title ?? ""),
    String(args.role ?? ""),
    String(args.summary ?? ""),
    ...(Array.isArray(args.keywords) ? args.keywords : []),
    ...(Array.isArray(args.extraTexts) ? args.extraTexts : []),
  ]
    .filter(Boolean)
    .map((item) => String(item).toLowerCase());
  const joined = texts.join("\n");
  let score = pathScore?.score ?? 0;
  const reasons = new Set<string>(pathScore?.reasons ?? []);

  if (args.role && String(args.role).toLowerCase() === queryLower) {
    score += 260;
    reasons.add("role_exact");
  } else if (args.role && String(args.role).toLowerCase().includes(queryLower) && queryLower) {
    score += 180;
    reasons.add("role_contains");
  }

  if (args.title && String(args.title).toLowerCase().includes(queryLower) && queryLower) {
    score += 220;
    reasons.add("title_contains");
  }

  let matchedTokens = 0;
  for (const token of tokens) {
    let matched = false;
    for (const text of texts) {
      if (text.includes(token)) {
        matched = true;
        break;
      }
    }
    if (matched) {
      matchedTokens += 1;
      score += 90;
    }
  }
  if (tokens.length > 1 && matchedTokens === tokens.length) {
    score += 140;
    reasons.add("all_tokens");
  }

  const querySimple = simplifyForSubsequence(queryLower);
  const joinedSimple = simplifyForSubsequence(joined);
  if (querySimple && joinedSimple && isSubsequence(querySimple, joinedSimple)) {
    score += 110;
    reasons.add("summary_subsequence");
  }
  if (score <= 0) return null;
  return { score, reasons: Array.from(reasons) };
}

export function searchDirSummaries(args: {
  summaries: ProjectSummaryIndexesV1 | null;
  query: string;
  maxResults?: number;
}): { query: string; matches: DirSummaryMatch[] } {
  const summaries = args.summaries;
  const query = String(args.query ?? "").trim();
  const maxResults = Number.isFinite(Number(args.maxResults)) ? Math.max(1, Math.min(20, Math.floor(Number(args.maxResults)))) : 8;
  if (!summaries || !query) return { query, matches: [] };
  const matches = summaries.dirs
    .map((dir) => {
      const scored = computeKeywordScore({
        query,
        path: dir.path,
        role: dir.role,
        summary: dir.summary,
        keywords: dir.keywords,
        extraTexts: dir.keyFiles,
        kind: "dir",
        depth: dir.depth,
      });
      if (!scored || scored.score < 140) return null;
      return { ...dir, score: scored.score, reasons: scored.reasons } satisfies DirSummaryMatch;
    })
    .filter((item): item is DirSummaryMatch => Boolean(item))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxResults);
  return { query, matches };
}

export function searchFileSummaries(args: {
  summaries: ProjectSummaryIndexesV1 | null;
  query: string;
  maxResults?: number;
}): { query: string; matches: FileSummaryMatch[] } {
  const summaries = args.summaries;
  const query = String(args.query ?? "").trim();
  const maxResults = Number.isFinite(Number(args.maxResults)) ? Math.max(1, Math.min(20, Math.floor(Number(args.maxResults)))) : 8;
  if (!summaries || !query) return { query, matches: [] };
  const matches = summaries.files
    .map((file) => {
      const scored = computeKeywordScore({
        query,
        path: file.path,
        title: file.title,
        role: file.role,
        summary: file.summary,
        keywords: file.keywords,
        kind: "file",
        depth: getDepth(file.path),
      });
      if (!scored || scored.score < 140) return null;
      return { ...file, score: scored.score, reasons: scored.reasons } satisfies FileSummaryMatch;
    })
    .filter((item): item is FileSummaryMatch => Boolean(item))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxResults);
  return { query, matches };
}

export function buildProjectSummarySegmentsV1(args: {
  rootDir: string | null;
  summaries: ProjectSummaryIndexesV1 | null;
  userPrompt: string;
}): ContextSegmentV1[] {
  const rootDir = String(args.rootDir ?? "").trim();
  const summaries = args.summaries;
  const userPrompt = String(args.userPrompt ?? "").trim();
  if (!rootDir || !summaries || summaries.rootDir !== rootDir || !userPrompt) return [];

  const dirMatches = searchDirSummaries({ summaries, query: userPrompt, maxResults: 2 }).matches;
  const fileMatches = searchFileSummaries({ summaries, query: userPrompt, maxResults: 2 }).matches;
  const out: ContextSegmentV1[] = [];

  if (dirMatches.length > 0 && dirMatches[0].score >= 180) {
    const payload = {
      query: userPrompt,
      matches: dirMatches.map((item) => ({
        path: item.path,
        role: item.role,
        summary: item.summary,
        keyFiles: item.keyFiles.slice(0, 3),
        score: item.score,
      })),
    };
    const compact = compactJsonWithinLimit(payload, 1000, ["matches"]);
    out.push({
      id: "DIR_SUMMARY",
      name: "DIR_SUMMARY",
      kind: "taskState",
      priority: "p3",
      trusted: true,
      format: "JSON",
      content: compact.content,
      meta: { source: "desktop", truncated: compact.truncated },
    });
  }

  if (fileMatches.length > 0 && fileMatches[0].score >= 180) {
    const payload = {
      query: userPrompt,
      matches: fileMatches.map((item) => ({
        path: item.path,
        role: item.role,
        title: item.title,
        summary: item.summary,
        score: item.score,
      })),
    };
    const compact = compactJsonWithinLimit(payload, 1000, ["matches"]);
    out.push({
      id: "FILE_SUMMARY",
      name: "FILE_SUMMARY",
      kind: "taskState",
      priority: "p3",
      trusted: true,
      format: "JSON",
      content: compact.content,
      meta: { source: "desktop", truncated: compact.truncated },
    });
  }

  return out;
}

function computePathScore(query: string, item: { path: string; name: string; depth: number }, kind: "file" | "dir") {
  const q = normalizeRelPath(query).toLowerCase();
  if (!q) return null;

  const path = item.path.toLowerCase();
  const base = item.name.toLowerCase();
  const tokens = q.split(/[\s/._-]+/g).filter(Boolean);
  let score = 0;
  const reasons: string[] = [];

  if (path === q) {
    score += 1000;
    reasons.push("path_exact");
  }
  if (base === q) {
    score += 920;
    reasons.push("basename_exact");
  }
  if (path.startsWith(q)) {
    score += 780;
    reasons.push("path_prefix");
  }
  if (base.startsWith(q)) {
    score += 720;
    reasons.push("basename_prefix");
  }
  if (path.includes(q)) {
    score += 560;
    reasons.push("path_contains");
  }
  if (base.includes(q)) {
    score += 600;
    reasons.push("basename_contains");
  }

  let matchedTokens = 0;
  for (const token of tokens) {
    if (base.includes(token)) {
      matchedTokens += 1;
      score += 120;
    } else if (path.includes(token)) {
      matchedTokens += 1;
      score += 80;
    }
  }
  if (tokens.length > 1 && matchedTokens === tokens.length) reasons.push("all_tokens");

  const qSimple = simplifyForSubsequence(q);
  const baseSimple = simplifyForSubsequence(base);
  const pathSimple = simplifyForSubsequence(path);
  if (qSimple && isSubsequence(qSimple, baseSimple)) {
    score += 280;
    reasons.push("basename_subsequence");
  } else if (qSimple && isSubsequence(qSimple, pathSimple)) {
    score += 220;
    reasons.push("path_subsequence");
  }

  if (score <= 0) return null;
  score += kind === "file" ? 10 : 0;
  score -= Math.min(80, item.depth * 8);
  score -= Math.min(40, Math.floor(item.path.length / 24));
  return { score, reasons: Array.from(new Set(reasons)) };
}

export function searchProjectPaths(args: {
  index: ProjectIndexV2 | null;
  query: string;
  kind?: "all" | "file" | "dir";
  maxResults?: number;
}): { query: string; matches: ProjectPathMatch[] } {
  const index = args.index;
  const query = String(args.query ?? "").trim();
  const kind = args.kind === "file" || args.kind === "dir" ? args.kind : "all";
  const maxResults = Number.isFinite(Number(args.maxResults)) ? Math.max(1, Math.min(50, Math.floor(Number(args.maxResults)))) : 12;
  if (!index || !query) return { query, matches: [] };

  const matches: ProjectPathMatch[] = [];
  if (kind === "all" || kind === "file") {
    for (const file of index.files) {
      const scored = computePathScore(query, { path: file.path, name: file.name, depth: file.depth }, "file");
      if (!scored) continue;
      matches.push({
        path: file.path,
        kind: "file",
        score: scored.score,
        reasons: scored.reasons,
        ext: file.ext,
        parentDir: file.parentDir || undefined,
      });
    }
  }
  if (kind === "all" || kind === "dir") {
    for (const dir of index.dirs) {
      const scored = computePathScore(query, { path: dir.path, name: dir.name, depth: dir.depth }, "dir");
      if (!scored) continue;
      matches.push({
        path: dir.path,
        kind: "dir",
        score: scored.score,
        reasons: scored.reasons,
        role: dir.role,
        parentDir: dir.parentDir || undefined,
      });
    }
  }

  return {
    query,
    matches: matches
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, maxResults),
  };
}
