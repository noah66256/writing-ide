import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import dotenv from "dotenv";
import { loadDb, saveDb, type User } from "./db.js";
import { kbSearch, type KbCard } from "@writing-ide/kb-core";
import { MemoryKbStore } from "./kb/memoryStore.js";
import { adjustUserPoints, listUserTransactions } from "./billing.js";
import { chatCompletionOnce, streamChatCompletions, type OpenAiChatMessage } from "./llm/openaiCompat.js";
import { isToolCallMessage, parseToolCalls, renderToolResultXml } from "./agent/xmlProtocol.js";
import { toolNamesForMode, toolsPrompt, type AgentMode } from "./agent/toolRegistry.js";

// 允许使用项目根目录的 .env（你可以用 env.example 复制出来），也支持 apps/gateway/.env 覆盖
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PORT = Number(process.env.PORT ?? 8000);
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
const IS_DEV = process.env.NODE_ENV !== "production";
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

type CodeRequest = {
  email: string;
  code: string;
  expiresAt: number;
};

const codeRequests = new Map<string, CodeRequest>();
const kbStore = new MemoryKbStore();

const fastify = Fastify({
  logger: true
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: unknown, reply: unknown) => Promise<void>;
  }
}

await fastify.register(cors, {
  origin: true,
  credentials: true
});

await fastify.register(jwt, {
  secret: JWT_SECRET
});

fastify.decorate("authenticate", async (request: any, reply: any) => {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: "UNAUTHORIZED" });
  }
});

function requireAdmin(request: any, reply: any) {
  if (request.user?.role !== "admin") {
    reply.code(403).send({ error: "FORBIDDEN" });
  }
}

fastify.get("/api/health", async () => {
  return { ok: true };
});

function getLlmEnv() {
  const baseUrl = String(process.env.LLM_BASE_URL ?? "").trim();
  const apiKey = String(process.env.LLM_API_KEY ?? "").trim();
  const defaultModel = String(process.env.LLM_MODEL ?? "").trim();
  return {
    baseUrl,
    apiKey,
    defaultModel,
    ok: Boolean(baseUrl && apiKey && defaultModel)
  };
}

// ======== LLM（OpenAI-compatible，开发期最小闭环） ========

fastify.get("/api/llm/models", async () => {
  const env = getLlmEnv();
  if (!env.defaultModel) return { models: [] };
  return { models: [{ id: env.defaultModel }] };
});

fastify.post("/api/llm/chat/stream", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const msgSchema = z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string()
  });
  const bodySchema = z.object({
    model: z.string().optional(),
    prompt: z.string().optional(),
    messages: z.array(msgSchema).optional(),
    temperature: z.number().min(0).max(2).optional()
  });
  const body = bodySchema.parse((request as any).body);

  const env = getLlmEnv();
  if (!env.ok) return reply.code(500).send({ error: "LLM_NOT_CONFIGURED" });

  const model = body.model ?? env.defaultModel;
  const messages: OpenAiChatMessage[] =
    body.messages?.length
      ? (body.messages as any)
      : body.prompt
        ? [{ role: "user", content: body.prompt }]
        : [];

  if (!messages.length) return reply.code(400).send({ error: "EMPTY_MESSAGES" });

  // 注意：不要用 writeHead 覆盖 fastify-cors 已设置的响应头，否则浏览器会 CORS 失败（Failed to fetch）
  // 这里用 setHeader 追加 SSE 相关头，并显式补齐 allow-origin（保险起见）。
  const origin = String((request as any).headers?.origin ?? "").trim();
  if (origin) {
    reply.raw.setHeader("access-control-allow-origin", origin);
    reply.raw.setHeader("access-control-allow-credentials", "true");
    reply.raw.setHeader("vary", "Origin");
  }
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  (reply as any).hijack?.();
  (reply.raw as any).flushHeaders?.();

  const abort = new AbortController();
  // 仅在“客户端中断”时取消上游请求；不要监听 request.close（它在正常完成请求体后也会触发）
  request.raw.on("aborted", () => abort.abort());
  reply.raw.on("close", () => abort.abort());

  const writeEvent = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  writeEvent("run.start", { model });

  try {
    for await (const ev of streamChatCompletions({
      config: { baseUrl: env.baseUrl, apiKey: env.apiKey },
      model,
      messages,
      temperature: body.temperature,
      signal: abort.signal
    })) {
      if (ev.type === "delta") writeEvent("assistant.delta", { delta: ev.delta });
      else if (ev.type === "done") writeEvent("assistant.done", {});
      else if (ev.type === "error") writeEvent("error", { error: ev.error });
    }
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    writeEvent("error", { error: msg });
  } finally {
    reply.raw.end();
  }
});

// ======== Agent（ReAct：Gateway 负责模型对话与 tool.call 事件；工具由 Desktop 执行并回传 tool_result） ========

type ToolResultPayload = {
  toolCallId: string;
  name: string;
  ok: boolean;
  output: unknown;
  meta?: {
    applyPolicy?: "proposal" | "auto_apply";
    riskLevel?: "low" | "medium" | "high";
    hasApply?: boolean;
  };
};

const agentRunWaiters = new Map<string, Map<string, (payload: ToolResultPayload) => void>>();

