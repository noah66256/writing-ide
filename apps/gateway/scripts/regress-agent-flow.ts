import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeAutoRetryText,
  analyzeStyleWorkflowBatch,
  createInitialRunState,
  detectRunIntent,
  deriveStyleGate,
  isStyleExampleKbSearch,
  isToolCallMessage,
  isProposalWaitingMeta,
  parseStyleLintResult,
  isWriteLikeTool,
  parseToolCalls,
  type ParsedToolCall,
} from "@writing-ide/agent-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../../..");

async function readRepoFile(rel: string) {
  return fs.readFile(path.resolve(ROOT, rel), "utf-8");
}

function ok(name: string) {
  // eslint-disable-next-line no-console
  console.log(`[regress-agent-flow] OK: ${name}`);
}

async function main() {
  // ======== 1) XML 协议：parseToolCalls ========
  {
    const msg =
      `<tool_calls>` +
      `<tool_call name="kb.search">` +
      `<arg name="query"><![CDATA[test]]></arg>` +
      `</tool_call>` +
      `</tool_calls>`;
    assert.equal(isToolCallMessage(msg), true);
    const calls = parseToolCalls(msg);
    assert.ok(calls && calls.length === 1);
    assert.equal(calls[0].name, "kb.search");
    assert.equal(String(calls[0].args.query ?? "").trim(), "test");
  }
  {
    const msg =
      "```xml\n" +
      `<tool_call name="run.setTodoList">` +
      `<arg name="items"><![CDATA[[]]]></arg>` +
      `</tool_call>\n` +
      "```";
    assert.equal(isToolCallMessage(msg), true);
    const calls = parseToolCalls(msg);
    assert.ok(calls && calls.length === 1);
    assert.equal(calls[0].name, "run.setTodoList");
  }
  ok("xmlProtocol.parseToolCalls");

  // ======== 2) StyleGate：workflow batch 判定 ========
  {
    const mode = "agent" as const;
    const intent = detectRunIntent({ mode, userPrompt: "按风格库仿写一段，并写入 drafts/a.md" });
    const gates = deriveStyleGate({
      mode,
      intent,
      kbSelected: [{ id: "style-1", purpose: "style" }],
    });
    const state = createInitialRunState({ autoRetryBudget: 3 });
    const toolCalls: ParsedToolCall[] = [{ name: "doc.write", args: { path: "drafts/a.md", content: "x" } }];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.shouldEnforce, true);
    assert.equal(batch.batchHasWrite, true);
    assert.equal(batch.violation, "WRITE_BEFORE_KB");
  }
  {
    const mode = "agent" as const;
    const intent = detectRunIntent({ mode, userPrompt: "按风格库仿写一段（跳过linter）" });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }] });
    const state = createInitialRunState({ autoRetryBudget: 3 });
    state.hasStyleKbSearch = true;
    const toolCalls: ParsedToolCall[] = [{ name: "doc.write", args: { path: "a.md", content: "x" } }];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.violation, null); // 跳过 lint 时，只要 KB 已完成即可写
  }
  ok("styleGate.analyzeStyleWorkflowBatch");

  // ======== 2.1) StyleGate：更多组合（拆回合约束/回炉耗尽） ========
  {
    const mode = "agent" as const;
    const intent = detectRunIntent({ mode, userPrompt: "按风格库仿写一段" });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }] });
    const state = createInitialRunState({ autoRetryBudget: 3 });
    const toolCalls: ParsedToolCall[] = [
      { name: "kb.search", args: { kind: "card", query: "开场" } },
      { name: "lint.style", args: { text: "x" } },
    ];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.violation, "KB_AND_LINT_SAME_TURN");
  }
  {
    const mode = "agent" as const;
    const intent = detectRunIntent({ mode, userPrompt: "按风格库仿写一段" });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }] });
    const state = createInitialRunState({ autoRetryBudget: 3 });
    state.hasStyleKbSearch = true;
    const toolCalls: ParsedToolCall[] = [
      { name: "lint.style", args: { text: "x" } },
      { name: "doc.write", args: { path: "a.md", content: "y" } },
    ];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.violation, "LINT_AND_WRITE_SAME_TURN");
  }
  {
    const mode = "agent" as const;
    const intent = detectRunIntent({ mode, userPrompt: "按风格库仿写一段" });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }] });
    const state = createInitialRunState({ autoRetryBudget: 3 });
    state.hasStyleKbSearch = true;
    state.styleLintPassed = false;
    state.styleLintFailCount = 3;
    const toolCalls: ParsedToolCall[] = [{ name: "doc.write", args: { path: "a.md", content: "y" } }];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.violation, "WRITE_BLOCKED_LINT_EXHAUSTED");
  }
  ok("styleGate.moreCombos");

  // ======== 3) AutoRetry：空输出/未写入/未 lint 等 ========
  {
    const mode = "agent" as const;
    const intent = detectRunIntent({ mode, userPrompt: "请写入 drafts/a.md" });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [] });
    const state = createInitialRunState({ autoRetryBudget: 3 });
    state.hasTodoList = true;
    const a = analyzeAutoRetryText({ assistantText: "", intent, gates, state, lintMaxRework: 2 });
    assert.equal(a.isEmpty, true);
    assert.equal(a.shouldRetry, true);
    assert.ok(a.reasons.length >= 1);
  }
  ok("autoRetry.analyzeAutoRetryText");

  // ======== 3.1) Lint parse / proposal meta ========
  {
    const parsed = parseStyleLintResult({ similarityScore: 12, issues: [{ severity: "high" }], rewritePrompt: "x", summary: "y", modelUsed: "local_heuristic(gpt-5)" });
    assert.equal(parsed.usedHeuristic, true);
  }
  {
    assert.equal(isProposalWaitingMeta({ applyPolicy: "proposal", hasApply: true }), true);
    assert.equal(isProposalWaitingMeta({ applyPolicy: "auto_apply", hasApply: true }), false);
  }
  ok("lint.parseStyleLintResult/isProposalWaitingMeta");

  // ======== 4) isStyleExampleKbSearch / isWriteLikeTool ========
  {
    const call: ParsedToolCall = { name: "kb.search", args: { kind: "card", query: "开场", libraryIds: "[\"style-1\"]" } };
    assert.equal(
      isStyleExampleKbSearch({ call, styleLibIdSet: new Set(["style-1"]), hasNonStyleLibraries: false }),
      true,
    );
    // 同时绑定非风格库：cardTypes 缺失 => 不算“风格样例检索”（避免污染）
    assert.equal(
      isStyleExampleKbSearch({ call: { name: "kb.search", args: { kind: "card", query: "开场" } }, styleLibIdSet: new Set(["style-1"]), hasNonStyleLibraries: true }),
      false,
    );
    // 同时绑定非风格库：显式限制 cardTypes + libraryIds（JSON 字符串） => 算“风格样例检索”
    assert.equal(
      isStyleExampleKbSearch({
        call: { name: "kb.search", args: { kind: "card", query: "开场", cardTypes: "[\"hook\"]", libraryIds: "[\"style-1\"]" } },
        styleLibIdSet: new Set(["style-1"]),
        hasNonStyleLibraries: true,
      }),
      true,
    );
  }
  assert.equal(isWriteLikeTool("doc.splitToDir"), true);
  assert.equal(isWriteLikeTool("kb.search"), false);
  ok("toolHeuristics.isStyleExampleKbSearch/isWriteLikeTool");

  // ======== 5) 静态回归：关键链路仍存在（防止“未来重构时删掉关键保护”） ========
  {
    const gw = await readRepoFile("apps/gateway/src/index.ts");
    assert.ok(gw.includes("\"policy.decision\""), "Gateway 缺少 policy.decision SSE（可观测性回退）");
    assert.ok(gw.includes("reasonCodes"), "Gateway run.end 未携带 reasonCodes（可解释性回退）");
    assert.ok(gw.includes("style_kb_zero_hit"), "Gateway 缺少 kb 0 命中降级标记（可能再次卡死）");
    assert.ok(gw.includes("reason: \"clarify_waiting\""), "Gateway 缺少 clarify_waiting 分支（可能再次“问你但仍继续跑”）");
    assert.ok(gw.includes("reason: \"tool_calls\""), "Gateway tool_calls 分支未发送 assistant.done(tool_calls)（assistant 边界回退）");
    assert.ok(gw.includes("executedBy"), "Gateway tool.call 未携带 executedBy（无法逐步迁回 Gateway）");
    assert.ok(gw.includes("styleLinterLibraries"), "Gateway 未读取 toolSidecar.styleLinterLibraries（server-side lint.style 无法落地）");
    assert.ok(gw.includes("completionOnceViaProvider"), "Gateway 未使用 completionOnceViaProvider（ProviderAdapter one-shot 可能回退）");
    assert.ok(!gw.includes("chatCompletionOnce("), "Gateway 仍直接调用 chatCompletionOnce（ProviderAdapter 统一回退）");
    assert.ok(gw.includes("source: \"tool.lint.style\""), "Gateway 未对 server-side lint.style 计费入账（工具计费地基回退）");
    assert.ok(gw.includes("projectFiles"), "Gateway 未接收 toolSidecar.projectFiles（server-side project.listFiles 无法落地）");
    assert.ok(gw.includes("docRules"), "Gateway 未接收 toolSidecar.docRules（server-side project.docRules.get 无法落地）");
    assert.ok(gw.includes("/api/admin/audit/runs"), "Gateway 未暴露审计查询接口 /api/admin/audit/runs（审计落库回退）");
  }
  {
    const desk = await readRepoFile("apps/desktop/src/agent/toolRegistry.ts");
    assert.ok(desk.includes("doc.restoreSnapshot"), "Desktop 虚拟 workspace 未覆盖 doc.restoreSnapshot");
    assert.ok(desk.includes("doc.splitToDir(proposal)"), "Desktop 虚拟 workspace 未覆盖 doc.splitToDir");
  }
  {
    const desk = await readRepoFile("apps/desktop/src/agent/gatewayAgent.ts");
    assert.ok(desk.includes("toolSidecar"), "Desktop 未向 /api/agent/run/stream 发送 toolSidecar（server-side lint.style 无法落地）");
    assert.ok(desk.includes("projectFiles"), "Desktop 未在 toolSidecar 携带 projectFiles（server-side project.listFiles 无法落地）");
    assert.ok(desk.includes("docRules"), "Desktop 未在 toolSidecar 携带 docRules（server-side project.docRules.get 无法落地）");
  }
  {
    const sr = await readRepoFile("apps/gateway/src/agent/serverToolRunner.ts");
    assert.ok(sr.includes("GATEWAY_SERVER_TOOL_ALLOWLIST"), "serverToolRunner 缺少 allowlist 环境变量（迁回入口可能回退）");
    assert.ok(sr.includes("project.listFiles"), "serverToolRunner 未支持 project.listFiles");
    assert.ok(sr.includes("project.docRules.get"), "serverToolRunner 未支持 project.docRules.get");
  }
  {
    const db = await readRepoFile("apps/gateway/src/db.ts");
    assert.ok(db.includes("runAudits"), "Db 缺少 runAudits 字段（审计无法落库）");
    assert.ok(db.includes("updateDb"), "Db 缺少 updateDb（并发写入可能互相覆盖）");
  }
  {
    const tools = await readRepoFile("packages/tools/src/index.ts");
    assert.ok(tools.includes("inputSchema"), "packages/tools 未引入 inputSchema（工具契约 schema 可能回退）");
    assert.ok(tools.includes("validateToolCallArgs"), "packages/tools 缺少 validateToolCallArgs（Gateway 参数校验可能回退）");
  }
  ok("static.regressChecks");

  // eslint-disable-next-line no-console
  console.log("[regress-agent-flow] ALL OK");
}

main().catch((e) => {
  console.error("[regress-agent-flow] FAILED:", e);
  process.exit(1);
});


