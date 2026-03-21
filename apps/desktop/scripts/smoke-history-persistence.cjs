const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function main() {
  const repoRoot = path.resolve(__dirname, "../../..");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ohmycrab-history-smoke-"));
  const userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });

  const electronBinary = require("electron");
  const result = spawnSync(
    electronBinary,
    [path.join(repoRoot, "apps/desktop/electron/main.cjs"), "--history-smoke-cli"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OHMYCRAB_USER_DATA_DIR: userDataDir,
      },
      encoding: "utf-8",
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    throw new Error(`history smoke failed with exit code ${result.status ?? "unknown"}`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${String(error?.stack ?? error?.message ?? error)}\n`);
  process.exit(1);
}