function buildAgentProtocolPrompt(mode: AgentMode) {
  const modePolicy =
    mode === "chat"
      ? `当前模式：Chat（纯对话）。\n- 你**不允许调用任何工具**（包括读写文件）。\n- 你只需用 Markdown 输出可读内容即可。\n\n`
      : `当前模式：${mode === "plan" ? "Plan（逐步）" : "Agent（一次成型+迭代）"}。\n` +
        `你需要按“写作闭环”工作，并把进度写入 Main Doc / Todo：\n` +
        `1) 澄清（最多 5 个问题，可选）：平台画像 / 受众 / 目标 / 口吻人设 / 素材来源。\n` +
        `   - 若用户明确说“先直接开始/先仿写看看/先给版本/不要再问”：你必须跳过澄清，基于合理默认假设直接开写。\n` +
        `   - 若信息不足以开写且用户未要求直接开始：先输出澄清问题（自然语言），此时不要调用工具。\n` +
        `2) 产 Todo List（可追踪）：只要进入执行阶段，你必须立刻调用 run.setTodoList（不要等用户再次确认）。\n` +
        `3) 执行（由你自主决定是否调用工具）：素材收集（@引用/读文件）→ 结构（先 outline）→ 初稿 → 改写润色 → 自检。\n` +
        `4) 进度记录：完成/推进每个关键步骤时，调用 run.updateTodo；关键决策与约束调用 run.mainDoc.update。\n` +
        `输出约束：\n` +
        `- 给用户看的文字输出必须是 Markdown（富文本），不要输出 JSON。\n` +
        `- 不要输出思维链/自言自语（例如“我将…”“下一步我会…”）；只输出对用户有用的内容（澄清问题 / 结果 / 简短步骤摘要）。\n` +
        `- 绝对不要臆造“用户刚刚说了什么/回复了继续”。历史仅以 Main Doc / RUN_TODO 为准。\n` +
        `- 如果用户要求把结果写入项目（例如：分割到文件夹、生成多个文件、覆盖某文件、移动/删除/重命名），你必须调用相关工具真正写入；不要只在文本里声称“已完成”。\n` +
        `- 若需要调用工具：请直接输出 <tool_call>/<tool_calls>（整条消息只含 XML）；不要在同一条消息里夹带任何 Markdown 文本。\n` +
        `- 如需更新多个 Todo/Main Doc：请在一次 <tool_calls> 中批量调用多个 tool_call，减少回合，避免触发 maxTurns。\n` +
        `- 写入类操作遵守系统的 proposal-first / Keep/Undo 机制。\n\n`;

  return (
    `你是写作 IDE 的内置 Agent（偏写作产出与编辑体验，不要跑偏成通用工作流平台）。\n\n` +
    modePolicy +
    `你可以在需要时“调用工具”。当你要调用工具时，你必须输出 **且只能输出** 下面 XML 之一：\n` +
    `- 单次：<tool_call name="..."><arg name="...">...</arg></tool_call>\n` +
    `- 多次：<tool_calls>...多个 tool_call...</tool_calls>\n\n` +
    `规则：\n` +
    `- 如果你输出 tool_call/tool_calls，则消息里禁止夹杂任何其它自然语言。\n` +
    `- <arg> 内可以放 JSON（不要代码块，不要反引号）。\n` +
    `- 工具结果会由系统用 XML 回传（system message）：<tool_result name="xxx"><![CDATA[{...json}]]></tool_result>\n\n` +
    `你可用的工具如下（只能调用这里列出的）：\n\n` +
    toolsPrompt(mode)
  );
}

