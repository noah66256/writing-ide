import path from "node:path";
import {
  BUILTIN_SUB_AGENTS,
  type ActiveSkill,
  type SkillManifest,
  type SubAgentDefinition,
} from "@ohmycrab/agent-core";

import { resolveSpawnAgentRole } from "./runtime/collabCompat.js";
import { HIGH_RISK_TOOL_NAME_SET } from "./coreTools.js";

const CLAUDE_TOOL_ALIAS_MAP = new Map<string, string>([
  ["read", "read"],
  ["write", "write"],
  ["edit", "edit"],
  ["glob", "project.searchPaths"],
  ["grep", "project.search"],
  ["bash", "shell.exec"],
  ["webfetch", "web.fetch"],
  ["web_fetch", "web.fetch"],
  ["websearch", "web.search"],
  ["web_search", "web.search"],
  ["web-search", "web.search"],
  ["agent", "spawn_agent"],
  ["task", "spawn_agent"],
]);

const TOOL_NAME_TO_CLAUDE_ALIAS = new Map<string, string>([
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["project.searchPaths", "Glob"],
  ["project.search", "Grep"],
  ["shell.exec", "Bash"],
  ["code.exec", "Bash"],
  ["web.fetch", "WebFetch"],
  ["web.search", "WebSearch"],
  ["spawn_agent", "Agent"],
  ["send_input", "Agent"],
  ["resume_agent", "Agent"],
  ["wait_agent", "Agent"],
  ["close_agent", "Agent"],
]);

const PORTABLE_AGENT_ALIAS_MAP = new Map<string, string>([
  ["explore", "topic_planner"],
  ["explorer", "topic_planner"],
  ["research", "topic_planner"],
  ["researcher", "topic_planner"],
  ["plan", "topic_planner"],
  ["planner", "topic_planner"],
  ["implement", "copywriter"],
  ["implementation", "copywriter"],
  ["worker", "copywriter"],
  ["writer", "copywriter"],
  ["copywriter", "copywriter"],
  ["seo", "seo_specialist"],
  ["learn", "learning_specialist"],
  ["learning", "learning_specialist"],
  ["ingest", "learning_specialist"],
]);

type PortableRuleKind =
  | "any"
  | "command_pattern"
  | "path_pattern"
  | "query_pattern"
  | "web_domain"
  | "web_url_pattern"
  | "task_role";

export type PortableAllowedToolRule = {
  skillId: string;
  raw: string;
  aliasName: string;
  toolName: string;
  kind: PortableRuleKind;
  specifier?: string;
};

export type PortableAllowedToolPolicy = {
  activeSkillIds: string[];
  allowedToolNames: Set<string>;
  rules: PortableAllowedToolRule[];
  rulesByTool: Map<string, PortableAllowedToolRule[]>;
  unsupportedEntries: Array<{ skillId: string; raw: string; reason: string }>;
};

export type PortableAllowedToolDecision = {
  ok: boolean;
  matchedRule?: PortableAllowedToolRule;
  reason?: string;
  message?: string;
};

export type PortableInvocationParseMode =
  | "empty"
  | "json_object"
  | "json_value"
  | "single_field_string"
  | "raw_string"
  | "schema_mismatch";

export type PortableInvocationInputState = {
  skillId: string;
  rawArguments: string;
  parseMode: PortableInvocationParseMode;
  parsedValue?: unknown;
  error?: string;
  schemaSummary?: string;
};

export type PortableResolvedAgent = {
  requestedAgent?: string;
  agentId?: string;
  definition?: SubAgentDefinition;
};

export type PortableSubAgentRegistryInput =
  | Map<string, SubAgentDefinition>
  | SubAgentDefinition[]
  | null
  | undefined;

export type PortableSkillRunContext = {
  activeSkillIds: string[];
  primarySkillId?: string;
  modelOverride?: string;
  allowedToolPolicy?: PortableAllowedToolPolicy | null;
  executionScope?: "explicit_portable_invocation" | "skill_activation";
  scopedHighRiskToolNames?: string[];
  inputStates?: PortableInvocationInputState[];
  hooksSkillIds?: string[];
  fork?: {
    skillId: string;
    agentId?: string;
    requestedAgent?: string;
    mode: "inline" | "fork";
  } | null;
};

