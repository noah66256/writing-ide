import assert from "node:assert/strict";

import { GatewayRuntime } from "../src/agent/runtime/GatewayRuntime.js";
import type { LoopKernel } from "../src/agent/runtime/kernel/LoopKernel.types.js";

type HookToolCall = {
  eventName: string;
  input: Record<string, unknown>;
};

function createCommandResult(
  overrides?: Partial<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  }>,
) {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    ...(overrides ?? {}),
  };
}

function createEmptyKernel(): LoopKernel {
  return {
    run() {
      return {
        async *[Symbol.asyncIterator]() {
          // no-op
        },
        async result() {
          return [];
        },
      } as any;
    },
  };
}

function createAssistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "smoke-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as any;
}

function createFollowUpKernel(args?: {
  onFollowUpBatch?: (messages: any[], stopAttempt: number) => void;
}): LoopKernel {
  return {
    run(runArgs: any) {
      const messages: any[] = [];
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "agent_start" };

          let stopAttempt = 0;
          let turnIndex = 0;
          while (true) {
            turnIndex += 1;
            if (turnIndex > 5) {
              throw new Error("unexpected endless follow-up loop");
            }
            yield { type: "turn_start" };

            const assistantMessage = createAssistantMessage(`turn ${turnIndex}`);
            messages.push(assistantMessage);
            yield { type: "message_start", message: assistantMessage };
            yield { type: "message_end", message: assistantMessage };
            yield { type: "turn_end", message: assistantMessage, toolResults: [] };

            stopAttempt += 1;
            const followUps = ((await runArgs.getFollowUpMessages?.()) || []) as any[];
            if (followUps.length === 0) break;
            args?.onFollowUpBatch?.(followUps, stopAttempt);
            for (const message of followUps) {
              messages.push(message);
              yield { type: "message_start", message };
              yield { type: "message_end", message };
            }
          }

          yield { type: "agent_end", messages };
        },
        async result() {
          return messages;
        },
      } as any;
    },
  };
}

function createRuntimeHarness(args?: {
  hooks?: Record<string, unknown>;
  portablePreRunCompact?: Record<string, unknown> | null;
  onHookToolCall?: (call: HookToolCall) => Record<string, unknown>;
  kernel?: LoopKernel;
}) {
  const events: Array<{ event: string; data: unknown }> = [];
  const waiters = new Map<string, (payload: any) => void>();
  const abortController = new AbortController();
  const skillId = "hook-smoke";
  const hookCalls: HookToolCall[] = [];

  const runtime = new GatewayRuntime(
    {
      mode: "pi",
      runCtx: {
        runId: "run_smoke",
        threadId: "thread_smoke",
        mode: "agent",
        opMode: "assistant",
        intent: { isWritingTask: false },
        gates: {},
        activeSkills: [{ id: skillId }],
        skillManifestById: new Map([
          [
            skillId,
            {
              id: skillId,
              name: skillId,
              portable: true,
              hooks: args?.hooks ?? {},
            },
          ],
        ]),
        allowedToolNames: new Set<string>(),
        systemPrompt: "smoke",
        toolSidecar: { ideSummary: { projectDir: process.cwd() } },
        styleLinterLibraries: [],
        fastify: null,
        authorization: null,
        modelId: "smoke-model",
        apiKey: "smoke-key",
        baseUrl: "https://example.com",
        endpoint: "/v1/responses",
        writeEvent: (event: string, data: unknown) => {
          events.push({ event, data });
          if (event !== "tool.call") return;
          const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
          if (String(payload.name ?? "") !== "portable.hook.command") return;
          const toolCallId = String(payload.toolCallId ?? "").trim();
          const toolArgs =
            payload.args && typeof payload.args === "object" && !Array.isArray(payload.args)
              ? (payload.args as Record<string, unknown>)
              : {};
          const hookCall = {
            eventName: String(toolArgs.eventName ?? "").trim(),
            input:
              toolArgs.stdinJson && typeof toolArgs.stdinJson === "object" && !Array.isArray(toolArgs.stdinJson)
                ? (toolArgs.stdinJson as Record<string, unknown>)
                : {},
          };
          hookCalls.push(hookCall);
          const output = args?.onHookToolCall?.(hookCall) ?? createCommandResult();
          waiters.get(toolCallId)?.({
            toolCallId,
            name: "portable.hook.command",
            ok: true,
            output,
          });
        },
        waiters,
        abortSignal: abortController.signal,
        mainDoc: {},
        portableSkillContext: {
          activeSkillIds: [skillId],
        } as any,
        portablePreRunCompact: args?.portablePreRunCompact ?? null,
      } as any,
    },
    args?.kernel ?? createEmptyKernel(),
  );

  return { runtime, events, hookCalls, abortController };
}

