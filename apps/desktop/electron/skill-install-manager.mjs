import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";

const INLINE_SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SOURCE_SIDECAR_FILE = ".ohmycrab-source.json";
const MAX_GITHUB_SKILL_FILES = 200;
const MAX_GITHUB_FILE_BYTES = 512 * 1024;
const MAX_GITHUB_TOTAL_BYTES = 5 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function trim(v) {
  return String(v ?? "").trim();
}

function toSafeSlug(v) {
  const raw = trim(v).toLowerCase();
  return raw.replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "item";
}

export function normalizeSkillRelativePath(raw) {
  const s = trim(raw).replace(/\\/g, "/");
  if (!s || s.startsWith("/") || s.includes("\0")) throw new Error("SKILL_FILE_PATH_INVALID");
  const norm = path.posix.normalize(s);
  if (!norm || norm === "." || norm.startsWith("../") || norm.includes("/../")) {
    throw new Error("SKILL_FILE_PATH_ESCAPE");
  }
  return norm;
}

function normalizeGithubSubdir(raw) {
  const s = trim(raw).replace(/\\/g, "/");
  if (!s || s === "." || s === "./") return "";
  if (s.startsWith("/") || s.includes("\0")) throw new Error("GITHUB_SUBDIR_INVALID");
  const norm = path.posix.normalize(s);
  if (!norm || norm === "." || norm.startsWith("../") || norm.includes("/../")) {
    throw new Error("GITHUB_SUBDIR_ESCAPE");
  }
  return norm.replace(/\/+$/g, "");
}

function extractFrontmatterName(skillMdContent, fallbackId) {
  const text = String(skillMdContent ?? "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m?.[1]) return fallbackId;
  try {
    const data = YAML.parse(m[1]);
    const name = trim(data?.name ?? "");
    return name || fallbackId;
  } catch {
    return fallbackId;
  }
}

function normalizeInstallableFiles(filesInput) {
  const entries = [];
  if (Array.isArray(filesInput)) {
    for (const item of filesInput) {
      if (!item || typeof item !== "object") continue;
      entries.push({
        path: normalizeSkillRelativePath(item.path),
        encoding: trim(item.encoding || "utf8").toLowerCase() === "base64" ? "base64" : "utf8",
        content: String(item.content ?? ""),
      });
    }
  } else if (filesInput && typeof filesInput === "object") {
    for (const [rawPath, rawContent] of Object.entries(filesInput)) {
      entries.push({
        path: normalizeSkillRelativePath(rawPath),
        encoding: "utf8",
        content: String(rawContent ?? ""),
      });
    }
  }
  if (!entries.length) throw new Error("SKILL_FILES_EMPTY");
  if (!entries.some((item) => item.path === "SKILL.md")) throw new Error("SKILL_MANIFEST_MISSING");
  return entries;
}

function buildSourceSidecar(provenance) {
  if (!provenance || typeof provenance !== "object") return null;
  if (trim(provenance.source) !== "github") return null;
  return {
    path: SOURCE_SIDECAR_FILE,
    encoding: "utf8",
    content: JSON.stringify(
      {
        source: "github",
        owner: trim(provenance.owner),
        repo: trim(provenance.repo),
        subdir: trim(provenance.subdir),
        requestedRef: trim(provenance.requestedRef) || null,
        resolvedRef: trim(provenance.resolvedRef) || null,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  };
}

async function writeInstallableFile(tmpDir, item) {
  const rel = normalizeSkillRelativePath(item.path);
  const abs = path.join(tmpDir, ...rel.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (String(item.encoding ?? "utf8") === "base64") {
    await fs.writeFile(abs, Buffer.from(String(item.content ?? ""), "base64"));
    return;
  }
  await fs.writeFile(abs, String(item.content ?? ""), "utf-8");
}

export async function installSkillBundle(args) {
  const rootDir = trim(args?.rootDir);
  const bundle = args?.bundle && typeof args.bundle === "object" ? args.bundle : null;
  if (!rootDir) throw new Error("SKILL_ROOT_DIR_REQUIRED");
  if (!bundle) throw new Error("SKILL_BUNDLE_REQUIRED");
  const skillId = trim(bundle.skillId);
  if (!skillId) throw new Error("SKILL_ID_REQUIRED");
  const files = normalizeInstallableFiles(bundle.files);
  const sourceSidecar = buildSourceSidecar(bundle.provenance);

  await fs.mkdir(rootDir, { recursive: true });
  const skillDirName = toSafeSlug(skillId);
  const targetDir = path.join(rootDir, skillDirName);
  const targetFile = path.join(targetDir, "SKILL.md");
  const tmpDir = path.join(rootDir, `.${skillDirName}.tmp-${Date.now()}`);
  const backupDir = path.join(rootDir, `.${skillDirName}.bak-${Date.now()}`);
  const replacedExisting = await exists(targetDir);
  let movedBackup = false;
  let movedTmp = false;
  try {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => void 0);
    await fs.mkdir(tmpDir, { recursive: true });
    for (const item of files) {
      await writeInstallableFile(tmpDir, item);
    }
    if (sourceSidecar) {
      await writeInstallableFile(tmpDir, sourceSidecar);
    }

    if (replacedExisting) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => void 0);
      await fs.rename(targetDir, backupDir);
      movedBackup = true;
    }

    await fs.rename(tmpDir, targetDir);
    movedTmp = true;
    if (typeof args?.reload === "function") {
      await args.reload();
    }
    if (movedBackup) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => void 0);
    }
    return {
      ok: true,
      skillId,
      skillDirName,
      dir: targetDir,
      path: targetFile,
      fileCount: files.length,
      replacedExisting,
      sourceMeta: bundle.provenance ?? null,
    };
  } catch (e) {
    if (!movedTmp) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => void 0);
    if (movedTmp) await fs.rm(targetDir, { recursive: true, force: true }).catch(() => void 0);
    if (movedBackup) await fs.rename(backupDir, targetDir).catch(() => void 0);
    throw e;
  }
}