const DEFAULT_EXTERNAL_SUB_AGENT_BUDGET = {
  maxTurns: 12,
  maxToolCalls: 30,
  timeoutMs: 240_000,
} as const;

function cloneSubAgentDefinition(definition: SubAgentDefinition): SubAgentDefinition {
  return {
    ...definition,
    tools: Array.isArray(definition.tools) ? [...definition.tools] : [],
    skills: Array.isArray(definition.skills) ? [...definition.skills] : [],
    mcpServers: Array.isArray(definition.mcpServers) ? [...definition.mcpServers] : [],
    fallbackModels: Array.isArray(definition.fallbackModels) ? [...definition.fallbackModels] : undefined,
    budget: {
      maxTurns: Number(definition.budget?.maxTurns ?? DEFAULT_EXTERNAL_SUB_AGENT_BUDGET.maxTurns) || DEFAULT_EXTERNAL_SUB_AGENT_BUDGET.maxTurns,
      maxToolCalls: Number(definition.budget?.maxToolCalls ?? DEFAULT_EXTERNAL_SUB_AGENT_BUDGET.maxToolCalls) || DEFAULT_EXTERNAL_SUB_AGENT_BUDGET.maxToolCalls,
      timeoutMs: Number(definition.budget?.timeoutMs ?? DEFAULT_EXTERNAL_SUB_AGENT_BUDGET.timeoutMs) || DEFAULT_EXTERNAL_SUB_AGENT_BUDGET.timeoutMs,
    },
  };
}

function normalizeSubAgentToolPolicy(raw: unknown, tools: string[]): SubAgentDefinition["toolPolicy"] {
  const text = cleanText(raw).toLowerCase();
  if (text === "readonly" || text === "proposal_first" || text === "auto_apply") return text;
  const hasMutableTool = tools.some((toolName) =>
    /^(write|edit|delete|mkdir|rename|doc\.|shell\.exec|process\.run|run\.mainDoc\.update)/.test(toolName),
  );
  return hasMutableTool ? "proposal_first" : "readonly";
}

function normalizeSubAgentBudget(raw: unknown): SubAgentDefinition["budget"] {
  const shape = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const maxTurns = Number(shape.maxTurns);
  const maxToolCalls = Number(shape.maxToolCalls);
  const timeoutMs = Number(shape.timeoutMs);
  return {
    maxTurns:
      Number.isFinite(maxTurns) && maxTurns > 0
        ? Math.max(1, Math.floor(maxTurns))
        : DEFAULT_EXTERNAL_SUB_AGENT_BUDGET.maxTurns,
    maxToolCalls:
      Number.isFinite(maxToolCalls) && maxToolCalls > 0
        ? Math.max(1, Math.floor(maxToolCalls))
        : DEFAULT_EXTERNAL_SUB_AGENT_BUDGET.maxToolCalls,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.max(5_000, Math.floor(timeoutMs))
        : DEFAULT_EXTERNAL_SUB_AGENT_BUDGET.timeoutMs,
  };
}

