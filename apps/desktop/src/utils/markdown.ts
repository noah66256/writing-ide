export type MdHeading = {
  level: number; // 1..6
  text: string;
  line: number; // 1-based
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function normLine(s: string) {
  return String(s ?? "");
}

function isFenceStart(line: string) {
  const t = line.trimStart();
  return t.startsWith("```") || t.startsWith("~~~");
}

export function parseMarkdownHeadings(text: string, args?: { maxLevel?: number }): MdHeading[] {
  const maxLevel = clamp(Number(args?.maxLevel ?? 3), 1, 6);
  const lines = String(text ?? "").split("\n");
  const out: MdHeading[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = normLine(lines[i]);
    if (isFenceStart(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const level = m[1]?.length ?? 1;
    if (level > maxLevel) continue;
    const title = String(m[2] ?? "").trim();
    out.push({ level, text: title, line: i + 1 });
  }
  return out;
}

export type MdSectionRange = {
  startLine: number; // heading line (1-based)
  endLineExclusive: number; // 1-based exclusive
  level: number;
};

export function computeHeadingRanges(text: string, args?: { maxLevel?: number }): MdSectionRange[] {
  const hs = parseMarkdownHeadings(text, args);
  const lines = String(text ?? "").split("\n");
  const out: MdSectionRange[] = [];
  for (let i = 0; i < hs.length; i += 1) {
    const cur = hs[i]!;
    let endLineExclusive = lines.length + 1;
    for (let j = i + 1; j < hs.length; j += 1) {
      const next = hs[j]!;
      if (next.level <= cur.level) {
        endLineExclusive = next.line;
        break;
      }
    }
    out.push({ startLine: cur.line, endLineExclusive, level: cur.level });
  }
  return out;
}

function replaceRange(lines: string[], startIdx: number, endIdxExclusive: number, replacement: string[]) {
  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdxExclusive);
  return before.concat(replacement).concat(after);
}

export function moveSectionByHeadingLine(text: string, headingLine: number, direction: "up" | "down", args?: { maxLevel?: number }) {
  const hs = parseMarkdownHeadings(text, args);
  const ranges = computeHeadingRanges(text, args);
  const idx = hs.findIndex((h) => h.line === headingLine);
  if (idx < 0) return { ok: false as const, error: "HEADING_NOT_FOUND" };

  // 兄弟：同层级、并且父节点相同（用“最近更小 level 的 heading”作为 parent 近似）
  const parentOf = (i: number) => {
    const lv = hs[i]!.level;
    for (let k = i - 1; k >= 0; k -= 1) {
      if (hs[k]!.level < lv) return hs[k]!.line;
    }
    return 0; // root
  };
  const parentLine = parentOf(idx);
  const myLevel = hs[idx]!.level;
  const sibIdxs = hs
    .map((h, i) => ({ i, h }))
    .filter((x) => x.h.level === myLevel && parentOf(x.i) === parentLine)
    .map((x) => x.i);
  const pos = sibIdxs.indexOf(idx);
  if (pos < 0) return { ok: false as const, error: "SIBLING_NOT_FOUND" };

  const targetIdx = direction === "up" ? (pos > 0 ? sibIdxs[pos - 1]! : -1) : pos < sibIdxs.length - 1 ? sibIdxs[pos + 1]! : -1;
  if (targetIdx < 0) return { ok: false as const, error: "NO_TARGET" };

  const lines = String(text ?? "").split("\n");
  const curR = ranges[idx]!;
  const tgtR = ranges[targetIdx]!;

  const curStart = curR.startLine - 1;
  const curEnd = curR.endLineExclusive - 1;
  const tgtStart = tgtR.startLine - 1;
  const tgtEnd = tgtR.endLineExclusive - 1;
  const curBlock = lines.slice(curStart, curEnd);

  // remove current
  let nextLines = replaceRange(lines, curStart, curEnd, []);

  if (direction === "up") {
    // insert before target start (target is before cur, indices stable)
    nextLines = replaceRange(nextLines, tgtStart, tgtStart, curBlock);
  } else {
    // after removal, target indices shift left if target after cur
    const removedLen = curEnd - curStart;
    const tgtEndAdj = tgtEnd - removedLen;
    nextLines = replaceRange(nextLines, tgtEndAdj, tgtEndAdj, curBlock);
  }

  return { ok: true as const, content: nextLines.join("\n") };
}

export function shiftHeadingLevelsInSection(text: string, headingLine: number, delta: -1 | 1) {
  const lines = String(text ?? "").split("\n");
  const ranges = computeHeadingRanges(text, { maxLevel: 6 });
  const range = ranges.find((r) => r.startLine === headingLine);
  if (!range) return { ok: false as const, error: "HEADING_NOT_FOUND" };

  const start = range.startLine - 1;
  const end = range.endLineExclusive - 1;
  let inFence = false;
  const next = lines.slice();
  for (let i = start; i < end && i < next.length; i += 1) {
    const line = normLine(next[i]);
    if (isFenceStart(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})(\s+)(.*)$/);
    if (!m) continue;
    const lvl = m[1]!.length;
    const nextLvl = clamp(lvl + delta, 1, 6);
    const hashes = "#".repeat(nextLvl);
    next[i] = `${hashes}${m[2]}${m[3] ?? ""}`;
  }
  return { ok: true as const, content: next.join("\n") };
}


