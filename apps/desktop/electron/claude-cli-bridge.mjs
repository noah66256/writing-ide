import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const BRIDGE_TTL_MS = 30 * 60 * 1000;

function trim(v) {
  return String(v ?? "").trim();
}

function trimSlash(v) {
  return trim(v).replace(/\/+$/g, "");
}

function createShimSource() {
  return `#!/usr/bin/env node
async function readStdin() {
  return await new Promise((resolve, reject) => {
    let out = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { out += chunk; });
    process.stdin.on("end", () => resolve(out));
    process.stdin.on("error", reject);
  });
}

function parseArgs(argv) {
  const out = { prompt: null, outputFormat: "text", model: null, verbose: false, includePartialMessages: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (arg === "-p") {
      const next = String(argv[i + 1] ?? "");
      if (next && !next.startsWith("-")) {
        out.prompt = next;
        i += 1;
      } else {
        out.prompt = null;
      }
      continue;
    }
    if (arg === "--output-format") {
      out.outputFormat = String(argv[i + 1] ?? "text") || "text";
      i += 1;
      continue;
    }
    if (arg === "--model") {
      out.model = String(argv[i + 1] ?? "") || null;
      i += 1;
      continue;
    }
    if (arg === "--verbose") {
      out.verbose = true;
      continue;
    }
    if (arg === "--include-partial-messages") {
      out.includePartialMessages = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error("UNSUPPORTED_CLAUDE_FLAG:" + arg);
    }
  }
  return out;
}

async function main() {
  const { prompt, outputFormat, model, verbose, includePartialMessages } = parseArgs(process.argv.slice(2));
  const finalPrompt = prompt != null ? String(prompt) : await readStdin();
  if (!String(finalPrompt ?? "").trim()) {
    throw new Error("CLAUDE_PROMPT_REQUIRED");
  }
  const bridgeUrl = String(process.env.CRAB_CLAUDE_BRIDGE_URL ?? "").trim();
  const bridgeToken = String(process.env.CRAB_CLAUDE_BRIDGE_TOKEN ?? "").trim();
  if (!bridgeUrl || !bridgeToken) {
    throw new Error("CRAB_CLAUDE_BRIDGE_NOT_AVAILABLE");
  }
  const res = await fetch(bridgeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer " + bridgeToken,
    },
    body: JSON.stringify({
      prompt: finalPrompt,
      outputFormat,
      model,
      verbose,
      includePartialMessages,
      cwd: process.cwd(),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    process.stderr.write(text || ("bridge request failed: " + res.status));
    process.exit(1);
  }
  process.stdout.write(text);
}

main().catch((err) => {
  process.stderr.write(String(err && err.message ? err.message : err));
  process.exit(1);
});
`;
}

function createWindowsCmdShimSource() {
  return `@echo off
node "%~dp0\\claude" %*
`;
}

