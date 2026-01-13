import { Fragment } from "react";

function renderInline(text: string): Array<string | JSX.Element> {
  // inline code: `code`
  const parts = text.split(/(`[^`]+`)/g);
  const out: Array<string | JSX.Element> = [];

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
            {b.slice(2, -2)}
          </strong>,
        );
      } else if (b) {
        out.push(b);
      }
    }
  }

  return out;
}

export function RichText(props: { text: string }) {
  const text = props.text ?? "";
  const lines = text.split("\n");

  const blocks: JSX.Element[] = [];

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
      blocks.push(
        <Tag key={`h-${blocks.length}`} className={`rtH rtH${level}`}>
          {renderInline(content)}
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
            <li key={idx}>{renderInline(it)}</li>
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
            <li key={idx}>{renderInline(it)}</li>
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
              {renderInline(it)}
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
            {renderInline(l)}
            {idx === para.length - 1 ? null : <br />}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="richText">{blocks}</div>;
}



