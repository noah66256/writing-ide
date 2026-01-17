import fs from "node:fs/promises";
import path from "node:path";

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function normalizeText(text) {
  return String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function splitSentences(text) {
  const t = normalizeText(text);
  const parts = t
    .split(/[\n。！？!?]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : t.trim() ? [t.trim()] : [];
}

function countRegex(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function computeTextFingerprintStats(text) {
  const t = normalizeText(text);
  const chars = t.length;
  const sentences = splitSentences(t);
  const sentenceCount = sentences.length;

  const avgSentenceLen = sentenceCount ? sentences.reduce((a, s) => a + s.length, 0) / sentenceCount : 0;
  const shortSentenceRate = sentenceCount ? sentences.filter((s) => s.length <= 12).length / sentenceCount : 0;

  const questionSentences = sentenceCount
    ? sentences.filter((s) => /[？?]/.test(s) || /(吗|呢|为什么|怎么|何以|问题来了)/.test(s)).length
    : 0;
  const questionRatePer100Sentences = sentenceCount ? (questionSentences / sentenceCount) * 100 : 0;

  const exclaimSentences = sentenceCount ? sentences.filter((s) => /[！!]/.test(s)).length : 0;
  const exclaimRatePer100Sentences = sentenceCount ? (exclaimSentences / sentenceCount) * 100 : 0;

  const per1k = (n) => (chars ? (n / chars) * 1000 : 0);
  const firstPersonPer1kChars = per1k(countRegex(t, /我|咱|咱们|我们/g));
  const secondPersonPer1kChars = per1k(countRegex(t, /你|你们/g));
  const particlePer1kChars = per1k(countRegex(t, /啊|呢|吧|呀|哎|诶|呐/g));
  const digitPer1kChars = per1k(countRegex(t, /\d/g));

  return {
    chars,
    sentences: sentenceCount,
    stats: {
      questionRatePer100Sentences: Number(questionRatePer100Sentences.toFixed(2)),
      exclaimRatePer100Sentences: Number(exclaimRatePer100Sentences.toFixed(2)),
      avgSentenceLen: Number(avgSentenceLen.toFixed(2)),
      shortSentenceRate: Number(clamp01(shortSentenceRate).toFixed(4)),
      firstPersonPer1kChars: Number(firstPersonPer1kChars.toFixed(2)),
      secondPersonPer1kChars: Number(secondPersonPer1kChars.toFixed(2)),
      particlePer1kChars: Number(particlePer1kChars.toFixed(2)),
      digitPer1kChars: Number(digitPer1kChars.toFixed(2)),
    },
  };
}

function computeTopNgrams(docs, maxItems = 10) {
  const maxN = Math.max(6, Math.min(32, Number(maxItems ?? 12)));
  const totalChars = docs.reduce((a, d) => a + (d.text?.length ?? 0), 0) || 0;
  const totalDocs = docs.length || 0;

  const totalCounts = new Map();
  const segRe = /[0-9A-Za-z\u4e00-\u9fff]+/g;

  for (const d of docs) {
    const text = normalizeText(d.text);
    const seenInDoc = new Set();
    const segs = text.match(segRe) ?? [];
    for (const seg of segs) {
      const s = seg.trim();
      if (s.length < 2) continue;
      const L = s.length;
      for (let n = 2; n <= 6; n += 1) {
        if (L < n) continue;
        for (let i = 0; i <= L - n; i += 1) {
          const g = s.slice(i, i + n);
          if (/^\d+$/.test(g)) continue;
          const key = `${n}:${g}`;
          const rec = totalCounts.get(key) ?? { n, count: 0, docs: new Set() };
          rec.count += 1;
          totalCounts.set(key, rec);
          seenInDoc.add(key);
        }
      }
    }
    for (const key of seenInDoc) {
      const rec = totalCounts.get(key);
      if (rec) rec.docs.add(d.docId);
    }
  }

  return Array.from(totalCounts.entries())
    .map(([key, v]) => {
      const text = key.split(":").slice(1).join(":");
      const per1kChars = totalChars ? (v.count / totalChars) * 1000 : 0;
      const docCoverageCount = v.docs.size;
      const docCoverage = totalDocs ? docCoverageCount / totalDocs : 0;
      return {
        n: v.n,
        text,
        per1kChars: Number(per1kChars.toFixed(3)),
        docCoverageCount,
        docCoverage: Number(docCoverage.toFixed(3)),
      };
    })
    .sort((a, b) => b.per1kChars - a.per1kChars)
    .slice(0, maxN);
}

function segmentMarkdownToSegments({ filePath, text, maxSegments = 120, maxCharsPerSegment = 8000 }) {
  const t = normalizeText(text);
  const paras = t.split(/\n\s*\n+/g).map((s) => s.trim()).filter(Boolean);

  const isSep = (s) => /^-{3,}$/.test(s);
  const isTitle = (s) => /^标题[:：]/.test(s);
  const isHeading = (s) => /^#{1,6}\s+/.test(s);
  const isScript = (s) => /^文案[:：]/.test(s);
  const stripScript = (s) => s.replace(/^文案[:：]\s*/, "").trim();

  const segments = [];
  let segIdx = 0;
  let buf = [];
  let bufChars = 0;

  const flush = () => {
    const out = buf.join("\n").trim();
    buf = [];
    bufChars = 0;
    if (!out) return;
    segments.push({ segmentId: `${filePath}#seg${segIdx++}`, filePath, text: out });
  };

  for (const raw0 of paras) {
    const raw = raw0;
    if (!raw) continue;

    // headings/sep/title -> boundary, drop
    if (isHeading(raw) || isSep(raw) || isTitle(raw)) {
      flush();
      continue;
    }

    if (isScript(raw)) {
      if (buf.length) flush();
      const s = stripScript(raw);
      if (!s) continue;
      buf.push(s);
      bufChars += s.length + 1;
    } else {
      buf.push(raw);
      bufChars += raw.length + 1;
    }

    if (bufChars >= maxCharsPerSegment) flush();
    if (segments.length >= maxSegments) break;
  }
  flush();
  return segments;
}

function meanStd(arr) {
  const n = arr.length || 1;
  const mean = arr.reduce((a, x) => a + x, 0) / n;
  const var0 = arr.reduce((a, x) => a + (x - mean) * (x - mean), 0) / n;
  const sd = Math.sqrt(var0) || 1;
  return { mean, sd };
}

function dist2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

function kmeans2(vectors) {
  if (vectors.length < 2) throw new Error("need >=2 vectors");

  // init by min/max on dim0 (avgSentenceLen after z-score)
  let minI = 0;
  let maxI = 0;
  for (let i = 1; i < vectors.length; i += 1) {
    if (vectors[i][0] < vectors[minI][0]) minI = i;
    if (vectors[i][0] > vectors[maxI][0]) maxI = i;
  }
  let c0 = vectors[minI].slice();
  let c1 = vectors[maxI].slice();
  let assign = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < 30; iter += 1) {
    let changed = 0;
    for (let i = 0; i < vectors.length; i += 1) {
      const v = vectors[i];
      const d0 = dist2(v, c0);
      const d1 = dist2(v, c1);
      const a = d0 <= d1 ? 0 : 1;
      if (assign[i] !== a) {
        assign[i] = a;
        changed += 1;
      }
    }

    const sum0 = new Array(vectors[0].length).fill(0);
    const sum1 = new Array(vectors[0].length).fill(0);
    let n0 = 0;
    let n1 = 0;
    for (let i = 0; i < vectors.length; i += 1) {
      const v = vectors[i];
      if (assign[i] === 0) {
        n0 += 1;
        for (let k = 0; k < v.length; k += 1) sum0[k] += v[k];
      } else {
        n1 += 1;
        for (let k = 0; k < v.length; k += 1) sum1[k] += v[k];
      }
    }
    if (n0 === 0 || n1 === 0) break;
    c0 = sum0.map((x) => x / n0);
    c1 = sum1.map((x) => x / n1);
    if (changed === 0) break;
  }

  return { assign, centroids: [c0, c1] };
}

function parseArgs(argv) {
  const out = {
    dirs: [],
    extra: [],
    draft: "",
    maxSegmentsPerFile: 120,
    maxCharsPerSegment: 8000,
    minSegChars: 200,
    topNgrams: 8,
  };

  const next = (i) => (i + 1 < argv.length ? argv[i + 1] : "");
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dir") {
      out.dirs.push(next(i));
      i += 1;
      continue;
    }
    if (a === "--extra") {
      out.extra.push(next(i));
      i += 1;
      continue;
    }
    if (a === "--draft") {
      out.draft = next(i);
      i += 1;
      continue;
    }
    if (a === "--maxSegmentsPerFile") {
      out.maxSegmentsPerFile = Number(next(i));
      i += 1;
      continue;
    }
    if (a === "--maxCharsPerSegment") {
      out.maxCharsPerSegment = Number(next(i));
      i += 1;
      continue;
    }
    if (a === "--minSegChars") {
      out.minSegChars = Number(next(i));
      i += 1;
      continue;
    }
    if (a === "--topNgrams") {
      out.topNgrams = Number(next(i));
      i += 1;
      continue;
    }
  }
  return out;
}

