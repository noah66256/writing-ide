#!/usr/bin/env node
/**
 * M1 回归小脚本（非破坏性默认）：验证 kb.v1.json 在引入 libraryPrefs（anchors）后
 * - 不会丢 libraries/sourceDocs/artifacts/fingerprints
 * - 能写入 anchors 并在二次读取时仍存在（模拟“重启仍在”）
 *
 * 用法：
 *   node scripts/regress-kb-m1.mjs --kb "D:/.../kb.v1.json" [--libraryId kb_lib_xxx] [--out "D:/.../kb.v1.m1-test.json"] [--inplace]
 */

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function pickLibraryId(db, requested) {
  const libs = Array.isArray(db?.libraries) ? db.libraries : [];
  if (requested && libs.some((l) => String(l?.id ?? "") === String(requested))) return String(requested);
  const style = libs.find((l) => String(l?.purpose ?? "") === "style");
  if (style?.id) return String(style.id);
  return libs[0]?.id ? String(libs[0].id) : null;
}

function latestFingerprintForLib(db, libraryId) {
  const fps = Array.isArray(db?.fingerprints) ? db.fingerprints : [];
  const list = fps.filter((x) => String(x?.libraryId ?? "") === String(libraryId));
  list.sort((a, b) => String(b?.computedAt ?? "").localeCompare(String(a?.computedAt ?? "")));
  return list[0] ?? null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const kbPath = String(args.kb ?? "").trim();
  if (!kbPath) {
    console.error("缺少参数：--kb <path-to-kb.v1.json>");
    process.exit(2);
  }

  const inplace = Boolean(args.inplace);
  const outPathRaw = args.out ? String(args.out).trim() : "";
  const outPath = inplace
    ? kbPath
    : outPathRaw
      ? outPathRaw
      : path.join(path.dirname(kbPath), path.basename(kbPath).replace(/\.json$/i, "") + ".m1-test.json");

  const raw = fs.readFileSync(kbPath, "utf8");
  const db = JSON.parse(raw);

  const before = {
    version: Number(db?.version ?? 0) || 0,
    libraries: Array.isArray(db?.libraries) ? db.libraries.length : 0,
    sourceDocs: Array.isArray(db?.sourceDocs) ? db.sourceDocs.length : 0,
    artifacts: Array.isArray(db?.artifacts) ? db.artifacts.length : 0,
    fingerprints: Array.isArray(db?.fingerprints) ? db.fingerprints.length : 0,
  };

  const libraryId = pickLibraryId(db, args.libraryId);
  if (!libraryId) {
    console.error("未找到任何库（libraries 为空），无法测试 anchors 写入。");
    process.exit(3);
  }

  const fp = latestFingerprintForLib(db, libraryId);
  const seg0 = fp && Array.isArray(fp?.perSegment) && fp.perSegment.length ? fp.perSegment[0] : null;
  const sourceDocs = Array.isArray(db?.sourceDocs) ? db.sourceDocs : [];
  const doc0 =
    (seg0?.sourceDocId && sourceDocs.find((d) => String(d?.id ?? "") === String(seg0.sourceDocId))) ||
    sourceDocs.find((d) => String(d?.libraryId ?? "") === String(libraryId)) ||
    sourceDocs[0] ||
    null;

  const sourceDocId = doc0?.id ? String(doc0.id) : String(seg0?.sourceDocId ?? "");
  const segmentId = String(seg0?.segmentId ?? `${sourceDocId}#seg0`);
  const paragraphIndexStart = Number.isFinite(Number(seg0?.paragraphIndexStart)) ? Number(seg0.paragraphIndexStart) : null;
  const quote = String(seg0?.preview ?? "（m1 回归脚本：示例 anchor）").slice(0, 200);

  const next = { ...db };
  next.version = Math.max(Number(next.version ?? 0) || 0, 4);
  next.libraryPrefs = next.libraryPrefs && typeof next.libraryPrefs === "object" && !Array.isArray(next.libraryPrefs) ? next.libraryPrefs : {};
  next.libraryPrefs[libraryId] = next.libraryPrefs[libraryId] && typeof next.libraryPrefs[libraryId] === "object" ? next.libraryPrefs[libraryId] : {};
  next.libraryPrefs[libraryId].style = next.libraryPrefs[libraryId].style && typeof next.libraryPrefs[libraryId].style === "object" ? next.libraryPrefs[libraryId].style : {};
  next.libraryPrefs[libraryId].style.updatedAt = nowIso();
  next.libraryPrefs[libraryId].style.anchorsV1 = [
    {
      v: 1,
      libraryId,
      sourceDocId,
      importedFrom: doc0?.importedFrom,
      segmentId,
      paragraphIndexStart,
      quote,
    },
  ];

  fs.writeFileSync(outPath, JSON.stringify(next, null, 2), "utf8");

  // 二次读取校验（模拟“重启仍在”）
  const reread = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const anchors = reread?.libraryPrefs?.[libraryId]?.style?.anchorsV1;
  const okAnchors = Array.isArray(anchors) && anchors.length > 0;

  const after = {
    version: Number(reread?.version ?? 0) || 0,
    libraries: Array.isArray(reread?.libraries) ? reread.libraries.length : 0,
    sourceDocs: Array.isArray(reread?.sourceDocs) ? reread.sourceDocs.length : 0,
    artifacts: Array.isArray(reread?.artifacts) ? reread.artifacts.length : 0,
    fingerprints: Array.isArray(reread?.fingerprints) ? reread.fingerprints.length : 0,
    anchors: okAnchors ? anchors.length : 0,
  };

  console.log("## M1 回归脚本结果");
  console.log(JSON.stringify({ kbPath, outPath, libraryId, before, after, okAnchors }, null, 2));
  if (!okAnchors) process.exit(4);
}

main();


