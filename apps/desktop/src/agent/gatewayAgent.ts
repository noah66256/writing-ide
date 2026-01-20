import { useProjectStore } from "../state/projectStore";
import { useRunStore, type Mode } from "../state/runStore";
import { useKbStore } from "../state/kbStore";
import { facetLabel, getFacetPack } from "../kb/facets";
import { activateSkills, detectRunIntent } from "@writing-ide/agent-core";
import { buildStyleLinterLibrariesSidecar, executeToolCall, getTool, toolsPrompt } from "./toolRegistry";
import { isToolCallMessage, parseToolCalls, renderToolErrorXml, renderToolResultXml } from "./xmlProtocol";

type GatewayRunController = {
  cancel: () => void;
};

type ChatRole = "system" | "user" | "assistant";
type ChatMessage = { role: ChatRole; content: string };

type SseEvent = {
  event: string;
  data: string;
};

function coerceSseArgValue(v: string): unknown {
  const raw = String(v ?? "");
  const s = raw.trim();
  if (!s) return "";
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.parse(s);
    } catch {
      return raw;
    }
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 32) return Number(s);
  return raw;
}

function parseSseToolArgs(rawArgs: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawArgs ?? {})) out[k] = coerceSseArgValue(v);
  return out;
}

function parseSseBlock(block: string): SseEvent | null {
  // Very small SSE parser: expects lines like "event: xxx" and "data: {...}"
  const lines = block
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean);
  if (!lines.length) return null;

  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (line.startsWith("data:")) data += line.slice("data:".length).trim();
  }
  return { event, data };
}

function buildAgentProtocolPrompt() {
  return (
    `你是写作 IDE 的内置 Agent（偏写作产出与编辑体验，不要跑偏成通用工作流平台）。\n\n` +
    `你可以在需要时“调用工具”。当你要调用工具时，你必须输出 **且只能输出** 下面 XML 之一：\n` +
    `- 单次：<tool_call name="..."><arg name="...">...</arg></tool_call>\n` +
    `- 多次：<tool_calls>...多个 tool_call...</tool_calls>\n\n` +
    `规则：\n` +
    `- 如果你输出 tool_call/tool_calls，则消息里禁止夹杂任何其它自然语言。\n` +
    `- <arg> 内可以放 JSON（不要代码块，不要反引号）。\n` +
    `- 工具结果会由系统用 XML 回传（system message）：<tool_result name="xxx"><![CDATA[{...json}]]></tool_result>\n\n` +
    `编辑器选区约定：\n` +
    `- Context Pack 会提供 EDITOR_SELECTION。\n` +
    `- 如果用户要求“改写/润色我选中的这段”，请优先使用 EDITOR_SELECTION.selectedText；如 hasSelection=false，再提示用户先选中，或用 doc.read 获取全文后让用户指定范围。\n` +
    `- 写回选区请用 doc.replaceSelection。\n\n` +
    `你可用的工具如下（只能调用这里列出的）：\n\n` +
    toolsPrompt()
  );
}

type Ref = { kind: "file" | "dir"; path: string };