async function scenario_permission_allow() {
  const { runtime } = createRuntimeHarness({
    hooks: {
      PermissionRequest: [{ hooks: [{ type: "command", command: "allow" }] }],
    },
    onHookToolCall(call) {
      if (call.eventName !== "PermissionRequest") return createCommandResult();
      return createCommandResult({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: "allow",
            updatedInput: { path: "approved.md" },
            permissionDecisionReason: "approved by smoke",
          },
        }),
      });
    },
  });

  const runtimeAny = runtime as any;
  runtimeAny.turn = 1;
  runtimeAny.internalAc = new AbortController();
  const ret = await runtimeAny._emitPortablePermissionRequest({
    toolName: "write",
    toolArgs: { path: "draft.md" },
    errorCode: "PORTABLE_SKILL_HOOK_DENIED",
    decisionSource: "portable_hook_pre_tool_use",
    message: "need approval",
    approvalEligible: true,
    allowCanProceed: true,
  });

  assert.equal(ret.permissionBehavior, "allow");
  assert.deepEqual(ret.updatedArgs, { path: "approved.md" });
}

async function scenario_permission_approval_waiting() {
  const { runtime, events } = createRuntimeHarness({
    hooks: {
      PermissionRequest: [{ hooks: [{ type: "command", command: "approval" }] }],
    },
    onHookToolCall(call) {
      if (call.eventName !== "PermissionRequest") return createCommandResult();
      return createCommandResult({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            decision: {
              behavior: "approval",
              question: "批准这次写入吗？",
              detail: { path: "draft.md" },
            },
          },
        }),
      });
    },
  });

  const runtimeAny = runtime as any;
  runtimeAny.turn = 2;
  runtimeAny.internalAc = new AbortController();
  const ret = await runtimeAny._emitPortablePermissionRequest({
    toolName: "write",
    toolArgs: { path: "draft.md" },
    errorCode: "PORTABLE_SKILL_HOOK_DENIED",
    decisionSource: "portable_hook_pre_tool_use",
    message: "need approval",
    approvalEligible: true,
    allowCanProceed: true,
  });

  assert.equal(ret.approvalRequested, true);
  assert.equal(ret.approvalQuestion, "批准这次写入吗？");
  assert.equal(runtime.getOutcome().reason, "approval_waiting");
  assert.ok(events.some((entry) => entry.event === "portable.permission.requested"));
}

async function scenario_dialogue_summary_compact() {
  const { runtime, hookCalls } = createRuntimeHarness({
    hooks: {
      PreCompact: [{ hooks: [{ type: "command", command: "pre-compact" }] }],
      PostCompact: [{ hooks: [{ type: "command", command: "post-compact" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "session-start" }] }],
    },
    portablePreRunCompact: {
      trigger: "auto",
      scope: "dialogue_summary",
      compactSummary: "summary from smoke",
      customInstructions: "",
      deltaTurns: 3,
      performedAt: "2026-03-21T00:00:00.000Z",
    },
    onHookToolCall() {
      return createCommandResult();
    },
  });

  await runtime.run("hello");

  const preCompact = hookCalls.find((item) => item.eventName === "PreCompact");
  const postCompact = hookCalls.find((item) => item.eventName === "PostCompact");
  const sessionStart = hookCalls.find((item) => item.eventName === "SessionStart");
  assert.ok(preCompact, "expected PreCompact hook call");
  assert.ok(postCompact, "expected PostCompact hook call");
  assert.ok(sessionStart, "expected SessionStart hook call");
  assert.equal(String(preCompact?.input.scope ?? ""), "dialogue_summary");
  assert.equal(String(postCompact?.input.compact_summary ?? ""), "summary from smoke");
  assert.equal(String(sessionStart?.input.source ?? ""), "compact");
}

