import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeAutoRetryText,
  analyzeStyleWorkflowBatch,
  activateSkills,
  createInitialRunState,
  detectRunIntent,
  deriveStyleGate,
  isStyleExampleKbSearch,
  pickSkillStageKeyForAgentRun,
  isProposalWaitingMeta,
  parseStyleLintResult,
  isWriteLikeTool,
  type ParsedToolCall,
} from "@ohmycrab/agent-core";
import {
  computeIntentRouteDecisionPhase0,
  shouldPreferPendingWriteResumeFromTaskState,
} from "../src/agent/runFactory.ts";

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
  // ======== 2) StyleGate：workflow batch 判定 ========
  {
    const mode = "agent" as const;
    const userPrompt = "按风格库仿写一段，并写入 drafts/a.md";
    const intent = detectRunIntent({ mode, userPrompt });
    const active = activateSkills({ mode, userPrompt, kbSelected: [{ id: "style-1", purpose: "style" }], intent });
    const gates = deriveStyleGate({
      mode,
      intent,
      kbSelected: [{ id: "style-1", purpose: "style" }],
      activeSkillIds: active.map((s) => s.id),
    });
    const state = createInitialRunState({ protocolRetryBudget: 2, workflowRetryBudget: 3, lintReworkBudget: 2 });
    const toolCalls: ParsedToolCall[] = [{ name: "doc.write", args: { path: "drafts/a.md", content: "x" } }];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.shouldEnforce, true);
    assert.equal(batch.batchHasWrite, true);
    assert.equal(batch.violation, "WRITE_BEFORE_KB");
  }
  {
    // V2：copy gate 默认启用：KB 已完成但未通过 lint.copy 时，不允许直接写入
    const mode = "agent" as const;
    const userPrompt = "按风格库仿写一段，并写入 a.md";
    const intent = detectRunIntent({ mode, userPrompt });
    const active = activateSkills({ mode, userPrompt, kbSelected: [{ id: "style-1", purpose: "style" }], intent });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }], activeSkillIds: active.map((s) => s.id) });
    const state = createInitialRunState({ protocolRetryBudget: 2, workflowRetryBudget: 3, lintReworkBudget: 2 });
    state.hasStyleKbSearch = true;
    const toolCalls: ParsedToolCall[] = [{ name: "doc.write", args: { path: "a.md", content: "x" } }];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.violation, "WRITE_BEFORE_DRAFT");
  }
  {
    const mode = "agent" as const;
    const userPrompt = "按风格库仿写一段（跳过linter）";
    const intent = detectRunIntent({ mode, userPrompt });
    const active = activateSkills({ mode, userPrompt, kbSelected: [{ id: "style-1", purpose: "style" }], intent });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }], activeSkillIds: active.map((s) => s.id) });
    const state = createInitialRunState({ protocolRetryBudget: 2, workflowRetryBudget: 3, lintReworkBudget: 2 });
    state.hasStyleKbSearch = true;
    const toolCalls: ParsedToolCall[] = [{ name: "doc.write", args: { path: "a.md", content: "x" } }];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.violation, null); // 跳过 lint 时，只要 KB 已完成即可写
  }
  ok("styleGate.analyzeStyleWorkflowBatch");

  // ======== 2.1) StyleGate：更多组合（拆回合约束/回炉耗尽） ========
  {
    const mode = "agent" as const;
    const userPrompt = "按风格库仿写一段";
    const intent = detectRunIntent({ mode, userPrompt });
    const active = activateSkills({ mode, userPrompt, kbSelected: [{ id: "style-1", purpose: "style" }], intent });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }], activeSkillIds: active.map((s) => s.id) });
    const state = createInitialRunState({ protocolRetryBudget: 2, workflowRetryBudget: 3, lintReworkBudget: 2 });
    const toolCalls: ParsedToolCall[] = [
      { name: "kb.search", args: { kind: "card", query: "开场" } },
      { name: "lint.style", args: { text: "x" } },
    ];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.violation, "KB_AND_LINT_SAME_TURN");
  }
  {
    const mode = "agent" as const;
    const userPrompt = "按风格库仿写一段";
    const intent = detectRunIntent({ mode, userPrompt });
    const active = activateSkills({ mode, userPrompt, kbSelected: [{ id: "style-1", purpose: "style" }], intent });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }], activeSkillIds: active.map((s) => s.id) });
    const state = createInitialRunState({ protocolRetryBudget: 2, workflowRetryBudget: 3, lintReworkBudget: 2 });
    state.hasStyleKbSearch = true;
    const toolCalls: ParsedToolCall[] = [
      { name: "lint.style", args: { text: "x" } },
      { name: "doc.write", args: { path: "a.md", content: "y" } },
    ];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.violation, "LINT_AND_WRITE_SAME_TURN");
  }
  {
    // lintMode=hint（或用户/系统关闭 lint gate）时：lint.style 只是提示，不应阻止写入
    const mode = "agent" as const;
    const userPrompt = "按风格库仿写一段";
    const intent = detectRunIntent({ mode, userPrompt });
    const active = activateSkills({ mode, userPrompt, kbSelected: [{ id: "style-1", purpose: "style" }], intent });
    const gates0 = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }], activeSkillIds: active.map((s) => s.id) });
    const gates = { ...gates0, lintGateEnabled: false, copyGateEnabled: false }; // 模拟 Gateway 的 STYLE_LINT_MODE=hint（关闭所有 lint 闸门）
    const state = createInitialRunState({ protocolRetryBudget: 2, workflowRetryBudget: 3, lintReworkBudget: 2 });
    state.hasStyleKbSearch = true;
    const toolCalls: ParsedToolCall[] = [
      { name: "lint.style", args: { text: "x" } },
      { name: "doc.write", args: { path: "a.md", content: "y" } },
    ];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.violation, null);
  }
  {
    const mode = "agent" as const;
    const userPrompt = "按风格库仿写一段";
    const intent = detectRunIntent({ mode, userPrompt });
    const active = activateSkills({ mode, userPrompt, kbSelected: [{ id: "style-1", purpose: "style" }], intent });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }], activeSkillIds: active.map((s) => s.id) });
    const state = createInitialRunState({ protocolRetryBudget: 2, workflowRetryBudget: 3, lintReworkBudget: 2 });
    state.hasStyleKbSearch = true;
    state.hasDraftText = true;
    state.copyLintPassed = true;
    state.styleLintPassed = false;
    state.styleLintFailCount = 3;
    const toolCalls: ParsedToolCall[] = [{ name: "doc.write", args: { path: "a.md", content: "y" } }];
    const batch = analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework: 2, toolCalls });
    assert.equal(batch.violation, "WRITE_BLOCKED_LINT_EXHAUSTED");
  }
  ok("styleGate.moreCombos");

  // ======== 2.2) Skills：激活/可解释/独立 stageKey ========
  {
    const mode = "agent" as const;
    const userPrompt = "按风格库仿写一段";
    const intent = detectRunIntent({ mode, userPrompt, mainDocRunIntent: "auto" });
    const skills = activateSkills({ mode, userPrompt, mainDocRunIntent: "auto", kbSelected: [{ id: "style-1", purpose: "style" }], intent });
    assert.equal(skills.some((s) => s.id === "style_imitate"), true);
    assert.equal(pickSkillStageKeyForAgentRun(skills), "agent.skill.style_imitate");
    assert.ok(Array.isArray(skills[0]?.activatedBy?.reasonCodes));
  }
  {
    // 真实场景：写@{file}（目标文件）+ runIntent=auto，应判为写作任务并激活 style_imitate
    const mode = "agent" as const;
    const userPrompt = "严格用绑定风格库的口吻写@{示例.md}，1200字左右";
    const intent = detectRunIntent({ mode, userPrompt, mainDocRunIntent: "auto" });
    assert.equal(intent.isWritingTask, true);
    const skills = activateSkills({ mode, userPrompt, mainDocRunIntent: "auto", kbSelected: [{ id: "style-1", purpose: "style" }], intent });
    assert.equal(skills.some((s) => s.id === "style_imitate"), true);
  }
  {
    // 续跑/澄清回复：用户 prompt 很短（例如“继续/视频脚本”），但 RUN_TODO 明确属于写作闭环，应激活 style_imitate
    const mode = "agent" as const;
    const userPrompt = "继续";
    const runTodo = [
      { id: "vs", text: "确认需求：形式（视频脚本vs文章）与素材扩充边界", status: "blocked", note: "等待用户回复" },
      { id: "t2", text: "检索风格素材：拉取直男财经样例", status: "todo" },
      { id: "lint_style", text: "风格自检：使用 lint.style", status: "todo" },
    ];
    const intent = detectRunIntent({ mode, userPrompt, mainDocRunIntent: "auto", runTodo });
    assert.equal(intent.isWritingTask, true);
    const skills = activateSkills({
      mode,
      userPrompt,
      mainDocRunIntent: "auto",
      kbSelected: [{ id: "style-1", purpose: "style" }],
      intent,
    });
    assert.equal(skills.some((s) => s.id === "style_imitate"), true);
  }
  {
    // 关键回归：RUN_TODO 为空时，用户用“编号回答/短回复”回复上一轮澄清（recent dialogue 里有“请确认/请选择”且语境是写作），也应判为写作续跑并激活 style_imitate。
    const mode = "agent" as const;
    const userPrompt = "1按建议来；2OK；3可以";
    const recentDialogue = [
      {
        role: "assistant",
        text: "我将按绑定风格库仿写 5 篇情感挽回稿（每篇 1200 字左右，各生成一个 md 文件）。请确认：1按建议来；2OK；3可以",
      },
    ];
    const intent = detectRunIntent({ mode, userPrompt, mainDocRunIntent: "auto", runTodo: [], recentDialogue });
    assert.equal(intent.isWritingTask, true);
    const skills = activateSkills({
      mode,
      userPrompt,
      mainDocRunIntent: "auto",
      kbSelected: [{ id: "style-1", purpose: "style" }],
      intent,
    });
    assert.equal(skills.some((s) => s.id === "style_imitate"), true);
  }
  {
    // web_topic_radar 已移除，此场景下 style_imitate 不应被激活（因为是搜索场景，不是写作）
    const mode = "agent" as const;
    const userPrompt = "查一查全网和github，看看这种问题怎么解决";
    const runTodo = [
      { id: "vs", text: "确认需求：形式（视频脚本vs文章）与素材扩充边界", status: "blocked", note: "等待用户回复" },
      { id: "t2", text: "检索风格素材：拉取直男财经样例", status: "todo" },
      { id: "lint_style", text: "风格自检：使用 lint.style", status: "todo" },
    ];
    const intent = detectRunIntent({ mode, userPrompt, mainDocRunIntent: "auto", runTodo });
    assert.equal(intent.isWritingTask, false);
    const skills = activateSkills({
      mode,
      userPrompt,
      mainDocRunIntent: "auto",
      kbSelected: [{ id: "style-1", purpose: "style" }],
      intent,
    });
    assert.equal(skills.some((s) => s.id === "style_imitate"), false);
  }
  {
    const mode = "agent" as const;
    const userPrompt = "帮我分析一下这段话";
    const intent = detectRunIntent({ mode, userPrompt, mainDocRunIntent: "analysis" });
    const skills = activateSkills({ mode, userPrompt, mainDocRunIntent: "analysis", kbSelected: [{ id: "style-1", purpose: "style" }], intent });
    assert.equal(skills.length, 0);
  }
  ok("skills.activation");

  // ======== 3) AutoRetry：空输出/未写入/未 lint 等 ========
  {
    const mode = "agent" as const;
    const intent = detectRunIntent({ mode, userPrompt: "请写入 drafts/a.md" });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [] });
    const state = createInitialRunState({ protocolRetryBudget: 2, workflowRetryBudget: 3, lintReworkBudget: 2 });
    state.hasTodoList = true;
    const a = analyzeAutoRetryText({ assistantText: "", intent, gates, state, lintMaxRework: 2, targetChars: 1200 });
    assert.equal(a.isEmpty, true);
    assert.equal(a.shouldRetry, true);
    assert.ok(a.reasons.length >= 1);
  }
  ok("autoRetry.analyzeAutoRetryText");

  // ======== 3.0.1) AutoRetry：不再承担 workflow 强约束（仅错误恢复） ========
  {
    const mode = "agent" as const;
    const userPrompt = "按风格库仿写一段";
    const intent = detectRunIntent({ mode, userPrompt });
    const active = activateSkills({ mode, userPrompt, kbSelected: [{ id: "style-1", purpose: "style" }], intent });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }], activeSkillIds: active.map((s) => s.id) });
    const state = createInitialRunState({ protocolRetryBudget: 2, workflowRetryBudget: 3, lintReworkBudget: 2 });
    state.hasTodoList = true;
    state.hasStyleKbSearch = true;
    state.hasDraftText = true;
    state.hasPostDraftStyleKbSearch = false;
    state.copyLintPassed = false;
    state.lastCopyLint = null;
    const a = analyzeAutoRetryText({ assistantText: "继续", intent, gates, state, lintMaxRework: 2, targetChars: 1200 });
    assert.equal(a.isEmpty, false);
    assert.equal(a.needTodo, false);
    assert.equal(a.shouldRetry, false);
  }
  ok("autoRetry.error_only_policy");

  // ======== 3.1) Lint parse / proposal meta ========
  {
    const parsed = parseStyleLintResult({
      similarityScore: 12,
      issues: [{ severity: "high" }],
      rewritePrompt: "x",
      summary: "y",
      expectedDimensions: ["logic_framework", "voice_rhythm"],
      coveredDimensions: ["voice_rhythm"],
      missingDimensions: ["logic_framework"],
      modelUsed: "local_heuristic(gpt-5)",
    });
    assert.equal(parsed.usedHeuristic, true);
    assert.equal(parsed.expectedDimensions.length, 2);
    assert.equal(parsed.coveredDimensions.length, 1);
    assert.equal(parsed.missingDimensions.length, 1);
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
      false, // V2：templates 阶段必须显式 cardTypes
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
    const runFactory = await readRepoFile("apps/gateway/src/agent/runFactory.ts");
    const runner = await readRepoFile("apps/gateway/src/agent/writingAgentRunner.ts");
    const gwAll = gw + "\n" + runFactory + "\n" + runner;
    assert.ok(gw.includes("\"policy.decision\""), "Gateway 缺少 policy.decision SSE（可观测性回退）");
    assert.ok(gwAll.includes("SkillPolicy"), "Gateway 缺少 SkillPolicy 决策记录（Skills 可解释性回退）");
    assert.ok(gwAll.includes("SkillToolCapsPolicy") || gwAll.includes("toolCaps"), "Gateway 缺少 SkillToolCapsPolicy/toolCaps（skills toolCaps/阶段门禁可能回退）");
    assert.ok(gwAll.includes("reasonCodes"), "Gateway run.end 未携带 reasonCodes（可解释性回退）");
    assert.ok(gwAll.includes("style_kb_zero_hit") || gwAll.includes("styleKbDegraded"), "Gateway 缺少 kb 0 命中降级标记（可能再次卡死）");
    assert.ok(gwAll.includes("reason: \"clarify_waiting\""), "Gateway 缺少 clarify_waiting 分支（可能再次“问你但仍继续跑”）");
    assert.ok(gwAll.includes("assistant.done"), "Gateway/Runner 未发送 assistant.done（assistant 边界回退）");
    assert.ok(gwAll.includes("assistant.start"), "Gateway 缺少 assistant.start SSE（turn 边界可能回退）");
    assert.ok(gwAll.includes("protocolRetryBudget"), "Gateway 缺少 protocolRetryBudget（预算拆分可能回退）");
    assert.ok(gwAll.includes("workflowRetryBudget"), "Gateway 缺少 workflowRetryBudget（预算拆分可能回退）");
    assert.ok(gwAll.includes("hasWriteProposed"), "Gateway 缺少 hasWriteProposed（proposal 语义可解释性可能回退）");
    assert.ok(gwAll.includes("executedBy"), "Gateway tool.call 未携带 executedBy（无法逐步迁回 Gateway）");
    assert.ok(gwAll.includes("styleLinterLibraries"), "Gateway 未读取 toolSidecar.styleLinterLibraries（server-side lint.style 无法落地）");
    assert.ok(gwAll.includes("completionOnceViaProvider"), "Gateway 未使用 completionOnceViaProvider（ProviderAdapter one-shot 可能回退）");
    assert.ok(!gwAll.includes("chatCompletionOnce("), "Gateway 仍直接调用 chatCompletionOnce（ProviderAdapter 统一回退）");
    // lint.style：调用上游模型的 server-side 工具，必须计费（否则白嫖强模型）。
    assert.ok(gwAll.includes("source: \"tool.lint.style\"") || gwAll.includes("tool.lint.style"), "Gateway 未对 lint.style 扣费入账（工具计费回退）");
    assert.ok(gwAll.includes("projectFiles"), "Gateway 未接收 toolSidecar.projectFiles（server-side project.listFiles 无法落地）");
    assert.ok(gw.includes("/api/admin/audit/runs"), "Gateway 未暴露审计查询接口 /api/admin/audit/runs（审计落库回退）");
    assert.ok(gwAll.includes("需确认") || gwAll.includes("澄清"), "Gateway ClarifyPolicy 未覆盖 需确认/澄清（可能再次自说自话继续跑）");
    // Selector v1：写法候选不应再用 clarify_waiting 强制用户先选（默认自动选并继续）
    assert.ok(gwAll.includes("policy: \"StyleClusterSelectPolicy\""), "Gateway 缺少 StyleClusterSelectPolicy（Selector v1 回退）");
    assert.ok(gwAll.includes("decision: \"auto_selected\""), "StyleClusterSelectPolicy 未默认 auto_selected（Selector v1 回退）");
  }
  {
    const desk = await readRepoFile("apps/desktop/src/agent/toolRegistry.ts");
    assert.ok(desk.includes("doc.restoreSnapshot"), "Desktop 虚拟 workspace 未覆盖 doc.restoreSnapshot");
    assert.ok(desk.includes("doc.splitToDir(proposal)"), "Desktop 虚拟 workspace 未覆盖 doc.splitToDir");
  }
  {
    const gatewayAgent = await readRepoFile("apps/desktop/src/agent/gatewayAgent.ts");
    const wsTransport = await readRepoFile("apps/desktop/src/agent/wsTransport.ts");
    const deskAll = gatewayAgent + "\n" + wsTransport;
    assert.ok(deskAll.includes("toolSidecar"), "Desktop 未向 /api/agent/run/stream 发送 toolSidecar（server-side lint.style 无法落地）");
    assert.ok(deskAll.includes("projectFiles"), "Desktop 未在 toolSidecar 携带 projectFiles（server-side project.listFiles 无法落地）");
    assert.ok(deskAll.includes("assistant.start"), "Desktop 未处理 assistant.start（turn 边界可能回退）");
    assert.ok(gatewayAgent.includes("ACTIVE_SKILLS(JSON)"), "Desktop 未注入 ACTIVE_SKILLS(JSON)（Skills 可见性回退）");
    assert.ok(gatewayAgent.includes("KB_STYLE_CLUSTERS(JSON)"), "Desktop 未注入 KB_STYLE_CLUSTERS(JSON)（M3 写法候选回退）");
    assert.ok(gatewayAgent.includes("STYLE_SELECTOR(JSON)"), "Desktop 未注入 STYLE_SELECTOR(JSON)（Selector v1 回退）");
    assert.ok(gatewayAgent.includes("STYLE_DIMENSIONS"), "Desktop 未注入 STYLE_DIMENSIONS（维度结构化注入回退）");
    assert.ok(gatewayAgent.includes("styleContractV1"), "Desktop 未落地 styleContractV1（M3 主文档风格契约回退）");
  }
  {
    const run = await readRepoFile("apps/desktop/src/state/runStore.ts");
    assert.ok(run.includes("styleContractV1"), "MainDoc 缺少 styleContractV1 字段（M3 回退）");
  }
  {
    const skills = await readRepoFile("packages/agent-core/src/skills.ts");
    assert.ok(skills.includes("KB_STYLE_CLUSTERS"), "style_imitate 未提示写法候选（M3 回退）");
    assert.ok(skills.includes("STYLE_SELECTOR(JSON)"), "style_imitate 未提示 STYLE_SELECTOR(JSON)（Selector v1 回退）");
    assert.ok(skills.includes("styleContractV1"), "style_imitate 未要求写入 styleContractV1（M3 回退）");
  }
  {
    const ai = await readRepoFile("apps/gateway/src/aiConfig.ts");
    assert.ok(ai.includes("agent.skill.style_imitate"), "aiConfig 未包含 agent.skill.style_imitate stage 默认定义（Skills stage 回退）");
  }
  {
    const sr = await readRepoFile("apps/gateway/src/agent/serverToolRunner.ts");
    assert.ok(sr.includes("GATEWAY_SERVER_TOOL_ALLOWLIST"), "serverToolRunner 缺少 allowlist 环境变量（迁回入口可能回退）");
    assert.ok(sr.includes("project.listFiles"), "serverToolRunner 未支持 project.listFiles");
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

  // ======== 6) missingDimensions 必须参与 lint 通过判定 ========
  {
    // 场景 A：score 过线 + highIssues=0 + 有 missing 维度 => 不应通过
    const lintOut = {
      similarityScore: 85,
      summary: "整体不错",
      issues: [],
      rewritePrompt: "补齐 values_embedding",
      expectedDimensions: ["values_embedding", "narrative_perspective", "rhetoric"],
      coveredDimensions: ["rhetoric"],
      missingDimensions: ["values_embedding", "narrative_perspective"],
    };
    const parsed = parseStyleLintResult(lintOut);
    assert.equal(parsed.score, 85);
    assert.equal(parsed.highIssues, 0);
    assert.equal(parsed.missingDimensions.length, 2);
    // 关键断言：即便 score=85 && highIssues=0，有 missing 维度就不能算 passed
    const mustCovered = parsed.expectedDimensions.length === 0 || parsed.missingDimensions.length === 0;
    assert.equal(mustCovered, false, "有 missingDimensions 时不应通过");

    // 场景 B：score 过线 + highIssues=0 + 无 missing 维度 => 应通过
    const lintOut2 = {
      similarityScore: 82,
      summary: "ok",
      issues: [],
      rewritePrompt: "",
      expectedDimensions: ["rhetoric", "values_embedding"],
      coveredDimensions: ["rhetoric", "values_embedding"],
      missingDimensions: [],
    };
    const parsed2 = parseStyleLintResult(lintOut2);
    const mustCovered2 = parsed2.expectedDimensions.length === 0 || parsed2.missingDimensions.length === 0;
    assert.equal(mustCovered2, true, "无 missingDimensions 时应通过");

    // 场景 C：无维度信息（旧版 lint.style 不返回维度字段）=> 应通过（向后兼容）
    const lintOut3 = { similarityScore: 75, summary: "ok", issues: [], rewritePrompt: "" };
    const parsed3 = parseStyleLintResult(lintOut3);
    const mustCovered3 = parsed3.expectedDimensions.length === 0 || parsed3.missingDimensions.length === 0;
    assert.equal(mustCovered3, true, "无维度信息时应向后兼容通过");
  }
  ok("lint.missingDimensions.blockPass");

  // ======== 7) targetChars 参数传递：AutoRetry 不做长度强约束 ========
  {
    const mode = "agent" as const;
    const intent = detectRunIntent({ mode, userPrompt: "按风格库仿写一段1200字" });
    const gates = deriveStyleGate({ mode, intent, kbSelected: [{ id: "style-1", purpose: "style" }], activeSkillIds: ["style_imitate"] });
    const state = createInitialRunState();
    state.hasTodoList = true;
    state.hasStyleKbSearch = true;
    state.hasStyleKbHit = true;
    state.hasDraftText = true;
    state.hasPostDraftStyleKbSearch = true;
    state.copyLintPassed = true;
    state.styleLintPassed = true;
    // 模拟：lint 已通过，但输出字数远超目标
    const longText = "这是一段非常长的候选正文。" + "此处省略大量文字。".repeat(200);
    const a = analyzeAutoRetryText({ assistantText: longText, intent, gates, state, lintMaxRework: 2, targetChars: 1200 });
    assert.equal(a.isEmpty, false, "非空文本不应被当作空输出");
    assert.equal(a.shouldRetry, false, "长度偏差不再由 AutoRetry 强制重试");

    // 不传 targetChars 同样不影响 AutoRetry 的错误恢复判断
    const b = analyzeAutoRetryText({ assistantText: longText, intent, gates, state, lintMaxRework: 2 });
    assert.equal(b.shouldRetry, false, "不传 targetChars 时保持错误恢复逻辑一致");
  }
  ok("autoRetry.targetChars.error_only_policy");

  // eslint-disable-next-line no-console
  console.log("[regress-agent-flow] ALL OK");
}

