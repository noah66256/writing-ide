/**
 * 文件引用检测与链接化工具
 * 在 agent 文本消息中检测文件名引用，渲染为可点击链接。
 */

/** 自定义协议，用于 ReactMarkdown 的 <a> 组件识别文件链接 */
export const FILE_REF_SCHEME = "file-ref:";

/** 允许的文件扩展名（小写，不带点） */
const KNOWN_EXTS = new Set([
  // 办公文档
  "pptx", "docx", "xlsx", "pdf", "doc", "xls", "ppt", "key", "pages", "numbers",
  // 图片
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico",
  // 数据
  "csv", "json", "yaml", "yml", "xml", "toml",
  // 压缩
  "zip", "tar", "gz", "rar",
  // 代码 / 文本
  "py", "js", "ts", "jsx", "tsx", "html", "css", "sh", "rb", "go", "rs",
  "md", "mdx", "txt", "log",
  // 媒体
  "mp3", "mp4", "wav", "avi", "mov", "mkv",
]);

/**
 * 匹配文本中的文件名引用。
 * Group 1: 前缀（空白/分隔符），Group 2: 完整文件路径，Group 3: 路径前缀(./ 等)，Group 4: 扩展名
 * 文件名不含冒号（排除 URL scheme 如 https://）
 */
const FILE_REF_RE =
  /(^|[\s(（\[【"'"'，：])((\.{0,2}[\\/])?(?:[^\s`"'<>|?*:]+[\\/])*[^\s`"'<>|?*:\\/]+\.([A-Za-z][A-Za-z0-9]{0,9}))(?=$|[\s)）\]】}"'"'、，。！？；:,.!?;])/g;

export type FileRefMatch = {
  start: number;
  end: number;
  raw: string;
  normalized: string;
};

/** 规范化文件引用路径，返回 null 表示无效 */
export function normalizeFileRef(raw: string): string | null {
  let s = String(raw ?? "").trim().replaceAll("\\", "/");
  if (!s) return null;
  // 绝对路径 / URL scheme 不处理
  if (/^[A-Za-z]:[/\\]/.test(s) || s.startsWith("/")) return null;
  if (/^[A-Za-z]+:\/\//.test(s)) return null;
  s = s.replace(/^\.\/+/, "");
  s = s.replace(/\/+/g, "/");
  const out: string[] = [];
  for (const part of s.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null; // 禁止路径穿越
    out.push(part);
  }
  if (!out.length) return null;
  // 最后一段必须含有效扩展名
  const last = out[out.length - 1];
  const dotIdx = last.lastIndexOf(".");
  if (dotIdx <= 0) return null;
  const ext = last.slice(dotIdx + 1).toLowerCase();
  if (!KNOWN_EXTS.has(ext)) return null;
  return out.join("/");
}

/** 从文本中提取所有文件引用 */
export function getFileRefMatches(text: string): FileRefMatch[] {
  const src = String(text ?? "");
  const out: FileRefMatch[] = [];
  const re = new RegExp(FILE_REF_RE.source, FILE_REF_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const prefix = m[1] ?? "";
    const raw = m[2] ?? "";
    const ext = (m[4] ?? "").toLowerCase();
    if (!KNOWN_EXTS.has(ext)) continue;
    const normalized = normalizeFileRef(raw);
    if (!normalized) continue;
    const start = m.index + prefix.length;
    const end = start + raw.length;
    out.push({ start, end, raw, normalized });
  }
  return out;
}

/** 构造绝对路径 */
export function resolveProjectAbsPath(rootDir: string, relPath: string): string {
  const sep = rootDir.includes("\\") ? "\\" : "/";
  const root = String(rootDir ?? "").replace(/[/\\]+$/, "");
  const rel = String(relPath ?? "").replaceAll("\\", "/").replace(/^\/+/, "").replace(/\//g, sep);
  return `${root}${sep}${rel}`;
}

/** 编码为自定义协议 href */
export function toFileRefHref(relPath: string): string {
  return `${FILE_REF_SCHEME}${encodeURIComponent(relPath)}`;
}

/** 从 href 解码文件相对路径，强制二次校验防注入 */
export function parseFileRefHref(href: string | undefined): string | null {
  if (!href || !href.startsWith(FILE_REF_SCHEME)) return null;
  const encoded = href.slice(FILE_REF_SCHEME.length);
  if (!encoded) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); } catch { return null; }
  // 二次校验：防止手写 markdown 注入 ../secret.txt 等路径
  return normalizeFileRef(decoded);
}

/** 已有 markdown 链接语法的正则（用于跳过） */
const MD_LINK_OR_CODE_RE = /(```[\s\S]*?```|`[^`\n]+`|\[[^\]]*\]\([^)]*\))/g;

/** 在 markdown 文本中将文件引用转换为链接（供 ReactMarkdown 使用），跳过代码块、行内代码和已有链接 */
export function injectFileRefLinksInMarkdown(text: string): string {
  const src = String(text ?? "");
  return src
    .split(MD_LINK_OR_CODE_RE)
    .map((chunk) => {
      if (!chunk) return chunk;
      // 跳过代码块和已有链接；但 inline code 中的纯文件路径要转为链接
      if (chunk.startsWith("```")) return chunk;
      if (chunk.startsWith("`") && chunk.endsWith("`")) {
        const inner = chunk.slice(1, -1).trim();
        const normalized = normalizeFileRef(inner);
        if (normalized) return `[${inner}](${toFileRefHref(normalized)})`;
        return chunk;
      }
      if (/^\[.*\]\(.*\)$/.test(chunk)) return chunk;
      const re = new RegExp(FILE_REF_RE.source, FILE_REF_RE.flags);
      return chunk.replace(re, (full: string, prefix: string, rawPath: string, _pathPrefix: string, ext: string) => {
        if (!KNOWN_EXTS.has((ext ?? "").toLowerCase())) return full;
        const normalized = normalizeFileRef(rawPath);
        if (!normalized) return full;
        return `${prefix}[${rawPath}](${toFileRefHref(normalized)})`;
      });
    })
    .join("");
}

/**
 * 将裸 URL 转为 markdown 链接 `[url](url)`。
 * 解决 remark-gfm autolink 对 CJK 字符边界处理不当导致后续中文被吞入链接的问题。
 * URL 字符限定为 ASCII 可打印范围，自动排除 CJK 字符。
 * 必须在 injectFileRefLinksInMarkdown 之前调用。
 */
export function wrapBareUrlsInMarkdown(text: string): string {
  const src = String(text ?? "");
  return src
    .split(MD_LINK_OR_CODE_RE)
    .map((chunk) => {
      if (!chunk) return chunk;
      // 跳过代码块、行内代码、已有 markdown 链接
      if (chunk.startsWith("```")) return chunk;
      if (chunk.startsWith("`") && chunk.endsWith("`")) return chunk;
      if (/^\[.*\]\(.*\)$/.test(chunk)) return chunk;

      // 裸 URL → markdown 链接（URL 字符限定为 ASCII 范围，自然排除 CJK）
      return chunk.replace(
        /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g,
        (url) => {
          // 去掉末尾可能被误包含的 ASCII 标点（句号、逗号、分号等）
          const cleaned = url.replace(/[.,;:!?)}\]]+$/, "");
          if (!cleaned || cleaned.length <= 8) return url;
          return `[${cleaned}](${cleaned})`;
        },
      );
    })
    .join("");
}
