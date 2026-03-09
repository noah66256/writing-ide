#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
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

async function copyDir(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rm(dst, { recursive: true, force: true }).catch(() => void 0);
  await fs.cp(src, dst, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });
}

function detectNpmRoot(nodePath) {
  if (!nodePath) return null;
  const probeByNode = spawnSync(
    nodePath,
    ["-e", "const p=require('path');process.stdout.write(p.dirname(require.resolve('npm/package.json')));"],
    { encoding: "utf-8" },
  );
  if (probeByNode.status === 0) {
    const out = String(probeByNode.stdout || "").trim();
    if (out) return out;
  }

  const npmCmd = resolveCommand("npm");
  if (!npmCmd) return null;
  try {
    const real = fsSync.realpathSync(npmCmd);
    const base = path.basename(real).toLowerCase();
    const parent = path.basename(path.dirname(real)).toLowerCase();
    if ((base === "npm-cli.js" || base === "npx-cli.js") && parent === "bin") {
      const root = path.dirname(path.dirname(real));
      if (fsSync.existsSync(path.join(root, "package.json"))) return root;
    }
    if ((base === "npm" || base === "npx") && parent === "bin") {
      const root = path.dirname(path.dirname(real));
      if (fsSync.existsSync(path.join(root, "package.json"))) return root;
    }
  } catch {
    // ignore
  }
  const probeByNpm = spawnSync(npmCmd, ["root", "-g"], { encoding: "utf-8" });
  if (probeByNpm.status !== 0) return null;
  const globalRoot = String(probeByNpm.stdout || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find(Boolean);
  if (!globalRoot) return null;
  const candidate = path.join(globalRoot, "npm");
  const pkg = path.join(candidate, "package.json");
  if (fsSync.existsSync(pkg)) return candidate;
  return null;
}

async function writeNodeShims(runtimeRoot, runtimeBinDir) {
  if (isWindows()) {
    const npmCmd = [
      "@echo off",
      "set \"RUNTIME_ROOT=%~dp0..\"",
      "\"%RUNTIME_ROOT%\\bin\\node.exe\" \"%RUNTIME_ROOT%\\lib\\node_modules\\npm\\bin\\npm-cli.js\" %*",
      "",
    ].join("\r\n");
    const npxCmd = [
      "@echo off",
      "set \"RUNTIME_ROOT=%~dp0..\"",
      "\"%RUNTIME_ROOT%\\bin\\node.exe\" \"%RUNTIME_ROOT%\\lib\\node_modules\\npm\\bin\\npx-cli.js\" %*",
      "",
    ].join("\r\n");
    await fs.writeFile(path.join(runtimeBinDir, "npm.cmd"), npmCmd, "utf-8");
    await fs.writeFile(path.join(runtimeBinDir, "npx.cmd"), npxCmd, "utf-8");
    return;
  }

  const npmSh = [
    "#!/usr/bin/env sh",
    "RUNTIME_ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\"",
    "exec \"$RUNTIME_ROOT/bin/node\" \"$RUNTIME_ROOT/lib/node_modules/npm/bin/npm-cli.js\" \"$@\"",
    "",
  ].join("\n");
  const npxSh = [
    "#!/usr/bin/env sh",
    "RUNTIME_ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\"",
    "exec \"$RUNTIME_ROOT/bin/node\" \"$RUNTIME_ROOT/lib/node_modules/npm/bin/npx-cli.js\" \"$@\"",
    "",
  ].join("\n");
  const npmPath = path.join(runtimeBinDir, "npm");
  const npxPath = path.join(runtimeBinDir, "npx");
  await fs.writeFile(npmPath, npmSh, "utf-8");
  await fs.writeFile(npxPath, npxSh, "utf-8");
  await fs.chmod(npmPath, 0o755).catch(() => void 0);
  await fs.chmod(npxPath, 0o755).catch(() => void 0);
}

async function main() {
  const appRoot = path.resolve(__dirname, "..");
  const runtimeRoot = path.join(appRoot, "electron", "mcp-runtime", platformKey());
  const runtimeBinDir = path.join(runtimeRoot, "bin");
  const runtimeNpmDir = path.join(runtimeRoot, "lib", "node_modules", "npm");
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

  // 预置 Node + npm/npx（用于 npx 型 MCP，避免用户机器必须安装 Node）
  const nodeResolved = resolveCommand("node");
  if (!nodeResolved) {
    missing.push("node");
  } else {
    const nodeTarget = path.join(runtimeBinDir, isWindows() ? "node.exe" : "node");
    await copyIfExists(nodeResolved, nodeTarget);
    copied.push({ cmd: "node", from: nodeResolved, to: nodeTarget });

    const npmRoot = detectNpmRoot(nodeResolved);
    if (!npmRoot) {
      missing.push("npm");
      missing.push("npx");
    } else {
      await copyDir(npmRoot, runtimeNpmDir);
      copied.push({ cmd: "npm(dir)", from: npmRoot, to: runtimeNpmDir });
      await writeNodeShims(runtimeRoot, runtimeBinDir);
      copied.push({ cmd: isWindows() ? "npm.cmd/npx.cmd" : "npm/npx", from: "generated", to: runtimeBinDir });
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