async function scenario_notification_hook() {
  const { runtime, hookCalls } = createRuntimeHarness({
    hooks: {
      Notification: [{ matcher: "sample.notice", hooks: [{ type: "command", command: "notification" }] }],
    },
    onHookToolCall() {
      return createCommandResult();
    },
  });

  const runtimeAny = runtime as any;
  runtimeAny.turn = 1;
  await runtimeAny._writePortableNotificationNotice({
    turn: 1,
    kind: "info",
    title: "NotificationSmoke",
    message: "notice from smoke",
    notificationType: "sample.notice",
    source: "smoke.notification",
  });

  const notificationHook = hookCalls.find((item) => item.eventName === "Notification");
  assert.ok(notificationHook, "expected Notification hook call");
  assert.equal(String(notificationHook?.input.notification_type ?? ""), "sample.notice");
}

async function scenario_stop_block_continues() {
  const followUpBatches: any[][] = [];
  let stopCalls = 0;
  const { runtime, hookCalls } = createRuntimeHarness({
    kernel: createFollowUpKernel({
      onFollowUpBatch(messages) {
        followUpBatches.push(messages);
      },
    }),
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "stop-block" }] }],
    },
    onHookToolCall(call) {
      if (call.eventName !== "Stop") return createCommandResult();
      stopCalls += 1;
      if (stopCalls === 1) {
        return createCommandResult({
          stdout: JSON.stringify({
            decision: {
              decision: "block",
              reason: "再做一次收口检查",
            },
          }),
        });
      }
      return createCommandResult();
    },
  });

  const ret = await runtime.run("hello");
  assert.ok(hookCalls.some((item) => item.eventName === "Stop"), "expected Stop hook call");
  assert.ok(followUpBatches.length > 0, "expected follow-up batch after Stop block");
  assert.equal(ret.turn, 2);
  assert.equal(ret.outcome.reason, "completed");
  assert.match(String((followUpBatches[0]?.[0] as any)?.text ?? ""), /再做一次收口检查/);
}

async function scenario_subagent_stop_block_continues() {
  const { runtime, hookCalls } = createRuntimeHarness({
    hooks: {
      SubagentStop: [{ hooks: [{ type: "command", command: "subagent-stop-block" }] }],
    },
    onHookToolCall(call) {
      if (call.eventName !== "SubagentStop") return createCommandResult();
      return createCommandResult({
        stdout: JSON.stringify({
          decision: {
            decision: "block",
            reason: "子 Agent 结果还需要父 Agent 继续整合",
          },
        }),
      });
    },
  });

  const runtimeAny = runtime as any;
  runtimeAny.turn = 1;
  runtimeAny.collabRuntime.spawn = async () => ({
    ok: true,
    output: { ok: true, agentId: "agent_smoke" },
    executedBy: "gateway",
  });
  const ret = await runtimeAny._executeAgentTool("tool_spawn_smoke", "spawn_agent", {
    agent: "reviewer",
    task: "inspect smoke",
  });
  const followUps = await runtimeAny._getFollowUpMessages();

  assert.equal(ret.ok, true);
  assert.ok(hookCalls.some((item) => item.eventName === "SubagentStop"), "expected SubagentStop hook call");
  assert.ok(followUps.length > 0, "expected follow-up after SubagentStop block");
  assert.match(String((followUps[0] as any)?.text ?? ""), /子 Agent 结果还需要父 Agent 继续整合/);
}

async function main() {
  await scenario_permission_allow();
  await scenario_permission_approval_waiting();
  await scenario_dialogue_summary_compact();
  await scenario_notification_hook();
  await scenario_stop_block_continues();
  await scenario_subagent_stop_block_continues();
  console.log("claude hook parity smoke ok");
}

main().catch((error) => {
  console.error("claude hook parity smoke failed", error);
  process.exitCode = 1;
});