function parseRefsFromPrompt(prompt: string): Ref[] {
  const out: Ref[] = [];
  const re = /@\{([^}]+)\}/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(prompt)) !== null) {
    const raw = String(m[1] ?? "").trim();
    if (!raw) continue;
    let p = raw.replaceAll("\\", "/").replace(/^\.\//, "").trim();
    if (!p) continue;
    let kind: Ref["kind"] = p.endsWith("/") ? "dir" : "file";
    if (kind === "dir") p = p.replace(/\/+$/g, "");
    out.push({ kind, path: p });
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = `${r.kind}:${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildReferencesTextFromRefs(refs: Ref[]) {
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return "";
  const proj = useProjectStore.getState();

  const maxTotal = 60_000;
  const maxPerFile = 8_000;
  const maxFilesInDir = 12;
  let used = 0;

  const pushLimited = (s: string, parts: string[]) => {
    if (!s) return;
    if (used >= maxTotal) return;
    const left = maxTotal - used;
    const chunk = s.length > left ? s.slice(0, left) + "\n…(references truncated)\n" : s;
    parts.push(chunk);
    used += chunk.length;
  };

  const parts: string[] = [];
  pushLimited(
    `REFERENCES（来自用户输入中的 @{} 引用；已提供正文，无需再调用 doc.read）：\n`,
    parts,
  );

  for (const ref of list) {
    if (used >= maxTotal) break;
    const path = ref.path;
    if (!path) continue;

    const looksDir =
      ref.kind === "dir" ||
      (Array.isArray((proj as any).dirs) && (proj as any).dirs.includes(path)) ||
      proj.files.some((f) => f.path.startsWith(`${path}/`));

    if (looksDir) {
      const children = proj.files
        .map((f) => f.path)
        .filter((p) => p.startsWith(`${path}/`))
        .sort((a, b) => a.localeCompare(b));
      const listed = children.slice(0, maxFilesInDir);
      pushLimited(`\n- DIR: ${path}/ (files=${children.length}${children.length > maxFilesInDir ? `, showing=${maxFilesInDir}` : ""})\n`, parts);
      if (!listed.length) {
        pushLimited(`  (no text files)\n`, parts);
        continue;
      }
      for (const fp of listed) {
        if (used >= maxTotal) break;
        let content = "";
        try {
          content = await proj.ensureLoaded(fp);
        } catch {
          content = proj.getFileByPath(fp)?.content ?? "";
        }
        const truncated = content.length > maxPerFile;
        const body = truncated ? content.slice(0, maxPerFile) + "\n…(file truncated)\n" : content;
        pushLimited(`  - FILE: ${fp} (chars=${content.length}${truncated ? ", truncated" : ""})\n`, parts);
        pushLimited(`-----BEGIN ${fp}-----\n${body}\n-----END ${fp}-----\n`, parts);
      }
      continue;
    }

    const file = proj.getFileByPath(path);
    if (!file) {
      pushLimited(`\n- FILE: ${path} (not found)\n`, parts);
      continue;
    }
    let content = "";
    try {
      content = await proj.ensureLoaded(path);
    } catch {
      content = file.content ?? "";
    }
    const truncated = content.length > maxPerFile;
    const body = truncated ? content.slice(0, maxPerFile) + "\n…(file truncated)\n" : content;
    pushLimited(`\n- FILE: ${path} (chars=${content.length}${truncated ? ", truncated" : ""})\n`, parts);
    pushLimited(`-----BEGIN ${path}-----\n${body}\n-----END ${path}-----\n`, parts);
  }

  return parts.join("");
}

function rankStabilityForSelectorV1(stability: string): number {
  const s = String(stability ?? "").trim().toLowerCase();
  return s === "high" ? 3 : s === "medium" ? 2 : s === "low" ? 1 : 0;
}

function buildTopicTextForSelectorV1(args: { userPrompt: string; mainDoc: any }): string {
  const g = String(args?.mainDoc?.goal ?? "").trim();
  const p = String(args?.userPrompt ?? "").trim();
  return [g, p].filter(Boolean).join("\n");
}

function extractTopicTokensV1(topicTextRaw: string): string[] {
  const text = String(topicTextRaw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const v = String(t ?? "").trim();
    if (!v) return;
    if (v.length < 2) return;
    if (v.length > 12) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };

  // English words / numbers
  {
    const words = text.match(/[a-zA-Z]{3,}/g) ?? [];
    for (const w of words.slice(0, 60)) push(w);
    const nums = text.match(/\d{2,}/g) ?? [];
    for (const n of nums.slice(0, 40)) push(n);
  }

  // Chinese char ngrams（2~4）
  {
    const segs = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    let budget = 220;
    for (const seg0 of segs) {
      if (budget <= 0) break;
      const seg = String(seg0 ?? "").trim();
      if (!seg) continue;
      // 太长的片段用 ngram 覆盖即可，不保留整段
      const maxLen = Math.min(seg.length, 28);
      const s = seg.slice(0, maxLen);
      for (const n of [4, 3, 2]) {
        for (let i = 0; i + n <= s.length; i += 1) {
          if (budget <= 0) break;
          push(s.slice(i, i + n));
          budget -= 1;
        }
      }
    }
  }

  return out.slice(0, 260);
}

function computeTopicFitV1(topicText: string, clusterText: string): { score: number; hits: string[] } {
  const tokens = extractTopicTokensV1(topicText);
  if (!tokens.length) return { score: 0, hits: [] };
  const hay = String(clusterText ?? "").toLowerCase();
  let score = 0;
  const hits: string[] = [];
  const seenHit = new Set<string>();
  for (const raw of tokens) {
    const t = String(raw ?? "");
    const key = t.toLowerCase();
    if (!key) continue;
    if (!hay.includes(key)) continue;
    const w = Math.min(16, key.length);
    score += w * w;
    if (!seenHit.has(key)) {
      seenHit.add(key);
      hits.push(t);
    }
  }
  return { score, hits: hits.slice(0, 8) };
}

type SelectorStageIdV1 = "opening" | "outline" | "draft" | "ending" | "polish" | "unknown";

function detectWritingStageV1(args: {
  userPrompt: string;
  todoList: any[];
}): { id: SelectorStageIdV1; label: string; by: string; evidence?: string } {
  const prompt = String(args?.userPrompt ?? "").trim();
  const todoList = Array.isArray(args?.todoList) ? args.todoList : [];
  const activeTodo = todoList.find((t: any) => {
    const s = String(t?.status ?? "").trim().toLowerCase();
    return s && s !== "done" && s !== "skipped";
  });
  const todoHint = activeTodo ? `${String(activeTodo?.text ?? "").trim()}\n${String(activeTodo?.note ?? "").trim()}`.trim() : "";
  const hay = `${prompt}\n${todoHint}`.trim();
  const by = todoHint ? "todo+prompt" : "prompt";

  const hit = (re: RegExp) => re.test(hay);
  if (hit(/润色|终稿|定稿|校对|自检|lint|polish/i)) return { id: "polish", label: "润色/终稿", by, evidence: todoHint || prompt };
  if (hit(/结尾|收尾|结论|总结|升华|CTA|call\s*to\s*action/i)) return { id: "ending", label: "收尾/结尾", by, evidence: todoHint || prompt };
  if (hit(/开头|开场|破题|钩子|hook|标题/i)) return { id: "opening", label: "开头/开场", by, evidence: todoHint || prompt };
  if (hit(/大纲|提纲|outline|结构|框架/i)) return { id: "outline", label: "大纲/结构", by, evidence: todoHint || prompt };
  if (hit(/改写|仿写|续写|扩写|写一篇|写\s*\d{2,5}\s*字/i)) return { id: "draft", label: "撰写/正文", by, evidence: todoHint || prompt };

  // 写作任务默认视为正文阶段（Selector v1：避免 unknown 导致选卡过于保守）
  return { id: "draft", label: "撰写/正文", by: "default", evidence: todoHint || prompt };
}

function topicBriefForKbQueryV1(args: { userPrompt: string; mainDoc: any }): string {
  const g = String(args?.mainDoc?.goal ?? "").trim();
  const p = String(args?.userPrompt ?? "").trim();
  const base = g || p;
  return base.replace(/\s+/g, " ").trim().slice(0, 80);
}

function stageFacetWeightsV1(
  packId: string,
  stageId: SelectorStageIdV1,
): { essential: string[]; supportive: string[]; k: number } {
  const pid = String(packId ?? "").trim() || "speech_marketing_v1";
  // 口播/营销（v1）
  if (pid === "speech_marketing_v1") {
    if (stageId === "opening")
      return {
        essential: ["opening_design", "intro", "question_design", "emotion_mobilization", "voice_rhythm", "one_liner_crafting"],
        supportive: ["reader_interaction", "scene_building", "rhetoric"],
        k: 6,
      };
    if (stageId === "outline")
      return {
        essential: ["narrative_structure", "logic_framework", "structure_patterns"],
        supportive: ["topic_selection", "persuasion", "reader_interaction"],
        k: 5,
      };
    if (stageId === "ending")
      return {
        essential: ["values_embedding", "resonance", "structure_patterns"],
        supportive: ["one_liner_crafting", "reader_interaction", "emotion_mobilization"],
        k: 5,
      };
    if (stageId === "polish")
      return {
        essential: ["language_style", "voice_rhythm", "special_markers", "ai_clone_strategy"],
        supportive: ["one_liner_crafting", "rhetoric"],
        k: 4,
      };
    // draft / unknown
    return {
      essential: ["logic_framework", "narrative_structure", "persuasion", "voice_rhythm", "emotion_mobilization"],
      supportive: ["reader_interaction", "scene_building", "one_liner_crafting", "rhetoric"],
      k: 7,
    };
  }

  // 小说（v1，占位）
  if (pid === "novel_v1") {
    if (stageId === "opening") return { essential: ["viewpoint_voice", "pacing_tension", "world_setting"], supportive: ["foreshadowing_payoff"], k: 4 };
    if (stageId === "outline") return { essential: ["plot_structure", "character_arc"], supportive: ["world_setting"], k: 4 };
    if (stageId === "ending") return { essential: ["foreshadowing_payoff", "pacing_tension"], supportive: ["character_arc"], k: 4 };
    if (stageId === "polish") return { essential: ["viewpoint_voice", "dialogue"], supportive: ["pacing_tension"], k: 4 };
    return { essential: ["plot_structure", "character_arc", "scene_goal_conflict"], supportive: ["dialogue", "pacing_tension"], k: 5 };
  }

  return { essential: [], supportive: [], k: 6 };
}

type SelectedFacetV1 = {
  facetId: string;
  label: string;
  score: number;
  topicFit: number;
  stageFit: number;
  basePlan: boolean;
  why: string;
  kbQueries: string[];
  topicHits?: string[];
};

function pickFacetsSelectorV1(args: {
  facetPackId: string;
  cluster: any;
  topicText: string;
  topicBrief: string;
  stageId: SelectorStageIdV1;
}): { selected: SelectedFacetV1[]; trace: any } {
  const pack = getFacetPack(args.facetPackId);
  const packFacetIds = pack.facets.map((f) => f.id);
  const order = new Map(pack.facets.map((f, i) => [f.id, i]));

  const planItems = Array.isArray(args.cluster?.facetPlan) ? (args.cluster.facetPlan as any[]) : [];
  const planById = new Map(
    planItems
      .map((x) => ({
        facetId: String(x?.facetId ?? "").trim(),
        why: String(x?.why ?? "").trim(),
        kbQueries: Array.isArray(x?.kbQueries) ? x.kbQueries.map((q: any) => String(q ?? "").trim()).filter(Boolean) : [],
      }))
      .filter((x) => x.facetId),
  );

  const candidateIds = Array.from(
    new Set([
      ...packFacetIds,
      ...planItems.map((x: any) => String(x?.facetId ?? "").trim()).filter(Boolean), // 兜底：允许 pack 外的 facetId
    ]),
  );

  const stage = stageFacetWeightsV1(pack.id, args.stageId);
  const essential = new Set(stage.essential);
  const supportive = new Set(stage.supportive);

  const scored: Array<{
    facetId: string;
    label: string;
    basePlan: boolean;
    stageFit: number;
    rawTopicScore: number;
    topicHits: string[];
    planWhy: string;
    planKbQueries: string[];
  }> = [];

  for (const facetId of candidateIds) {
    const label = facetLabel(facetId);
    const plan = planById.get(facetId);
    const planWhy = plan?.why ?? "";
    const planKbQueries = plan?.kbQueries ?? [];
    const basePlan = planById.has(facetId);
    const stageFit = essential.has(facetId) ? 1 : supportive.has(facetId) ? 0.6 : 0;
    const facetText = [label, facetId, planWhy, planKbQueries.join(" ")].filter(Boolean).join("\n");
    const tf = computeTopicFitV1(args.topicText, facetText);
    scored.push({
      facetId,
      label,
      basePlan,
      stageFit,
      rawTopicScore: tf.score,
      topicHits: tf.hits,
      planWhy,
      planKbQueries,
    });
  }

  const maxRaw = scored.reduce((m, x) => Math.max(m, x.rawTopicScore), 0);
  const withFinal = scored.map((x) => {
    const topicFit = maxRaw > 0 ? x.rawTopicScore / maxRaw : 0;
    const basePlanScore = x.basePlan ? 1 : 0;
    const score = 0.55 * topicFit + 0.30 * x.stageFit + 0.15 * basePlanScore;
    return { ...x, topicFit, score };
  });

  // 先强制纳入 essential，再按总分补齐
  const k = Math.max(4, Math.min(8, stage.k || 6));
  const selectedIds: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    const k = String(id ?? "").trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    selectedIds.push(k);
  };

  // essential（按 facet pack 顺序）
  for (const fid of stage.essential) {
    if (selectedIds.length >= k) break;
    if (!candidateIds.includes(fid)) continue;
    push(fid);
  }

  const sorted = withFinal
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (Number(b.basePlan) !== Number(a.basePlan)) return Number(b.basePlan) - Number(a.basePlan);
      if (b.stageFit !== a.stageFit) return b.stageFit - a.stageFit;
      const oa = order.get(a.facetId) ?? 999;
      const ob = order.get(b.facetId) ?? 999;
      if (oa !== ob) return oa - ob;
      return String(a.facetId).localeCompare(String(b.facetId));
    });

  for (const it of sorted) {
    if (selectedIds.length >= k) break;
    push(it.facetId);
  }

  const selected = selectedIds
    .map((fid) => withFinal.find((x) => x.facetId === fid))
    .filter(Boolean)
    .map((x: any) => {
      const q0 = String(args.topicBrief ?? "").trim();
      const base = q0 ? `${q0} ${x.label}`.trim() : x.label;
      const hint = String((x.planKbQueries?.[0] ?? (Array.isArray(args.cluster?.queries) ? args.cluster.queries[0] : "") ?? "") as any).trim();
      const q1 = base.slice(0, 96);
      const q2 = hint ? `${base} ${hint}`.trim().slice(0, 110) : "";
      const kbQueries = Array.from(new Set([q1, q2].map((s) => String(s ?? "").trim()).filter(Boolean))).slice(0, 2);
      const whyParts = [
        x.planWhy ? `plan:${x.planWhy}` : "",
        x.stageFit > 0.8 ? "stage:必备" : x.stageFit > 0.3 ? "stage:辅助" : "",
        x.topicHits?.length ? `topic:${x.topicHits.slice(0, 3).join("、")}` : "",
      ].filter(Boolean);
      return {
        facetId: x.facetId,
        label: x.label,
        score: Number(x.score.toFixed(4)),
        topicFit: Number(x.topicFit.toFixed(4)),
        stageFit: Number(x.stageFit.toFixed(2)),
        basePlan: Boolean(x.basePlan),
        why: whyParts.join("；").slice(0, 220),
        kbQueries,
        topicHits: Array.isArray(x.topicHits) ? x.topicHits.slice(0, 5) : undefined,
      } as SelectedFacetV1;
    });

  return {
    selected,
    trace: {
      method: "selector_v1_facets",
      stage: args.stageId,
      k,
      maxRawTopic: maxRaw,
      top: sorted.slice(0, 6).map((x) => ({ facetId: x.facetId, score: Number(x.score.toFixed(4)) })),
    },
  };
}

function pickClusterSelectorV1(args: {
  clusters: any[];
  defaultClusterId?: string;
  topicText?: string;
}): { selectedId: string; trace: any; topicHits: string[] } {
  const clusters = Array.isArray(args.clusters) ? args.clusters : [];
  const byId = new Map(clusters.map((c: any) => [String(c?.id ?? "").trim(), c]));
  const d = String(args.defaultClusterId ?? "").trim();
  const hasDefault = Boolean(d && byId.get(d));
  const topicText = String(args.topicText ?? "").trim();

  // 1) anchors 优先（更像原文）
  let maxAnchors = 0;
  for (const c of clusters) {
    const n = Array.isArray(c?.anchors) ? c.anchors.length : 0;
    if (n > maxAnchors) maxAnchors = n;
  }
  if (maxAnchors > 0) {
    const picked = clusters
      .slice()
      .sort((a: any, b: any) => {
        const na = Array.isArray(a?.anchors) ? a.anchors.length : 0;
        const nb = Array.isArray(b?.anchors) ? b.anchors.length : 0;
        if (nb !== na) return nb - na;
        const sa = rankStabilityForSelectorV1(String(a?.stability ?? ""));
        const sb = rankStabilityForSelectorV1(String(b?.stability ?? ""));
        if (sb !== sa) return sb - sa;
        const ca = Number(a?.docCoverageRate ?? 0) || 0;
        const cb = Number(b?.docCoverageRate ?? 0) || 0;
        if (cb !== ca) return cb - ca;
        const sega = Number(a?.segmentCount ?? 0) || 0;
        const segb = Number(b?.segmentCount ?? 0) || 0;
        return segb - sega;
      })[0];
    const selectedId = String(picked?.id ?? "").trim() || (hasDefault ? d : String(clusters?.[0]?.id ?? "").trim());
    return {
      selectedId,
      topicHits: [],
      trace: { method: "selector_v1", pickedBy: "anchors", maxAnchors, defaultClusterId: hasDefault ? d : null },
    };
  }

  // 2) topicFit（同库混题材时优先按话题匹配）
  const topicScores: Array<{ id: string; score: number; hits: string[] }> = [];
  for (const c of clusters) {
    const id = String(c?.id ?? "").trim();
    if (!id) continue;
    const quotes = Array.isArray(c?.evidence) ? c.evidence.map((e: any) => String(e?.quote ?? "").trim()).filter(Boolean) : [];
    const queries = Array.isArray(c?.queries) ? c.queries.map((q: any) => String(q ?? "").trim()).filter(Boolean) : [];
    const label = String(c?.label ?? "").trim();
    const clusterText = [label, ...queries.slice(0, 8), ...quotes.slice(0, 5)].filter(Boolean).join("\n");
    const fit = topicText ? computeTopicFitV1(topicText, clusterText) : { score: 0, hits: [] };
    topicScores.push({ id, score: fit.score, hits: fit.hits });
  }
  const maxTopic = topicScores.reduce((m, x) => Math.max(m, x.score), 0);
  if (maxTopic > 0) {
    const best = topicScores
      .slice()
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ca = byId.get(a.id);
        const cb = byId.get(b.id);
        const sa = rankStabilityForSelectorV1(String(ca?.stability ?? ""));
        const sb = rankStabilityForSelectorV1(String(cb?.stability ?? ""));
        if (sb !== sa) return sb - sa;
        const cova = Number(ca?.docCoverageRate ?? 0) || 0;
        const covb = Number(cb?.docCoverageRate ?? 0) || 0;
        if (covb !== cova) return covb - cova;
        const sega = Number(ca?.segmentCount ?? 0) || 0;
        const segb = Number(cb?.segmentCount ?? 0) || 0;
        return segb - sega;
      })[0];
    const selectedId = best?.id || (hasDefault ? d : String(clusters?.[0]?.id ?? "").trim());
    const hits = best?.hits ?? [];
    return {
      selectedId,
      topicHits: hits,
      trace: {
        method: "selector_v1",
        pickedBy: "topicFit",
        maxTopicScore: maxTopic,
        defaultClusterId: hasDefault ? d : null,
        top: topicScores
          .slice()
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((x) => ({ id: x.id, score: x.score })),
      },
    };
  }

  // 3) 无话题信号：默认写法（仅本库）优先，否则稳定性/覆盖率/段数
  if (hasDefault) {
    return { selectedId: d, topicHits: [], trace: { method: "selector_v1", pickedBy: "defaultCluster", defaultClusterId: d } };
  }
  const picked = clusters
    .slice()
    .sort((a: any, b: any) => {
      const sa = rankStabilityForSelectorV1(String(a?.stability ?? ""));
      const sb = rankStabilityForSelectorV1(String(b?.stability ?? ""));
      if (sb !== sa) return sb - sa;
      const ca = Number(a?.docCoverageRate ?? 0) || 0;
      const cb = Number(b?.docCoverageRate ?? 0) || 0;
      if (cb !== ca) return cb - ca;
      const sega = Number(a?.segmentCount ?? 0) || 0;
      const segb = Number(b?.segmentCount ?? 0) || 0;
      return segb - sega;
    })[0];
  const selectedId = String(picked?.id ?? "").trim() || String(clusters?.[0]?.id ?? "").trim() || "";
  return { selectedId, topicHits: [], trace: { method: "selector_v1", pickedBy: "stability", defaultClusterId: null } };
}

function pickFacetIdsV1(cluster: any, max = 8): string[] {
  const plan = Array.isArray(cluster?.facetPlan) ? (cluster.facetPlan as any[]) : [];
  const all = plan.map((f: any) => String(f?.facetId ?? "").trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (id: string) => {
    const k = String(id ?? "").trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  // 先把“常见关键卡”放前面（存在才加入）
  for (const id of ["opening_design", "narrative_structure", "one_liner_crafting", "emotion_mobilization", "logic_framework", "voice_rhythm"]) {
    if (all.includes(id)) push(id);
  }
  for (const id of all) {
    if (out.length >= max) break;
    push(id);
  }
  return out.slice(0, max);
}

type ContextManifestPriorityV1 = "p0" | "p1" | "p2" | "p3";
type ContextManifestSegmentV1 = {
  name: string;
  chars: number;
  priority: ContextManifestPriorityV1;
  trusted: boolean;
  truncated: boolean;
  source: "desktop" | "gateway";
  note?: string;
};

function renderContextManifestV1(args: { mode: Mode; segments: ContextManifestSegmentV1[] }) {
  const payload = {
    v: 1,
    generatedAt: new Date().toISOString(),
    mode: args.mode,
    segments: args.segments,
  };
  return `CONTEXT_MANIFEST(JSON):\n${JSON.stringify(payload, null, 2)}\n\n`;
}

async function buildContextPack(extra?: { referencesText?: string; userPrompt?: string }) {
  const mainDoc = useRunStore.getState().mainDoc;
  const todoList = useRunStore.getState().todoList;
  const proj = useProjectStore.getState();
  const docRules = proj.getFileByPath("doc.rules.md")?.content ?? "";
  const kbAttached = useRunStore.getState().kbAttachedLibraryIds ?? [];
  const kbLibraries = useKbStore.getState().libraries ?? [];
  const userPrompt = String(extra?.userPrompt ?? "");
  // PROJECT_STATE：只提供最小信息（避免“光标文件/全量文件列表”对模型产生过强暗示）
  const state = {
    fileCount: proj.files.length,
    // 说明：activePath/openPaths 仍存在于 Desktop 内部（工具默认路径等会用到），但不默认注入给模型
  };

  const selection = (() => {
    const ed = proj.editorRef;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !model || !sel) {
      return { ok: false, hasSelection: false, reason: "NO_EDITOR" as const };
    }
    const fullText = model.getValueInRange(sel);
    const maxChars = 4000;
    const truncated = fullText.length > maxChars;
    const selectedText = truncated ? fullText.slice(0, maxChars) : fullText;
    // 无选区时不要携带 path/range（避免模型把“光标文件”当作默认上下文）
    if (!fullText.length) return { ok: true, hasSelection: false, reason: "EMPTY_SELECTION" as const };
    return {
      ok: true,
      hasSelection: true,
      path: proj.activePath,
      selectedChars: fullText.length,
      truncated,
      range: {
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      },
      selectedText,
    };
  })();

  // RUN_TODO：注入给模型的 todo 要做裁剪（避免上下文膨胀）；UI 仍保留全量 todoList。
  const runTodoForPack = (() => {
    const normalizeOne = (t: any) => {
      const id = String(t?.id ?? "").trim();
      const text0 = String(t?.text ?? "").replace(/\s+/g, " ").trim();
      const status0 = String(t?.status ?? "").trim().toLowerCase();
      const status =
        status0 === "done" || status0 === "todo" || status0 === "in_progress" || status0 === "blocked" || status0 === "skipped"
          ? (status0 as any)
          : ("todo" as const);
      const note0 = t?.note === undefined ? undefined : String(t.note ?? "").replace(/\s+/g, " ").trim();
      if (!id || !text0) return null;
      const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max).trimEnd() + "…" : s);
      return {
        id,
        text: clip(text0, 120),
        status,
        ...(note0 ? { note: clip(note0, 220) } : {}),
      };
    };

    const norm = (Array.isArray(todoList) ? todoList : []).map(normalizeOne).filter(Boolean) as any[];
    const open = norm.filter((t) => t.status === "todo" || t.status === "in_progress" || t.status === "blocked").slice(0, 24);
    const doneAll = norm.filter((t) => t.status === "done");
    const done = doneAll.slice(Math.max(0, doneAll.length - 6));

    // 兜底：如果 open 为空但存在其它状态（例如全 done），至少带一点最近 done
    const merged = [...open, ...done];
    return merged.slice(0, 32);
  })();

  // 最近对话片段（只注入少量，避免上下文噪音；关键决策仍应写入 Main Doc）
  const recentDialogue = (() => {
    const stripToolXml = (text: string) =>
      String(text ?? "")
        .replace(/<tool_calls[\s\S]*?<\/tool_calls>/g, "")
        .replace(/<tool_call[\s\S]*?<\/tool_call>/g, "")
        .trim();
    const all = useRunStore.getState().steps ?? [];
    const msgs = all
      .filter((s: any) => s && typeof s === "object" && (s.type === "user" || s.type === "assistant"))
      .map((s: any) => ({
        role: s.type === "user" ? "user" : "assistant",
        text: stripToolXml(String(s.text ?? "")).slice(0, 800),
      }))
      .filter((x: any) => String(x.text ?? "").trim());
    // 去掉最后一条 user（通常是“本轮 prompt”，它会单独作为 user message 发送）
    const trimmed = msgs.length && msgs[msgs.length - 1].role === "user" ? msgs.slice(0, -1) : msgs;
    const recent = trimmed.slice(-6);
    return recent.length ? `RECENT_DIALOGUE(JSON):\n${JSON.stringify(recent, null, 2)}\n\n` : "";
  })();

  const refs = extra?.referencesText ? `${extra.referencesText}\n\n` : "";
  const kbSelected = (() => {
    const ids = Array.isArray(kbAttached) ? kbAttached.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [];
    const map = new Map(
      kbLibraries.map((l: any) => [
        l.id,
        {
          id: l.id,
          name: l.name,
          purpose: l.purpose ?? "material",
          facetPackId: l.facetPackId,
          docCount: l.docCount,
          updatedAt: l.updatedAt,
        },
      ]),
    );
    return ids.map((id: string) => map.get(id) ?? { id, name: id });
  })();

  const activeSkillsRaw = activateSkills({
    mode: useRunStore.getState().mode as any,
    userPrompt,
    mainDocRunIntent: (mainDoc as any)?.runIntent,
    kbSelected: kbSelected as any,
    // 关键：与 Gateway 对齐（detectRunIntent 会参考 RUN_TODO 做“续跑/短句”意图继承）
    intent: detectRunIntent({
      mode: useRunStore.getState().mode as any,
      userPrompt,
      mainDocRunIntent: (mainDoc as any)?.runIntent,
      runTodo: runTodoForPack,
    }),
  });
  const idSetRaw = new Set((activeSkillsRaw ?? []).map((s: any) => String(s?.id ?? "").trim()).filter(Boolean));
  const webTopicRadarActive = idSetRaw.has("web_topic_radar");

  // 与 Gateway 对齐：WebRadar 收集阶段 suppress style_imitate（避免误导模型抢跑进入风格闭环）
  const activeSkills = webTopicRadarActive
    ? (activeSkillsRaw ?? []).filter((s: any) => String(s?.id ?? "").trim() !== "style_imitate")
    : activeSkillsRaw;

  const skillsText = `ACTIVE_SKILLS(JSON):\n${JSON.stringify(activeSkills, null, 2)}\n\n`;

  const activeSkillIdSet = new Set((activeSkills ?? []).map((s: any) => String(s?.id ?? "").trim()).filter(Boolean));
  const styleSkillActive = activeSkillIdSet.has("style_imitate");

  const kbHint = webTopicRadarActive
    ? `提示：当前为“全网热点/素材收集（web_topic_radar）”。优先使用 web.search/web.fetch 完成素材收集；收集阶段不要调用 kb.search（尤其是风格库）。\n\n`
    : `提示：如需引用知识库内容，请调用工具 kb.search（默认只在已关联库中检索）。\n\n`;
  const kbText = `KB_SELECTED_LIBRARIES(JSON):\n${JSON.stringify(kbSelected, null, 2)}\n\n` + kbHint;

  // 关键：风格 playbook/写法候选等“强引导”上下文，只在写作闭环真正激活时注入。
  // （解决：仅做“搜索/盘点热点”时，绑定风格库也不应抢跑影响素材收集与选题广度）
  const allowInjectStyleContext = styleSkillActive && !webTopicRadarActive;

  const playbookSection = await (async () => {
    if (!allowInjectStyleContext) return "";
    const ids = Array.isArray(kbAttached) ? kbAttached.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [];
    const playbookText = await useKbStore
      .getState()
      .getPlaybookTextForLibraries(ids)
      .catch(() => "");
    if (!playbookText) return "";
    return (
      `KB_LIBRARY_PLAYBOOK(Markdown):\n${playbookText}\n\n` +
      `提示：上面已注入库级“仿写手册”（Style Profile + 维度写法）。如需更多原文证据/更多样例，再调用 kb.search。\n\n`
    );
  })();

  const styleClustersSection = await (async () => {
    // M3：从最新声音指纹快照提取“写法候选（子簇）”，用于写作前选定写法并写入 Main Doc
    if (!allowInjectStyleContext) return "";
    const styleLibs = kbSelected.filter((l: any) => String(l?.purpose ?? "").trim() === "style").slice(0, 4);
    if (!styleLibs.length) return "";
    const topicText = buildTopicTextForSelectorV1({ userPrompt, mainDoc });

    const payload: any[] = [];
    for (const lib of styleLibs) {
      const libId = String(lib?.id ?? "").trim();
      if (!libId) continue;
      const fpRet = await useKbStore.getState().getLatestLibraryFingerprint(libId).catch(() => ({ ok: false } as any));
      const snapshot = fpRet?.ok ? (fpRet as any).snapshot : null;
      const clustersRaw = Array.isArray(snapshot?.clustersV1) ? snapshot.clustersV1 : [];
      const cfg = await useKbStore.getState().getLibraryStyleConfig(libId).catch(() => ({ ok: false, anchors: [] } as any));
      const defaultClusterId = cfg?.ok ? (cfg as any).defaultClusterId : undefined;
      const recommendedClusterId = clustersRaw.length ? pickClusterSelectorV1({ clusters: clustersRaw, defaultClusterId, topicText }).selectedId : "";

      const clusters = clustersRaw
        .slice(0, 6)
        .map((c: any) => ({
          id: String(c?.id ?? "").trim(),
          label: String(c?.label ?? "").trim(),
          stability: String(c?.stability ?? "").trim(),
          segmentCount: Number(c?.segmentCount ?? 0) || 0,
          docCoverageCount: Number(c?.docCoverageCount ?? 0) || 0,
          docCoverageRate: Number(c?.docCoverageRate ?? 0) || 0,
          anchorsCount: Array.isArray(c?.anchors) ? c.anchors.length : 0,
          softRanges: {
            avgSentenceLen: (c?.softRanges as any)?.avgSentenceLen,
            questionRatePer100Sentences: (c?.softRanges as any)?.questionRatePer100Sentences,
            digitPer1kChars: (c?.softRanges as any)?.digitPer1kChars,
          },
          evidence: Array.isArray(c?.evidence) ? c.evidence.slice(0, 3).map((e: any) => String(e?.quote ?? "").trim()).filter(Boolean) : [],
          facetIds: Array.isArray(c?.facetPlan) ? c.facetPlan.map((f: any) => String(f?.facetId ?? "").trim()).filter(Boolean).slice(0, 8) : [],
        }))
        .filter((c: any) => c.id);

      payload.push({
        id: libId,
        name: String(lib?.name ?? libId),
        defaultClusterId: defaultClusterId ? String(defaultClusterId) : undefined,
        recommendedClusterId: recommendedClusterId || undefined,
        clusters,
      });
    }
    if (!payload.length) return "";
    return (
      `KB_STYLE_CLUSTERS(JSON):\n${JSON.stringify(payload, null, 2)}\n\n` +
      `提示：这是“写法候选（子簇）”摘要。系统可能已默认选定推荐写法继续写作；你也可随时改口切换（回复 clusterId 或 “写法A/写法B/写法C”）。\n\n`
    );
  })();

  const styleSelectorSection = await (async () => {
    // Selector v1：为“自动选簇/选卡”提供结构化输出，保证换生成模型也稳定可用
    if (!allowInjectStyleContext) return "";
    const styleSkillActive = Array.isArray(activeSkills) && activeSkills.some((s: any) => String(s?.id ?? "") === "style_imitate");
    if (!styleSkillActive) return "";
    const styleLibs = kbSelected.filter((l: any) => String(l?.purpose ?? "").trim() === "style").slice(0, 1);
    if (!styleLibs.length) return "";
    const lib = styleLibs[0];
    const libId = String(lib?.id ?? "").trim();
    if (!libId) return "";

    const fpRet = await useKbStore.getState().getLatestLibraryFingerprint(libId).catch(() => ({ ok: false } as any));
    const snapshot = fpRet?.ok ? (fpRet as any).snapshot : null;
    const clustersRaw = Array.isArray(snapshot?.clustersV1) ? snapshot.clustersV1 : [];
    if (!clustersRaw.length) return "";

    const cfg = await useKbStore.getState().getLibraryStyleConfig(libId).catch(() => ({ ok: false, anchors: [] } as any));
    const defaultClusterId = cfg?.ok ? String((cfg as any).defaultClusterId ?? "").trim() : "";

    const topicText = buildTopicTextForSelectorV1({ userPrompt, mainDoc });
    const topicBrief = topicBriefForKbQueryV1({ userPrompt, mainDoc });
    const autoPick = pickClusterSelectorV1({ clusters: clustersRaw, defaultClusterId, topicText });

    const existing: any = (mainDoc as any)?.styleContractV1 ?? null;
    const selectedByMainDoc =
      existing &&
      String(existing?.libraryId ?? "").trim() === libId &&
      String(existing?.selectedCluster?.id ?? "").trim().length > 0
        ? String(existing.selectedCluster.id).trim()
        : "";

    const selectedClusterId = selectedByMainDoc || String(autoPick.selectedId ?? "").trim();
    const byId = new Map(clustersRaw.map((c: any) => [String(c?.id ?? "").trim(), c]));
    const selected = selectedClusterId ? (byId.get(selectedClusterId) as any) : null;
    const stage = detectWritingStageV1({ userPrompt, todoList });
    const facetPackId = String(lib?.facetPackId ?? "speech_marketing_v1").trim() || "speech_marketing_v1";
    const facetPick = selected
      ? pickFacetsSelectorV1({
          facetPackId,
          cluster: selected,
          topicText,
          topicBrief,
          stageId: stage.id,
        })
      : { selected: [] as SelectedFacetV1[], trace: { method: "selector_v1_facets", stage: stage.id, k: 0, maxRawTopic: 0 } };
    const selectedFacets = facetPick.selected;
    const selectedFacetIds = selectedFacets.map((x) => x.facetId).filter(Boolean);

    const why: string[] = [];
    if (selectedByMainDoc) why.push("已按 Main Doc 锁定写法（用户可改口覆盖）。");
    const anchorsCount = selected && Array.isArray(selected?.anchors) ? selected.anchors.length : 0;
    if (anchorsCount > 0) why.push(`本簇已采纳 anchors：${anchorsCount} 段（优先“更像原文”）。`);
    if (autoPick.topicHits?.length) why.push(`话题命中关键词：${autoPick.topicHits.slice(0, 4).join("、")}`);
    why.push(`写作阶段：${stage.label}（${stage.by}）`);
    if (selectedFacetIds.length) why.push(`本次维度子集：${selectedFacetIds.length} 张（TopK，选出来就必须执行）`);
    const st = String(selected?.stability ?? "").trim();
    const cov = Number(selected?.docCoverageRate ?? 0) || 0;
    const seg = Number(selected?.segmentCount ?? 0) || 0;
    if (st || cov || seg) why.push(`稳定性=${st || "unknown"}；覆盖率=${Math.round(cov * 100)}%；段数=${seg}`);
    if (defaultClusterId && selectedClusterId === defaultClusterId) why.push("命中本库默认写法。");

    const facetCardsSection = await (async () => {
      if (!selectedFacetIds.length) return "";
      const ret = await useKbStore
        .getState()
        .getPlaybookFacetCardsForLibrary({ libraryId: libId, facetIds: selectedFacetIds, maxCharsPerCard: 1000, maxTotalChars: 6500 })
        .catch(() => ({ ok: false, cards: [] } as any));
      const cards = ret?.ok && Array.isArray(ret.cards) ? ret.cards : [];
      const body = cards
        .map((c: any) => String(c?.content ?? "").trim())
        .filter(Boolean)
        .join("\n\n");
      if (!body) return "";
      return (
        `STYLE_FACETS_SELECTED(Markdown):\n${body}\n\n` +
        `提示：以上为本次 Selector 选出的“维度卡子集”（只执行这些卡；不要自行扩展到 21 张）。如需更多原文证据，请调用 kb.search 并带 facetIds 过滤。\n\n`
      );
    })();

    const payload = {
      v: 2,
      libraryId: libId,
      libraryName: String(lib?.name ?? libId),
      facetPackId,
      selectedClusterId: selectedClusterId || null,
      selectedFacetIds,
      selectedFacets: selectedFacets.map((f) => ({
        facetId: f.facetId,
        label: f.label,
        why: f.why,
        kbQueries: f.kbQueries,
        score: f.score,
      })),
      stage,
      why: why.slice(0, 6),
      trace: {
        ...autoPick.trace,
        facets: facetPick.trace,
        selectedBy: selectedByMainDoc ? "mainDoc" : "auto",
        selectedClusterId: selectedClusterId || null,
      },
    };

    return `STYLE_SELECTOR(JSON):\n${JSON.stringify(payload, null, 2)}\n\n` + facetCardsSection;
  })();

  // Pending proposals：用于“proposal-first 不落盘”但仍可继续下一步（避免下一轮说‘没有初稿’）
  const pendingProposals = (() => {
    const steps = useRunStore.getState().steps ?? [];
    const out: Array<{ toolName: string; path?: string; note?: string }> = [];
    for (const st of steps as any[]) {
      if (!st || typeof st !== "object") continue;
      if (st.type !== "tool") continue;
      if (st.status !== "success") continue;
      if (st.applyPolicy !== "proposal") continue;
      if (st.applied === true) continue;
      if (st.status === "undone") continue;
      if (st.toolName === "doc.write") {
        out.push({
          toolName: "doc.write",
          path: typeof st.input?.path === "string" ? st.input.path : typeof st.output?.path === "string" ? st.output.path : undefined,
          note: typeof st.output?.preview?.note === "string" ? st.output.preview.note : undefined,
        });
        continue;
      }
      if (st.toolName === "doc.applyEdits") {
        out.push({
          toolName: "doc.applyEdits",
          path: typeof st.output?.path === "string" ? st.output.path : typeof st.input?.path === "string" ? st.input.path : undefined,
          note: typeof st.output?.preview?.note === "string" ? st.output.preview.note : undefined,
        });
        continue;
      }
      if (st.toolName === "doc.splitToDir") {
        out.push({
          toolName: "doc.splitToDir",
          path: typeof st.output?.targetDir === "string" ? st.output.targetDir : undefined,
          note: typeof st.output?.note === "string" ? st.output.note : undefined,
        });
        continue;
      }
      if (st.toolName === "doc.restoreSnapshot") {
        out.push({
          toolName: "doc.restoreSnapshot",
          path: typeof st.output?.preview?.path === "string" ? st.output.preview.path : undefined,
          note: typeof st.output?.note === "string" ? st.output.note : undefined,
        });
        continue;
      }
    }
    return out.slice(-20);
  })();
  const pendingSection = pendingProposals.length
    ? `PENDING_FILE_PROPOSALS(JSON):\n${JSON.stringify(pendingProposals, null, 2)}\n\n` +
      `提示：存在未 Keep 的“文件提案”。后续若调用 doc.read 读取对应文件，系统会优先返回“提案态最新内容”（不要求先 Keep）。\n\n`
    : "";

  const segments: ContextManifestSegmentV1[] = [];
  const parts: string[] = [];
  const pushSeg = (seg: {
    name: string;
    content: string;
    priority: ContextManifestPriorityV1;
    trusted: boolean;
    source: "desktop" | "gateway";
    truncated?: boolean;
    note?: string;
  }) => {
    const content = String(seg.content ?? "");
    parts.push(content);
    segments.push({
      name: seg.name,
      chars: content.length,
      priority: seg.priority,
      trusted: seg.trusted,
      truncated: Boolean(seg.truncated),
      source: seg.source,
      ...(seg.note ? { note: seg.note } : {}),
    });
  };

  // p0: 任务主线/约束（可信）
  pushSeg({
    name: "MAIN_DOC",
    content: `MAIN_DOC(JSON):\n${JSON.stringify(mainDoc, null, 2)}\n\n`,
    priority: "p0",
    trusted: true,
    source: "desktop",
  });
  pushSeg({
    name: "RUN_TODO",
    content: `RUN_TODO(JSON):\n${JSON.stringify(runTodoForPack, null, 2)}\n\n`,
    priority: "p0",
    trusted: true,
    source: "desktop",
  });
  pushSeg({
    name: "DOC_RULES",
    content: `DOC_RULES(Markdown):\n${docRules}\n\n`,
    priority: "p0",
    trusted: true,
    source: "desktop",
  });

  // p1: 最近对话/引用（引用视为不可信数据）
  if (recentDialogue) {
    pushSeg({ name: "RECENT_DIALOGUE", content: recentDialogue, priority: "p1", trusted: true, source: "desktop" });
  }
  if (refs) {
    pushSeg({ name: "REFERENCES", content: refs, priority: "p1", trusted: false, source: "desktop" });
  }

  // p1: KB 元信息（可信）；KB 正文（手册/卡片/样例）视为不可信数据（仅供参考，不可覆盖系统规则）
  pushSeg({ name: "KB_SELECTED_LIBRARIES", content: kbText, priority: "p1", trusted: true, source: "desktop" });
  pushSeg({ name: "ACTIVE_SKILLS", content: skillsText, priority: "p1", trusted: true, source: "desktop" });
  if (playbookSection) pushSeg({ name: "KB_LIBRARY_PLAYBOOK", content: playbookSection, priority: "p2", trusted: false, source: "desktop" });
  if (styleClustersSection) pushSeg({ name: "KB_STYLE_CLUSTERS", content: styleClustersSection, priority: "p2", trusted: false, source: "desktop" });
  if (styleSelectorSection) pushSeg({ name: "STYLE_SELECTOR", content: styleSelectorSection, priority: "p2", trusted: false, source: "desktop" });

  // p2: 提案态提示（可信）
  if (pendingSection) pushSeg({ name: "PENDING_FILE_PROPOSALS", content: pendingSection, priority: "p2", trusted: true, source: "desktop" });

  // p2: 选区（可信，但可能截断）
  pushSeg({
    name: "EDITOR_SELECTION",
    content: `EDITOR_SELECTION(JSON):\n${JSON.stringify(selection, null, 2)}\n\n`,
    priority: "p2",
    trusted: true,
    source: "desktop",
    truncated: Boolean((selection as any)?.truncated),
  });

  // p3: 项目状态最小信息（可信）
  pushSeg({
    name: "PROJECT_STATE",
    content: `PROJECT_STATE(JSON):\n${JSON.stringify(state, null, 2)}\n\n`,
    priority: "p3",
    trusted: true,
    source: "desktop",
  });
  pushSeg({
    name: "NOTES",
    content:
      `注意：\n` +
      `- 已提供当前编辑器选区（EDITOR_SELECTION）。若用户说“改写我选中的这段”，优先用该选区。\n` +
      `- 如需文件正文请调用 doc.read；如需刷新选区也可调用 doc.getSelection。\n` +
      `- 本次 Context Pack 仅注入少量最近对话片段（RECENT_DIALOGUE），不是完整历史；关键决策请写入 Main Doc（run.mainDoc.update），历史素材请用 @{} 显式引用。\n\n`,
    priority: "p3",
    trusted: true,
    source: "desktop",
  });

  const manifest = renderContextManifestV1({ mode: useRunStore.getState().mode as Mode, segments });
  return manifest + parts.join("");
}

function buildChatContextPack(extra?: { referencesText?: string }) {
  const proj = useProjectStore.getState();
  const docRules = proj.getFileByPath("doc.rules.md")?.content ?? "";
  const selection = (() => {
    const ed = proj.editorRef;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !model || !sel) {
      return { ok: false, hasSelection: false, reason: "NO_EDITOR" as const };
    }
    const fullText = model.getValueInRange(sel);
    const maxChars = 4000;
    const truncated = fullText.length > maxChars;
    const selectedText = truncated ? fullText.slice(0, maxChars) : fullText;
    if (!fullText.length) return { ok: true, hasSelection: false, reason: "EMPTY_SELECTION" as const };
    return {
      ok: true,
      hasSelection: true,
      path: proj.activePath,
      selectedChars: fullText.length,
      truncated,
      range: {
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      },
      selectedText,
    };
  })();
  const refs = extra?.referencesText ? `${extra.referencesText}\n\n` : "";
  const segments: ContextManifestSegmentV1[] = [];
  const parts: string[] = [];
  const pushSeg = (seg: {
    name: string;
    content: string;
    priority: ContextManifestPriorityV1;
    trusted: boolean;
    source: "desktop" | "gateway";
    truncated?: boolean;
    note?: string;
  }) => {
    const content = String(seg.content ?? "");
    parts.push(content);
    segments.push({
      name: seg.name,
      chars: content.length,
      priority: seg.priority,
      trusted: seg.trusted,
      truncated: Boolean(seg.truncated),
      source: seg.source,
      ...(seg.note ? { note: seg.note } : {}),
    });
  };

  pushSeg({ name: "DOC_RULES", content: `DOC_RULES(Markdown):\n${docRules}\n\n`, priority: "p0", trusted: true, source: "desktop" });
  if (refs) pushSeg({ name: "REFERENCES", content: refs, priority: "p1", trusted: false, source: "desktop" });
  pushSeg({
    name: "EDITOR_SELECTION",
    content: `EDITOR_SELECTION(JSON):\n${JSON.stringify(selection, null, 2)}\n`,
    priority: "p1",
    trusted: true,
    source: "desktop",
    truncated: Boolean((selection as any)?.truncated),
  });

  const manifest = renderContextManifestV1({ mode: "chat", segments });
  return manifest + parts.join("");
}

async function fetchChatStream(args: {
  gatewayUrl: string;
  model: string;
  messages: ChatMessage[];
  abort: AbortController;
  onDelta: (delta: string) => void;
  log: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
}) {
  const doFetch = async (baseUrl: string) => {
    const url = baseUrl ? `${baseUrl}/api/llm/chat/stream` : "/api/llm/chat/stream";
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
      }),
      signal: args.abort.signal,
    });
  };

  let res: Response | null = null;
  try {
    res = await doFetch(args.gatewayUrl);
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    if (msg.includes("Failed to fetch") && args.gatewayUrl.includes("localhost")) {
      const fallback = args.gatewayUrl.replace("localhost", "127.0.0.1");
      args.log("warn", "gateway.fetch_retry", { from: args.gatewayUrl, to: fallback });
      res = await doFetch(fallback);
    } else {
      throw e;
    }
  }

  args.log("info", "gateway.response", { status: res.status });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    return { ok: false as const, error: text || `HTTP_${res.status}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltaCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const evt = parseSseBlock(block);
      if (!evt) {
        idx = buffer.indexOf("\n\n");
        continue;
      }

      if (evt.event === "assistant.delta") {
        try {
          const payload = JSON.parse(evt.data);
          const delta = payload?.delta;
          if (typeof delta === "string") {
            deltaCount += 1;
            args.onDelta(delta);
          }
        } catch {
          // ignore
        }
      }

      if (evt.event === "assistant.done") {
        return { ok: true as const, deltaCount };
      }

      if (evt.event === "error") {
        try {
          const payload = JSON.parse(evt.data);
          const msg = payload?.error ? String(payload.error) : "unknown";
          return { ok: false as const, error: msg };
        } catch {
          return { ok: false as const, error: String(evt.data) };
        }
      }

      idx = buffer.indexOf("\n\n");
    }
  }

  return { ok: true as const, deltaCount, endedWithoutDone: true as const };
}

