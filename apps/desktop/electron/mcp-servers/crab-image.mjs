import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_INFO = { name: "crab-image", version: "0.1.0" };
const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_FLASH_MODEL = "gemini-3.1-flash-image-preview";
const DEFAULT_PRO_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_TIMEOUT_MS = 600_000;
const SUPPORTED_ASPECT_RATIOS = new Set(["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"]);

const providerSessionCache = new Map();

function trim(value) {
  return String(value ?? "").trim();
}

function truncate(text, max = 12_000) {
  const raw = String(text ?? "");
  return raw.length <= max ? raw : `${raw.slice(0, max)}\n\n[已截断，原始 ${raw.length} 字符]`;
}

function ok(content) {
  return { content };
}

function err(message) {
  return {
    isError: true,
    content: [{ type: "text", text: `Crab Image 错误：${truncate(message, 4_000)}` }],
  };
}

function readImageApiKey() {
  return trim(process.env.GEMINI_API_KEY || process.env.LLM_GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

function parseJsonObjectEnv(...keys) {
  for (const key of keys) {
    const raw = trim(process.env[key]);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // ignore invalid override json
    }
  }
  return {};
}

function readImageConfig() {
  return {
    apiKey: readImageApiKey(),
    baseUrl: trim(process.env.GEMINI_BASE_URL) || GEMINI_DEFAULT_BASE_URL,
    defaultTier: trim(process.env.CRAB_IMAGE_DEFAULT_TIER || process.env.NANOBANANA_DEFAULT_TIER).toLowerCase() || "auto",
    flashModel: trim(process.env.CRAB_IMAGE_FLASH_MODEL || process.env.NANOBANANA_DEFAULT_MODEL) || DEFAULT_FLASH_MODEL,
    proModel: trim(process.env.CRAB_IMAGE_PRO_MODEL || process.env.NANOBANANA_PRO_MODEL) || DEFAULT_PRO_MODEL,
    modelNameOverride: parseJsonObjectEnv("CRAB_IMAGE_MODEL_NAME_OVERRIDE", "NANOBANANA_MODEL_NAME_OVERRIDE"),
  };
}

function normalizeAspectRatio(value) {
  const ratio = trim(value);
  return SUPPORTED_ASPECT_RATIOS.has(ratio) ? ratio : "";
}

function chooseProviderTier(args) {
  const quality = trim(args?.quality).toLowerCase();
  const defaultTier = trim(args?.defaultTier).toLowerCase();
  if (quality === "high") return "pro";
  if (quality === "fast") return "flash";
  if (defaultTier === "pro") return "pro";
  if (defaultTier === "nb2" || defaultTier === "flash") return "flash";
  const prompt = trim(args?.prompt).toLowerCase();
  const refCount = Number(args?.referenceCount ?? 0);
  if (refCount >= 2) return "pro";
  if (/(4k|ultra|商业级|超写实|电影感|高细节|high detail|photoreal|product shot)/i.test(prompt)) return "pro";
  return "flash";
}

function resolveModelName(config, tier) {
  const overrideKey = tier === "pro" ? "pro" : "flash";
  const override = trim(config.modelNameOverride?.[overrideKey]);
  if (override) return override;
  return tier === "pro" ? config.proModel : config.flashModel;
}

function buildGenerateContentUrl(baseUrl, modelName, apiKey) {
  const base = trim(baseUrl) || GEMINI_DEFAULT_BASE_URL;
  const model = encodeURIComponent(trim(modelName) || DEFAULT_FLASH_MODEL);
  if (/\/v1beta\/models\/[^/]+:generateContent(?:\?|$)/i.test(base)) {
    const replaced = base.replace(/\/v1beta\/models\/[^/]+:generateContent/i, `/v1beta/models/${model}:generateContent`);
    return replaced.includes("?key=") ? replaced : `${replaced}${replaced.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`;
  }
  const normalized = base.replace(/\/+$/, "");
  const root = /\/v1beta$/i.test(normalized) ? normalized : `${normalized}/v1beta`;
  return `${root}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function parseDataUrl(value) {
  const raw = trim(value);
  const match = raw.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  return {
    mimeType: trim(match[1]) || "image/png",
    data: trim(match[2]),
  };
}

function isAbsolutePathLike(value) {
  const raw = trim(value);
  return raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);
}

async function fileToInlineData(value) {
  const filePath = trim(value);
  if (!filePath) throw new Error("EMPTY_FILE_PATH");
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".png" ? "image/png"
    : ext === ".webp" ? "image/webp"
    : ext === ".gif" ? "image/gif"
    : ext === ".bmp" ? "image/bmp"
    : ext === ".svg" ? "image/svg+xml"
    : ext === ".avif" ? "image/avif"
    : "application/octet-stream";
  return {
    mimeType,
    data: buffer.toString("base64"),
  };
}

async function sourceToPart(source) {
  if (!source || typeof source !== "object") return null;
  if (source.kind === "path") {
    const inlineData = await fileToInlineData(source.path);
    return { inlineData };
  }
  if (source.kind === "data") {
    const parsed = parseDataUrl(source.dataUrl);
    if (!parsed) throw new Error("INVALID_DATA_URL");
    return { inlineData: parsed };
  }
  return null;
}

function normalizeReferenceImageRole(value) {
  return String(value ?? "").trim().toLowerCase() || "reference";
}

function describeRole(role) {
  const r = normalizeReferenceImageRole(role);
  if (r === "identity_plate")
    return "身份底板锁：人物结构/轮廓/比例/视角严格以此图为准；锁定发型与体态，不要重构成别的人；禁止左右翻转/禁止镜像。";
  if (r === "identity" || r.startsWith("identity_"))
    return "身份锁：必须是同一人物（脸型/五官比例/肤色/年龄感一致）。";
  if (r === "outfit_plate")
    return "服装底板锁：服装结构/版型/材质质感/配色以此图为准；不要随意换款式或加外套；禁止把服装换成别的款式。";
  if (r === "outfit" || r.startsWith("outfit_"))
    return "服装锁：衣服款式/材质/配色以此图为准，只允许调整穿着角度，不得换成其他服装。";
  if (r === "scene_plate")
    return "场景底板锁（极强）：背景空间几何/透视/机位/楼梯走向/墙面分色/灯具位置严格以此图为准；禁止新增/删除/移动任何背景元素；禁止左右翻转。";
  if (r === "scene" || r.startsWith("scene_"))
    return "场景锁：背景结构/透视/机位方向以此图为准；不要发散成别的地点；不要新增路人；不要左右翻转。";
  if (r === "hand_prop" || r.startsWith("hand_prop_"))
    return "手持道具锁：该道具必须出现在对应角色手中，不得消失/不得互换/不得被别人拿走。";
  if (r === "set_prop" || r.startsWith("set_prop_"))
    return "场景道具锁：桌面/锚点道具必须出现且位置一致。";
  if (r === "layout_guide")
    return "构图引导（仅约束，不可见）：生成时按此图构图放置元素，但最终成片严禁出现线框/示意图残留。";
  if (r === "prop" || r.startsWith("prop_"))
    return "道具锁：该道具必须出现且外观一致。";
  return "通用参考图：用于补充风格/材质/构图等信息。";
}

async function normalizeResolvedImages(args) {
  const rawRoles = Array.isArray(args?.referenceImageRoles) ? args.referenceImageRoles : [];
  const resolvedRefs = Array.isArray(args?.resolvedReferenceImages) ? args.resolvedReferenceImages : [];
  const collected = [];

  const push = (part, role) => { if (part) collected.push({ part, role: normalizeReferenceImageRole(role) }); };

  for (let i = 0; i < resolvedRefs.length; i++) {
    push(await sourceToPart(resolvedRefs[i]), rawRoles[i]);
  }

  if (collected.length === 0) {
    const rawRefs = Array.isArray(args?.referenceImages) ? args.referenceImages : [];
    for (let i = 0; i < rawRefs.length; i++) {
      const value = trim(rawRefs[i]);
      if (!value) continue;
      if (isAbsolutePathLike(value)) { push({ inlineData: await fileToInlineData(value) }, rawRoles[i]); continue; }
      const parsed = parseDataUrl(value);
      if (parsed) push({ inlineData: parsed }, rawRoles[i]);
    }
  }

  if (collected.length > 12) {
    console.error(`[crab-image] referenceImages truncated: received=${collected.length}, kept=12`);
  }

  // B喂法：每张参考图前插入角色说明文本
  return collected.slice(0, 12).flatMap(({ part, role }, index) => [
    { text: `Image${index + 1} role=${role}：${describeRole(role)}` },
    part,
  ]);
}

async function normalizeTargetImage(args) {
  const resolved = args?.resolvedTargetImage;
  if (resolved && typeof resolved === "object") {
    return await sourceToPart(resolved);
  }
  const rawTarget = trim(args?.target);
  if (!rawTarget) return null;
  if (isAbsolutePathLike(rawTarget)) {
    return { inlineData: await fileToInlineData(rawTarget) };
  }
  const parsed = parseDataUrl(rawTarget);
  return parsed ? { inlineData: parsed } : null;
}

function parseSizeToWH(value) {
  const raw = trim(value) || "2048x2048";
  const match = raw.match(/^(\d{2,5})\s*[xX]\s*(\d{2,5})$/);
  if (!match) return { width: 2048, height: 2048 };
  const w = Number(match[1]); const h = Number(match[2]);
  return (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) ? { width: w, height: h } : { width: 2048, height: 2048 };
}

function pickGeminiImageSizeByLongEdge(width, height) {
  const longEdge = Math.max(Number(width) || 0, Number(height) || 0);
  if (longEdge > 2816) return "4K";
  if (longEdge > 1408) return "2K";
  return "1K";
}

function collectTextParts(response) {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const parts = candidates.flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []);
  return parts
    .map((part) => trim(part?.text))
    .filter(Boolean);
}

function collectImageParts(response) {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const parts = candidates.flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []);
  return parts
    .map((part) => {
      const inline = part?.inlineData ?? part?.inline_data ?? null;
      const mimeType = trim(inline?.mimeType ?? inline?.mime_type);
      const data = trim(inline?.data);
      if (!mimeType || !data || !/^image\//i.test(mimeType)) return null;
      return {
        type: "image",
        mimeType,
        data,
      };
    })
    .filter(Boolean);
}

async function geminiGenerateImage(args) {
  const config = readImageConfig();
  if (!config.apiKey) {
    throw new Error("缺少 GEMINI_API_KEY / LLM_GEMINI_API_KEY，请在 MCP 设置中填写后重试");
  }

  const prompt = trim(args.prompt);
  if (!prompt) throw new Error("prompt 不能为空");

  const referenceParts = await normalizeResolvedImages(args);
  // B喂法后 referenceParts 是 text+inlineData 交错数组，只统计 inlineData 数量
  const referenceImageCount = referenceParts.filter(
    (p) => p && typeof p === "object" && "inlineData" in p
  ).length;
  const requestParts = [...referenceParts, { text: prompt }];
  const aspectRatio = normalizeAspectRatio(args.aspectRatio);
  const { width, height } = parseSizeToWH(args.size);
  const imageSize = pickGeminiImageSizeByLongEdge(width, height);
  const tier = chooseProviderTier({
    quality: args.quality,
    defaultTier: config.defaultTier,
    prompt,
    referenceCount: referenceImageCount,
  });
  const modelName = resolveModelName(config, tier);
  const url = buildGenerateContentUrl(config.baseUrl, modelName, config.apiKey);
  const body = {
    contents: [
      {
        role: "user",
        parts: requestParts,
      },
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        imageSize,
        ...(aspectRatio ? { aspectRatio } : {}),
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let rawText = "";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    rawText = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${rawText}`);
    }
    const parsed = JSON.parse(rawText);
    const images = collectImageParts(parsed);
    if (images.length === 0) {
      throw new Error("Gemini 未返回图片结果");
    }
    // responseModalities=["IMAGE"] 时模型不输出 TEXT，guard 防止空 parts 报错
    const hasText = Array.isArray(parsed?.candidates) && parsed.candidates.some(
      (c) => Array.isArray(c?.content?.parts) && c.content.parts.some((p) => trim(p?.text))
    );
    const textParts = hasText ? collectTextParts(parsed) : [];
    const threadId = trim(args.threadId);
    if (threadId) {
      providerSessionCache.set(threadId, {
        provider: "gemini_nb",
        lastModel: modelName,
        lastPrompt: prompt,
        lastUsedAt: Date.now(),
        lastImageCount: images.length,
      });
    }
    const summary = [
      `Crab Image 已完成${referenceImageCount > 0 ? "图像生成/编辑" : "图像生成"}`,
      `模型：${modelName}`,
      aspectRatio ? `比例：${aspectRatio}` : "",
      referenceImageCount > 0 ? `参考图：${referenceImageCount} 张` : "",
      textParts[0] ? `说明：${textParts[0]}` : "",
    ].filter(Boolean).join("\n");
    return {
      content: [
        { type: "text", text: truncate(summary) },
        ...images,
      ],
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时（>${DEFAULT_TIMEOUT_MS}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const server = new McpServer(SERVER_INFO);

// 当前 MCP SDK 的 `tool()` 重载只会把 raw shape 识别为 input schema；
// 这里用 `registerTool()` 保留完整 object schema，同时允许 passthrough 隐藏字段。
const generateImageInputSchema = z.object({
  prompt: z.string().describe("图片生成提示词"),
  aspectRatio: z.enum(["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"]).optional().describe("画面比例"),
  size: z.string().optional().describe('输出尺寸，格式 "WxH"，如 "2048x2048"，默认 2048x2048'),
  quality: z.enum(["auto", "fast", "high"]).optional().describe("质量档位"),
  useThreadHistory: z.boolean().optional().describe("是否优先继承当前线程图片历史"),
  referenceImages: z.array(z.string()).optional().describe("参考图引用，如 last_generated / last_user_image / artifact:<id>"),
  referenceImageRoles: z.array(z.string()).optional().describe("与 referenceImages 对齐的角色标签，如 identity / outfit / scene / scene_plate / outfit_plate 等"),
}).passthrough();

const editImageInputSchema = z.object({
  target: z.string().describe("编辑目标，如 last / last_generated / last_user_image / artifact:<id>"),
  editPrompt: z.string().describe("编辑要求"),
  aspectRatio: z.enum(["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"]).optional().describe("画面比例"),
  quality: z.enum(["auto", "fast", "high"]).optional().describe("质量档位"),
  referenceImages: z.array(z.string()).optional().describe("补充参考图"),
}).passthrough();

server.registerTool(
  "generate_image",
  {
    description: "根据文字描述生成图片；支持继承当前线程的最近图片作为参考，实现对话式连续出图。",
    inputSchema: generateImageInputSchema,
  },
  async (args) => {
    try {
      const { prompt, aspectRatio, quality, referenceImages, ...hidden } = args ?? {};
      console.error(`[crab-image] generate_image called: prompt=${JSON.stringify(prompt)}, keys=${Object.keys(args ?? {})}`);
      return ok((await geminiGenerateImage({
        prompt,
        aspectRatio,
        quality,
        referenceImages,
        ...hidden,
      })).content);
    } catch (error) {
      return err(error?.message ?? String(error));
    }
  },
);

server.registerTool(
  "edit_image",
  {
    description: "基于当前线程最近一张图、用户上传图或指定 artifact 做修图/换背景/重绘。",
    inputSchema: editImageInputSchema,
  },
  async ({ target, editPrompt, aspectRatio, quality, referenceImages, ...hidden }) => {
    try {
      const targetImage = await normalizeTargetImage({ target, ...hidden });
      if (!targetImage) {
        return err("未解析到可编辑的目标图片");
      }
      const resolvedReferenceImages = [
        hidden?.resolvedTargetImage ?? null,
        ...(Array.isArray(hidden?.resolvedReferenceImages) ? hidden.resolvedReferenceImages : []),
      ].filter(Boolean);
      if (!hidden?.resolvedTargetImage) {
        resolvedReferenceImages.unshift(
          targetImage.inlineData
            ? { kind: "data", dataUrl: `data:${targetImage.inlineData.mimeType};base64,${targetImage.inlineData.data}` }
            : null,
        );
      }
      return ok((await geminiGenerateImage({
        prompt: trim(editPrompt),
        aspectRatio,
        quality,
        referenceImages,
        resolvedReferenceImages: resolvedReferenceImages.filter(Boolean),
        threadId: hidden?.threadId,
      })).content);
    } catch (error) {
      return err(error?.message ?? String(error));
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[crab-image] MCP Server 已启动");