export function normalizePortableSubAgentDefinition(raw: unknown): SubAgentDefinition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const shape = raw as Record<string, unknown>;
  const id = cleanText(shape.id);
  const name = cleanText(shape.name) || id;
  const description = cleanText(shape.description) || name;
  const systemPrompt = cleanText(shape.systemPrompt);
  const tools = Array.isArray(shape.tools)
    ? shape.tools.map((item) => cleanText(item)).filter(Boolean)
    : [];
  if (!id || !name || !systemPrompt) return null;
  return {
    id,
    name,
    description,
    systemPrompt,
    tools,
    skills: Array.isArray(shape.skills) ? shape.skills.map((item) => cleanText(item)).filter(Boolean) : [],
    mcpServers: Array.isArray(shape.mcpServers) ? shape.mcpServers.map((item) => cleanText(item)).filter(Boolean) : [],
    model: cleanText(shape.model) || "sonnet",
    fallbackModels: Array.isArray(shape.fallbackModels)
      ? shape.fallbackModels.map((item) => cleanText(item)).filter(Boolean)
      : undefined,
    toolPolicy: normalizeSubAgentToolPolicy(shape.toolPolicy, tools),
    budget: normalizeSubAgentBudget(shape.budget),
    enabled: shape.enabled !== false,
    avatar: cleanText(shape.avatar) || undefined,
    version: cleanText(shape.version) || undefined,
    triggerPatterns: Array.isArray(shape.triggerPatterns)
      ? shape.triggerPatterns.map((item) => cleanText(item)).filter(Boolean)
      : undefined,
    priority:
      Number.isFinite(Number(shape.priority))
        ? Math.max(0, Math.floor(Number(shape.priority)))
        : undefined,
  };
}

function listPortableRegistryAgents(registry?: PortableSubAgentRegistryInput): SubAgentDefinition[] {
  if (registry instanceof Map) {
    return Array.from(registry.values()).map(cloneSubAgentDefinition);
  }
  if (Array.isArray(registry)) {
    return registry
      .map((item) => normalizePortableSubAgentDefinition(item))
      .filter((item): item is SubAgentDefinition => Boolean(item))
      .map(cloneSubAgentDefinition);
  }
  return [];
}

export function buildPortableSubAgentDefinitionMap(rawList: unknown): Map<string, SubAgentDefinition> {
  const registry = new Map<string, SubAgentDefinition>();
  for (const definition of listPortableRegistryAgents(Array.isArray(rawList) ? (rawList as SubAgentDefinition[]) : [])) {
    if (!definition.enabled) continue;
    registry.set(definition.id, definition);
  }
  return registry;
}

export type PortableSkillPromptRenderRuntime = {
  sessionId?: string;
  skillDir?: string;
};

export type PortableCommandSubstitution = {
  raw: string;
  command: string;
  index: number;
};

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardToRegExp(pattern: string, options?: { caseInsensitive?: boolean }) {
  const escaped = escapeRegExp(String(pattern ?? "").trim()).replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`, options?.caseInsensitive ? "i" : "");
}

function matchWildcard(pattern: string, value: string, options?: { caseInsensitive?: boolean }) {
  if (!pattern) return false;
  return wildcardToRegExp(pattern, options).test(value);
}

function normalizePortableToolBase(raw: unknown) {
  const text = cleanText(raw);
  if (!text) return "";
  return text.replace(/\(.*$/, "").trim().toLowerCase();
}

function normalizePortablePath(value: unknown) {
  let text = cleanText(value).replace(/\\/g, "/").replace(/\/+/g, "/");
  if (text.startsWith("./")) text = text.slice(2);
  return text;
}

function stringifyCommandLine(toolArgs: Record<string, unknown>) {
  const command = cleanText(toolArgs.command);
  const args = Array.isArray(toolArgs.args)
    ? toolArgs.args.map((item) => cleanText(item)).filter(Boolean)
    : [];
  return [command, ...args].filter(Boolean).join(" ").trim();
}

function summarizeSchema(schema: unknown) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "";
  const shape = schema as Record<string, unknown>;
  const type = cleanText(shape.type);
  if (type) return type;
  if (shape.properties && typeof shape.properties === "object") return "object";
  return "";
}

function collectSchemaKeys(schema: unknown) {
  const shape =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : null;
  const properties =
    shape?.properties && typeof shape.properties === "object" && !Array.isArray(shape.properties)
      ? (shape.properties as Record<string, unknown>)
      : {};
  const keys = Object.keys(properties);
  const required = Array.isArray(shape?.required)
    ? shape.required.map((item) => cleanText(item)).filter(Boolean)
    : [];
  return { type: cleanText(shape?.type) || (keys.length ? "object" : ""), keys, required };
}

function truncateJson(value: unknown, maxChars = 1600) {
  let text = "";
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value ?? "");
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...<truncated>` : text;
}

