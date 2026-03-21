import type { SkillManifest } from "@ohmycrab/agent-core";
import type { McpSidecarServer, ToolCatalogEntry } from "./toolCatalog.js";
import { detectPromptCapabilities } from "./toolCatalog.js";

export type CapabilityCardResultType = "mcp_capability" | "skill";
export type McpCapabilityFamily = "browser" | "search" | "word" | "spreadsheet" | "pdf" | "custom";
export type CapabilitySearchReason = string;

type SearchableCardBase = {
  id: string;
  title: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  tags: string[];
  examples: string[];
  searchText: string;
};

export type McpCapabilityToolDetail = {
  name: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  capabilities: string[];
  inputSchema?: Record<string, unknown>;
};

export type McpCapabilityCard = SearchableCardBase & {
  resultType: "mcp_capability";
  serverId: string;
  serverName: string;
  family: McpCapabilityFamily;
  authState: "ready" | "needs_auth" | "error" | "unknown";
  toolCount: number;
  tools: McpCapabilityToolDetail[];
};

export type SkillCard = SearchableCardBase & {
  resultType: "skill";
  skillId: string;
  skillKind: "workflow" | "hint" | "service" | "pipeline" | "unknown";
  activationMode: "auto" | "explicit" | "hybrid" | "unknown";
  source: "builtin" | "standard" | "user" | "admin" | "unknown";
  requires: string[];
  conflicts: string[];
  autoEnable: boolean;
  userInvocable: boolean;
  portable: boolean;
  disableModelInvocation: boolean;
  slashCommand?: string;
  argumentHint?: string;
  allowedTools: string[];
  promptSummary?: string;
  workflowSummary?: string;
};

export type BridgeSkillDescriptor = {
  id: string;
  title?: string;
  description: string;
  allowedTools?: string[];
  portable?: boolean;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  activationMode?: SkillCard["activationMode"];
  source?: SkillCard["source"];
};

export type CapabilityCard = McpCapabilityCard | SkillCard;

export type CapabilitySearchResult = {
  card: CapabilityCard;
  score: number;
  reasons: CapabilitySearchReason[];
};

function tokenize(text: string): string[] {
  const s = String(text ?? "").toLowerCase();
  if (!s.trim()) return [];

  const out: string[] = [];
  const ascii = s.match(/[a-z0-9_:-]+/g);
  if (ascii) out.push(...ascii);

  const cjk = s.match(/[\u4e00-\u9fff]+/g);
  if (cjk) {
    for (const seg of cjk) {
      const t = seg.trim();
      if (!t) continue;
      out.push(t);
      if (t.length <= 1) continue;
      for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    }
  }

  return out.filter(Boolean).slice(0, 160);
}

function bm25Score(args: {
  docs: Array<{ id: string; tokens: string[] }>;
  queryTokens: string[];
}): Map<string, number> {
  const docs = args.docs;
  const q = Array.from(new Set(args.queryTokens)).filter(Boolean);
  const scores = new Map<string, number>();
  if (docs.length === 0 || q.length === 0) return scores;

  const k1 = 1.2;
  const b = 0.75;

  const df = new Map<string, number>();
  let totalLen = 0;
  const tfByDoc = new Map<string, Map<string, number>>();

  for (const d of docs) {
    const tfs = new Map<string, number>();
    totalLen += d.tokens.length;
    const seen = new Set<string>();
    for (const t of d.tokens) {
      tfs.set(t, (tfs.get(t) ?? 0) + 1);
      if (!seen.has(t)) {
        df.set(t, (df.get(t) ?? 0) + 1);
        seen.add(t);
      }
    }
    tfByDoc.set(d.id, tfs);
  }

  const avgdl = totalLen / Math.max(1, docs.length);
  const nDocs = docs.length;

  for (const d of docs) {
    const dl = d.tokens.length;
    const tfs = tfByDoc.get(d.id) ?? new Map<string, number>();
    let score = 0;

    for (const term of q) {
      const tf = tfs.get(term) ?? 0;
      if (tf <= 0) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (nDocs - n + 0.5) / (n + 0.5));
      const denom = tf + k1 * (1 - b + b * (dl / Math.max(1e-6, avgdl)));
      score += idf * (tf * (k1 + 1)) / denom;
    }

    if (score > 0) scores.set(d.id, score);
  }

  return scores;
}