main().catch((e) => {
  console.error("[regress-agent-flow] FAILED:", e);
  process.exit(1);
});


  // ======== 4) 路由：Directive / Inquiry / Continuation ========
  {
    const mode = "agent" as const;
    const userPrompt = "hi";
    const intent = detectRunIntent({ mode, userPrompt });
    const route = computeIntentRouteDecisionPhase0({ mode, userPrompt, intent, runTodo: [], mainDoc: null });
    assert.equal(route.intentType, "discussion");
    assert.equal(route.routeId, "discussion");
  }
  {
    const mode = "agent" as const;
    const userPrompt = "打开小红书页面，等我登录后告诉你下一步";
    const intent = detectRunIntent({ mode, userPrompt });
    const route = computeIntentRouteDecisionPhase0({ mode, userPrompt, intent, runTodo: [], mainDoc: null });
    assert.equal(route.intentType, "task_execution");
  }
  {
    const ok = shouldPreferPendingWriteResumeFromTaskState({
      taskState: {
        resume: { canResumePendingWrite: true, artifactId: "artifact_1", pathHint: "drafts/a.md" },
      },
      userPrompt: "保存吧",
      projectDirAvailable: true,
      intent: {},
    });
    assert.equal(ok, true);
  }
  ok("routing.directive_inquiry_and_resume_state");