fastify.post("/api/agent/run/stream", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const bodySchema = z.object({
    model: z.string().optional(),
    mode: z.enum(["plan", "agent", "chat"]).optional(),
    prompt: z.string().min(1),
    contextPack: z.string().optional()
  });
  const body = bodySchema.parse((request as any).body);

  const env = getLlmEnv();
  if (!env.ok) return reply.code(500).send({ error: "LLM_NOT_CONFIGURED" });

  const model = body.model ?? env.defaultModel;
  const mode = (body.mode ?? "agent") as AgentMode;
  const runId = randomUUID();
  const allowedToolNames = toolNamesForMode(mode);

  const origin = String((request as any).headers?.origin ?? "").trim();
  if (origin) {
    reply.raw.setHeader("access-control-allow-origin", origin);
    reply.raw.setHeader("access-control-allow-credentials", "true");
    reply.raw.setHeader("vary", "Origin");
  }
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  (reply as any).hijack?.();
  (reply.raw as any).flushHeaders?.();

  const abort = new AbortController();
  request.raw.on("aborted", () => abort.abort());
  reply.raw.on("close", () => abort.abort());

  const writeEvent = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const waiters = new Map<string, (payload: ToolResultPayload) => void>();
  agentRunWaiters.set(runId, waiters);

  writeEvent("run.start", { runId, model, mode });

  const messages: OpenAiChatMessage[] = [
    { role: "system", content: buildAgentProtocolPrompt(mode) },
    ...(body.contextPack ? [{ role: "system", content: body.contextPack } as OpenAiChatMessage] : []),
    { role: "user", content: body.prompt }
  ];

  const userPrompt = String(body.prompt ?? "");
  const forceProceed =
    mode !== "chat" &&
    /(先(直接)?(开始|写|仿写|给一版|给版本|产出|干活)|不要(再)?问|别问了|先做|直接写)/.test(userPrompt);
  const wantsWrite =
    mode !== "chat" &&
    (/@\{[^}]+\/\}/.test(userPrompt) ||
      /(分割|拆分|切分|写入|保存|生成|放到|移动到|导出|新建|删除|重命名)/.test(userPrompt));

  let hasTodoList = false;
  let hasWriteOps = false;
  let hasAnyToolCall = false;
  let autoRetryBudget = 2;

  function looksLikeClarifyQuestions(text: string) {
    const t = String(text ?? "").trim();
    if (!t) return false;
    if (t.length > 2000) return false;
    // 简单启发式：包含问号/疑问词，且不像是在输出最终结果
    return /[?？]/.test(t) || /(请问|是否|能否|方便|要不要|需要你)/.test(t);
  }

  function isWriteLikeTool(name: string) {
    return (
      name === "doc.write" ||
      name === "doc.applyEdits" ||
      name === "doc.replaceSelection" ||
      name === "doc.mkdir" ||
      name === "doc.renamePath" ||
      name === "doc.deletePath" ||
      name === "doc.restoreSnapshot" ||
      name === "doc.splitToDir"
    );
  }

  const maxTurns = mode === "agent" ? 48 : mode === "plan" ? 32 : 12;

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (abort.signal.aborted) break;

      let assistantText = "";
      let decided: "unknown" | "tool" | "text" = "unknown";
      let flushed = 0;

      for await (const ev of streamChatCompletions({
        config: { baseUrl: env.baseUrl, apiKey: env.apiKey },
        model,
        messages,
        signal: abort.signal
      })) {
        if (ev.type === "delta") {
          assistantText += ev.delta;
          const prevDecided = decided;
          if (decided === "unknown") {
            const t = assistantText.trimStart();
            if (t.startsWith("<tool_calls") || t.startsWith("<tool_call")) decided = "tool";
            else if (t.length > 0 && !t.startsWith("<")) decided = "text";
            else if (t.length > 96 && t.startsWith("<") && !t.startsWith("<tool_calls") && !t.startsWith("<tool_call"))
              decided = "text";
          }
          // 一旦判断为 text，需要把此前积累但未发出的内容补发，否则会出现“输出中断/缺头”
          if (decided === "text") {
            if (prevDecided !== "text") {
              writeEvent("assistant.delta", { delta: assistantText.slice(flushed) });
              flushed = assistantText.length;
            } else {
              writeEvent("assistant.delta", { delta: ev.delta });
              flushed = assistantText.length;
            }
          }
        }
        if (ev.type === "error") {
          writeEvent("error", { error: ev.error });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }
        if (ev.type === "done") break;
      }

      const toolCalls = parseToolCalls(assistantText);
      if (!toolCalls) {
        // 如果看起来像 tool_calls 但解析失败：不要直接终止 run，要求模型立刻重试一次（避免用户手动“继续”）
        if (isToolCallMessage(assistantText)) {
          writeEvent("assistant.delta", {
            delta:
              "\n\n[解析提示] 该条看起来像工具调用，但 XML 解析失败；我会让模型自动重试一次（无需你输入）。\n" +
              "请它严格输出 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。"
          });
          writeEvent("assistant.done", { reason: "tool_xml_parse_failed_retry" });
          messages.push({
            role: "system",
            content:
              "你上一条输出看起来像工具调用，但 XML 解析失败。请立刻重新输出严格的 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。"
          });
          continue;
        }

        // Plan/Agent：避免“只读完 doc 就停 / 没有 todo 就结束 / 明明要写入却没写入”
        if (mode !== "chat" && autoRetryBudget > 0) {
          const t = assistantText.trim();
          const isEmpty = t.length === 0;
          const isClarify = looksLikeClarifyQuestions(t) && !forceProceed;

          const needTodo = !hasTodoList && !isClarify;
          const needWrite = wantsWrite && !hasWriteOps && !isClarify;

          if (isEmpty || needTodo || needWrite) {
            autoRetryBudget -= 1;
            writeEvent("assistant.delta", {
              delta:
                "\n\n[系统提示] 检测到本次任务尚未进入可追踪执行（Todo 未设置 / 或尚未完成写入目标），我会让模型自动继续一次（无需你输入）。\n" +
                "请它：若不需澄清，先 run.setTodoList；若用户要求写入项目/分割到文件夹，请务必用工具执行（例如 doc.write / doc.splitToDir）。"
            });
            writeEvent("assistant.done", { reason: "auto_retry_incomplete" });

            // 记录本轮输出（即使为空），并要求下一轮按协议继续
            messages.push({ role: "assistant", content: assistantText });
            messages.push({
              role: "system",
              content:
                "你刚才输出了纯文本，但任务尚未完成。\n" +
                "- 如果需要澄清：请直接输出最多 5 个问题（纯文本），此时不要调用工具。\n" +
                "- 否则：请立刻输出严格的 <tool_calls>...</tool_calls>（整条消息只含 XML，不夹杂自然语言）。\n" +
                "  - 至少包含 run.setTodoList\n" +
                "  - 若用户要求写入/分割到文件夹：请调用 doc.splitToDir（或 doc.write 等）完成写入。"
            });
            continue;
          }
        }

        // 纯文本：认为本次 run 已给出用户可读输出，结束
        messages.push({ role: "assistant", content: assistantText });
        writeEvent("run.end", { runId, reason: "text", turn });
        writeEvent("assistant.done", { reason: "text" });
        reply.raw.end();
        agentRunWaiters.delete(runId);
        return;
      }

      messages.push({ role: "assistant", content: assistantText });

      // tool_calls：逐个 emit tool.call，等待 Desktop 回传 tool_result
      for (const call of toolCalls) {
        hasAnyToolCall = true;
        if (!call?.name || !allowedToolNames.has(call.name)) {
          writeEvent("error", { error: `TOOL_NOT_ALLOWED:${call?.name ?? ""}` });
          writeEvent("run.end", { runId, reason: "tool_not_allowed", turn, tool: call?.name ?? "" });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }

        const toolCallId = randomUUID();
        writeEvent("tool.call", { toolCallId, name: call.name, args: call.args });

        const payload: ToolResultPayload = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("TOOL_RESULT_TIMEOUT")), 180_000);
          waiters.set(toolCallId, (p) => {
            clearTimeout(timeout);
            resolve(p);
          });
          abort.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              reject(new Error("ABORTED"));
            },
            { once: true }
          );
        });

        waiters.delete(toolCallId);
        writeEvent("tool.result", {
          toolCallId,
          name: payload.name,
          ok: payload.ok,
          output: payload.output,
          meta: payload.meta ?? null
        });

        if (payload.ok && payload.name === "run.setTodoList") hasTodoList = true;
        if (payload.ok && isWriteLikeTool(payload.name)) hasWriteOps = true;

        messages.push({ role: "system", content: renderToolResultXml(call.name, payload.output) });

        // proposal-first：工具返回需要用户确认的提案，终止本次 run，等待用户 Keep/Undo 后再继续对话
        if (payload.meta?.applyPolicy === "proposal" && payload.meta?.hasApply) {
          writeEvent("assistant.delta", {
            delta:
              "\n\n我已经生成一份“修改提案”（见上方 Tool Block）。\n\n" +
              "- 点击 **Keep**：应用到编辑器\n" +
              "- 点击 **Undo**：丢弃该提案\n\n" +
              "确认后你可以继续发下一条指令（例如：继续改写下一段/生成整篇）。"
          });
          writeEvent("run.end", { runId, reason: "proposal_waiting", turn, tool: call.name });
          writeEvent("assistant.done", { reason: "proposal_waiting" });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }
      }
    }

    writeEvent("assistant.delta", {
      delta: "\n\n[提示] 已达到本次 Run 的最大工具循环轮数（maxTurns），为避免死循环已自动停止。"
    });
    writeEvent("run.end", { runId, reason: "maxTurns", maxTurns });
    writeEvent("assistant.done", { reason: "maxTurns" });
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    writeEvent("error", { error: msg });
  } finally {
    agentRunWaiters.delete(runId);
    reply.raw.end();
  }
});

