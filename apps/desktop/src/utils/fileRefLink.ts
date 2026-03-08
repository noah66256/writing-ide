/**
 * 文件引用检测与链接化工具
 * 在 agent 文本消息中检测文件名引用，渲染为可点击链接。
 */

export const FILE_REF_SCHEME = "file-ref:";

const KNOWN_EXTS = new Set([
  "pptx", "docx", "xlsx", "pdf", "doc", "xls", "ppt", "key", "pages", "numbers",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico",
  "csv", "json", "yaml", "yml", "xml", "toml",
  "zip", "tar", "gz", "rar",
  "py", "js", "ts", "jsx", "tsx", "html", "css", "sh", "rb", "go", "rs",
  "md", "mdx", "txt", "log",
  "mp3", "mp4", "wav", "avi", "mov", "mkv",
]);

const FILE_PATH_BODY = String.raw`(?:[^\s\x60"'<>|?*:：，。！？；（）【】]+[\\/])*[^\s\x60"'<>|?*:\\/：，。！？；（）【】]+\.([A-Za-z][A-Za-z0-9]{0,9})`;

/**
 * Group 1: 前缀（空白/分隔符）
 * Group 2: 完整文件路径（支持相对路径与本地绝对路径）
 * Group 3: 扩展名
 */
const FILE_REF_RE = new RegExp(
  String.raw`(^|[\s(（\[【"'，：])((?:(?:[A-Za-z]:[\\/])|(?:\.{0,2}[\\/])|/)?${FILE_PATH_BODY})(?=$|[\s)）\]】}"'、，。！？；:,.!?;])`,
  "g",
);

export type FileRefMatch = {
  start: number;
  end: number;
  raw: string;
  normalized: string;
};

function isUrlLike(value: string): boolean {
  return /^[A-Za-z]+:\/\//.test(value);
}

export function isAbsoluteFileRefPath(value: string): boolean {
  const s = String(value ?? "").trim().replaceAll("\\", "/");
  return /^[A-Za-z]:\//.test(s) || s.startsWith("/");
}

export function normalizeFileRef(raw: string, opts?: { allowAbsolute?: boolean }): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  if (isUrlLike(s)) return null;

  const allowAbsolute = Boolean(opts?.allowAbsolute);
  const winAbs = /^[A-Za-z]:[\\/]/.test(s);
  const posixAbs = s.startsWith("/");
  if ((winAbs || posixAbs) && !allowAbsolute) return null;

  s = s.replaceAll("\\", "/").replace(/\/+/g, "/");

  let prefix = "";
  if (/^[A-Za-z]:\//.test(s)) {
    prefix = `${s.slice(0, 2).toUpperCase()}/`;
    s = s.slice(3);
  } else if (s.startsWith("/")) {
    prefix = "/";
    s = s.replace(/^\/+/, "");
  } else {
    s = s.replace(/^\.\/+/, "");
  }

  const out: string[] = [];
  for (const part of s.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    out.push(part);
  }
  if (!out.length) return null;

  const last = out[out.length - 1];
  const dotIdx = last.lastIndexOf(".");
  if (dotIdx <= 0) return null;
  const ext = last.slice(dotIdx + 1).toLowerCase();
  if (!KNOWN_EXTS.has(ext)) return null;

  return prefix ? `${prefix}${out.join("/")}` : out.join("/");
}

export function getFileRefMatches(text: string): FileRefMatch[] {
  const src = String(text ?? "");
  const out: FileRefMatch[] = [];
  const re = new RegExp(FILE_REF_RE.source, FILE_REF_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const prefix = m[1] ?? "";
    const raw = m[2] ?? "";
    const ext = (m[3] ?? "").toLowerCase();
    if (!KNOWN_EXTS.has(ext)) continue;
    const normalized = normalizeFileRef(raw, { allowAbsolute: true });
    if (!normalized) continue;
    const start = m.index + prefix.length;
    const end = start + raw.length;
    out.push({ start, end, raw, normalized });
  }
  return out;
}

export function resolveProjectAbsPath(rootDir: string, relPath: string): string {
  const sep = rootDir.includes("\\") ? "\\" : "/";
  const root = String(rootDir ?? "").replace(/[/\\]+$/, "");
  const rel = String(relPath ?? "").replaceAll("\\", "/").replace(/^\/+/, "").replace(/\//g, sep);
  return `${root}${sep}${rel}`;
}

export function resolveOpenableFileRef(rootDir: string | null | undefined, path: string): string | null {
  const normalized = normalizeFileRef(path, { allowAbsolute: true });
  if (!normalized) return null;
  if (isAbsoluteFileRefPath(normalized)) return normalized;
  if (!rootDir) return null;
  return resolveProjectAbsPath(rootDir, normalized);
}

export function toFileRefHref(path: string): string {
  return `${FILE_REF_SCHEME}${encodeURIComponent(path)}`;
}

export function parseFileRefHref(href: string | undefined): string | null {
  if (!href || !href.startsWith(FILE_REF_SCHEME)) return null;
  const encoded = href.slice(FILE_REF_SCHEME.length);
  if (!encoded) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return normalizeFileRef(decoded, { allowAbsolute: true });
}

const MD_LINK_OR_CODE_RE = /(```[\s\S]*?```|`[^`\n]+`|\[[^\]]*\]\([^)]*\))/g;

export function injectFileRefLinksInMarkdown(text: string): string {
  const src = String(text ?? "");
  return src
    .split(MD_LINK_OR_CODE_RE)
    .map((chunk) => {
      if (!chunk) return chunk;
      if (chunk.startsWith("```")) return chunk;
      if (chunk.startsWith("`") && chunk.endsWith("`")) {
        const inner = chunk.slice(1, -1).trim();
        const normalized = normalizeFileRef(inner, { allowAbsolute: true });
        if (normalized) return `[${inner}](${toFileRefHref(normalized)})`;
        return chunk;
      }
      if (/^\[.*\]\(.*\)$/.test(chunk)) return chunk;
      const re = new RegExp(FILE_REF_RE.source, FILE_REF_RE.flags);
      return chunk.replace(re, (full: string, prefix: string, rawPath: string, ext: string) => {
        if (!KNOWN_EXTS.has((ext ?? "").toLowerCase())) return full;
        const normalized = normalizeFileRef(rawPath, { allowAbsolute: true });
        if (!normalized) return full;
        return `${prefix}[${rawPath}](${toFileRefHref(normalized)})`;
      });
    })
    .join("");
}

export function wrapBareUrlsInMarkdown(text: string): string {
  const src = String(text ?? "");
  return src
    .split(MD_LINK_OR_CODE_RE)
    .map((chunk) => {
      if (!chunk) return chunk;
      if (chunk.startsWith("```")) return chunk;
      if (chunk.startsWith("`") && chunk.endsWith("`")) return chunk;
      if (/^\[.*\]\(.*\)$/.test(chunk)) return chunk;

      return chunk.replace(
        /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g,
        (url) => {
          const cleaned = url.replace(/[.,;:!?)}\]]+$/, "");
          if (!cleaned || cleaned.length <= 8) return url;
          return `[${cleaned}](${cleaned})`;
        },
      );
    })
    .join("");
}
