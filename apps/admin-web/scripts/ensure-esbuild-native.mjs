import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// 说明：
// - Vite 会用 esbuild 打包加载配置文件；esbuild 依赖平台包 @esbuild/<platform-arch>
// - 服务器偶发会因 npm optional 依赖 bug 导致平台包缺失（或误装为 win32），从而构建直接失败
// - 这里在 build 前做一次自检：缺了就用 `npm i --no-save` 补装（不改 package-lock）

function repoRootDir() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // apps/admin-web/scripts -> repo root
  return path.resolve(__dirname, "../../..");
}

function hasPackage(pkg) {
  try {
    require(`${pkg}/package.json`);
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

async function main() {
  // 只在 Linux x64 服务器构建时兜底
  if (process.platform !== "linux" || process.arch !== "x64") return;

  const pkg = "@esbuild/linux-x64";
  if (hasPackage(pkg)) return;

  const v = getEsbuildVersion();
  const spec = v ? `${pkg}@${v}` : `${pkg}@latest`;
  console.log(`[ensure-esbuild-native] missing ${pkg}, installing ${spec} (no-save) ...`);

  execSync(`npm i --no-save ${spec} --no-audit --no-fund`, {
    cwd: repoRootDir(),
    stdio: "inherit",
  });

  if (!hasPackage(pkg)) {
    console.error(`[ensure-esbuild-native] failed: ${pkg} still missing after install`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[ensure-esbuild-native] error:", e);
  process.exit(1);
});