fastify.post("/api/agent/run/:runId/tool_result", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const paramsSchema = z.object({ runId: z.string().min(1) });
  const bodySchema = z.object({
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    ok: z.boolean(),
    output: z.any(),
    meta: z
      .object({
        applyPolicy: z.enum(["proposal", "auto_apply"]).optional(),
        riskLevel: z.enum(["low", "medium", "high"]).optional(),
        hasApply: z.boolean().optional()
      })
      .optional()
  });
  const { runId } = paramsSchema.parse((request as any).params);
  const payload = bodySchema.parse((request as any).body) as ToolResultPayload;

  const waiters = agentRunWaiters.get(runId);
  if (!waiters) return reply.code(404).send({ error: "RUN_NOT_FOUND" });

  const resolve = waiters.get(payload.toolCallId);
  if (!resolve) return reply.code(404).send({ error: "TOOL_CALL_NOT_FOUND" });

  resolve(payload);
  return reply.send({ ok: true });
});

fastify.post("/api/auth/email/request-code", async (request, reply) => {
  const bodySchema = z.object({
    email: z.string().email()
  });
  const { email } = bodySchema.parse(request.body);

  const requestId = randomUUID();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresInSeconds = 10 * 60;

  codeRequests.set(requestId, {
    email: email.toLowerCase(),
    code,
    expiresAt: Date.now() + expiresInSeconds * 1000
  });

  // TODO(生产): 接入邮件服务商发送验证码
  return reply.send({
    requestId,
    expiresInSeconds,
    ...(IS_DEV ? { devCode: code } : {})
  });
});

fastify.post("/api/auth/email/verify", async (request, reply) => {
  const bodySchema = z.object({
    email: z.string().email(),
    requestId: z.string().min(1),
    code: z.string().regex(/^\d{6}$/)
  });
  const { email, requestId, code } = bodySchema.parse(request.body);

  const record = codeRequests.get(requestId);
  if (!record || record.email !== email.toLowerCase()) {
    return reply.code(400).send({ error: "INVALID_REQUEST" });
  }
  if (Date.now() > record.expiresAt) {
    codeRequests.delete(requestId);
    return reply.code(400).send({ error: "CODE_EXPIRED" });
  }
  if (record.code !== code) {
    return reply.code(400).send({ error: "CODE_INVALID" });
  }
  codeRequests.delete(requestId);

  const db = await loadDb();
  const lowerEmail = email.toLowerCase();

  let user = db.users.find((u) => u.email === lowerEmail);
  if (!user) {
    const isAdmin = ADMIN_EMAILS.includes(lowerEmail) || (IS_DEV && db.users.length === 0);
    const role: User["role"] = isAdmin ? "admin" : "user";
    user = {
      id: randomUUID(),
      email: lowerEmail,
      role,
      pointsBalance: 0,
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    await saveDb(db);
  }

  const accessToken = fastify.jwt.sign({ sub: user.id, email: user.email, role: user.role });
  return reply.send({
    accessToken,
    user
  });
});

fastify.get(
  "/api/me",
  {
    preHandler: (fastify as any).authenticate
  },
  async (request: any) => {
    const db = await loadDb();
    const me = db.users.find((u) => u.id === request.user.sub);
    return {
      user: {
        id: request.user.sub,
        email: request.user.email,
        role: request.user.role,
        pointsBalance: me?.pointsBalance ?? 0
      }
    };
  }
);

// ======== Points（C端可展示余额/流水） ========

fastify.get(
  "/api/points/balance",
  {
    preHandler: (fastify as any).authenticate
  },
  async (request: any) => {
    const db = await loadDb();
    const me = db.users.find((u) => u.id === request.user.sub);
    return { pointsBalance: me?.pointsBalance ?? 0 };
  }
);

fastify.get(
  "/api/points/transactions",
  {
    preHandler: (fastify as any).authenticate
  },
  async (request: any) => {
    const db = await loadDb();
    return { transactions: listUserTransactions(db, request.user.sub) };
  }
);

// ======== Admin：用户管理 + 充值积分（B端使用） ========

fastify.get(
  "/api/admin/users",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin]
  },
  async () => {
    const db = await loadDb();
    return {
      users: db.users.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        pointsBalance: u.pointsBalance,
        createdAt: u.createdAt
      }))
    };
  }
);