function parseSkillMarkdown(text, fallbackId) {
  const src = String(text ?? "");
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let description = "";
  if (m?.[1]) {
    for (const line of m[1].split(/\r?\n/)) {
      const mm = line.match(/^description\s*:\s*(.+)\s*$/i);
      if (mm?.[1]) {
        description = mm[1].trim().replace(/^['"]|['"]$/g, "");
        break;
      }
    }
  }
  return {
    id: trim(fallbackId),
    description,
  };
}

function splitSseEvents(raw) {
  const blocks = String(raw ?? "").split(/\r?\n\r?\n/g);
  const out = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    let event = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim() || "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    const dataRaw = dataLines.join("\n");
    if (!dataRaw) continue;
    try {
      out.push({ event, data: JSON.parse(dataRaw) });
    } catch {
      out.push({ event, data: dataRaw });
    }
  }
  return out;
}

async function callGatewayChat(args) {
  const gatewayBaseUrl = trimSlash(args.gatewayBaseUrl);
  const accessToken = trim(args.accessToken);
  const messages = Array.isArray(args.messages) ? args.messages : [];
  if (!gatewayBaseUrl) throw new Error("CLAUDE_BRIDGE_GATEWAY_URL_REQUIRED");
  if (!accessToken) throw new Error("CLAUDE_BRIDGE_ACCESS_TOKEN_REQUIRED");
  if (!messages.length) throw new Error("CLAUDE_BRIDGE_MESSAGES_REQUIRED");
  const res = await fetch(`${gatewayBaseUrl}/api/llm/chat/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      ...(trim(args.model) ? { model: trim(args.model) } : {}),
      messages,
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`CLAUDE_BRIDGE_GATEWAY_HTTP_${res.status}:${raw.slice(0, 300)}`);
  }
  const events = splitSseEvents(raw);
  let text = "";
  for (const item of events) {
    if (item.event === "assistant.delta" && item.data && typeof item.data === "object") {
      text += String(item.data.delta ?? "");
      continue;
    }
    if (item.event === "error") {
      const message = item.data && typeof item.data === "object" ? String(item.data.error ?? "") : String(item.data ?? "");
      throw new Error(message || "CLAUDE_BRIDGE_GATEWAY_ERROR");
    }
  }
  return text;
}

function parseJsonObject(text) {
  const src = String(text ?? "").trim();
  if (!src) return {};
  try {
    return JSON.parse(src);
  } catch {
    const m = src.match(/\{[\s\S]*\}/);
    if (!m?.[0]) return {};
    try {
      return JSON.parse(m[0]);
    } catch {
      return {};
    }
  }
}

async function callGatewayBridgeSkillSelect(args) {
  const gatewayBaseUrl = trimSlash(args.gatewayBaseUrl);
  const accessToken = trim(args.accessToken);
  if (!gatewayBaseUrl) throw new Error("CLAUDE_BRIDGE_GATEWAY_URL_REQUIRED");
  if (!accessToken) throw new Error("CLAUDE_BRIDGE_ACCESS_TOKEN_REQUIRED");
  const res = await fetch(`${gatewayBaseUrl}/api/agent/skills/claude-bridge/select`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: trim(args.query),
      ...(trim(args.model) ? { model: trim(args.model) } : {}),
      installedSkills: Array.isArray(args.installedSkills) ? args.installedSkills : [],
      syntheticSkills: Array.isArray(args.syntheticSkills) ? args.syntheticSkills : [],
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`CLAUDE_BRIDGE_SELECTION_HTTP_${res.status}:${raw.slice(0, 300)}`);
  }
  return parseJsonObject(raw);
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadSyntheticCommandSkills(cwd) {
  let current = path.resolve(trim(cwd) || process.cwd());
  while (true) {
    const claudeDir = path.join(current, ".claude");
    if (await exists(claudeDir)) {
      const commandsDir = path.join(claudeDir, "commands");
      if (!(await exists(commandsDir))) return [];
      const entries = await fs.readdir(commandsDir, { withFileTypes: true });
      const skills = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const filePath = path.join(commandsDir, entry.name);
        const text = await fs.readFile(filePath, "utf-8");
        const parsed = parseSkillMarkdown(text, entry.name.replace(/\.md$/i, ""));
        if (!parsed.id || !parsed.description) continue;
        skills.push({
          id: parsed.id,
          description: parsed.description,
          title: parsed.id,
          synthetic: true,
          filePath,
        });
      }
      return skills;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [];
}

function normalizeInstalledSkills(skills) {
  const list = Array.isArray(skills) ? skills : [];
  return list
    .map((item) => {
      const manifest = item?.manifest && typeof item.manifest === "object" ? item.manifest : item;
      const id = trim(manifest?.id ?? item?.id);
      const description = trim(manifest?.description);
      const title = trim(manifest?.title ?? manifest?.name ?? id);
      if (!id || !description) return null;
      const allowedTools = Array.isArray(manifest?.allowedTools)
        ? manifest.allowedTools.map((x) => trim(x)).filter(Boolean).slice(0, 12)
        : [];
      return {
        id,
        description,
        title,
        synthetic: false,
        allowedTools,
        portable: manifest?.portable === true,
        disableModelInvocation: manifest?.disableModelInvocation === true,
        userInvocable: manifest?.userInvocable === true,
        activationMode: trim(manifest?.activationMode) || undefined,
        source: trim(manifest?.source) || undefined,
      };
    })
    .filter(Boolean);
}

function buildTriggeredSkillNdjson(skillId) {
  return [
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "Skill" } },
    }),
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ skill: skillId }) },
      },
    }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_stop" } }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ].join("\n") + "\n";
}

function buildNoTriggerNdjson() {
  return `${JSON.stringify({ type: "result", subtype: "success" })}\n`;
}

export class ClaudeCliBridgeManager {
  constructor(args) {
    this._userDataPath = trim(args?.userDataPath);
    this._getInstalledSkills = typeof args?.getInstalledSkills === "function" ? args.getInstalledSkills : () => [];
    this._server = null;
    this._port = 0;
    this._shimDir = path.join(this._userDataPath, "runtime", "claude-bridge-bin");
    this._sessions = new Map();
  }

  async ensureStarted() {
    if (this._server && this._port) return;
    await fs.mkdir(this._shimDir, { recursive: true });
    const shimPath = path.join(this._shimDir, "claude");
    await fs.writeFile(shimPath, createShimSource(), "utf-8");
    await fs.chmod(shimPath, 0o755).catch(() => void 0);
    const cmdShimPath = path.join(this._shimDir, "claude.cmd");
    await fs.writeFile(cmdShimPath, createWindowsCmdShimSource(), "utf-8");

    await new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          await this._handleRequest(req, res);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(String(e?.message ?? e));
        }
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("CLAUDE_BRIDGE_ADDRESS_INVALID"));
          return;
        }
        this._server = server;
        this._port = address.port;
        resolve();
      });
    });
  }

  dispose() {
    this._sessions.clear();
    const server = this._server;
    this._server = null;
    this._port = 0;
    try { server?.close?.(); } catch {}
  }

  async createSession(args) {
    await this.ensureStarted();
    const accessToken = trim(args?.accessToken);
    const gatewayBaseUrl = trimSlash(args?.gatewayBaseUrl);
    if (!accessToken || !gatewayBaseUrl) return null;
    const token = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    this._sessions.set(token, {
      id: sessionId,
      gatewayBaseUrl,
      accessToken,
      createdAt: Date.now(),
      expiresAt: Date.now() + BRIDGE_TTL_MS,
    });
    return {
      env: {
        CRAB_CLAUDE_BRIDGE_URL: `http://127.0.0.1:${this._port}/invoke`,
        CRAB_CLAUDE_BRIDGE_TOKEN: token,
        CRAB_CLAUDE_BRIDGE_SESSION: sessionId,
      },
      prependPath: [this._shimDir],
      dispose: () => {
        this._sessions.delete(token);
      },
    };
  }

  async _handleRequest(req, res) {
    if (req.method !== "POST" || trim(req.url) !== "/invoke") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const auth = trim(req.headers.authorization);
    const token = auth.startsWith("Bearer ") ? trim(auth.slice("Bearer ".length)) : "";
    const session = token ? this._sessions.get(token) : null;
    if (!session || session.expiresAt < Date.now()) {
      if (token) this._sessions.delete(token);
      res.statusCode = 401;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("CLAUDE_BRIDGE_SESSION_INVALID");
      return;
    }
    const body = await this._readJsonBody(req);
    const prompt = String(body?.prompt ?? "");
    const outputFormat = trim(body?.outputFormat).toLowerCase() === "stream-json" ? "stream-json" : "text";
    const model = trim(body?.model);
    const cwd = trim(body?.cwd) || process.cwd();

    if (!prompt.trim()) {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("CLAUDE_BRIDGE_PROMPT_REQUIRED");
      return;
    }

    if (outputFormat === "text") {
      const text = await callGatewayChat({
        gatewayBaseUrl: session.gatewayBaseUrl,
        accessToken: session.accessToken,
        model,
        messages: [{ role: "user", content: prompt }],
      });
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(text);
      return;
    }

    const syntheticSkills = await loadSyntheticCommandSkills(cwd);
    const installedSkills = normalizeInstalledSkills(await this._getInstalledSkills());
    const merged = Array.from(
      new Map([...syntheticSkills, ...installedSkills].map((item) => [item.id, item])).values(),
    ).slice(0, 40);

    if (!merged.length) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      res.end(buildNoTriggerNdjson());
      return;
    }

    const selection = await callGatewayBridgeSkillSelect({
      gatewayBaseUrl: session.gatewayBaseUrl,
      accessToken: session.accessToken,
      model,
      query: prompt,
      installedSkills,
      syntheticSkills,
    });
    const decision = trim(selection?.decision).toLowerCase();
    const skillId = trim(selection?.skill);
    const selected = decision === "skill" && skillId ? merged.find((item) => item.id === skillId) : null;

    res.statusCode = 200;
    res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    res.end(selected ? buildTriggeredSkillNdjson(selected.id) : buildNoTriggerNdjson());
  }

  async _readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf-8");
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("CLAUDE_BRIDGE_BAD_JSON");
    }
  }
}
