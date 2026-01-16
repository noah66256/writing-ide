import type { FastifyInstance } from "fastify";
import { computeDraftStatsForStyleLint } from "../kb/styleLintDraftStats.js";

export type ServerToolExecutionDecision = {
  executedBy: "gateway" | "desktop";
  reasonCodes: string[];
};

export type ToolSidecar = {
  styleLinterLibraries?: any[];
  projectFiles?: Array<{ path: string }>;
  docRules?: { path: string; content: string } | null;
};

function parseCsv(v: any) {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getServerToolAllowlist(): Set<string> {
  const cfg = String(process.env.GATEWAY_SERVER_TOOL_ALLOWLIST ?? "").trim();
  const list = cfg ? parseCsv(cfg) : ["lint.style", "project.listFiles", "project.docRules.get"];
  return new Set(list.map((x) => String(x ?? "").trim()).filter(Boolean));
}

export function parseIdListArg(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j.map((x: any) => String(x ?? "").trim()).filter(Boolean);
    } catch {
      // ignore
    }
  }
  if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  return [s];
}

export function decideServerToolExecution(args: {
  name: string;
  toolArgs: any;
  toolSidecar: ToolSidecar | null;
}): ServerToolExecutionDecision {
  const name = String(args.name ?? "").trim();
  const allow = getServerToolAllowlist();
  if (!allow.has(name)) return { executedBy: "desktop", reasonCodes: ["server_tool_not_allowed"] };

  const sidecar = (args.toolSidecar ?? null) as any;
  const styleLinterLibraries = Array.isArray(sidecar?.styleLinterLibraries) ? (sidecar.styleLinterLibraries as any[]) : [];

  // 逐步迁回：先落地 lint.style(text=...)（只读；需要 Desktop sidecar 提供指纹/样例）。
  if (name === "lint.style") {
    const text = typeof args.toolArgs?.text === "string" ? String(args.toolArgs.text) : "";
    const pathArg = typeof args.toolArgs?.path === "string" ? String(args.toolArgs.path) : "";
    const okText = text.trim().length > 0;
    const okNoPath = !pathArg.trim();
    const hasLibs = styleLinterLibraries.length > 0;
    if (okText && okNoPath && hasLibs) {
      return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "lint_style_text_server_side"] };
    }
    return { executedBy: "desktop", reasonCodes: ["server_tool_condition_not_met"] };
  }

  if (name === "project.listFiles") {
    const files = Array.isArray(sidecar?.projectFiles) ? (sidecar.projectFiles as any[]) : [];
    if (files.length > 0) return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "project_files_from_sidecar"] };
    return { executedBy: "desktop", reasonCodes: ["server_tool_condition_not_met"] };
  }

  if (name === "project.docRules.get") {
    const dr = sidecar?.docRules ?? null;
    if (dr && typeof dr === "object" && String(dr.path ?? "").trim()) {
      return { executedBy: "gateway", reasonCodes: ["server_tool_allowed", "doc_rules_from_sidecar"] };
    }
    return { executedBy: "desktop", reasonCodes: ["server_tool_condition_not_met"] };
  }

  return { executedBy: "desktop", reasonCodes: ["server_tool_not_supported"] };
}

export async function executeLintStyleOnGateway(args: {
  fastify: FastifyInstance;
  call: any;
  styleLinterLibraries: any[];
}) {
  const call = args.call;
  const text = typeof (call?.args as any)?.text === "string" ? String((call.args as any).text) : "";
  const pathArg = typeof (call?.args as any)?.path === "string" ? String((call.args as any).path) : "";
  if (!text.trim() || pathArg.trim()) {
    return { ok: false as const, error: "MISSING_TEXT_OR_PATH_NOT_SUPPORTED" };
  }

  const ids = parseIdListArg((call?.args as any)?.libraryIds);
  const filtered = ids.length
    ? (args.styleLinterLibraries ?? []).filter((l: any) => ids.includes(String(l?.id ?? "").trim()))
    : args.styleLinterLibraries ?? [];
  const libraries = filtered.slice(0, 6);
  if (!libraries.length) return { ok: false as const, error: "NO_STYLE_LIBRARIES_IN_SIDECAR" };

  const modelArg = typeof (call?.args as any)?.model === "string" ? String((call.args as any).model).trim() : "";
  const maxIssuesRaw = (call?.args as any)?.maxIssues;
  const maxIssuesNum = Number(maxIssuesRaw);
  const maxIssues = Number.isFinite(maxIssuesNum) ? Math.max(3, Math.min(24, Math.floor(maxIssuesNum))) : 10;

  const fp = computeDraftStatsForStyleLint(text);
  const injected = await args.fastify.inject({
    method: "POST",
    url: "/api/kb/dev/lint_style",
    headers: { "Content-Type": "application/json" },
    payload: {
      ...(modelArg ? { model: modelArg } : {}),
      maxIssues,
      draft: { text, chars: fp.chars, sentences: fp.sentences, stats: fp.stats },
      libraries,
    },
  });
  const status = injected.statusCode;
  let json: any = null;
  try {
    json = injected.json();
  } catch {
    json = null;
  }
  if (status < 200 || status >= 300) {
    const msg = json?.error ? String(json.error) : `HTTP_${status}`;
    return { ok: false as const, error: msg, detail: json };
  }
  return {
    ok: true as const,
    output: {
      ok: true,
      ...(json ?? {}),
      libraryIds: libraries.map((l: any) => String(l?.id ?? "").trim()).filter(Boolean),
    },
  };
}

export async function executeProjectListFilesOnGateway(args: { toolSidecar: ToolSidecar | null }) {
  const sidecar: any = args.toolSidecar ?? null;
  const filesRaw = Array.isArray(sidecar?.projectFiles) ? (sidecar.projectFiles as any[]) : [];
  const files = filesRaw
    .map((f: any) => ({ path: String(f?.path ?? "").trim() }))
    .filter((f: any) => f.path)
    .slice(0, 5000);
  if (!files.length) return { ok: false as const, error: "NO_PROJECT_FILES_IN_SIDECAR" };
  return { ok: true as const, output: { ok: true, files } };
}

export async function executeProjectDocRulesGetOnGateway(args: { toolSidecar: ToolSidecar | null }) {
  const sidecar: any = args.toolSidecar ?? null;
  const dr = sidecar?.docRules ?? null;
  if (!dr || typeof dr !== "object") return { ok: false as const, error: "DOC_RULES_NOT_FOUND" };
  const path = String(dr?.path ?? "").trim();
  const content = typeof dr?.content === "string" ? String(dr.content) : "";
  if (!path) return { ok: false as const, error: "DOC_RULES_NOT_FOUND" };
  return { ok: true as const, output: { ok: true, path, content } };
}

export async function executeServerToolOnGateway(args: {
  fastify: FastifyInstance;
  call: any;
  toolSidecar: ToolSidecar | null;
  styleLinterLibraries: any[];
}) {
  const name = String(args.call?.name ?? "").trim();
  if (name === "lint.style") return executeLintStyleOnGateway({ fastify: args.fastify, call: args.call, styleLinterLibraries: args.styleLinterLibraries });
  if (name === "project.listFiles") return executeProjectListFilesOnGateway({ toolSidecar: args.toolSidecar });
  if (name === "project.docRules.get") return executeProjectDocRulesGetOnGateway({ toolSidecar: args.toolSidecar });
  return { ok: false as const, error: "SERVER_TOOL_NOT_IMPLEMENTED" };
}