export function toPortableToolAliasName(toolName: unknown) {
  const normalized = cleanText(toolName);
  return TOOL_NAME_TO_CLAUDE_ALIAS.get(normalized) ?? normalized;
}

export function splitPortableSkillInvocationArgs(raw: string): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const matches = text.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g) ?? [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, "").replace(/\\(["'])/g, "$1"));
}

export function extractPortableCommandSubstitutions(text: string): PortableCommandSubstitution[] {
  const raw = String(text ?? "");
  if (!raw) return [];
  const out: PortableCommandSubstitution[] = [];
  const re = /!`([^`\r\n]+)`/g;
  let match: RegExpExecArray | null = null;
  while ((match = re.exec(raw))) {
    const command = cleanText(match[1]);
    if (!command) continue;
    out.push({
      raw: String(match[0] ?? ""),
      command,
      index: Number(match.index ?? 0),
    });
  }
  return out;
}

export function renderPortableSkillPromptTemplate(
  text: string,
  args?: string,
  runtime?: PortableSkillPromptRenderRuntime | null,
) {
  const raw = String(text ?? "");
  const value = String(args ?? "").trim();
  if (!raw) return "";
  const skillDir = cleanText(runtime?.skillDir);
  const sessionId = cleanText(runtime?.sessionId);
  const templated = raw
    .replace(/\$\{CLAUDE_SESSION_ID\}/g, sessionId)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);
  const tokens = splitPortableSkillInvocationArgs(value);
  let usedPlaceholder = false;
  const rendered = templated
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, idx) => {
      usedPlaceholder = true;
      return tokens[Number(idx)] ?? "";
    })
    .replace(/\$(\d+)\b/g, (_m, idx) => {
      usedPlaceholder = true;
      return tokens[Number(idx)] ?? "";
    })
    .replace(/\$ARGUMENTS\b/g, () => {
      usedPlaceholder = true;
      return value;
    });
  if (!value || usedPlaceholder) return rendered;
  return `${rendered}\n\n[Skill Invocation Arguments]\n${value}`.trim();
}

export function rewritePortableSkillRelativePaths(text: string, manifest: SkillManifest | null | undefined) {
  const raw = String(text ?? "");
  const skillDir = String(manifest?.portableRuntime?.skillDir ?? "").trim();
  if (!(manifest?.portable && raw && skillDir)) return raw;
  const absolutize = (rel: string) => path.resolve(skillDir, rel);
  return raw
    .replace(/\]\(((?:scripts|references|assets)\/[^)\s]+)\)/g, (_m, rel) => `](${absolutize(rel)})`)
    .replace(/(^|[\s`'"])((?:scripts|references|assets)\/[^\s`'")]+)/gm, (_m, prefix, rel) => `${prefix}${absolutize(rel)}`);
}

export function buildPortableSkillResourceNotice(manifest: SkillManifest | null | undefined): string {
  const skillDir = String(manifest?.portableRuntime?.skillDir ?? "").trim();
  if (!(manifest?.portable && skillDir)) return "";
  return [
    `Portable skill root: ${skillDir}`,
    "Resolve all relative scripts/, references/, and assets/ paths in this skill from the directory above.",
  ].join("\n");
}

export function buildPortableSkillToolAliasNotice(manifest: SkillManifest | null | undefined): string {
  const allowedTools = Array.isArray(manifest?.allowedTools)
    ? manifest.allowedTools.map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  if (!(manifest?.portable || allowedTools.length > 0)) return "";
  return [
    "Claude Code tool aliases in this environment:",
    "- Read -> read",
    "- Write -> write",
    "- Edit -> edit",
    "- Glob -> project.searchPaths",
    "- Grep -> project.search",
    "- Bash（命令执行 + Python 代码）",
    "- WebFetch -> web.fetch",
    "- WebSearch -> web.search",
    "- Agent（子 Agent 生命周期）",
  ].join("\n");
}

