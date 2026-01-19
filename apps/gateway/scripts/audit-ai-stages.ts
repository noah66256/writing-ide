import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultStageDefinitionsFromEnv } from "../src/aiConfig.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SRC_DIR = path.resolve(__dirname, "../src");

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // 跳过 dist/ 与 node_modules（以防误扫）
      if (e.name === "node_modules" || e.name === "dist") continue;
      out.push(...(await listTsFiles(p)));
    } else if (e.isFile()) {
      if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
    }
  }
  return out;
}

function findResolveStageKeys(code: string): string[] {
  const keys: string[] = [];
  const re = /resolveStage\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const key = String(m[2] ?? "").trim();
    if (key) keys.push(key);
  }
  return keys;
}

async function main() {
  const defs = getDefaultStageDefinitionsFromEnv();
  const defined = new Set(defs.map((d) => d.key));

  const files = await listTsFiles(SRC_DIR);
  const used = new Set<string>();

  for (const f of files) {
    // aiConfig.ts 自己包含 stage 字符串，跳过避免噪声（我们只关心业务调用点）
    if (f.endsWith(`${path.sep}aiConfig.ts`)) continue;
    const code = await fs.readFile(f, "utf-8");
    for (const k of findResolveStageKeys(code)) used.add(k);
  }

  const unknown = Array.from(used).filter((k) => !defined.has(k)).sort();

  if (unknown.length) {
    console.error("[audit-ai-stages] 发现代码中引用了未定义的 stage：");
    for (const k of unknown) console.error(`- ${k}`);
    console.error("\n请在 apps/gateway/src/aiConfig.ts 的 stage definitions 中补齐，或修正引用。");
    process.exit(1);
  }

  console.log(`[audit-ai-stages] OK (defined=${defined.size}, used=${used.size})`);
}

main().catch((e) => {
  console.error("[audit-ai-stages] FAILED:", e);
  process.exit(1);
});




