function escapeHtml(s: string) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(s: string) {
  let out = escapeHtml(s);
  // inline code `code`
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${escapeHtml(String(c))}</code>`);
  // bold **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${escapeHtml(String(c))}</strong>`);
  return out;
}

export function markdownToHtml(md: string) {
  const lines = String(md ?? "").split("\n");
  const html: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = String(lines[i] ?? "");

    // code fence
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !(String(lines[i] ?? "").trimStart().startsWith("```"))) {
        buf.push(String(lines[i] ?? ""));
        i += 1;
      }
      if (i < lines.length) i += 1;
      const code = escapeHtml(buf.join("\n"));
      html.push(`<pre><code>${lang ? `// ${escapeHtml(lang)}\n` : ""}${code}</code></pre>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1]?.length ?? 1;
      const content = renderInline(String(h[2] ?? ""));
      html.push(`<h${level}>${content}</h${level}>`);
      i += 1;
      continue;
    }

    // unordered list
    if (line.trimStart().startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && String(lines[i] ?? "").trimStart().startsWith("- ")) {
        items.push(String(lines[i] ?? "").trimStart().slice(2));
        i += 1;
      }
      html.push(`<ul>${items.map((x) => `<li>${renderInline(x)}</li>`).join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(String(lines[i] ?? ""))) {
        items.push(String(lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      html.push(`<ol>${items.map((x) => `<li>${renderInline(x)}</li>`).join("")}</ol>`);
      continue;
    }

    // blockquote
    if (line.trimStart().startsWith("> ")) {
      const items: string[] = [];
      while (i < lines.length && String(lines[i] ?? "").trimStart().startsWith("> ")) {
        items.push(String(lines[i] ?? "").trimStart().slice(2));
        i += 1;
      }
      html.push(`<blockquote>${items.map((x) => `${renderInline(x)}<br/>`).join("")}</blockquote>`);
      continue;
    }

    // blank
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // paragraph
    const para: string[] = [];
    while (i < lines.length && String(lines[i] ?? "").trim()) {
      para.push(String(lines[i] ?? ""));
      i += 1;
    }
    html.push(`<p>${para.map((x) => renderInline(x)).join("<br/>")}</p>`);
  }

  return html.join("\n");
}

export function wrapHtmlDocument(args: { title: string; bodyHtml: string }) {
  const title = escapeHtml(args.title);
  const body = String(args.bodyHtml ?? "");
  const css = `
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial;line-height:1.7;padding:32px;max-width:920px;margin:0 auto;color:#111827;}
pre{background:#0b1020;color:#e5e7eb;padding:12px 14px;border-radius:10px;overflow:auto;}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:0.92em;}
blockquote{border-left:3px solid rgba(37,99,235,0.35);padding:6px 12px;margin:10px 0;color:#374151;background:rgba(37,99,235,0.04);border-radius:10px;}
h1,h2,h3{line-height:1.25;margin-top:1.2em;}
`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}