function parsePortableAllowedToolRule(
  skillId: string,
  rawItem: unknown,
): PortableAllowedToolRule | { unsupported: { skillId: string; raw: string; reason: string } } | null {
  const raw = cleanText(rawItem);
  if (!raw) return null;

  const match = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\(([\s\S]*)\))?$/);
  const aliasName = cleanText(match?.[1] ?? raw);
  const toolName = CLAUDE_TOOL_ALIAS_MAP.get(normalizePortableToolBase(aliasName));
  if (!toolName) {
    return { unsupported: { skillId, raw, reason: "unsupported_tool_alias" } };
  }

  const specifier = cleanText(match?.[2]);
  if (!specifier) {
    return {
      skillId,
      raw,
      aliasName,
      toolName,
      kind: "any",
    };
  }

  if (toolName === "shell.exec") {
    return { skillId, raw, aliasName, toolName, kind: "command_pattern", specifier };
  }
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    return { skillId, raw, aliasName, toolName, kind: "path_pattern", specifier };
  }
  if (toolName === "project.searchPaths" || toolName === "project.search") {
    return { skillId, raw, aliasName, toolName, kind: "query_pattern", specifier };
  }
  if (toolName === "web.fetch") {
    if (/^domain:/i.test(specifier)) {
      return {
        skillId,
        raw,
        aliasName,
        toolName,
        kind: "web_domain",
        specifier: specifier.replace(/^domain:/i, "").trim(),
      };
    }
    return { skillId, raw, aliasName, toolName, kind: "web_url_pattern", specifier };
  }
  if (toolName === "spawn_agent") {
    return { skillId, raw, aliasName, toolName, kind: "task_role", specifier };
  }

  return { unsupported: { skillId, raw, reason: "unsupported_specifier" } };
}

export function parsePortableAllowedToolPolicy(manifests: SkillManifest[]): PortableAllowedToolPolicy | null {
  const portableManifests = (Array.isArray(manifests) ? manifests : []).filter((manifest) =>
    manifest?.portable && Array.isArray(manifest.allowedTools) && manifest.allowedTools.length > 0,
  );
  if (portableManifests.length === 0) return null;

  const activeSkillIds: string[] = [];
  const allowedToolNames = new Set<string>();
  const rules: PortableAllowedToolRule[] = [];
  const rulesByTool = new Map<string, PortableAllowedToolRule[]>();
  const unsupportedEntries: Array<{ skillId: string; raw: string; reason: string }> = [];

  for (const manifest of portableManifests) {
    const skillId = cleanText(manifest.id);
    if (skillId) activeSkillIds.push(skillId);
    for (const item of manifest.allowedTools ?? []) {
      const parsed = parsePortableAllowedToolRule(skillId, item);
      if (!parsed) continue;
      if ("unsupported" in parsed) {
        unsupportedEntries.push(parsed.unsupported);
        continue;
      }
      allowedToolNames.add(parsed.toolName);
      rules.push(parsed);
      const bucket = rulesByTool.get(parsed.toolName) ?? [];
      bucket.push(parsed);
      rulesByTool.set(parsed.toolName, bucket);
    }
  }

  if (allowedToolNames.size === 0 && unsupportedEntries.length === 0) return null;

  return {
    activeSkillIds: Array.from(new Set(activeSkillIds.filter(Boolean))),
    allowedToolNames,
    rules,
    rulesByTool,
    unsupportedEntries,
  };
}

export function buildPortableAllowedToolPolicyNotice(policy: PortableAllowedToolPolicy | null | undefined) {
  if (!policy) return "";
  const lines = ["Portable skill allowed-tools overlay (applies inside explicit portable skill execution scope only):"];
  for (const rule of policy.rules.slice(0, 16)) {
    lines.push(`- ${rule.skillId}: ${rule.raw} -> ${rule.toolName}`);
  }
  if (policy.unsupportedEntries.length > 0) {
    const unsupported = policy.unsupportedEntries
      .slice(0, 8)
      .map((item) => `${item.skillId}:${item.raw}(${item.reason})`)
      .join(", ");
    lines.push(`Unsupported allowed-tools entries ignored: ${unsupported}`);
  }
  return lines.join("\n");
}

