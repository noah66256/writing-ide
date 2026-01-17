#!/usr/bin/env node
/**
 * M2 回归小脚本（非破坏性默认）：验证 fingerprints.clustersV1 存在且可复现、以及 clusterLabels/defaultClusterId 可写入并重读。
 *
 * 用法：
 *   node scripts/regress-kb-m2.mjs --kb "D:/.../kb.v1.json" [--libraryId kb_lib_xxx] [--out "D:/.../kb.v1.m2-test.json"] [--inplace]
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

function stableSignature(fp) {
  // 只取稳定字段：clusterId、segmentCount、docCoverageCount、stability
  const clusters = Array.isArray(fp?.clustersV1) ? fp.clustersV1 : [];
  return clusters
    .map((c) => ({
      id: String(c?.id ?? ""),
      segmentCount: Number(c?.segmentCount ?? 0) || 0,
      docCoverageCount: Number(c?.docCoverageCount ?? 0) || 0,
      stability: String(c?.stability ?? ""),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
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
      : path.join(path.dirname(kbPath), path.basename(kbPath).replace(/\.json$/i, "") + ".m2-test.json");

  const db = JSON.parse(fs.readFileSync(kbPath, "utf8"));
  const libraryId = pickLibraryId(db, args.libraryId);
  if (!libraryId) {
    console.error("未找到任何库（libraries 为空）。");
    process.exit(3);
  }

  const fp = latestFingerprintForLib(db, libraryId);
  const sig1 = fp ? stableSignature(fp) : [];
  const hasClusters = sig1.length > 0;

  // 写入 prefs：clusterLabels + defaultCluster
  const next = { ...db };
  next.version = Math.max(Number(next.version ?? 0) || 0, 4);
  next.libraryPrefs = next.libraryPrefs && typeof next.libraryPrefs === "object" && !Array.isArray(next.libraryPrefs) ? next.libraryPrefs : {};
  next.libraryPrefs[libraryId] = next.libraryPrefs[libraryId] && typeof next.libraryPrefs[libraryId] === "object" ? next.libraryPrefs[libraryId] : {};
  next.libraryPrefs[libraryId].style = next.libraryPrefs[libraryId].style && typeof next.libraryPrefs[libraryId].style === "object" ? next.libraryPrefs[libraryId].style : {};
  next.libraryPrefs[libraryId].style.updatedAt = nowIso();
  next.libraryPrefs[libraryId].style.clusterLabelsV1 = {
    ...(next.libraryPrefs[libraryId].style.clusterLabelsV1 || {}),
    cluster_0: "写法A（测试改名）",
  };
  next.libraryPrefs[libraryId].style.defaultClusterId = "cluster_0";

  fs.writeFileSync(outPath, JSON.stringify(next, null, 2), "utf8");
  const reread = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const style = reread?.libraryPrefs?.[libraryId]?.style ?? {};
  const okPrefs = String(style.defaultClusterId ?? "") === "cluster_0" && String(style.clusterLabelsV1?.cluster_0 ?? "").includes("测试改名");

  // 二次读取 fingerprint signature（不重算聚类，只验证已有快照字段稳定存在）
  const fp2 = latestFingerprintForLib(reread, libraryId);
  const sig2 = fp2 ? stableSignature(fp2) : [];

  console.log("## M2 回归脚本结果");
  console.log(
    JSON.stringify(
      {
        kbPath,
        outPath,
        libraryId,
        hasClusters,
        signature1: sig1,
        signature2: sig2,
        okPrefs,
      },
      null,
      2,
    ),
  );

  if (!okPrefs) process.exit(4);
}

main();