fastify.patch(
  "/api/admin/users/:id/role",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin]
  },
  async (request) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const bodySchema = z.object({ role: z.enum(["admin", "user"]) });
    const { id } = paramsSchema.parse((request as any).params);
    const { role } = bodySchema.parse((request as any).body);

    const db = await loadDb();
    const user = db.users.find((u) => u.id === id);
    if (!user) return { error: "USER_NOT_FOUND" };
    user.role = role;
    await saveDb(db);
    return { ok: true };
  }
);

fastify.post(
  "/api/admin/users/:id/points/recharge",
  {
    preHandler: [(fastify as any).authenticate, requireAdmin]
  },
  async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const bodySchema = z.object({
      points: z.number().int().min(1),
      reason: z.string().max(200).optional()
    });
    const { id } = paramsSchema.parse((request as any).params);
    const { points, reason } = bodySchema.parse((request as any).body);

    const db = await loadDb();
    try {
      const { user, tx } = adjustUserPoints({
        db,
        userId: id,
        delta: points,
        type: "recharge",
        reason: reason ?? "admin_recharge"
      });
      await saveDb(db);
      return reply.send({ ok: true, pointsBalance: user.pointsBalance, tx });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(400).send({ error: msg });
    }
  }
);

/**
 * KB: 仅用于验证“kb-core 可复用”的最小闭环接口。
 * - 暂不做 embedding：返回结果主要靠你后续接入 embedding & semantic parse。
 * - 先把 Jinli 的混合评分检索算法抽到 kb-core，这里只是演示如何接。
 */
fastify.post(
  "/api/kb/dev/seed",
  {
    preHandler: (fastify as any).authenticate
  },
  async () => {
    // seed 2 cards, embeddingDone=false => 目前不会被向量检索选中
    const cards: Array<Partial<KbCard>> = [
      {
        title: "知识库是什么？",
        content: "知识库是 Agent 的长期可检索记忆（RAG）+可引用素材库。",
        tags: ["知识库", "RAG"],
        priority: 7,
        embeddingDone: false
      },
      {
        title: "平台画像（分发机制）",
        content: "平台差异按分发机制：Feed试看型 vs 点选/搜索型 vs 长内容订阅型。",
        tags: ["平台画像"],
        priority: 8,
        embeddingDone: false
      }
    ];
    for (const c of cards) kbStore.upsertCard(c as any);
    return { ok: true, count: kbStore.listCards().length };
  }
);

fastify.post(
  "/api/kb/search",
  {
    preHandler: (fastify as any).authenticate
  },
  async (request) => {
    const bodySchema = z.object({
      query: z.string().min(1),
      topK: z.number().int().min(1).max(50).optional()
    });
    const { query, topK } = bodySchema.parse(request.body);

    // TODO: 接入 embedding provider 后用真正的 queryEmbedding
    const queryEmbedding = [] as number[];

    const { results } = kbSearch({
      query,
      candidates: kbStore.listCards(),
      queryEmbedding,
      understanding: null,
      options: { topK }
    });

    return {
      results: results.map((r) => ({
        id: r.card.id,
        title: r.card.title,
        score: r.score,
        matchReasons: r.matchReasons
      }))
    };
  }
);

/**
 * KB 抽卡（开发期）：输入段落列表，输出结构化卡片（JSON）。
 * - 不落库：由 Desktop 本地 KB 接口负责写入/断点续传。
 * - 不要求登录：因为 Desktop 目前还没接入真实登录态（后续可切到 authenticate）。
 */
