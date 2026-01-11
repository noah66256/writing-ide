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
import { streamChatCompletions, type OpenAiChatMessage } from "./llm/openaiCompat.js";
import { isToolCallMessage, parseToolCalls, renderToolResultXml } from "./agent/xmlProtocol.js";
import { TOOL_NAMES, toolsPrompt } from "./agent/toolRegistry.js";

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
    `你可用的工具如下（只能调用这里列出的）：\n\n` +
    toolsPrompt()
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
  const mode = body.mode ?? "agent";
  const runId = randomUUID();

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
    { role: "system", content: buildAgentProtocolPrompt() },
    ...(body.contextPack ? [{ role: "system", content: body.contextPack } as OpenAiChatMessage] : []),
    { role: "user", content: body.prompt }
  ];

  const maxTurns = 12;

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

      messages.push({ role: "assistant", content: assistantText });

      const toolCalls = parseToolCalls(assistantText);
      if (!toolCalls) {
        // 如果看起来像 tool_calls 但解析失败，给出提示并结束
        if (isToolCallMessage(assistantText)) {
          writeEvent("assistant.delta", {
            delta:
              "\n\n[解析提示] 该条看起来像工具调用，但 XML 解析失败；请严格输出 <tool_calls>...</tool_calls>。"
          });
        }
        writeEvent("assistant.done", {});
        reply.raw.end();
        agentRunWaiters.delete(runId);
        return;
      }

      // tool_calls：逐个 emit tool.call，等待 Desktop 回传 tool_result
      for (const call of toolCalls) {
        if (!call?.name || !TOOL_NAMES.has(call.name)) {
          writeEvent("error", { error: `UNKNOWN_TOOL:${call?.name ?? ""}` });
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }

        const toolCallId = randomUUID();
        writeEvent("tool.call", { toolCallId, name: call.name, args: call.args });

        const payload: ToolResultPayload = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("TOOL_RESULT_TIMEOUT")), 60_000);
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
          writeEvent("assistant.done", {});
          reply.raw.end();
          agentRunWaiters.delete(runId);
          return;
        }
      }
    }

    writeEvent("assistant.delta", {
      delta: "\n\n[提示] 已达到本次 Run 的最大工具循环轮数（maxTurns），为避免死循环已自动停止。"
    });
    writeEvent("assistant.done", {});
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

await fastify.listen({ port: PORT, host: "0.0.0.0" });


