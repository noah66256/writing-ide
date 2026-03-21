import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

const CLAUDE_TOOL_ALIAS_MAP = new Map([
  ["read", "read"],
  ["write", "write"],
  ["edit", "edit"],
  ["glob", "project.searchPaths"],
  ["grep", "project.search"],
  ["bash", "shell.exec"],
  ["webfetch", "web.fetch"],
  ["task", "spawn_agent"],
]);

function norm(value) {
  return String(value ?? "").trim();
}

function isObj(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniq(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}

function toCamelKey(key) {
  return String(key ?? "").replace(/-([a-zA-Z0-9])/g, (_m, c) => c.toUpperCase());
}

function normalizeKeysDeep(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeKeysDeep(item));
  if (!isObj(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[toCamelKey(key)] = normalizeKeysDeep(item);
  }
  return out;
}

function normalizeProjectRoots(projectRoots) {
  return uniq(
    (Array.isArray(projectRoots) ? projectRoots : [])
      .map((root) => norm(root))
      .filter(Boolean)
      .map((root) => path.resolve(root)),
  );
}

function buildAgentRoots(projectRoots) {
  const projects = normalizeProjectRoots(projectRoots);
  return uniq([
    path.join(os.homedir(), ".claude", "agents"),
    path.join(os.homedir(), ".agents", "agents"),
    ...projects.flatMap((root) => [
      path.join(root, ".claude", "agents"),
      path.join(root, ".agents", "agents"),
    ]),
  ]);
}

function getRootPrecedence(rootDir, projectRoots) {
  const root = path.resolve(norm(rootDir));
  const homeClaudeRoot = path.join(os.homedir(), ".claude", "agents");
  if (root === homeClaudeRoot) return 300;
  const homeAgentsRoot = path.join(os.homedir(), ".agents", "agents");
  if (root === homeAgentsRoot) return 290;
  const projects = normalizeProjectRoots(projectRoots);
  for (let i = 0; i < projects.length; i += 1) {
    const projectRoot = projects[i];
    if (root === path.join(projectRoot, ".claude", "agents")) return 500 - i;
    if (root === path.join(projectRoot, ".agents", "agents")) return 490 - i;
  }
  return 0;
}

function shouldPreferDefinition(candidate, incumbent, projectRoots) {
  const candidateRank = getRootPrecedence(candidate._rootDir, projectRoots);
  const incumbentRank = getRootPrecedence(incumbent._rootDir, projectRoots);
  if (candidateRank !== incumbentRank) return candidateRank > incumbentRank;
  const candidateIndex = Number.isFinite(candidate._scanIndex) ? candidate._scanIndex : Number.MAX_SAFE_INTEGER;
  const incumbentIndex = Number.isFinite(incumbent._scanIndex) ? incumbent._scanIndex : Number.MAX_SAFE_INTEGER;
  return candidateIndex < incumbentIndex;
}

function splitAllowedToolsText(text) {
  const out = [];
  let current = "";
  let depth = 0;
  for (const ch of String(text ?? "")) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      const value = norm(current);
      if (value) out.push(value);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = norm(current);
  if (tail) out.push(tail);
  return out;
}

function normalizeAllowedTools(raw) {
  if (Array.isArray(raw)) return raw.map((item) => norm(item)).filter(Boolean).slice(0, 200);
  const text = norm(raw);
  if (!text) return [];
  return splitAllowedToolsText(text).slice(0, 200);
}

function normalizePortableToolName(raw) {
  const text = norm(raw);
  if (!text) return "";
  return text.replace(/\(.*$/, "").trim().toLowerCase();
}

function mapPortableTools(rawTools) {
  const out = [];
  for (const item of normalizeAllowedTools(rawTools)) {
    const mapped = CLAUDE_TOOL_ALIAS_MAP.get(normalizePortableToolName(item));
    if (mapped) out.push(mapped);
  }
  return uniq(out);
}

function inferToolPolicy(tools) {
  const normalized = Array.isArray(tools) ? tools.map((item) => norm(item)).filter(Boolean) : [];
  const hasMutableTool = normalized.some((name) =>
    /^(write|edit|delete|mkdir|rename|doc\.|shell\.exec|process\.run|run\.mainDoc\.update)/.test(name),
  );
  return hasMutableTool ? "proposal_first" : "readonly";
}

function parseMarkdownAgent(text, fileName) {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/);
  if (!lines.length || !/^---\s*$/.test(lines[0])) {
    return { frontmatter: {}, body: raw };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: {}, body: raw };
  const yamlText = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  let data = {};
  if (yamlText.trim()) {
    try {
      data = YAML.parse(yamlText) ?? {};
    } catch {
      throw new Error(`AGENT_FRONTMATTER_PARSE_ERROR:${fileName}`);
    }
  }
  return { frontmatter: isObj(data) ? data : {}, body };
}

function deriveAgentId(filePath, frontmatter) {
  const fileBase = path.basename(filePath, path.extname(filePath));
  const rawId = norm(frontmatter.id) || fileBase;
  return rawId
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
}

function deriveAgentDescription(frontmatter, body, id) {
  const explicit = norm(frontmatter.description);
  if (explicit) return explicit;
  const bodyLine = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return bodyLine || `External Claude agent ${id}`;
}

function buildAgentDefinition({ frontmatter, body, filePath, rootDir, scanIndex }) {
  const fm = normalizeKeysDeep(frontmatter ?? {});
  const id = deriveAgentId(filePath, fm);
  const name = norm(fm.name) || id;
  const systemPrompt = String(body ?? "").trim();
  if (!id || !name || !systemPrompt) return null;
  const tools = mapPortableTools(fm.tools ?? fm.allowedTools);
  const fallbackModels = Array.isArray(fm.fallbackModels)
    ? fm.fallbackModels.map((item) => norm(item)).filter(Boolean)
    : [];
  return {
    id,
    name,
    description: deriveAgentDescription(fm, body, id),
    systemPrompt,
    tools,
    skills: [],
    mcpServers: [],
    model: norm(fm.model) || "sonnet",
    ...(fallbackModels.length ? { fallbackModels } : {}),
    toolPolicy: inferToolPolicy(tools),
    budget: {
      maxTurns: 12,
      maxToolCalls: 30,
      timeoutMs: 240_000,
    },
    enabled: fm.enabled !== false,
    version: "claude-agent-v1",
    _rootDir: rootDir,
    _scanIndex: scanIndex,
    _sourcePath: filePath,
  };
}

export async function listExternalAgentDefinitions(options = {}) {
  const projectRoots = normalizeProjectRoots(options.projectRoots);
  const roots = buildAgentRoots(projectRoots);
  const byId = new Map();

  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const rootDir = roots[rootIndex];
    let entries = [];
    try {
      entries = await fsp.readdir(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const markdownEntries = entries.filter((entry) => entry?.isFile?.() && path.extname(entry.name).toLowerCase() === ".md");
    for (const entry of markdownEntries) {
      const filePath = path.join(rootDir, entry.name);
      try {
        const text = await fsp.readFile(filePath, "utf-8");
        const { frontmatter, body } = parseMarkdownAgent(text, entry.name);
        const definition = buildAgentDefinition({
          frontmatter,
          body,
          filePath,
          rootDir,
          scanIndex: rootIndex,
        });
        if (!definition || definition.enabled === false) continue;
        const incumbent = byId.get(definition.id);
        if (!incumbent || shouldPreferDefinition(definition, incumbent, projectRoots)) {
          byId.set(definition.id, definition);
        }
      } catch {
        // Ignore malformed agent files and continue scanning.
      }
    }
  }

  return Array.from(byId.values()).map((definition) => ({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    tools: definition.tools,
    skills: definition.skills,
    mcpServers: definition.mcpServers,
    model: definition.model,
    fallbackModels: definition.fallbackModels,
    toolPolicy: definition.toolPolicy,
    budget: definition.budget,
    enabled: definition.enabled,
    version: definition.version,
  }));
}
