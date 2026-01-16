import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// 说明：
// - 服务器构建时偶发出现 npm optionalDependencies 缺失，导致 Vite/Rollup/esbuild 无法运行（尤其是平台 native 包）。
// - 之前分两个脚本分别补装 esbuild/rollup native，但 npm 在第二次安装时可能会“顺手”清掉前一个包，造成反复失败。
// - 这里合并为一个脚本：一次性确保两类 native 包都存在，避免互相移除。

function repoRootDir() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // apps/admin-web/scripts -> repo root
  return path.resolve(__dirname, "../../..");
}

function isMusl() {
  try {
    return !process.report.getReport().header.glibcVersionRuntime;
  } catch {
    return false;
  }
}

function hasPackageJsonSubpath(pkg) {
  try {
    require.resolve(`${pkg}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function getEsbuildVersion() {
  try {
    return String(require("esbuild/package.json")?.version ?? "").trim();
  } catch {
    return "";
  }
}

function getRollupVersion() {
  try {
    return String(require("rollup/package.json")?.version ?? "").trim();
  } catch {
    return "";
  }
}

async function main() {
  // 只在 Linux x64 服务器构建时兜底，避免影响本地开发与其他平台
  if (process.platform !== "linux" || process.arch !== "x64") return;

  const esbuildPkg = "@esbuild/linux-x64";
  const rollupPkg = `@rollup/rollup-${isMusl() ? "linux-x64-musl" : "linux-x64-gnu"}`;

  const hasEsbuild = hasPackageJsonSubpath(esbuildPkg);
  const hasRollup = hasPackageJsonSubpath(rollupPkg);
  if (hasEsbuild && hasRollup) return;

  const esbuildVer = getEsbuildVersion();
  const rollupVer = getRollupVersion();
  const esbuildSpec = esbuildVer ? `${esbuildPkg}@${esbuildVer}` : `${esbuildPkg}@latest`;
  const rollupSpec = rollupVer ? `${rollupPkg}@${rollupVer}` : `${rollupPkg}@latest`;

  console.log(
    `[ensure-native] missing native deps: ${hasEsbuild ? "" : esbuildPkg} ${hasRollup ? "" : rollupPkg}`.trim(),
  );
  console.log(`[ensure-native] installing (no-save): ${esbuildSpec} ${rollupSpec}`);

  execSync(`npm i --no-save ${esbuildSpec} ${rollupSpec} --no-audit --no-fund`, {
    cwd: repoRootDir(),
    stdio: "inherit",
  });

  const okEsbuild = hasPackageJsonSubpath(esbuildPkg);
  const okRollup = hasPackageJsonSubpath(rollupPkg);
  if (!okEsbuild || !okRollup) {
    console.error(
      `[ensure-native] failed: still missing ${!okEsbuild ? esbuildPkg : ""} ${!okRollup ? rollupPkg : ""}`.trim(),
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[ensure-native] error:", e);
  process.exit(1);
});