export function evaluatePortableAllowedToolPolicy(
  policy: PortableAllowedToolPolicy | null | undefined,
  toolName: string,
  toolArgs: Record<string, unknown>,
): PortableAllowedToolDecision {
  if (!policy) return { ok: true };

  if (!policy.allowedToolNames.has(toolName)) {
    return {
      ok: false,
      reason: "tool_not_whitelisted",
      message: `Portable skill guardrails do not allow tool "${toolName}".`,
    };
  }

  const rules = policy.rulesByTool.get(toolName) ?? [];
  if (rules.length === 0) return { ok: true };

  const anyRule = rules.find((rule) => rule.kind === "any");
  if (anyRule) return { ok: true, matchedRule: anyRule };

  for (const rule of rules) {
    if (rule.kind === "command_pattern") {
      if (matchWildcard(rule.specifier ?? "", stringifyCommandLine(toolArgs))) {
        return { ok: true, matchedRule: rule };
      }
      continue;
    }
    if (rule.kind === "path_pattern") {
      const normalizedPath = normalizePortablePath(toolArgs.path);
      const pattern = normalizePortablePath(rule.specifier);
      if (normalizedPath && pattern && matchWildcard(pattern, normalizedPath)) {
        return { ok: true, matchedRule: rule };
      }
      continue;
    }
    if (rule.kind === "query_pattern") {
      const query = cleanText(toolArgs.query);
      if (query && matchWildcard(rule.specifier ?? "", query)) {
        return { ok: true, matchedRule: rule };
      }
      continue;
    }
    if (rule.kind === "web_domain") {
      const url = cleanText(toolArgs.url);
      try {
        const domain = new URL(url).hostname;
        if (domain && matchWildcard(rule.specifier ?? "", domain, { caseInsensitive: true })) {
          return { ok: true, matchedRule: rule };
        }
      } catch {
        // ignore malformed URL and let the denial path handle it
      }
      continue;
    }
    if (rule.kind === "web_url_pattern") {
      const url = cleanText(toolArgs.url);
      if (url && matchWildcard(rule.specifier ?? "", url, { caseInsensitive: true })) {
        return { ok: true, matchedRule: rule };
      }
      continue;
    }
    if (rule.kind === "task_role") {
      const requested = cleanText(toolArgs.agent_type ?? toolArgs.agentId ?? toolArgs.agent);
      const resolved = resolveSpawnAgentRole(requested).agentId;
      const expected = resolveSpawnAgentRole(rule.specifier).agentId;
      if (requested && (requested === rule.specifier || resolved === expected || resolved === rule.specifier)) {
        return { ok: true, matchedRule: rule };
      }
    }
  }

  return {
    ok: false,
    reason: "tool_args_not_allowed",
    message: rules.length > 0
      ? `Portable skill guardrails blocked ${toolName}; args did not match any allowed-tools specifier.`
      : `Portable skill guardrails blocked ${toolName}.`,
  };
}

export function normalizePortableContextMode(raw: unknown): "inline" | "fork" {
  return cleanText(raw).toLowerCase() === "fork" ? "fork" : "inline";
}

export function resolvePortableSkillAgent(
  raw: unknown,
  registry?: PortableSubAgentRegistryInput,
): PortableResolvedAgent {
  const requestedAgent = cleanText(raw);
  if (!requestedAgent) return {};
  const externalAgents = listPortableRegistryAgents(registry).filter((agent) => agent.enabled !== false);

  const exact = BUILTIN_SUB_AGENTS.find((agent) => agent.id === requestedAgent);
  if (exact) {
    return { requestedAgent, agentId: exact.id, definition: exact };
  }
  const externalExact = externalAgents.find((agent) => agent.id === requestedAgent);
  if (externalExact) {
    return { requestedAgent, agentId: externalExact.id, definition: externalExact };
  }

  const byName = BUILTIN_SUB_AGENTS.find((agent) => agent.name === requestedAgent);
  if (byName) {
    return { requestedAgent, agentId: byName.id, definition: byName };
  }
  const externalByName = externalAgents.find((agent) => agent.name === requestedAgent);
  if (externalByName) {
    return { requestedAgent, agentId: externalByName.id, definition: externalByName };
  }

  const normalized = requestedAgent.toLowerCase().replace(/[\s-]+/g, "_");
  const alias = PORTABLE_AGENT_ALIAS_MAP.get(normalized) ?? resolveSpawnAgentRole(requestedAgent).agentId;
  const definition =
    BUILTIN_SUB_AGENTS.find((agent) => agent.id === alias) ??
    externalAgents.find((agent) => agent.id === alias);
  return {
    requestedAgent,
    agentId: definition?.id ?? (alias || undefined),
    definition: definition ?? undefined,
  };
}