export function startGatewayRun(args: {
  gatewayUrl: string;
  mode: Mode;
  model: string;
  prompt: string;
}): GatewayRunController {
  const {
    setRunning,
    setActivity,
    addAssistant,
    appendAssistantDelta,
    finishAssistant,
    patchAssistant,
    addTool,
    patchTool,
    updateMainDoc,
    log
  } = useRunStore.getState();

  setRunning(true);
  setActivity("正在构建上下文…", { resetTimer: true });
  // 不要每轮覆盖 goal：只在为空时初始化（后续由 run.mainDoc.update 维护主线）
  // 关键：不要把整段长原文/长 prompt 塞进 Main Doc（会每轮注入 Context Pack，导致仿写手册/约束被淹没，输出变差）
  const cur = useRunStore.getState().mainDoc;
  if (!cur.goal) {
    const raw = String(args.prompt ?? "").trim();
    const oneLine = raw.replace(/\s+/g, " ");
    const max = 180;
    const short = oneLine.length > max ? oneLine.slice(0, max) + "…（已截断；原始输入见置顶回合/历史）" : oneLine;
    updateMainDoc({ goal: short });
  }

  // 用户偏好：lint 不过就保留最高分（写入 Main Doc，跨本轮对话生效）
  const wantsKeepBestOnLintFail =
    /(lint|linter|风格(对齐|校验|检查)).{0,30}(不过|不通过).{0,30}(保留|留下|用).{0,30}(最高分|最好|最佳)/i.test(
      String(args.prompt ?? ""),
    );
  if (wantsKeepBestOnLintFail) updateMainDoc({ styleLintFailPolicy: "keep_best" });

  const abort = new AbortController();
  let currentAssistantId: string | null = null;

  (async () => {
    log("info", "gateway.run.start", { gatewayUrl: args.gatewayUrl, model: args.model, mode: args.mode });
    try {
      let promptForGateway = String(args.prompt ?? "");
      const promptRefs = parseRefsFromPrompt(args.prompt);
      // refs：以“常驻 ctxRefs”为主；本轮 prompt 里的 @{} 作为增量补充
      const pinned = (useRunStore.getState().ctxRefs ?? []).map((r: any) => ({
        kind: r?.kind === "dir" ? ("dir" as const) : ("file" as const),
        path: String(r?.path ?? "").trim(),
      }));
      const effectiveRefs = (() => {
        const seen = new Set<string>();
        const out: Ref[] = [];
        const push = (r: Ref) => {
          const kind = r.kind === "dir" ? "dir" : "file";
          let p = String(r.path ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
          p = p.replace(/\/+/g, "/");
          if (!p) return;
          if (kind === "dir") p = p.replace(/\/+$/g, "");
          else p = p.replace(/\/+$/g, "");
          const key = `${kind}:${p}`;
          if (seen.has(key)) return;
          seen.add(key);
          out.push({ kind, path: p });
        };
        for (const r of pinned) push(r);
        for (const r of promptRefs) push(r);
        return out;
      })();
      // 把 prompt refs “钉”到 ctxRefs（避免下一轮只回“继续”时丢上下文）
      if (promptRefs.length) {
        for (const r of promptRefs) useRunStore.getState().addCtxRef({ kind: r.kind, path: r.path } as any);
      }
      const referencesText = await buildReferencesTextFromRefs(effectiveRefs).catch(() => "");
      setActivity("正在构建上下文…");
      // 尽量确保 doc.rules 与 activePath 已加载，避免“上下文不对”（空规则/空正文）
      const proj = useProjectStore.getState();
      const docRulesPath = proj.getFileByPath("doc.rules.md")?.path;
      if (docRulesPath) {
        await proj.ensureLoaded(docRulesPath).catch(() => void 0);
      }
      if (proj.activePath) {
        await proj.ensureLoaded(proj.activePath).catch(() => void 0);
      }

      // 关键：确保 KB 库列表（含 purpose=style 等元信息）已刷新，否则 Context Pack 里可能注入不到风格库用途，导致 Gateway 不开启“风格库强闭环闸门”
      const kb = useKbStore.getState();
      const attached = useRunStore.getState().kbAttachedLibraryIds ?? [];
      if (Array.isArray(attached) && attached.length) {
        await kb.refreshLibraries().catch(() => void 0);
      }

      // Selector v1：写作任务默认自动选簇并写入 styleContractV1（可改口、可解释、与生成模型解耦）
      // - 不再强制 clarify_waiting 卡住用户
      // - 但用户仍可随时改口（写法A/B/C 或 cluster_0/1/2）
      try {
        const run = useRunStore.getState();
        const main: any = run.mainDoc ?? {};
        const existing = main?.styleContractV1;
        const libsMeta = useKbStore.getState().libraries ?? [];
        const metaById = new Map(libsMeta.map((l: any) => [String(l?.id ?? "").trim(), l]));
        const styleLibIds = (run.kbAttachedLibraryIds ?? [])
          .map((x: any) => String(x ?? "").trim())
          .filter(Boolean)
          .filter((id: string) => String((metaById.get(id) as any)?.purpose ?? "").trim() === "style");
        const libId = styleLibIds.length ? styleLibIds[0] : "";

        const existingLibId = String(existing?.libraryId ?? "").trim();
        const existingClusterId = String(existing?.selectedCluster?.id ?? "").trim();
        const shouldConsider = libId && (!existing || existingLibId !== libId || !existingClusterId);
        if (shouldConsider) {
          // 仅在“本轮会激活 style_imitate skill（写作/改写/润色类）”时才自动写入，避免非写作任务被误导
          const kbSelectedForSkills = (run.kbAttachedLibraryIds ?? [])
            .map((id: any) => String(id ?? "").trim())
            .filter(Boolean)
            .map((id: string) => {
              const m = metaById.get(id) as any;
              return { id, purpose: String(m?.purpose ?? "material") };
            });
          const activeForThisRun = activateSkills({
            mode: args.mode as any,
            userPrompt: String(args.prompt ?? ""),
            mainDocRunIntent: main?.runIntent,
            kbSelected: kbSelectedForSkills as any,
          });
          const hasStyleSkill = activeForThisRun.some((s: any) => String(s?.id ?? "") === "style_imitate");
          if (!hasStyleSkill) {
            // 非写作任务：不自动写入 styleContract
          } else {
            const fpRet = await useKbStore.getState().getLatestLibraryFingerprint(libId).catch(() => ({ ok: false } as any));
            const snapshot = fpRet?.ok ? (fpRet as any).snapshot : null;
            const clusters = Array.isArray(snapshot?.clustersV1) ? snapshot.clustersV1 : [];
            const cfg = await useKbStore.getState().getLibraryStyleConfig(libId).catch(() => ({ ok: false, anchors: [] } as any));
            const defaultClusterId = cfg?.ok ? String((cfg as any).defaultClusterId ?? "").trim() : "";

            if (clusters.length) {
              const prompt = String(args.prompt ?? "").trim();
              const topicText = buildTopicTextForSelectorV1({ userPrompt: prompt, mainDoc: main });
              const pickedByPrompt = (() => {
              // 1) 用户直接输入 clusterId（最稳）
              const m = prompt.match(/\b(cluster[_-]\d+)\b/i);
              if (m?.[1]) {
                const cid = String(m[1]).replace("-", "_");
                const byId = new Map(clusters.map((c: any) => [String(c?.id ?? "").trim(), c]));
                if (byId.get(cid)) return byId.get(cid);
              }
              // 2) 用户输入“写法A/B/C”
              const m2 = prompt.match(/写法\s*([ABC])\b/i);
              if (m2?.[1]) {
                const letter = String(m2[1]).toUpperCase();
                const label = `写法${letter}`;
                const hit = clusters.find((c: any) => String(c?.label ?? "").includes(label));
                if (hit) return hit;
              }
              // 3) 用户输入“继续/按推荐/就用推荐”：接受推荐写法
              if (/^(继续|按推荐|用推荐|就用推荐|默认就行)$/i.test(prompt)) {
                // 下面会走 pickRecommended
                return "__USE_RECOMMENDED__" as any;
              }
              return null;
              })();

              const byId = new Map(clusters.map((c: any) => [String(c?.id ?? "").trim(), c]));
              let picked: any = null;
              if (pickedByPrompt && pickedByPrompt !== "__USE_RECOMMENDED__") picked = pickedByPrompt;
              if (!picked) {
                const auto = pickClusterSelectorV1({ clusters, defaultClusterId, topicText });
                if (auto?.selectedId && byId.get(String(auto.selectedId).trim())) picked = byId.get(String(auto.selectedId).trim());
              }

              if (picked) {
                const meta = metaById.get(libId) as any;
                // 关键修正：用户回复“写法C/写法B/cluster_2”时，不要把这句话原样当成 userPrompt 交给模型；
                // 否则模型可能把“写法C”误解为“C语言”，跑偏到编程话题。
                // 这里把 prompt 改写成“继续（已选 cluster_x）”，并依赖 Main Doc 里的 goal + styleContractV1 继续写作闭环。
                const pickedId = String(picked?.id ?? "").trim();
                if (pickedId) {
                  const raw = String(args.prompt ?? "").trim();
                  const looksLikePureChoice =
                    raw.length <= 16 &&
                    (/^(写法\s*[ABC]\b|cluster[_-]\d+\b|继续|按推荐|用推荐|就用推荐|默认就行)[\s。！？!]*$/i.test(raw) ||
                      /^就用写法\s*[ABC]\b[\s。！？!]*$/i.test(raw));
                  if (looksLikePureChoice) {
                    promptForGateway = `继续（已选 ${pickedId}）`;
                  }
                }
                updateMainDoc({
                  styleContractV1: {
                    v: 1,
                    updatedAt: new Date().toISOString(),
                    libraryId: libId,
                    libraryName: String(meta?.name ?? libId),
                    selectedCluster: {
                      id: String(picked?.id ?? "").trim(),
                      label: String(picked?.label ?? "").trim(),
                    },
                    anchors: Array.isArray(picked?.anchors) ? picked.anchors.slice(0, 8) : [],
                    evidence: Array.isArray(picked?.evidence) ? picked.evidence.slice(0, 5) : [],
                    softRanges: picked?.softRanges ?? {},
                    facetPlan: Array.isArray(picked?.facetPlan) ? picked.facetPlan.slice(0, 8) : [],
                    queries: Array.isArray(picked?.queries) ? picked.queries.slice(0, 8) : [],
                  },
                } as any);
              }
            }
          }
        }
      } catch {
        // ignore：仅是“默认写法预填充”，失败不影响 run
      }

      // 记录 Context Pack 摘要（便于排查“上下文不对/自动终止”）
      try {
        const todo = useRunStore.getState().todoList ?? [];
        const done = todo.filter((t) => t.status === "done").length;
        const refs = effectiveRefs;
        const kbLibCount = (useKbStore.getState().libraries ?? []).length;
        const pendingProposals = (() => {
          const steps = useRunStore.getState().steps ?? [];
          const out: Array<{ toolName: string; path?: string }> = [];
          for (const st of steps as any[]) {
            if (!st || typeof st !== "object") continue;
            if (st.type !== "tool") continue;
            if (st.status !== "success") continue;
            if (st.applyPolicy !== "proposal") continue;
            if (st.applied === true) continue;
            if (st.status === "undone") continue;
            if (st.toolName === "doc.write") {
              out.push({
                toolName: "doc.write",
                path: typeof st.input?.path === "string" ? st.input.path : typeof st.output?.path === "string" ? st.output.path : undefined,
              });
              continue;
            }
            if (st.toolName === "doc.applyEdits") {
              out.push({
                toolName: "doc.applyEdits",
                path: typeof st.output?.path === "string" ? st.output.path : typeof st.input?.path === "string" ? st.input.path : undefined,
              });
              continue;
            }
            if (st.toolName === "doc.splitToDir") {
              out.push({
                toolName: "doc.splitToDir",
                path: typeof st.output?.targetDir === "string" ? st.output.targetDir : undefined,
              });
              continue;
            }
            if (st.toolName === "doc.restoreSnapshot") {
              out.push({
                toolName: "doc.restoreSnapshot",
                path: typeof st.output?.preview?.path === "string" ? st.output.preview.path : undefined,
              });
              continue;
            }
          }
          return out.slice(-20);
        })();
        const ed = proj.editorRef;
        const hasSelection = (() => {
          const model = ed?.getModel();
          const sel = ed?.getSelection();
          if (!ed || !model || !sel) return false;
          return model.getValueInRange(sel).length > 0;
        })();
        const docRulesChars = proj.getFileByPath("doc.rules.md")?.content?.length ?? 0;
        log("info", "context.pack.summary", {
          mode: args.mode,
          model: args.model,
          activePath: proj.activePath,
          openPaths: proj.openPaths?.length ?? 0,
          fileCount: proj.files?.length ?? 0,
          docRulesChars,
          refs: refs.map((r) => ({ kind: r.kind, path: r.path })),
          todo: { done, total: todo.length },
          pendingProposals: { total: pendingProposals.length, tail: pendingProposals.slice(-6) },
          hasSelection,
        });
      } catch {
        // ignore
      }

      // Chat：也走 Gateway 的 /api/agent/run/stream（mode=chat），允许只读工具（读文档/读项目/读网页），禁止任何写入/副作用工具。

      // Plan/Agent：改为走 Gateway 的 /api/agent/run/stream（Gateway 负责 ReAct 循环；Desktop 负责执行工具并回传 tool_result）
      const url = args.gatewayUrl ? `${args.gatewayUrl}/api/agent/run/stream` : "/api/agent/run/stream";

      setActivity("正在请求模型…", { resetTimer: true });
      // toolSidecar：用于“工具逐步迁回 Gateway”时携带必要的本地只读上下文（不注入模型 messages，避免 token 爆炸）
      const toolSidecar = await (async () => {
        const proj = useProjectStore.getState();
        const projectFiles = (proj.files ?? [])
          .map((f: any) => ({ path: String(f?.path ?? "").trim() }))
          .filter((f: any) => f.path)
          .slice(0, 5000);
        const docRulesFile = proj.getFileByPath("doc.rules.md");
        const docRules = docRulesFile ? { path: docRulesFile.path, content: docRulesFile.content ?? "" } : null;

        const attached = useRunStore.getState().kbAttachedLibraryIds ?? [];
        let styleLinterLibraries: any[] | undefined = undefined;
        if (Array.isArray(attached) && attached.length) {
          // 仅携带风格库的 lint 所需 payload（stats/ngrams/samples）；非风格库不带
          const ret = await buildStyleLinterLibrariesSidecar({ maxLibraries: 6 }).catch(() => ({ ok: false } as any));
          if (ret?.ok && Array.isArray(ret.libraries) && ret.libraries.length) styleLinterLibraries = ret.libraries;
        }

        // ideSummary：用于 Gateway 侧的 Intent Router/澄清（不注入模型 messages，避免“光标文件/默认文件”过强暗示）。
        // 仅提供最小元信息（不含正文/不含 openPaths 列表）。
        const ed = proj.editorRef;
        const { hasSelection, selectionChars } = (() => {
          const model = ed?.getModel();
          const sel = ed?.getSelection();
          if (!ed || !model || !sel) return { hasSelection: false, selectionChars: 0 };
          const n = model.getValueInRange(sel).length;
          return { hasSelection: n > 0, selectionChars: n };
        })();
        const ideSummary = {
          activePath: proj.activePath ?? null,
          openPaths: proj.openPaths?.length ?? 0,
          fileCount: proj.files?.length ?? 0,
          hasSelection,
          selectionChars,
        };

        const out: any = { projectFiles, docRules, ideSummary };
        if (styleLinterLibraries) out.styleLinterLibraries = styleLinterLibraries;
        return out;
      })();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: args.model,
          mode: args.mode,
          prompt: promptForGateway,
          contextPack:
            args.mode === "chat"
              ? buildChatContextPack({ referencesText })
              : await buildContextPack({ referencesText, userPrompt: promptForGateway }),
          toolSidecar,
        }),
        signal: abort.signal,
      });

      log("info", "gateway.agent.response", { status: res.status });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const a = addAssistant("", false, false);
        patchAssistant(a, { hidden: false });
        appendAssistantDelta(a, `\n\n[Gateway 错误] ${text || `HTTP_${res.status}`}`);
        finishAssistant(a);
        setRunning(false);
        setActivity(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let runId: string | null = null;
      let assistantId: string | null = null;
      // 关键：toolCallId 是“与 Gateway 对齐的相关 ID”，不应直接当作 UI step.id（会跨回合重复：1/2/3…）
      // 仅用于 gateway-executed tools：tool.call 创建占位 step，tool.result 回填时需要找到对应 stepId。
      const gatewayToolStepIdsByCallId = new Map<string, string[]>();

      const ensureAssistant = () => {
        if (assistantId) return assistantId;
        assistantId = addAssistant("", true, false);
        currentAssistantId = assistantId;
        return assistantId;
      };

      const postToolResult = async (payload: any) => {
        if (!runId) return;
        const postUrl = args.gatewayUrl
          ? `${args.gatewayUrl}/api/agent/run/${runId}/tool_result`
          : `/api/agent/run/${runId}/tool_result`;
        await fetch(postUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: abort.signal,
        });
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const evt = parseSseBlock(block);
          if (!evt) {
            idx = buffer.indexOf("\n\n");
            continue;
          }

          if (evt.event === "run.start") {
            try {
              const payload = JSON.parse(evt.data);
              runId = payload?.runId ? String(payload.runId) : runId;
              log("info", "agent.run.start", payload);
            } catch {
              log("info", "agent.run.start", evt.data);
            }
          }

          if (evt.event === "run.end") {
            log("info", "agent.run.end", evt.data);
            // 关键：Gateway 已明确结束本次 Run（包括 clarify_waiting / proposal_waiting 等“等待用户”的结束态）
            // UI 必须立刻停下来，否则底部会错误显示“正在生成/可停止”。
            setRunning(false);
            setActivity(null);
          }

          if (evt.event === "policy.decision") {
            try {
              const payload = JSON.parse(evt.data);
              log("info", "policy.decision", payload);
            } catch {
              log("info", "policy.decision", evt.data);
            }
          }

          if (evt.event === "run.notice") {
            try {
              const payload = JSON.parse(evt.data);
              const kind0 = String(payload?.kind ?? "info").trim().toLowerCase();
              const level = kind0 === "error" ? "error" : kind0 === "warn" ? "warn" : "info";
              log(level as any, "run.notice", payload);
              const title = String(payload?.title ?? "").trim();
              if (useRunStore.getState().isRunning && title) {
                // 关键：内部策略提示不应作为“输出气泡”刷屏；用 ActivityBar 提示即可。
                setActivity(`系统：${title}`, { resetTimer: true });
              }
            } catch {
              log("info", "run.notice", evt.data);
              if (useRunStore.getState().isRunning) setActivity("系统：正在自动调整流程…", { resetTimer: true });
            }
          }

          if (evt.event === "assistant.start") {
            // SSE 强边界：Gateway 会在每次模型调用前发 assistant.start(turn)
            // - 用于强制切分“回合边界”，避免下一轮 delta 追加到上一条 assistant 气泡
            // - 兼容旧实现：如果 Gateway 不发 assistant.start，本地仍会在首个 delta 时创建气泡
            try {
              const payload = JSON.parse(evt.data);
              log("info", "assistant.start", payload);
            } catch {
              log("info", "assistant.start", evt.data);
            }
            if (assistantId) finishAssistant(assistantId);
            assistantId = null;
            if (useRunStore.getState().isRunning) setActivity("正在生成…");
          }

          if (evt.event === "assistant.delta") {
            try {
              const payload = JSON.parse(evt.data);
              const delta = payload?.delta;
              if (typeof delta === "string" && delta.length) {
                // 一旦开始输出正文，更新状态（避免用户以为卡住）
                setActivity("正在生成…");
                const id = ensureAssistant();
                appendAssistantDelta(id, delta);
              }
            } catch {
              // ignore
            }
          }

          if (evt.event === "assistant.done") {
            if (assistantId) finishAssistant(assistantId);
            assistantId = null;
            // 一个 assistant 气泡结束后，先标记“继续运行中”，直到 run.end 或下一个 tool.call
            if (useRunStore.getState().isRunning) setActivity("正在继续…");
          }

          if (evt.event === "tool.call") {
            let payload: any = null;
            try {
              payload = JSON.parse(evt.data);
            } catch {
              payload = null;
            }
            const toolCallId = String(payload?.toolCallId ?? "");
            const name = String(payload?.name ?? "");
            const rawArgs = (payload?.args ?? {}) as Record<string, string>;
            const executedBy = String(payload?.executedBy ?? "desktop");

            log("info", "tool.call", { toolCallId, name });
            setActivity(executedBy === "gateway" ? `正在等待 Gateway 执行工具：${name}…` : `正在执行工具：${name}…`, { resetTimer: true });

            // 兼容：旧实现里 Gateway 可能不会在每次模型调用结束都发 assistant.done（现在 tool_calls 分支也会发）。
            // 如果此时不手动结束当前 assistant 气泡，后续新的 assistant.delta 会继续追加到“上面那条气泡”，
            // 造成视觉上“工具卡片插入后，内容在中间继续生成/自动滚动失效”。
            if (assistantId) {
              finishAssistant(assistantId);
              assistantId = null;
            }

            // Gateway 执行：Desktop 只创建占位 ToolBlock（running），等待 tool.result 回填，不执行本地工具也不回传 tool_result。
            if (executedBy === "gateway") {
              const def = getTool(name);
              const parsedArgs = parseSseToolArgs(rawArgs);
              const stepId = addTool({
                toolName: name,
                status: "running",
                input: parsedArgs,
                output: null,
                riskLevel: def?.riskLevel ?? "high",
                applyPolicy: def?.applyPolicy ?? "proposal",
                undoable: false,
                kept: false,
                applied: false,
              });
              if (toolCallId) {
                const q = gatewayToolStepIdsByCallId.get(toolCallId) ?? [];
                q.push(stepId);
                gatewayToolStepIdsByCallId.set(toolCallId, q);
              }
              continue;
            }

            const exec = await executeToolCall({ toolName: name, rawArgs, mode: args.mode });
            const def = exec.def;
            const stepApplyPolicy =
              exec.result.ok ? exec.result.applyPolicy ?? def?.applyPolicy ?? "proposal" : def?.applyPolicy ?? "proposal";
            const stepRiskLevel =
              exec.result.ok ? exec.result.riskLevel ?? def?.riskLevel ?? "high" : def?.riskLevel ?? "high";
            const initialKept = stepApplyPolicy === "auto_apply";

            const stepId = addTool({
              toolName: name,
              status: exec.result.ok ? "success" : "failed",
              input: exec.parsedArgs,
              output: exec.result.ok ? exec.result.output : { ok: false, error: exec.result.error },
              riskLevel: stepRiskLevel,
              applyPolicy: stepApplyPolicy,
              undoable: exec.result.ok ? exec.result.undoable : false,
              undo: exec.result.ok ? exec.result.undo : undefined,
              apply: exec.result.ok ? exec.result.apply : undefined,
              kept: initialKept,
              applied: stepApplyPolicy === "auto_apply",
            });
            void stepId;

            await postToolResult({
              toolCallId,
              name,
              ok: exec.result.ok,
              output: exec.result.ok ? exec.result.output : { ok: false, error: exec.result.error },
              meta: {
                applyPolicy: stepApplyPolicy,
                riskLevel: stepRiskLevel,
                hasApply: exec.result.ok ? typeof exec.result.apply === "function" : false,
              },
            });
            if (useRunStore.getState().isRunning) setActivity("正在等待模型继续…", { resetTimer: true });
          }

          if (evt.event === "tool.result") {
            // server-side tool：tool.call 只占位（running），tool.result 在这里回填
            try {
              const payload = JSON.parse(evt.data);
              const toolCallId = String(payload?.toolCallId ?? "");
              const ok0 = Boolean(payload?.ok);
              const out = payload?.output;
              const meta = payload?.meta ?? null;
              if (toolCallId) {
                const q = gatewayToolStepIdsByCallId.get(toolCallId) ?? [];
                const stepId = q.length ? q[0] : "";
                const st = stepId
                  ? (useRunStore.getState().steps ?? []).find((s: any) => s && s.type === "tool" && s.id === stepId)
                  : null;
                if (st && st.type === "tool" && st.status === "running") {
                  patchTool(stepId, {
                    status: ok0 ? "success" : "failed",
                    output: out,
                    ...(meta && typeof meta === "object"
                      ? {
                          applyPolicy: (meta as any).applyPolicy ?? st.applyPolicy,
                          riskLevel: (meta as any).riskLevel ?? st.riskLevel,
                        }
                      : {}),
                  });
                  // 出队：避免同一个 toolCallId（跨回合复用 1/2/3…）导致映射错误或无限增长
                  if (q.length) q.shift();
                  if (q.length) gatewayToolStepIdsByCallId.set(toolCallId, q);
                  else gatewayToolStepIdsByCallId.delete(toolCallId);
                  if (useRunStore.getState().isRunning) setActivity("正在等待模型继续…", { resetTimer: true });
                }
              }
              log("info", "tool.result", payload);
            } catch {
              log("info", "tool.result", evt.data);
            }
          }

          if (evt.event === "error") {
            try {
              const payload = JSON.parse(evt.data);
              const msg = payload?.error ? String(payload.error) : "unknown";
              const id = ensureAssistant();
              patchAssistant(id, { hidden: false });
              appendAssistantDelta(id, `\n\n[模型错误] ${msg}`);
              finishAssistant(id);
            } catch {
              const id = ensureAssistant();
              patchAssistant(id, { hidden: false });
              appendAssistantDelta(id, `\n\n[模型错误] ${evt.data}`);
              finishAssistant(id);
            }
            setRunning(false);
            setActivity(null);
            return;
          }

          idx = buffer.indexOf("\n\n");
        }
      }

      setRunning(false);
      setActivity(null);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      // 用户点击“停止/取消”会触发 AbortController.abort；这不应显示为“网络错误”
      const aborted =
        abort.signal.aborted ||
        String(e?.name ?? "") === "AbortError" ||
        /BodyStreamBuffer was aborted/i.test(msg) ||
        /\baborted\b/i.test(msg);
      if (aborted) {
        log("info", "gateway.run.aborted", { message: msg });
        setRunning(false);
        setActivity(null);
        if (currentAssistantId) {
          finishAssistant(currentAssistantId);
          currentAssistantId = null;
        }
        return;
      }

      log("error", "gateway.network_error", { message: msg });
      const a = currentAssistantId ?? addAssistant("", false, false);
      patchAssistant(a, { hidden: false });
      appendAssistantDelta(a, `\n\n[网络错误] ${msg}`);
      finishAssistant(a);
      setRunning(false);
      setActivity(null);
    }
  })();

  return {
    cancel: () => {
      log("warn", "gateway.run.cancel");
      abort.abort();
      setRunning(false);
      setActivity(null);
      if (currentAssistantId) {
        finishAssistant(currentAssistantId);
        currentAssistantId = null;
      }
    }
  };
}


