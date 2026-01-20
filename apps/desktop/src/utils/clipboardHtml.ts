type ClipboardPlatform = "xiaohongshu" | "wechat" | "zhihu" | "feishu";

function escapeHtml(s: string) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripFrontmatter(md: string) {
  const s = String(md ?? "");
  if (!s.startsWith("---\n")) return s;
  const end = s.indexOf("\n---", 4);
  if (end === -1) return s;
  const after = s.indexOf("\n", end + 1);
  return after === -1 ? "" : s.slice(after + 1);
}

function stylesFor(platform: ClipboardPlatform) {
  // 目标：尽量“可粘贴保留”的基础内联样式（公众号/小红书/知乎/飞书普遍会清洗 <style>）
  const common = {
    wrap: `font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial;`,
    p: `margin:0 0 12px 0;white-space:normal;word-break:break-word;`,
    strong: `font-weight:700;`,
    code: `font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:0.92em;background:rgba(0,0,0,0.05);padding:0 4px;border-radius:6px;`,
    pre: `margin:10px 0;padding:10px 12px;border-radius:10px;background:#0b1020;color:#e5e7eb;overflow:auto;`,
    ul: `margin:6px 0 12px 22px;padding:0;`,
    ol: `margin:6px 0 12px 22px;padding:0;`,
    li: `margin:6px 0;`,
    blockquote: `margin:10px 0;padding:6px 12px;border-left:3px solid rgba(37,99,235,0.35);background:rgba(37,99,235,0.06);border-radius:10px;color:inherit;`,
    hr: `border:none;border-top:1px solid rgba(0,0,0,0.12);margin:14px 0;`,
  };

  if (platform === "xiaohongshu") {
    return {
      ...common,
      wrap: `${common.wrap}font-size:16px;line-height:1.9;color:#111827;`,
      h1: `margin:0 0 12px 0;font-size:22px;line-height:1.25;font-weight:800;`,
      h2: `margin:18px 0 10px 0;font-size:18px;line-height:1.25;font-weight:800;`,
      h3: `margin:16px 0 8px 0;font-size:16px;line-height:1.25;font-weight:800;`,
      p: `${common.p}letter-spacing:0.2px;`,
    };
  }

  if (platform === "wechat") {
    return {
      ...common,
      wrap: `${common.wrap}font-size:16px;line-height:1.75;color:#222;`,
      h1: `margin:0 0 10px 0;font-size:22px;line-height:1.25;font-weight:800;`,
      h2: `margin:16px 0 8px 0;font-size:18px;line-height:1.25;font-weight:800;`,
      h3: `margin:14px 0 6px 0;font-size:16px;line-height:1.25;font-weight:800;`,
      blockquote: `margin:10px 0;padding:6px 12px;border-left:3px solid rgba(0,0,0,0.18);background:rgba(0,0,0,0.03);border-radius:10px;color:inherit;`,
    };
  }

  if (platform === "zhihu") {
    return {
      ...common,
      wrap: `${common.wrap}font-size:16px;line-height:1.8;color:#1a1a1a;`,
      h1: `margin:0 0 10px 0;font-size:22px;line-height:1.25;font-weight:800;`,
      h2: `margin:18px 0 8px 0;font-size:18px;line-height:1.25;font-weight:800;`,
      h3: `margin:16px 0 6px 0;font-size:16px;line-height:1.25;font-weight:800;`,
      p: `${common.p}`,
    };
  }

  // feishu
  return {
    ...common,
    wrap: `${common.wrap}font-size:15px;line-height:1.75;color:#111827;`,
    h1: `margin:0 0 10px 0;font-size:20px;line-height:1.25;font-weight:800;`,
    h2: `margin:16px 0 8px 0;font-size:17px;line-height:1.25;font-weight:800;`,
    h3: `margin:14px 0 6px 0;font-size:15px;line-height:1.25;font-weight:800;`,
  };
}

function renderInline(s: string, st: { strong: string; code: string }) {
  let out = escapeHtml(s);
  // inline code `code`
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code style="${st.code}">${escapeHtml(String(c))}</code>`);
  // bold **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong style="${st.strong}">${escapeHtml(String(c))}</strong>`);
  // italic *text* or _text_
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, pre, c) => `${pre}<em>${escapeHtml(String(c))}</em>`);
  out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, (_m, pre, c) => `${pre}<em>${escapeHtml(String(c))}</em>`);
  // links: [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, url) => {
    const safeUrl = escapeHtml(String(url));
    const safeText = escapeHtml(String(t));
    return `<a href="${safeUrl}">${safeText}</a>`;
  });
  return out;
}

export function markdownToClipboardHtml(md: string, platform: ClipboardPlatform) {
  const st = stylesFor(platform);
  const lines = String(stripFrontmatter(md ?? "")).split("\n");
  const html: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = String(lines[i] ?? "");

    // hr
    if (/^\s*---\s*$/.test(line)) {
      html.push(`<hr style="${st.hr}"/>`);
      i += 1;
      continue;
    }

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
      const head = lang ? `// ${escapeHtml(lang)}\n` : "";
      html.push(`<pre style="${st.pre}"><code>${head}${code}</code></pre>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1]?.length ?? 1;
      const content = renderInline(String(h[2] ?? ""), st);
      if (level === 1) html.push(`<h1 style="${st.h1}">${content}</h1>`);
      else if (level === 2) html.push(`<h2 style="${st.h2}">${content}</h2>`);
      else html.push(`<h3 style="${st.h3}">${content}</h3>`);
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
      html.push(
        `<ul style="${st.ul}">${items.map((x) => `<li style="${st.li}">${renderInline(x, st)}</li>`).join("")}</ul>`,
      );
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(String(lines[i] ?? ""))) {
        items.push(String(lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      html.push(
        `<ol style="${st.ol}">${items.map((x) => `<li style="${st.li}">${renderInline(x, st)}</li>`).join("")}</ol>`,
      );
      continue;
    }

    // blockquote
    if (line.trimStart().startsWith("> ")) {
      const items: string[] = [];
      while (i < lines.length && String(lines[i] ?? "").trimStart().startsWith("> ")) {
        items.push(String(lines[i] ?? "").trimStart().slice(2));
        i += 1;
      }
      html.push(`<blockquote style="${st.blockquote}">${items.map((x) => `${renderInline(x, st)}<br/>`).join("")}</blockquote>`);
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
    html.push(`<p style="${st.p}">${para.map((x) => renderInline(x, st)).join("<br/>")}</p>`);
  }

  // wrapper：有些平台会保留 div 的 inline style（即使内部也有 style）
  return `<div style="${st.wrap}">${html.join("")}</div>`;
}

export type { ClipboardPlatform };