export function parsePortableSkillInvocationInput(args: {
  skillId: string;
  rawArguments?: string;
  inputSchema?: unknown;
}): PortableInvocationInputState | null {
  const rawArguments = cleanText(args.rawArguments);
  if (args.inputSchema === undefined) return null;

  const schemaSummary = summarizeSchema(args.inputSchema) || "unknown";
  if (!rawArguments) {
    return {
      skillId: args.skillId,
      rawArguments,
      parseMode: "empty",
      schemaSummary,
    };
  }

  const { type, keys, required } = collectSchemaKeys(args.inputSchema);
  let parsedJson: unknown = undefined;
  let parsedJsonOk = false;
  try {
    parsedJson = JSON.parse(rawArguments);
    parsedJsonOk = true;
  } catch {
    parsedJsonOk = false;
  }

  if ((type === "object" || keys.length > 0) && parsedJsonOk && parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
    const parsedObject = parsedJson as Record<string, unknown>;
    const missingRequired = required.filter((key) => !(key in parsedObject));
    if (missingRequired.length === 0) {
      return {
        skillId: args.skillId,
        rawArguments,
        parseMode: "json_object",
        parsedValue: parsedObject,
        schemaSummary,
      };
    }
    return {
      skillId: args.skillId,
      rawArguments,
      parseMode: "schema_mismatch",
      parsedValue: parsedObject,
      error: `missing required keys: ${missingRequired.join(", ")}`,
      schemaSummary,
    };
  }

  if ((type === "object" || keys.length > 0) && keys.length === 1) {
    return {
      skillId: args.skillId,
      rawArguments,
      parseMode: "single_field_string",
      parsedValue: { [keys[0]]: rawArguments },
      schemaSummary,
    };
  }

  if (type === "string") {
    return {
      skillId: args.skillId,
      rawArguments,
      parseMode: "raw_string",
      parsedValue: rawArguments,
      schemaSummary,
    };
  }

  if (parsedJsonOk) {
    return {
      skillId: args.skillId,
      rawArguments,
      parseMode: "json_value",
      parsedValue: parsedJson,
      schemaSummary,
    };
  }

  return {
    skillId: args.skillId,
    rawArguments,
    parseMode: "schema_mismatch",
    error: "raw arguments could not be coerced into the declared inputSchema",
    schemaSummary,
  };
}

export function buildPortableSkillInputNotice(
  manifest: SkillManifest,
  state: PortableInvocationInputState | null | undefined,
) {
  if (!manifest?.portable || !state) return "";
  const lines = [`Portable skill inputSchema for /${manifest.id}: ${state.schemaSummary || "unknown"}`];
  if (state.rawArguments) {
    lines.push(`[Raw Skill Arguments]\n${state.rawArguments}`);
  }
  if (state.parsedValue !== undefined) {
    lines.push(`[Parsed Skill Input]\n${truncateJson(state.parsedValue)}`);
  }
  if (state.error) {
    lines.push(`Input coercion warning: ${state.error}`);
  }
  return lines.join("\n\n");
}