function familyFromCapabilities(capabilities: string[]): McpCapabilityFamily {
  const caps = new Set((capabilities ?? []).map((x) => String(x ?? "").trim()));
  if (caps.has("browser_open")) return "browser";
  if (caps.has("mcp_word_doc")) return "word";
  if (caps.has("mcp_spreadsheet")) return "spreadsheet";
  if (caps.has("mcp_pdf")) return "pdf";
  if (caps.has("web_search") || caps.has("web_fetch")) return "search";
  return "custom";
}

function familyTitle(family: McpCapabilityFamily): string {
  switch (family) {
    case "browser":
      return "浏览器自动化";
    case "search":
      return "联网检索";
    case "word":
      return "Word 文档";
    case "spreadsheet":
      return "表格处理";
    case "pdf":
      return "PDF 文档";
    default:
      return "扩展能力";
  }
}

function familySummary(family: McpCapabilityFamily): string {
  switch (family) {
    case "browser":
      return "打开网页、点击、截图、读取动态页面和登录后的内容。";
    case "search":
      return "联网搜索、抓取网页正文、补充实时信息。";
    case "word":
      return "创建、读取、编辑和导出 Word/docx 文档。";
    case "spreadsheet":
      return "创建、读取、编辑和导出 Excel/表格内容。";
    case "pdf":
      return "读取、解析、转换或导出 PDF 内容。";
    default:
      return "通过外部 MCP Server 提供的专用扩展能力。";
  }
}

function familyExamples(family: McpCapabilityFamily): string[] {
  switch (family) {
    case "browser":
      return ["打开网页", "扫码登录", "截图页面"];
    case "search":
      return ["联网搜索", "抓取网页正文", "找最新信息"];
    case "word":
      return ["生成 Word", "修改 docx", "导出文档"];
    case "spreadsheet":
      return ["生成 Excel", "更新表格", "导出工作表"];
    case "pdf":
      return ["读取 PDF", "转换 PDF", "抽取 PDF 文本"];
    default:
      return ["使用扩展能力", "调用外部服务"];
  }
}