async function listMdFiles(dir) {
  const names = await fs.readdir(dir);
  return names
    .filter((n) => String(n).toLowerCase().endsWith(".md"))
    .filter((n) => n !== "doc.rules.md")
    .map((n) => path.join(dir, n));
}

async function readText(p) {
  return await fs.readFile(p, "utf8");
}

function fmtStats(fp) {
  const s = fp.stats;
  return {
    avgSentenceLen: s.avgSentenceLen,
    shortSentenceRate: s.shortSentenceRate,
    questionRatePer100Sentences: s.questionRatePer100Sentences,
    particlePer1kChars: s.particlePer1kChars,
    digitPer1kChars: s.digitPer1kChars,
    firstPersonPer1kChars: s.firstPersonPer1kChars,
    secondPersonPer1kChars: s.secondPersonPer1kChars,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dirs.length && !args.extra.length) {
    console.log(
      [
        "用法：",
        "  node scripts/style-cluster.mjs --dir \"D:/文稿/测试/直男财经\" --extra \"D:/文稿/测试/直男财经.md\" --draft \"D:/文稿/测试/直男财经/日本反制事件分析（风格改写终稿）.md\"",
      ].join("\n"),
    );
    process.exit(2);
  }

  const files = [];
  for (const dir of args.dirs) files.push(...(await listMdFiles(dir)));
  for (const f of args.extra) files.push(f);

  const segments = [];
  for (const fp of files) {
    const content = await readText(fp);
    const segs = segmentMarkdownToSegments({
      filePath: fp,
      text: content,
      maxSegments: args.maxSegmentsPerFile,
      maxCharsPerSegment: args.maxCharsPerSegment,
    });
    for (const s of segs) {
      if (s.text.length < args.minSegChars) continue;
      const fp2 = computeTextFingerprintStats(s.text);
      segments.push({ ...s, fp: fp2 });
    }
  }
  if (segments.length < 2) throw new Error(`segments too few: ${segments.length}`);

  const FEATURES = ["avgSentenceLen", "digitPer1kChars", "questionRatePer100Sentences", "particlePer1kChars", "shortSentenceRate"];
  const cols = FEATURES.map((k) => segments.map((x) => Number(x.fp.stats[k] ?? 0)));
  const norms = cols.map(meanStd);
  const vecOf = (stats) =>
    FEATURES.map((k, i) => {
      const v = Number(stats?.[k] ?? 0);
      const { mean, sd } = norms[i];
      return (v - mean) / sd;
    });

  const vectors = segments.map((x) => vecOf(x.fp.stats));
  const { assign, centroids } = kmeans2(vectors);

  const clusters = [[], []];
  for (let i = 0; i < segments.length; i += 1) clusters[assign[i]].push({ seg: segments[i], vec: vectors[i] });

  const summarizeCluster = (clusterIdx) => {
    const items = clusters[clusterIdx];
    const text = items.map((x) => x.seg.text).join("\n\n");
    const fp = computeTextFingerprintStats(text);
    const ngrams = computeTopNgrams(
      items.slice(0, 1200).map((x) => ({ docId: x.seg.segmentId, text: x.seg.text })),
      args.topNgrams,
    );

    const centroid = centroids[clusterIdx];
    const withD = items
      .map((x) => ({ ...x, d: Math.sqrt(dist2(x.vec, centroid)) }))
      .sort((a, b) => a.d - b.d);
    const take = (arr) =>
      arr.map((x) => ({
        file: path.basename(x.seg.filePath),
        d: Number(x.d.toFixed(3)),
        snippet: x.seg.text.replace(/\s+/g, " ").slice(0, 120),
      }));
    return { count: items.length, fp, ngrams, close: take(withD.slice(0, 3)), far: take(withD.slice(-3)) };
  };

  const s0 = summarizeCluster(0);
  const s1 = summarizeCluster(1);
  const shortIs0 = (s0.fp.stats.avgSentenceLen ?? 0) <= (s1.fp.stats.avgSentenceLen ?? 0);
  const shortIdx = shortIs0 ? 0 : 1;
  const longIdx = shortIs0 ? 1 : 0;

  const printCluster = (label, s, idx) => {
    console.log(`\n## ${label}（cluster=${idx}，segments=${s.count}）`);
    console.log("stats:", fmtStats(s.fp));
    console.log(
      "topNgrams:",
      s.ngrams
        .slice(0, Math.max(1, Math.min(args.topNgrams, 12)))
        .map((x) => `${x.text}(${x.per1kChars}/1k, 覆盖${x.docCoverageCount}/${s.count})`)
        .join(" | "),
    );
    console.log("代表样例(closest):");
    for (const x of s.close) console.log(`- ${x.file} (d=${x.d}) ${x.snippet}`);
    console.log("离群样例(farthest):");
    for (const x of s.far) console.log(`- ${x.file} (d=${x.d}) ${x.snippet}`);
  };

  console.log(`# 聚类结果：样本文件=${files.length}，segments=${segments.length}`);
  printCluster("短句/敲打簇（推定）", shortIdx === 0 ? s0 : s1, shortIdx);
  printCluster("长句/算账簇（推定）", longIdx === 0 ? s0 : s1, longIdx);

  if (args.draft) {
    const draftText = await readText(args.draft);
    const draftFp = computeTextFingerprintStats(draftText);
    const draftVec = vecOf(draftFp.stats);
    const d0 = Math.sqrt(dist2(draftVec, centroids[0]));
    const d1 = Math.sqrt(dist2(draftVec, centroids[1]));
    const closer = d0 <= d1 ? 0 : 1;
    console.log(`\n## Draft 对比：${path.basename(args.draft)}`);
    console.log("draft stats:", fmtStats(draftFp));
    console.log(
      `draft -> centroid distance: cluster0=${d0.toFixed(3)}, cluster1=${d1.toFixed(3)} => 更接近 cluster${closer}（${
        closer === shortIdx ? "短句/敲打" : "长句/算账"
      }）`,
    );
  }
}

main().catch((e) => {
  console.error("[style-cluster] failed:", String(e?.stack ?? e?.message ?? e));
  process.exit(1);
});


