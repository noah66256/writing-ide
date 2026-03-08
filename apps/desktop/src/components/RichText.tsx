import { Fragment, useCallback, type ReactElement } from "react";
import { useProjectStore } from "../state/projectStore";
import { getFileRefMatches, resolveOpenableFileRef } from "../utils/fileRefLink";

type InlineOptions = {
  onOpenFileRef?: (path: string, raw: string) => void;
};

/** 将纯文本中的文件引用渲染为可点击 span */
function renderFileRefs(
  text: string,
  keyPrefix: string,
  opts?: InlineOptions,
): Array<string | ReactElement> {
  const src = String(text ?? "");
  if (!src || !opts?.onOpenFileRef) return [src];
  const matches = getFileRefMatches(src);
  if (!matches.length) return [src];

  const out: Array<string | ReactElement> = [];
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (m.start > cursor) out.push(src.slice(cursor, m.start));
    const normalized = m.normalized;
    out.push(
      <span
        key={`${keyPrefix}-fr-${i}`}
        className="rtFileRef"
        role="button"
        tabIndex={0}
        title={`打开文件：${m.raw}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); opts.onOpenFileRef?.(normalized, m.raw); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            opts.onOpenFileRef?.(normalized, m.raw);
          }
        }}
      >
        {m.raw}
      </span>,
    );
    cursor = m.end;
  }
  if (cursor < src.length) out.push(src.slice(cursor));
  return out;
}

function renderInline(text: string, opts?: InlineOptions): Array<string | ReactElement> {
  // inline code: `code`
  const parts = text.split(/(`[^`]+`)/g);
  const out: Array<string | ReactElement> = [];

  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i] ?? "";
    if (p.startsWith("`") && p.endsWith("`") && p.length >= 2) {
      out.push(
        <code key={`code-${i}`} className="rtCode">
          {p.slice(1, -1)}
        </code>,
      );
      continue;
    }

    // bold: **text**
    const boldParts = p.split(/(\*\*[^*]+\*\*)/g);
    for (let j = 0; j < boldParts.length; j += 1) {
      const b = boldParts[j] ?? "";
      if (b.startsWith("**") && b.endsWith("**") && b.length >= 4) {
        out.push(
          <strong key={`b-${i}-${j}`} className="rtBold">
            {renderFileRefs(b.slice(2, -2), `b-${i}-${j}`, opts)}
          </strong>,
        );
      } else if (b) {
        out.push(...renderFileRefs(b, `t-${i}-${j}`, opts));
      }
    }
  }

  return out;
}

export function RichText(props: { text: string; onHeadingClick?: (args: { level: 1 | 2 | 3; line: number; text: string }) => void }) {
  const text = props.text ?? "";
  const rootDir = useProjectStore((s) => s.rootDir);

  const openFileRef = useCallback(
    async (filePath: string, raw: string) => {
      const targetPath = resolveOpenableFileRef(rootDir, filePath);
      if (!targetPath) return;
      const ret = await window.desktop?.exec?.openFile?.(targetPath);
      if (ret && !ret.ok) {
        alert(ret.detail || `无法打开文件：${raw}`);
      }
    },
    [rootDir],
  );

  const inlineOpts: InlineOptions = { onOpenFileRef: openFileRef };

  const lines = text.split("\n");

  const blocks: ReactElement[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // code fence
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        buf.push(lines[i] ?? "");
        i += 1;
      }
      // skip closing fence
      if (i < lines.length) i += 1;
      blocks.push(
        <pre key={`pre-${blocks.length}`} className="rtPre" aria-label="代码块">
          <code>
            {lang ? `// ${lang}\n` : ""}
            {buf.join("\n")}
          </code>
        </pre>,
      );
      continue;
    }

    // headings
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1]?.length ?? 1;
      const content = h[2] ?? "";
      const Tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
      const lineNo = i + 1;
      blocks.push(
        <Tag key={`h-${blocks.length}`} className={`rtH rtH${level}`}>
          <span
            role={props.onHeadingClick ? "button" : undefined}
            tabIndex={props.onHeadingClick ? 0 : undefined}
            style={{ cursor: props.onHeadingClick ? "pointer" : undefined }}
            onClick={() => props.onHeadingClick?.({ level: level as any, line: lineNo, text: String(content ?? "") })}
            onKeyDown={(e) => {
              if (!props.onHeadingClick) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                props.onHeadingClick({ level: level as any, line: lineNo, text: String(content ?? "") });
              }
            }}
          >
            {renderInline(content, inlineOpts)}
          </span>
        </Tag>,
      );
      i += 1;
      continue;
    }

    // unordered list
    if (line.trimStart().startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trimStart().startsWith("- ")) {
        items.push((lines[i] ?? "").trimStart().slice(2));
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="rtUl">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, inlineOpts)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${blocks.length}`} className="rtOl">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, inlineOpts)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // blockquote
    if (line.trimStart().startsWith("> ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trimStart().startsWith("> ")) {
        items.push((lines[i] ?? "").trimStart().slice(2));
        i += 1;
      }
      blocks.push(
        <blockquote key={`bq-${blocks.length}`} className="rtQuote">
          {items.map((it, idx) => (
            <Fragment key={idx}>
              {renderInline(it, inlineOpts)}
              <br />
            </Fragment>
          ))}
        </blockquote>,
      );
      continue;
    }

    // blank line
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // paragraph (merge consecutive non-empty lines until blank)
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim()) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push(
      <p key={`p-${blocks.length}`} className="rtP">
        {para.map((l, idx) => (
          <Fragment key={idx}>
            {renderInline(l, inlineOpts)}
            {idx === para.length - 1 ? null : <br />}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="richText">{blocks}</div>;
}