export function normalizeMarketplaceSkillPayloadToBundle(manifest, payload) {
  const p = payload && typeof payload === "object" ? payload : null;
  if (!p || p.kind !== "skill") throw new Error("SKILL_PAYLOAD_INVALID");
  const files = normalizeInstallableFiles(p.files);
  const skillId = trim(p.skillId ?? manifest?.id);
  if (!skillId) throw new Error("SKILL_ID_REQUIRED");
  return { skillId, files };
}

function normalizeInlineSkillInstallPayload(payload) {
  const name = trim(payload?.name);
  const content = String(payload?.content ?? "").trim();
  if (!name) throw new Error("INVALID_NAME");
  if (!INLINE_SKILL_NAME_RE.test(name)) throw new Error("INVALID_NAME");
  if (!content) throw new Error("INVALID_CONTENT");
  return {
    skillId: name,
    files: [{ path: "SKILL.md", encoding: "utf8", content }],
    provenance: { source: "inline" },
  };
}

function buildGithubArchiveUrl(owner, repo, archiveRef) {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/${encodeURIComponent(archiveRef)}.tar.gz`;
}

async function downloadGithubArchive(args) {
  const owner = trim(args?.owner);
  const repo = trim(args?.repo);
  const archiveRef = trim(args?.archiveRef) || "HEAD";
  const url = buildGithubArchiveUrl(owner, repo, archiveRef);
  const res = await fetch(url, { headers: { "User-Agent": "OhMyCrab/skill-install" }, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`GITHUB_ARCHIVE_HTTP_${res.status}`);
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-skill-archive-"));
  const archivePath = path.join(tmpDir, "repo.tar.gz");
  await fs.writeFile(archivePath, Buffer.from(await res.arrayBuffer()));
  return {
    tmpDir,
    archivePath,
    finalUrl: String(res.url ?? ""),
  };
}

async function extractGithubArchive(args) {
  const archivePath = trim(args?.archivePath);
  const tmpDir = trim(args?.tmpDir);
  if (!archivePath || !tmpDir) throw new Error("GITHUB_ARCHIVE_MISSING");
  const extractDir = path.join(tmpDir, "extract");
  await fs.mkdir(extractDir, { recursive: true });
  await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir]);
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const rootEntry = entries.find((item) => item.isDirectory());
  if (!rootEntry) throw new Error("GITHUB_ARCHIVE_ROOT_MISSING");
  return path.join(extractDir, rootEntry.name);
}

async function walkLocalSkillDir(rootDir, currentDir, out) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkLocalSkillDir(rootDir, abs, out);
      continue;
    }
    if (!entry.isFile()) throw new Error(`GITHUB_SKILL_UNSUPPORTED_ENTRY:${entry.name}`);
    const relPath = normalizeSkillRelativePath(path.relative(rootDir, abs).replace(/\\/g, "/"));
    const stat = await fs.stat(abs);
    if (stat.size > MAX_GITHUB_FILE_BYTES) throw new Error(`GITHUB_SKILL_FILE_TOO_LARGE:${relPath}`);
    const content = await fs.readFile(abs);
    out.push({
      path: relPath,
      encoding: "base64",
      content: content.toString("base64"),
      size: stat.size,
    });
  }
}

function parseResolvedRefFromArchiveUrl(url) {
  const m = String(url ?? "").match(/\/tar\.gz\/([0-9a-f]{40})(?:$|[?#])/i);
  return m?.[1] ? m[1] : "";
}

async function collectGithubFiles(args) {
  const baseDir = normalizeGithubSubdir(args.subdir);
  const files = [];
  let totalBytes = 0;
  const archive = await downloadGithubArchive({
    owner: args.owner,
    repo: args.repo,
    archiveRef: args.archiveRef,
  });
  try {
    const archiveRoot = await extractGithubArchive(archive);
    const sourceRoot = baseDir ? path.join(archiveRoot, ...baseDir.split("/")) : archiveRoot;
    const stat = await fs.stat(sourceRoot).catch(() => null);
    if (!stat?.isDirectory()) throw new Error("GITHUB_SUBDIR_NOT_DIRECTORY");
    const discovered = [];
    await walkLocalSkillDir(sourceRoot, sourceRoot, discovered);
    for (const item of discovered) {
      totalBytes += Number(item.size ?? 0);
      if (totalBytes > MAX_GITHUB_TOTAL_BYTES) throw new Error("GITHUB_SKILL_TOTAL_TOO_LARGE");
      if (files.length >= MAX_GITHUB_SKILL_FILES) throw new Error("GITHUB_SKILL_TOO_MANY_FILES");
      files.push({
        path: item.path,
        encoding: "base64",
        content: item.content,
      });
    }
    return {
      files,
      resolvedRef: parseResolvedRefFromArchiveUrl(archive.finalUrl),
    };
  } finally {
    await fs.rm(archive.tmpDir, { recursive: true, force: true }).catch(() => void 0);
  }
}

export async function resolveGithubSkillBundle(payload) {
  const owner = trim(payload?.owner);
  const repo = trim(payload?.repo);
  const requestedRefRaw = trim(payload?.ref);
  if (!owner) throw new Error("GITHUB_OWNER_REQUIRED");
  if (!repo) throw new Error("GITHUB_REPO_REQUIRED");
  const subdir = normalizeGithubSubdir(payload?.subdir);
  const archiveRef = requestedRefRaw || "HEAD";
  const { files, resolvedRef: archiveResolvedRef } = await collectGithubFiles({
    owner,
    repo,
    archiveRef,
    subdir,
  });
  const skillMd = files.find((item) => item.path === "SKILL.md");
  if (!skillMd) throw new Error("SKILL_MANIFEST_MISSING");
  const skillMdText = Buffer.from(String(skillMd.content ?? ""), "base64").toString("utf-8");
  const fallbackId = trim(path.posix.basename(subdir || repo));
  const skillId = extractFrontmatterName(skillMdText, fallbackId) || fallbackId;
  const resolvedRef = trim(archiveResolvedRef || requestedRefRaw || archiveRef);

  return {
    skillId,
    files,
    provenance: {
      source: "github",
      owner,
      repo,
      subdir: subdir || ".",
      requestedRef: requestedRefRaw || null,
      resolvedRef,
    },
  };
}

export async function installSkillFromPayload(args) {
  const payload = args?.payload && typeof args.payload === "object" ? args.payload : null;
  if (!payload) throw new Error("SKILL_INSTALL_PAYLOAD_INVALID");
  const bundle =
    trim(payload.source).toLowerCase() === "github"
      ? await resolveGithubSkillBundle(payload)
      : normalizeInlineSkillInstallPayload(payload);
  return installSkillBundle({
    rootDir: args?.rootDir,
    bundle,
    reload: args?.reload,
  });
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