fastify.post("/api/kb/dev/extract_cards", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const bodySchema = z.object({
    model: z.string().optional(),
    maxCards: z.number().int().min(1).max(80).optional(),
    facetIds: z.array(z.string().min(1)).min(1).max(80).optional(),
    // doc_v2: 让模型直接输出最终写作要素类型（hook/thesis/ending/one_liner/outline/other）
    mode: z.enum(["generic", "doc_v2"]).optional(),
    paragraphs: z
      .array(
        z.object({
          index: z.number().int().min(0),
          text: z.string().min(1),
          headingPath: z.array(z.string()).optional()
        })
      )
      .min(1)
      .max(300)
  });
  const body = bodySchema.parse((request as any).body);

  const baseUrlDefault = String(process.env.LLM_BASE_URL ?? "").trim();
  const apiKeyDefault = String(process.env.LLM_API_KEY ?? "").trim();
  const modelDefault = String(process.env.LLM_MODEL ?? "").trim();

  const cardBaseUrl = String(process.env.LLM_CARD_BASE_URL ?? "").trim() || baseUrlDefault;
  const cardApiKey = String(process.env.LLM_CARD_API_KEY ?? "").trim() || apiKeyDefault;
  const cardModelDefault = String(process.env.LLM_CARD_MODEL ?? "").trim() || modelDefault;

  if (!cardBaseUrl || !cardApiKey || !cardModelDefault) {
    return reply.code(500).send({
      error: "LLM_NOT_CONFIGURED",
      hint: "请配置 LLM_BASE_URL/LLM_MODEL/LLM_API_KEY；若抽卡需不同 key/model，请配置 LLM_CARD_MODEL/LLM_CARD_API_KEY（可选 LLM_CARD_BASE_URL）。"
    });
  }

  const model = body.model ?? cardModelDefault;
  const maxCards = body.maxCards ?? 18;
  const retryMax = Number(process.env.LLM_CARD_RETRY_MAX ?? 3);
  const retryBaseMs = Number(process.env.LLM_CARD_RETRY_BASE_MS ?? 800);

  // facet 列表：先用 plan.md 里的顶层枚举（后续接入更细的 taxonomy 文件）
  const defaultFacetIds = [
    "intro",
    "opening_design",
    "narrative_structure",
    "language_style",
    "one_liner_crafting",
    "topic_selection",
    "resonance",
    "logic_framework",
    "reader_interaction",
    "emotion_mobilization",
    "question_design",
    "scene_building",
    "rhetoric",
    "voice_rhythm",
    "persuasion",
    "values_embedding",
    "structure_patterns",
    "psychology_principles",
    "special_markers",
    "viral_patterns",
    "ai_clone_strategy"
  ];
  const facetIds =
    Array.isArray((body as any).facetIds) && (body as any).facetIds.length
      ? (body as any).facetIds.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 80)
      : defaultFacetIds;

  const mode = (body as any).mode ?? "generic";

  const sys =
    mode === "doc_v2"
      ? [
          "你是写作 IDE 的「知识库抽卡器」。",
          "任务：从输入段落中抽取“最终写作要素卡”，用于仿写与结构复用（人类不看中间产物）。",
          "",
          "输出要求：你必须且只能输出一个 JSON 数组（不要代码块，不要多余文字）。",
          "数组元素为 Card 对象，字段：",
          '- title: string（短标题）',
          '- cardType: "hook"|"thesis"|"ending"|"one_liner"|"outline"|"other"（必填）',
          "- content: string（Markdown，要能直接拿来写作/仿写）",
          "- paragraphIndices: number[]（引用来源段落索引；至少 1 个）",
          `- facetIds: string[]（必填：从以下枚举里选 1-3 个；不要编造新的；若无法判断用 ["${facetIds[0] ?? "logic_framework"}"]）：${facetIds.join(", ")}`,
          "",
          "数量建议：hook<=3，thesis<=3，ending<=3，one_liner<=12（可合并成少量卡），outline<=1。",
          `数量硬约束：最多 ${maxCards} 张卡。避免重复、避免空泛。`
        ].join("\n")
      : [
          "你是写作 IDE 的「知识库抽卡器」。",
          "任务：把输入的段落列表抽取成可复用的写作知识卡（卡片越少越精）。",
          "",
          "输出要求：你必须且只能输出一个 JSON 数组（不要代码块，不要多余文字）。",
          "数组元素为 Card 对象，字段：",
          '- title: string（卡片标题，短且可复用）',
          '- type: "concept"|"principle"|"strategy"|"tactic"|"case"|"warning"|"faq"（可选，尽量填）',
          "- content: string（Markdown，建议用要点列表；要能直接拿来写作）",
          "- tags?: string[]",
          "- oneLiners?: string[]（可选）",
          "- steps?: string[]（可选）",
          "- pitfalls?: string[]（可选）",
          "- examples?: string[]（可选）",
          "- paragraphIndices: number[]（引用来源段落索引，用于回链；至少 1 个）",
          `- facetIds: string[]（必填：从以下枚举里选 1-3 个，允许多选；不要编造新的；如果确实无法判断，填 ["logic_framework"]）：${facetIds.join(", ")}`,
          "",
          `数量约束：最多 ${maxCards} 张卡。避免重复、避免空泛。`
        ].join("\n");

  const user = [
    "段落列表如下（格式：[#index] (headingPath 可选) 内容）：",
    ...body.paragraphs.map((p) => {
      const hp = Array.isArray(p.headingPath) && p.headingPath.length ? ` (${p.headingPath.join(" > ")})` : "";
      const text = String(p.text ?? "").replace(/\s+/g, " ").trim();
      return `[#${p.index}]${hp} ${text}`;
    })
  ].join("\n");

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const parseUpstream = (text: string) => {
    let message = String(text ?? "");
    try {
      const j = JSON.parse(message);
      if (typeof j?.error?.message === "string") message = j.error.message;
      else if (typeof j?.message === "string") message = j.message;
    } catch {
      // ignore
    }
    const m = message.match(/request id:\s*([^)]+)\)/i);
    const requestId = m?.[1] ? String(m[1]) : undefined;
    return { message, requestId };
  };

  let lastErr: any = null;
  let lastStatus: number | undefined = undefined;
  let lastDetail: string | undefined = undefined;

  let ret: any = null;
  for (let attempt = 0; attempt <= retryMax; attempt += 1) {
    ret = await chatCompletionOnce({
      config: { baseUrl: cardBaseUrl, apiKey: cardApiKey },
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      temperature: 0.2
    });

    if (ret.ok) break;

    lastStatus = ret.status;
    lastDetail = ret.error;
    const is429 = ret.status === 429 || String(ret.error ?? "").includes("Too Many Requests") || String(ret.error ?? "").includes("负载已饱和");
    lastErr = { is429, detail: ret.error, status: ret.status };
    if (!is429 || attempt >= retryMax) break;

    const jitter = Math.floor(Math.random() * 200);
    const wait = retryBaseMs * Math.pow(2, attempt) + jitter;
    await sleep(wait);
  }

  if (!ret?.ok) {
    const is429 = Boolean(lastErr?.is429);
    const parsed = parseUpstream(String(lastDetail ?? ""));
    const payload = {
      error: is429 ? "UPSTREAM_BUSY" : "UPSTREAM_ERROR",
      message: parsed.message || "upstream error",
      requestId: parsed.requestId,
      status: lastStatus ?? null,
      retry: { attempts: retryMax + 1, retryMax, retryBaseMs }
    };
    return reply.code(is429 ? 503 : 502).send(payload);
  }

  const raw = String(ret.content ?? "").trim();

  const tryParse = (s: string) => {
    try {
      const x = JSON.parse(s);
      return x;
    } catch {
      return null;
    }
  };

  let parsed: any = tryParse(raw);
  if (!parsed) {
    // 宽松兜底：截取第一个 JSON 数组
    const m = raw.match(/\[[\s\S]*\]/);
    if (m?.[0]) parsed = tryParse(m[0]);
  }

  if (!Array.isArray(parsed)) {
    return reply.code(500).send({ error: "INVALID_MODEL_OUTPUT", hint: "模型未返回合法 JSON 数组" });
  }

  // 轻量清洗
  const cards = parsed
    .map((c: any) => ({
      title: typeof c?.title === "string" ? c.title.trim().slice(0, 120) : "",
      type: typeof c?.type === "string" ? c.type.trim() : undefined,
      cardType: typeof c?.cardType === "string" ? c.cardType.trim() : undefined,
      content: typeof c?.content === "string" ? c.content.trim() : "",
      tags: Array.isArray(c?.tags) ? c.tags.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 12) : undefined,
      oneLiners: Array.isArray(c?.oneLiners)
        ? c.oneLiners.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
        : undefined,
      steps: Array.isArray(c?.steps) ? c.steps.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 24) : undefined,
      pitfalls: Array.isArray(c?.pitfalls)
        ? c.pitfalls.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 24)
        : undefined,
      examples: Array.isArray(c?.examples)
        ? c.examples.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
        : undefined,
      paragraphIndices: Array.isArray(c?.paragraphIndices)
        ? c.paragraphIndices.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n) && n >= 0).slice(0, 24)
        : [],
      facetIds: Array.isArray(c?.facetIds)
        ? c.facetIds.map((x: any) => String(x ?? "").trim()).filter((x: string) => facetIds.includes(x)).slice(0, 6)
        : undefined
    }))
    .filter((c: any) => c.title && c.content && c.paragraphIndices.length > 0)
    .slice(0, maxCards);

  return reply.send({ ok: true, cards });
});