function authStateFromStatus(status: string): McpCapabilityCard["authState"] {
  const s = String(status ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (["connected", "ready", "ok", "active"].includes(s)) return "ready";
  if (/(auth|login|oauth|pending|need)/.test(s)) return "needs_auth";
  if (/(error|failed|disconnected|offline)/.test(s)) return "error";
  return "unknown";
}

function summarizeText(text: unknown, maxChars: number): string | undefined {
  const s = String(text ?? "").trim();
  if (!s) return undefined;
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function buildSkillSlashCommand(skillId: string, userInvocable: boolean): string | undefined {
  const id = String(skillId ?? "").trim();
  if (!id || !userInvocable) return undefined;
  return `/${id}`;
}

export function buildMcpCapabilityCards(args: {
  mcpCatalog: ToolCatalogEntry[];
  mcpServers?: McpSidecarServer[];
}): McpCapabilityCard[] {
  const serverMap = new Map(
    (Array.isArray(args.mcpServers) ? args.mcpServers : [])
      .map((server) => [String(server?.serverId ?? "").trim(), server] as const)
      .filter(([id]) => Boolean(id)),
  );
  const groups = new Map<string, {
    serverId: string;
    serverName: string;
    family: McpCapabilityFamily;
    authState: McpCapabilityCard["authState"];
    tags: Set<string>;
    tools: McpCapabilityToolDetail[];
    searchTexts: string[];
  }>();

  for (const entry of Array.isArray(args.mcpCatalog) ? args.mcpCatalog : []) {
    if (entry.source !== "mcp") continue;
    const serverId = String(entry.serverId ?? "").trim() || "unknown";
    const server = serverMap.get(serverId);
    const serverName = String(entry.serverName ?? server?.serverName ?? serverId).trim() || serverId;
    const family = familyFromCapabilities(entry.capabilities);
    const key = `${serverId}/${family}`;
    const existing = groups.get(key) ?? {
      serverId,
      serverName,
      family,
      authState: authStateFromStatus(String(server?.status ?? "")),
      tags: new Set<string>([family, serverName]),
      tools: [],
      searchTexts: [],
    };
    for (const cap of entry.capabilities ?? []) existing.tags.add(cap);
    existing.tools.push({
      name: entry.name,
      description: entry.description,
      riskLevel: entry.riskLevel,
      capabilities: entry.capabilities ?? [],
      inputSchema: entry.inputSchema,
    });
    existing.searchTexts.push(
      [
        entry.name,
        entry.description,
        serverName,
        familyTitle(family),
        ...(entry.capabilities ?? []),
      ].join(" "),
    );
    groups.set(key, existing);
  }

  return Array.from(groups.values())
    .map((group) => {
      const titleCore = familyTitle(group.family);
      const title = group.serverName && group.serverName !== "unknown"
        ? `${group.serverName} · ${titleCore}`
        : titleCore;
      const summary = familySummary(group.family);
      const tags = Array.from(group.tags).slice(0, 12);
      const examples = familyExamples(group.family);
      return {
        id: `mcp:${group.serverId}/${group.family}`,
        resultType: "mcp_capability" as const,
        title,
        summary,
        riskLevel: (group.family === "browser" ? "medium" : "low") as "low" | "medium" | "high",
        serverId: group.serverId,
        serverName: group.serverName,
        family: group.family,
        authState: group.authState,
        toolCount: group.tools.length,
        tools: group.tools
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 24),
        tags,
        examples,
        searchText: [
          title,
          summary,
          group.serverName,
          ...tags,
          ...examples,
          ...group.searchTexts,
        ].join(" "),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function buildSkillCards(args: {
  skillManifests: SkillManifest[];
  activeSkillIds?: string[];
}): SkillCard[] {
  const active = new Set((args.activeSkillIds ?? []).map((x) => String(x ?? "").trim()).filter(Boolean));
  return (Array.isArray(args.skillManifests) ? args.skillManifests : [])
    .filter((manifest) => manifest && typeof manifest === "object")
    .filter((manifest) => {
      const id = String(manifest.id ?? "").trim();
      return Boolean(id) && !active.has(id);
    })
    .map((manifest) => {
      const skillId = String(manifest.id ?? "").trim();
      const userInvocable = manifest.userInvocable !== false;
      const portable = manifest.portable === true;
      const disableModelInvocation = manifest.disableModelInvocation === true || (portable && manifest.autoEnable !== true);
      const slashCommand = buildSkillSlashCommand(skillId, userInvocable);
      const argumentHint = summarizeText(manifest.argumentHint, 80);
      const allowedTools = Array.isArray(manifest.allowedTools)
        ? manifest.allowedTools.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
        : [];
      const tags = Array.from(
        new Set([
          String(manifest.kind ?? "unknown").trim(),
          String(manifest.activationMode ?? "unknown").trim(),
          ...(portable ? ["portable"] : []),
          ...(disableModelInvocation ? ["explicit_only"] : []),
          ...(userInvocable ? ["slash_invocable"] : ["slash_hidden"]),
          ...(allowedTools.length ? allowedTools.map((name) => `allowed:${name}`) : []),
          ...(Array.isArray(manifest.policies) ? manifest.policies.map((x) => String(x ?? "").trim()) : []),
        ].filter(Boolean)),
      ).slice(0, 12);
      const examples = (() => {
        if (slashCommand && argumentHint) return [slashCommand, `${slashCommand} ${argumentHint}`];
        if (slashCommand) return [slashCommand];
        if (skillId === "style_imitate") return ["风格仿写", "口播稿", "按李叔风格写"];
        if (String(manifest.kind ?? "").trim() === "workflow") return ["按工作流执行", "补完整闭环"];
        return ["按需激活技能"];
      })();
      const workflowSummary = manifest.workflow
        ? summarizeText(
            `phases=${Array.isArray((manifest.workflow as any)?.phases) ? (manifest.workflow as any).phases.length : 0}, followUp=${String((manifest.workflow as any)?.followUp?.kind ?? "").trim() || "none"}`,
            200,
          )
        : undefined;
      const promptSummary = summarizeText(manifest.promptFragments?.system, 280);
      return {
        id: `skill:${skillId}`,
        resultType: "skill" as const,
        title: String(manifest.name ?? skillId).trim() || skillId,
        summary: summarizeText(manifest.description, 180) ?? "可按需激活的 Skill 能力。",
        riskLevel: "low" as const,
        skillId,
        skillKind: (["workflow", "hint", "service", "pipeline"] as string[]).includes(String(manifest.kind ?? ""))
          ? (String(manifest.kind ?? "") as SkillCard["skillKind"])
          : "unknown",
        activationMode: (["auto", "explicit", "hybrid"] as string[]).includes(String(manifest.activationMode ?? ""))
          ? (String(manifest.activationMode ?? "") as SkillCard["activationMode"])
          : "unknown",
        source: (["builtin", "standard", "user", "admin"] as string[]).includes(String(manifest.source ?? ""))
          ? (String(manifest.source ?? "") as SkillCard["source"])
          : "unknown",
        requires: Array.isArray(manifest.requires) ? manifest.requires.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 8) : [],
        conflicts: Array.isArray(manifest.conflicts) ? manifest.conflicts.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 8) : [],
        autoEnable: manifest.autoEnable !== false,
        userInvocable,
        portable,
        disableModelInvocation,
        ...(slashCommand ? { slashCommand } : {}),
        ...(argumentHint ? { argumentHint } : {}),
        allowedTools,
        tags,
        examples,
        promptSummary,
        workflowSummary,
        searchText: [
          slashCommand,
          argumentHint,
          skillId,
          manifest.name,
          manifest.description,
          manifest.kind,
          manifest.activationMode,
          portable ? "portable skill" : "",
          disableModelInvocation ? "disable model invocation" : "",
          userInvocable ? "slash command" : "not slash invocable",
          ...allowedTools,
          ...tags,
          ...examples,
          ...(Array.isArray(manifest.triggers) ? manifest.triggers.map((x) => JSON.stringify(x)) : []),
        ].join(" "),
      };
    })
    .sort((a, b) => a.skillId.localeCompare(b.skillId));
}

export function buildBridgeSkillCards(args: {
  skills: BridgeSkillDescriptor[];
  defaultSource?: SkillCard["source"];
  synthetic?: boolean;
}): SkillCard[] {
  const list = Array.isArray(args.skills) ? args.skills : [];
  const defaultSource = args.defaultSource ?? "user";
  const synthetic = args.synthetic === true;
  const cards: SkillCard[] = [];
  for (const item of list) {
      const skillId = String(item?.id ?? "").trim();
      const description = String(item?.description ?? "").trim();
      if (!skillId || !description) continue;
      const title = String(item?.title ?? "").trim() || skillId;
      const portable = item?.portable === true;
      const disableModelInvocation = item?.disableModelInvocation === true;
      const userInvocable = item?.userInvocable === true;
      const activationMode: SkillCard["activationMode"] = item?.activationMode && ["auto", "explicit", "hybrid"].includes(String(item.activationMode))
        ? (item.activationMode as SkillCard["activationMode"])
        : "explicit";
      const allowedTools = Array.isArray(item?.allowedTools)
        ? item.allowedTools.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
        : [];
      const slashCommand = buildSkillSlashCommand(skillId, userInvocable);
      const tags = Array.from(
        new Set([
          "bridge",
          synthetic ? "synthetic" : "installed",
          activationMode,
          portable ? "portable" : "",
          disableModelInvocation ? "explicit_only" : "",
          userInvocable ? "slash_invocable" : "slash_hidden",
          ...allowedTools.map((name) => `allowed:${name}`),
        ].filter(Boolean)),
      );
      const examples = slashCommand ? [slashCommand] : ["按需激活技能"];
      const source: SkillCard["source"] = item?.source && ["builtin", "standard", "user", "admin", "unknown"].includes(String(item.source))
        ? (item.source as SkillCard["source"])
        : defaultSource;
      cards.push({
        id: `skill:${skillId}`,
        resultType: "skill" as const,
        title,
        summary: summarizeText(description, 180) ?? "可按需激活的 Skill 能力。",
        riskLevel: "low" as const,
        skillId,
        skillKind: "unknown" as const,
        activationMode,
        source,
        requires: [],
        conflicts: [],
        autoEnable: false,
        userInvocable,
        portable,
        disableModelInvocation,
        ...(slashCommand ? { slashCommand } : {}),
        allowedTools,
        tags,
        examples,
        promptSummary: summarizeText(description, 280),
        searchText: [
          skillId,
          title,
          description,
          synthetic ? "synthetic skill" : "installed skill",
          portable ? "portable skill" : "",
          disableModelInvocation ? "disable model invocation" : "",
          userInvocable ? "slash command" : "not slash invocable",
          ...allowedTools,
          ...tags,
          ...examples,
        ].join(" "),
      });
    }
  return cards.sort((a, b) => a.skillId.localeCompare(b.skillId));
}

export function searchCapabilityCards(args: {
  query: string;
  cards: CapabilityCard[];
  limit?: number;
}): CapabilitySearchResult[] {
  const query = String(args.query ?? "").trim();
  const cards = Array.isArray(args.cards) ? args.cards : [];
  if (!query || cards.length === 0) return [];

  const queryTokens = tokenize(query);
  const promptCaps = detectPromptCapabilities(query);
  const baseScores = bm25Score({
    docs: cards.map((card) => ({ id: card.id, tokens: tokenize(card.searchText) })),
    queryTokens,
  });

  const out: CapabilitySearchResult[] = [];
  for (const card of cards) {
    let score = baseScores.get(card.id) ?? 0;
    const reasons: string[] = [];
    if (score > 0) reasons.push(`bm25=${score.toFixed(3)}`);

    if (card.resultType === "mcp_capability") {
      if (promptCaps.has("browser_open") && card.family === "browser") {
        score += 6.2;
        reasons.push("cap:browser_open");
      }
      if ((promptCaps.has("web_search") || promptCaps.has("web_fetch")) && card.family === "search") {
        score += 5.4;
        reasons.push("cap:web_search");
      }
      if (promptCaps.has("mcp_word_doc") && card.family === "word") {
        score += 5.8;
        reasons.push("cap:mcp_word_doc");
      }
      if (promptCaps.has("mcp_spreadsheet") && card.family === "spreadsheet") {
        score += 5.8;
        reasons.push("cap:mcp_spreadsheet");
      }
      if (promptCaps.has("mcp_pdf") && card.family === "pdf") {
        score += 5.2;
        reasons.push("cap:mcp_pdf");
      }
      if (card.authState === "ready") {
        score += 0.6;
        reasons.push("ready");
      }
    } else if (card.resultType === "skill") {
      if (query.includes(card.skillId.toLowerCase())) {
        score += 5.0;
        reasons.push("skill_id_match");
      }
      if (query.includes(card.title.toLowerCase())) {
        score += 3.5;
        reasons.push("skill_title_match");
      }
      if (card.skillKind === "workflow" && /(风格|仿写|润色|改写|口播|workflow|技能|skill)/i.test(query)) {
        score += 2.8;
        reasons.push("workflow_skill_hint");
      }
      if (card.userInvocable) {
        score += 0.4;
        reasons.push("user_invocable");
      }
    }

    if (score < 0.9) continue;
    out.push({ card, score, reasons: reasons.length ? reasons : ["match"] });
  }

  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.card.id.localeCompare(b.card.id);
  });

  return out.slice(0, Math.max(1, Math.min(20, Math.floor(Number(args.limit ?? 8) || 8))));
}

export function findCapabilityCardById(args: {
  id: string;
  cards: CapabilityCard[];
}): CapabilityCard | null {
  const id = String(args.id ?? "").trim();
  if (!id) return null;
  return (Array.isArray(args.cards) ? args.cards : []).find((card) => card.id === id) ?? null;
}
