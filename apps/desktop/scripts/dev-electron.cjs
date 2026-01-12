const waitOn = require("wait-on");
const { spawn } = require("node:child_process");
const path = require("node:path");

function resolvePort(defaultPort = 5173) {
  const raw = String(process.env.DESKTOP_DEV_PORT ?? "").trim();
  if (!raw) return defaultPort;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultPort;
  return Math.floor(n);
}

function resolveDevServerUrl(port) {
  const raw = String(process.env.VITE_DEV_SERVER_URL ?? "").trim();
  if (raw) return raw;
  return `http://127.0.0.1:${port}`;
}

function parseHostPort(urlStr, fallbackPort) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname || "127.0.0.1";
    const port = u.port ? Number(u.port) : fallbackPort;
    return { host, port };
  } catch {
    return { host: "127.0.0.1", port: fallbackPort };
  }
}

async function main() {
  const port = resolvePort();
  const devServerUrl = resolveDevServerUrl(port);
  const { host, port: waitPort } = parseHostPort(devServerUrl, port);

  await waitOn({
    resources: [`tcp:${host}:${waitPort}`],
    timeout: Number(process.env.DESKTOP_DEV_WAIT_ON_TIMEOUT_MS ?? 60_000),
    interval: 200,
  });

  const electronPath = require("electron");
  const mainEntry = path.join(__dirname, "..", "electron", "main.cjs");

  const child = spawn(electronPath, [mainEntry], {
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl },
  });

  const forward = (sig) => {
    try {
      child.kill(sig);
    } catch {
      // ignore
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(`[desktop] dev-electron failed: ${e?.message ?? e}`);
  process.exit(1);
});


