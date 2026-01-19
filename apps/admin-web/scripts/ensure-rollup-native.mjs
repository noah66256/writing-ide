import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// 说明：
// - Rollup v4 使用平台 native 包（@rollup/rollup-<platform-arch>），偶发会因 npm optional 依赖 bug 缺失而构建失败
// - 这里在 build 前做一次自检：缺了就用 `npm i --no-save` 补装（不改 package-lock）

function isMusl() {
  try {
    return !process.report.getReport().header.glibcVersionRuntime;
  } catch {
    return false;
  }
}

function hasPackage(pkg) {
  try {
    require(`${pkg}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function getRollupVersion() {
  try {
    return String(require("rollup/package.json")?.version ?? "").trim();
  } catch {
    return "";
  }
}

function repoRootDir() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // apps/admin-web/scripts -> repo root
  return path.resolve(__dirname, "../../..");
}

async function main() {
  // 只在 Linux x64 服务器构建时兜底，避免影响本地开发与其他平台
  if (process.platform !== "linux" || process.arch !== "x64") return;

  const packageBase = isMusl() ? "linux-x64-musl" : "linux-x64-gnu";
  const pkg = `@rollup/rollup-${packageBase}`;

  if (hasPackage(pkg)) return;

  const rollupVer = getRollupVersion();
  const spec = rollupVer ? `${pkg}@${rollupVer}` : `${pkg}@latest`;

  console.log(`[ensure-rollup-native] missing ${pkg}, installing ${spec} (no-save) ...`);
  execSync(`npm i --no-save ${spec} --no-audit --no-fund`, {
    cwd: repoRootDir(),
    stdio: "inherit",
  });

  if (!hasPackage(pkg)) {
    console.error(`[ensure-rollup-native] failed: ${pkg} still missing after install`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[ensure-rollup-native] error:", e);
  process.exit(1);
});