/**
 * KB 生成库级“仿写手册”（开发期）：输入单篇已抽出的结构化要素卡，输出库级 StyleProfile + Facet Playbook。
 * - 产物由 Desktop 负责落库（会落到一个“仿写手册”虚拟 SourceDoc 下）
 */
fastify.post("/api/kb/dev/build_library_playbook", async (request, reply) => {
  if (!IS_DEV) return reply.code(404).send({ error: "NOT_AVAILABLE" });

  const bodySchema = z.object({
    model: z.string().optional(),
    facetIds: z.array(z.string().min(1)).min(1).max(80),
    docs: z
      .array(
        z.object({
          id: z.string().min(1),
          title: z.string().min(1),
          items: z
            .array(
              z.object({
                cardType: z.enum(["hook", "thesis", "ending", "one_liner", "outline", "other"]),
                title: z.string().optional(),
                content: z.string().min(1),
                paragraphIndices: z.array(z.number().int().min(0)).min(1).max(24),
                facetIds: z.array(z.string().min(1)).min(1).max(6).optional()
              })
            )
            .min(1)
            .max(120)
        })
      )
      .min(1)
      .max(200)
  });
  const body = bodySchema.parse((request as any).body);

  const baseUrlDefault = String(process.env.LLM_BASE_URL ?? "").trim();
  const apiKeyDefault = String(process.env.LLM_API_KEY ?? "").trim();
  const modelDefault = String(process.env.LLM_MODEL ?? "").trim();

  const cardBaseUrl = String(process.env.LLM_CARD_BASE_URL ?? "").trim() || baseUrlDefault;
  const cardApiKey = String(process.env.LLM_CARD_API_KEY ?? "").trim() || apiKeyDefault;
  const cardModelDefault = String(process.env.LLM_CARD_MODEL ?? "").trim() || modelDefault;

  if (!cardBaseUrl || !cardApiKey || !cardModelDefault) {
    return reply.code(500).send({
      error: "LLM_NOT_CONFIGURED",
      hint: "请配置 LLM_BASE_URL/LLM_MODEL/LLM_API_KEY；若抽卡需不同 key/model，请配置 LLM_CARD_MODEL/LLM_CARD_API_KEY（可选 LLM_CARD_BASE_URL）。"
    });
  }

  const model = body.model ?? cardModelDefault;
  const retryMax = Number(process.env.LLM_CARD_RETRY_MAX ?? 3);
  const retryBaseMs = Number(process.env.LLM_CARD_RETRY_BASE_MS ?? 800);

  const facetIds = body.facetIds.slice(0, 80);
  const docs = body.docs.slice(0, 200);

  const sys = [
    "你是写作 IDE 的「库级仿写手册生成器」。",
    "你会收到一批文档的“结构化要素卡”（hook/thesis/ending/one_liner/outline 等），每条都带来源段落索引。",
    "",
    "任务：输出两个东西：",
    "1) styleProfile：该库作者/素材的整体写法画像（可用于仿写），要具体、可操作（别空泛）。",
    "2) playbookFacets：对每个 facetId 生成一张“写法手册卡”（21 个一级维度），每张卡包含：信号/套路/模板/禁忌/检查清单，并给 2-4 个带引用的例子。",
    "",
    "引用格式要求：每条例子必须包含 evidence 数组元素：{docId, docTitle, paragraphIndex, quote}；quote 尽量短（<=60字）且来自对应段落。",
    "",
    "输出要求：你必须且只能输出一个 JSON 对象（不要代码块，不要多余文字）。",
    "JSON 结构：",
    "{",
    '  "styleProfile": { "title": string, "content": string(Markdown), "evidence": Evidence[] },',
    '  "playbookFacets": [ { "facetId": string, "title": string, "content": string(Markdown), "evidence": Evidence[] } ]',
    "}",
    `facetId 枚举如下（不要新增）：${facetIds.join(", ")}。`,
    "约束：playbookFacets 必须覆盖所有 facetId（顺序不限）。content 要短、硬、可执行。"
  ].join("\n");

  const user = [
    "输入文档要素卡如下（已做过摘要；不要要求全文）：",
    JSON.stringify(
      {
        facetIds,
        docs: docs.map((d) => ({
          id: d.id,
          title: d.title,
          items: d.items.map((it) => ({
            cardType: it.cardType,
            title: it.title ?? "",
            // 传入的 content 可能较长：这里截一下，避免 prompt 爆
            content: String(it.content ?? "").slice(0, 1600),
            paragraphIndices: it.paragraphIndices,
            facetIds: it.facetIds ?? []
          }))
        }))
      },
      null,
      2
    )
  ].join("\n");

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const parseUpstream = (text: string) => {
    let message = String(text ?? "");
    try {
      const j = JSON.parse(message);
      if (typeof j?.error?.message === "string") message = j.error.message;
      else if (typeof j?.message === "string") message = j.message;
    } catch {
      // ignore
    }
    const m = message.match(/request id:\s*([^)]+)\)/i);
    const requestId = m?.[1] ? String(m[1]) : undefined;
    return { message, requestId };
  };

  let lastErr: any = null;
  let lastStatus: number | undefined = undefined;
  let lastDetail: string | undefined = undefined;

  let ret: any = null;
  for (let attempt = 0; attempt <= retryMax; attempt += 1) {
    ret = await chatCompletionOnce({
      config: { baseUrl: cardBaseUrl, apiKey: cardApiKey },
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      temperature: 0.2
    });

    if (ret.ok) break;

    lastStatus = ret.status;
    lastDetail = ret.error;
    const is429 = ret.status === 429 || String(ret.error ?? "").includes("Too Many Requests") || String(ret.error ?? "").includes("负载已饱和");
    lastErr = { is429, detail: ret.error, status: ret.status };
    if (!is429 || attempt >= retryMax) break;

    const jitter = Math.floor(Math.random() * 200);
    const wait = retryBaseMs * Math.pow(2, attempt) + jitter;
    await sleep(wait);
  }

  if (!ret?.ok) {
    const is429 = Boolean(lastErr?.is429);
    const parsed = parseUpstream(String(lastDetail ?? ""));
    const payload = {
      error: is429 ? "UPSTREAM_BUSY" : "UPSTREAM_ERROR",
      message: parsed.message || "upstream error",
      requestId: parsed.requestId,
      status: lastStatus ?? null,
      retry: { attempts: retryMax + 1, retryMax, retryBaseMs }
    };
    return reply.code(is429 ? 503 : 502).send(payload);
  }

  const raw = String(ret.content ?? "").trim();
  const tryParse = (s: string) => {
    try {
      const x = JSON.parse(s);
      return x;
    } catch {
      return null;
    }
  };

  let parsed: any = tryParse(raw);
  if (!parsed) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m?.[0]) parsed = tryParse(m[0]);
  }
  if (!parsed || typeof parsed !== "object") {
    return reply.code(500).send({ error: "INVALID_MODEL_OUTPUT", hint: "模型未返回合法 JSON 对象" });
  }

  const evSchema = z.object({
    docId: z.string().min(1),
    docTitle: z.string().min(1),
    paragraphIndex: z.number().int().min(0),
    quote: z.string().min(1).max(120)
  });
  const outSchema = z.object({
    styleProfile: z.object({
      title: z.string().min(1).max(120),
      content: z.string().min(1),
      evidence: z.array(evSchema).min(1).max(24)
    }),
    playbookFacets: z
      .array(
        z.object({
          facetId: z.string().min(1),
          title: z.string().min(1).max(160),
          content: z.string().min(1),
          evidence: z.array(evSchema).min(1).max(24)
        })
      )
      .min(1)
      .max(120)
  });

  let out: any = null;
  try {
    out = outSchema.parse(parsed);
  } catch (e) {
    return reply.code(500).send({ error: "INVALID_MODEL_OUTPUT", hint: "输出 schema 不符合预期", detail: String((e as any)?.message ?? e) });
  }

  // 只保留 facetIds 内的 facet；并补齐缺失（缺的用空壳兜底）
  const seen = new Set<string>();
  const filtered = (out.playbookFacets as any[])
    .map((x) => ({ ...x, facetId: String(x.facetId ?? "").trim() }))
    .filter((x) => facetIds.includes(x.facetId))
    .filter((x) => {
      if (seen.has(x.facetId)) return false;
      seen.add(x.facetId);
      return true;
    });
  const missing = facetIds.filter((id) => !seen.has(id));
  const filled = [
    ...filtered,
    ...missing.map((id) => ({
      facetId: id,
      title: `（待补齐）${id}`,
      content: `- （待补齐：该维度暂无足够样本，请后续补充语料或重新抽卡）`,
      evidence: out.styleProfile.evidence.slice(0, 1)
    }))
  ];

  return reply.send({
    ok: true,
    styleProfile: out.styleProfile,
    playbookFacets: filled
  });
});

await fastify.listen({ port: PORT, host: "0.0.0.0" });