export function buildPortableSkillHooksNotice(manifest: SkillManifest) {
  if (!manifest?.portable || manifest.hooks === undefined) return "";
  return [
    `Portable skill hooks declared for /${manifest.id}.`,
    "Crab executes portable skill hook lifecycles at runtime and also exposes the declared hook metadata to the model for visibility.",
    `[Hook Metadata]\n${truncateJson(manifest.hooks, 1200)}`,
  ].join("\n\n");
}

export function buildPortableForkUserPrompt(args: {
  renderedPrompt: string;
  rawArguments?: string;
  userPrompt: string;
  parsedInputState?: PortableInvocationInputState | null;
}) {
  const parts: string[] = [];
  const renderedPrompt = cleanText(args.renderedPrompt);
  const rawArguments = cleanText(args.rawArguments);
  const userPrompt = cleanText(args.userPrompt);

  if (renderedPrompt) parts.push(renderedPrompt);
  if (args.parsedInputState?.parsedValue !== undefined) {
    parts.push(`[Structured Skill Input]\n${truncateJson(args.parsedInputState.parsedValue)}`);
  }
  if (userPrompt && userPrompt !== rawArguments) {
    parts.push(`[Original User Request]\n${userPrompt}`);
  }

  return parts.filter(Boolean).join("\n\n").trim();
}

export function createActiveSkillFromManifest(args: {
  manifest: SkillManifest;
  reasonCode?: string;
  detail?: Record<string, unknown>;
}): ActiveSkill {
  const manifest = args.manifest;
  const skillId = cleanText(manifest?.id) || "unknown";
  const stageKey = cleanText(manifest?.stageKey) || `agent.skill.${skillId}`;
  const badge = cleanText(manifest?.ui?.badge) || cleanText(manifest?.name).toUpperCase() || skillId.toUpperCase();
  return {
    id: skillId,
    name: cleanText(manifest?.name) || skillId,
    stageKey,
    badge,
    activatedBy: {
      reasonCodes: [cleanText(args.reasonCode) || "skill:model_activation"],
      detail: args.detail ?? { trigger: "model_tool" },
    },
  };
}

export function collectPortableActivationToolNames(
  manifests: SkillManifest[],
  registry?: PortableSubAgentRegistryInput,
): Set<string> {
  const out = new Set<string>();
  for (const manifest of Array.isArray(manifests) ? manifests : []) {
    if (!manifest || typeof manifest !== "object") continue;
    const policy = parsePortableAllowedToolPolicy([manifest]);
    if (policy?.allowedToolNames?.size) {
      for (const name of policy.allowedToolNames) {
        if (HIGH_RISK_TOOL_NAME_SET.has(name)) continue;
        out.add(name);
      }
      continue;
    }
    const resolvedAgent = resolvePortableSkillAgent(manifest.agent, registry);
    for (const name of resolvedAgent.definition?.tools ?? []) {
      const toolName = cleanText(name);
      if (toolName) out.add(toolName);
    }
  }
  return out;
}

export function buildPortableSkillActivationInstructions(args: {
  manifest: SkillManifest;
  rawArguments?: string;
  inputState?: PortableInvocationInputState | null;
  allowedToolPolicy?: PortableAllowedToolPolicy | null;
  includeHooksNotice?: boolean;
  sessionId?: string;
}): string {
  const manifest = args.manifest;
  const runtime = {
    sessionId: cleanText(args.sessionId),
    skillDir: cleanText(manifest?.portableRuntime?.skillDir),
  };
  const rendered = rewritePortableSkillRelativePaths(
    renderPortableSkillPromptTemplate(String(manifest?.promptFragments?.system ?? "").trim(), args.rawArguments, runtime),
    manifest,
  );
  const parts = [
    buildPortableSkillToolAliasNotice(manifest),
    buildPortableSkillResourceNotice(manifest),
    args.allowedToolPolicy ? buildPortableAllowedToolPolicyNotice(args.allowedToolPolicy) : "",
    buildPortableSkillInputNotice(manifest, args.inputState ?? null),
    args.includeHooksNotice === false ? "" : buildPortableSkillHooksNotice(manifest),
    rendered,
  ].filter(Boolean);
  return parts.join("\n\n").trim();
}
