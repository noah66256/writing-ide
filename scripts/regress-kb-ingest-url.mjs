#!/usr/bin/env node
/**
 * URL Ingest 回归脚本（非破坏性默认）：
 * - 模拟 “url 导入入库” 的去重与更新语义（同库同源同 entryIndex）
 * - 验证 sourceDocs/artifacts 不丢字段，且更新会重建 artifacts
 *
 * 用法：
 *   node scripts/regress-kb-ingest-url.mjs --kb "D:/.../kb.v1.json" --url "https://example.com/a" --text "..." [--libraryId kb_lib_xxx]
 *   node scripts/regress-kb-ingest-url.mjs --kb "D:/.../kb.v1.json" --url "https://example.com/a" --textFile "D:/tmp/page.txt" [--libraryId kb_lib_xxx]
 *   node scripts/regress-kb-ingest-url.mjs --kb ... --url ... --text ... --rerunSame
 *   node scripts/regress-kb-ingest-url.mjs --kb ... --url ... --text ... --updateText "new..."   （模拟网页内容更新）
 *   node scripts/regress-kb-ingest-url.mjs --kb ... --url ... --text ... [--out ".../kb.v1.url-test.json"] [--inplace]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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

function normalizeText(input) {
  return String(input ?? "").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function upsertUrlDocAndArtifacts(db, args) {
  const libId = String(args.libraryId ?? "").trim();
  const url = String(args.url ?? "").trim();
  const entryIndex = 0;
  const fetchedAt = args.fetchedAt ?? nowIso();
  const finalUrl = args.finalUrl ?? url;
  const content = normalizeText(args.text);
  const contentHash = sha256Hex(content);

  db.version = Math.max(Number(db.version ?? 0) || 0, 4);
  db.sourceDocs = Array.isArray(db.sourceDocs) ? db.sourceDocs : [];
  db.artifacts = Array.isArray(db.artifacts) ? db.artifacts : [];

  const importedFrom = { kind: "url", url, finalUrl, fetchedAt, entryIndex };
  const existing = db.sourceDocs.find(
    (d) =>
      String(d?.libraryId ?? "") === libId &&
      d?.importedFrom?.kind === "url" &&
      String(d?.importedFrom?.url ?? "") === url &&
      Number(d?.importedFrom?.entryIndex ?? 0) === entryIndex,
  );

  if (existing && String(existing.contentHash ?? "") === contentHash) {
    return { imported: false, docId: String(existing.id), reason: "duplicate_same_hash", contentHash };
  }

  const id = existing?.id ? String(existing.id) : `kb_doc_regress_${Date.now()}`;
  const title = String(existing?.title ?? "").trim() || String(args.titleHint ?? "").trim() || `URL: ${url}`.slice(0, 80);
  const doc = {
    id,
    libraryId: libId,
    title,
    format: "md",
    importedFrom,
    contentHash,
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };

  // rebuild artifacts: a few paragraph chunks
  const paras = content.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
  const artifacts = paras.map((p, idx) => ({
    id: `kb_art_regress_${id}_${idx}`,
    sourceDocId: id,
    kind: "paragraph",
    content: p,
    facetIds: [],
    anchor: { paragraphIndex: idx },
  }));

  db.sourceDocs = [...db.sourceDocs.filter((x) => String(x?.id ?? "") !== id), doc];
  db.artifacts = db.artifacts.filter((a) => String(a?.sourceDocId ?? "") !== id).concat(artifacts);

  return { imported: true, docId: id, reason: existing ? "updated" : "inserted", contentHash, artifactCount: artifacts.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const kbPath = String(args.kb ?? "").trim();
  const url = String(args.url ?? "").trim();
  if (!kbPath) {
    console.error("缺少参数：--kb <path-to-kb.v1.json>");
    process.exit(2);
  }
  if (!url) {
    console.error("缺少参数：--url <https://...>");
    process.exit(2);
  }

  const inplace = Boolean(args.inplace);
  const outPathRaw = args.out ? String(args.out).trim() : "";
  const outPath = inplace
    ? kbPath
    : outPathRaw
      ? outPathRaw
      : path.join(path.dirname(kbPath), path.basename(kbPath).replace(/\.json$/i, "") + ".url-test.json");

  const db = JSON.parse(fs.readFileSync(kbPath, "utf8"));
  const libraryId = pickLibraryId(db, args.libraryId);
  if (!libraryId) {
    console.error("未找到任何库（libraries 为空）。");
    process.exit(3);
  }

  const text =
    args.textFile ? fs.readFileSync(String(args.textFile), "utf8") : typeof args.text === "string" ? String(args.text) : "";
  if (!String(text).trim()) {
    console.error("缺少参数：--text 或 --textFile");
    process.exit(2);
  }

  const before = {
    version: Number(db?.version ?? 0) || 0,
    libraries: Array.isArray(db?.libraries) ? db.libraries.length : 0,
    sourceDocs: Array.isArray(db?.sourceDocs) ? db.sourceDocs.length : 0,
    artifacts: Array.isArray(db?.artifacts) ? db.artifacts.length : 0,
  };

  const next = { ...db };

  const r1 = upsertUrlDocAndArtifacts(next, { libraryId, url, text, titleHint: args.titleHint });
  const r2 = args.rerunSame ? upsertUrlDocAndArtifacts(next, { libraryId, url, text, titleHint: args.titleHint }) : null;
  const updateText = typeof args.updateText === "string" ? String(args.updateText) : null;
  const r3 = updateText ? upsertUrlDocAndArtifacts(next, { libraryId, url, text: updateText, titleHint: args.titleHint }) : null;

  fs.writeFileSync(outPath, JSON.stringify(next, null, 2), "utf8");
  const reread = JSON.parse(fs.readFileSync(outPath, "utf8"));

  const after = {
    version: Number(reread?.version ?? 0) || 0,
    libraries: Array.isArray(reread?.libraries) ? reread.libraries.length : 0,
    sourceDocs: Array.isArray(reread?.sourceDocs) ? reread.sourceDocs.length : 0,
    artifacts: Array.isArray(reread?.artifacts) ? reread.artifacts.length : 0,
  };

  const doc = Array.isArray(reread?.sourceDocs) ? reread.sourceDocs.find((d) => String(d?.id ?? "") === String(r1.docId)) : null;
  const arts = Array.isArray(reread?.artifacts) ? reread.artifacts.filter((a) => String(a?.sourceDocId ?? "") === String(r1.docId)) : [];
  const okImportedFrom = doc?.importedFrom?.kind === "url" && String(doc?.importedFrom?.url ?? "") === url;
  const okArtifacts = arts.length > 0 && arts.every((a) => a.kind === "paragraph");

  const okDedup = r2 ? r2.imported === false : true;
  const okUpdate = r3 ? r3.imported === true && String(doc?.contentHash ?? "") === String(r3.contentHash) : true;

  console.log("## URL Ingest 回归脚本结果");
  console.log(
    JSON.stringify(
      {
        kbPath,
        outPath,
        libraryId,
        before,
        after,
        run1: r1,
        run2: r2,
        run3: r3,
        checks: { okImportedFrom, okArtifacts, okDedup, okUpdate },
      },
      null,
      2,
    ),
  );

  if (!okImportedFrom || !okArtifacts || !okDedup || !okUpdate) process.exit(4);
}

main();

