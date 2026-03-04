#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function isWindows() {
  return process.platform === "win32";
}

function commandCandidates(name) {
  if (!isWindows()) return [name];
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

function resolveCommand(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  if (raw.includes("/") || raw.includes("\\") || path.isAbsolute(raw)) {
    return raw;
  }
  const probe = isWindows()
    ? spawnSync("where", [raw], { encoding: "utf-8" })
    : spawnSync("which", [raw], { encoding: "utf-8" });
  if (probe.status !== 0) return null;
  const first = String(probe.stdout || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find(Boolean);
  return first || null;
}

async function copyIfExists(src, dst) {
  if (!src) return false;
  await fs.copyFile(src, dst);
  if (!isWindows()) {
    await fs.chmod(dst, 0o755).catch(() => void 0);
  }
  return true;
}

async function main() {
  const appRoot = path.resolve(__dirname, "..");
  const runtimeBinDir = path.join(appRoot, "electron", "mcp-runtime", platformKey(), "bin");
  await fs.mkdir(runtimeBinDir, { recursive: true });

  const copied = [];
  const missing = [];

  for (const cmd of ["uv", "uvx"]) {
    let resolved = null;
    for (const c of commandCandidates(cmd)) {
      resolved = resolveCommand(c);
      if (resolved) break;
    }
    if (!resolved) {
      missing.push(cmd);
      continue;
    }
    const target = path.join(runtimeBinDir, path.basename(resolved));
    await copyIfExists(resolved, target);
    copied.push({ cmd, from: resolved, to: target });
  }

  // 兜底：若 uvx 缺失但 uv 存在，创建 shim
  const hasUvx = copied.some((x) => x.cmd === "uvx");
  const hasUv = copied.some((x) => x.cmd === "uv");
  if (!hasUvx && hasUv) {
    if (isWindows()) {
      const shim = path.join(runtimeBinDir, "uvx.cmd");
      await fs.writeFile(shim, "@echo off\r\nuv tool run %*\r\n", "utf-8");
      copied.push({ cmd: "uvx(shim)", from: "generated", to: shim });
    } else {
      const shim = path.join(runtimeBinDir, "uvx");
      await fs.writeFile(shim, "#!/usr/bin/env sh\nexec uv tool run \"$@\"\n", "utf-8");
      await fs.chmod(shim, 0o755).catch(() => void 0);
      copied.push({ cmd: "uvx(shim)", from: "generated", to: shim });
    }
  }

  console.log(`[prepare-mcp-runtime] platform=${platformKey()}`);
  for (const c of copied) {
    console.log(`[prepare-mcp-runtime] copied ${c.cmd}: ${c.from} -> ${c.to}`);
  }
  if (missing.length > 0) {
    console.log(`[prepare-mcp-runtime] missing: ${missing.join(", ")}`);
  }
  console.log(`[prepare-mcp-runtime] done: copied=${copied.length} missing=${missing.length}`);
}

main().catch((e) => {
  console.error("[prepare-mcp-runtime] failed:", e?.message || e);
  process.exit(1);
});
