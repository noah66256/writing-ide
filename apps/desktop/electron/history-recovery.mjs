import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const HISTORY_FILENAME = "conversations.v1.json";
const HISTORY_INDEX_FILENAME_V2 = "conversations.index.v2.json";
const HISTORY_CONV_DIRNAME_V2 = "conversations";

function parseArgs(argv) {
  const out = { historyDir: "", apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] ?? "");
    if (token === "--apply") {
      out.apply = true;
      continue;
    }
    if (token === "--history-dir") {
      out.historyDir = String(argv[i + 1] ?? "");
      i += 1;
    }
  }
  return out;
}

async function readJson(file) {
  try {
    const raw = await fsp.readFile(file, "utf-8");
    return JSON.parse(String(raw ?? ""));
  } catch {
    return null;
  }
}

function normalizeConversationIdForFilename(id) {
  return String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_") || "conv";
}

function buildBodyPayload(conversationId, snapshot) {
  const steps = Array.isArray(snapshot?.steps) ? snapshot.steps : [];
  const payloadForHash = JSON.stringify({
    model: String(snapshot?.model ?? ""),
    opMode: snapshot?.opMode ?? null,
    projectDir: typeof snapshot?.projectDir === "string" ? snapshot.projectDir : null,
    steps,
    logs: Array.isArray(snapshot?.logs) ? snapshot.logs : [],
    thread: snapshot?.thread && typeof snapshot.thread === "object" ? snapshot.thread : null,
    turns: Array.isArray(snapshot?.turns) ? snapshot.turns : [],
    items: Array.isArray(snapshot?.items) ? snapshot.items : [],
    collabSessions: Array.isArray(snapshot?.collabSessions) ? snapshot.collabSessions : [],
    activeItemIds: Array.isArray(snapshot?.activeItemIds) ? snapshot.activeItemIds : [],
  });
  return {
    version: 2,
    conversationId,
    head: {
      mode: snapshot?.mode ?? null,
      model: String(snapshot?.model ?? ""),
      opMode: snapshot?.opMode ?? null,
      mainDoc: snapshot?.mainDoc ?? {},
      todoList: Array.isArray(snapshot?.todoList) ? snapshot.todoList : [],
      kbAttachedLibraryIds: Array.isArray(snapshot?.kbAttachedLibraryIds) ? snapshot.kbAttachedLibraryIds : [],
      ctxRefs: Array.isArray(snapshot?.ctxRefs) ? snapshot.ctxRefs : [],
      pendingArtifacts: Array.isArray(snapshot?.pendingArtifacts) ? snapshot.pendingArtifacts : [],
      projectDir: typeof snapshot?.projectDir === "string" ? snapshot.projectDir : null,
      dialogueSummaryByMode: snapshot?.dialogueSummaryByMode ?? null,
      dialogueSummaryTurnCursorByMode: snapshot?.dialogueSummaryTurnCursorByMode ?? null,
    },
    steps,
    logs: Array.isArray(snapshot?.logs) ? snapshot.logs : [],
    thread: snapshot?.thread && typeof snapshot.thread === "object" ? snapshot.thread : null,
    turns: Array.isArray(snapshot?.turns) ? snapshot.turns : [],
    items: Array.isArray(snapshot?.items) ? snapshot.items : [],
    collabSessions: Array.isArray(snapshot?.collabSessions) ? snapshot.collabSessions : [],
    activeItemIds: Array.isArray(snapshot?.activeItemIds) ? snapshot.activeItemIds : [],
    bodyStepCount: steps.length,
    bodyUpdatedAt: Date.now(),
    bodyHash: crypto.createHash("sha1").update(payloadForHash).digest("hex"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const historyDir = String(args.historyDir || process.env.OHMYCRAB_HISTORY_DIR || "").trim();
  if (!historyDir) {
    throw new Error("missing --history-dir");
  }

  const indexFile = path.join(historyDir, HISTORY_INDEX_FILENAME_V2);
  const legacyFile = path.join(historyDir, HISTORY_FILENAME);
  const convRootDir = path.join(historyDir, HISTORY_CONV_DIRNAME_V2);
  const indexPayload = await readJson(indexFile);
  const legacyPayload = await readJson(legacyFile);
  const legacyById = new Map();
  for (const conv of Array.isArray(legacyPayload?.conversations) ? legacyPayload.conversations : []) {
    const id = String(conv?.id ?? "").trim();
    if (!id || !conv?.snapshot || typeof conv.snapshot !== "object") continue;
    legacyById.set(id, conv);
  }

  const indexEntries = Array.isArray(indexPayload?.conversations) ? indexPayload.conversations : [];
  const candidateIds = new Set([
    ...indexEntries.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean),
    ...legacyById.keys(),
  ]);

  const repairs = [];
  for (const id of candidateIds) {
    const legacyConv = legacyById.get(id);
    const legacySteps = Array.isArray(legacyConv?.snapshot?.steps) ? legacyConv.snapshot.steps.length : 0;
    const convFile = path.join(convRootDir, `conv_${normalizeConversationIdForFilename(id)}.json`);
    const convPayload = await readJson(convFile);
    const bodySteps = Array.isArray(convPayload?.steps) ? convPayload.steps.length : 0;
    if (legacySteps > bodySteps && legacyConv?.snapshot && typeof legacyConv.snapshot === "object") {
      repairs.push({
        id,
        reason: bodySteps === 0 ? "missing_or_empty_body" : "legacy_has_more_steps",
        legacySteps,
        bodySteps,
        snapshot: legacyConv.snapshot,
      });
    }
  }

  if (args.apply && repairs.length > 0) {
    await fsp.mkdir(convRootDir, { recursive: true });
    const nextIndexEntries = [...indexEntries];
    for (const item of repairs) {
      const payload = buildBodyPayload(item.id, item.snapshot);
      const convFile = path.join(convRootDir, `conv_${normalizeConversationIdForFilename(item.id)}.json`);
      await fsp.writeFile(convFile, JSON.stringify(payload), "utf-8");
      const idx = nextIndexEntries.findIndex((entry) => String(entry?.id ?? "").trim() === item.id);
      if (idx >= 0) {
        nextIndexEntries[idx] = {
          ...nextIndexEntries[idx],
          bodyStepCount: payload.bodyStepCount,
          bodyUpdatedAt: payload.bodyUpdatedAt,
          bodyHash: payload.bodyHash,
        };
      }
    }
    if (indexPayload && Array.isArray(indexEntries)) {
      await fsp.writeFile(
        indexFile,
        JSON.stringify({
          ...indexPayload,
          conversations: nextIndexEntries,
          updatedAt: Date.now(),
        }),
        "utf-8",
      );
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      historyDir,
      apply: args.apply,
      repairs: repairs.map(({ snapshot: _snapshot, ...rest }) => rest),
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error?.message ?? error)}\n`);
  process.exit(1);
});
