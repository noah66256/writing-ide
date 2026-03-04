#!/usr/bin/env node
/* eslint-disable no-console */
const os = require("node:os");
const path = require("node:path");

function parseArgs(argv) {
  const out = {
    repair: false,
    commands: [],
    userData: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] || "").trim();
    if (!a) continue;
    if (a === "--repair") {
      out.repair = true;
      continue;
    }
    if (a === "--commands") {
      out.commands = String(argv[i + 1] || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (a === "--user-data") {
      out.userData = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userData = args.userData || path.join(os.tmpdir(), "writing-ide-mcp-runtime-smoke");
  const appBase = path.resolve(__dirname, "..");
  const { McpManager } = await import(path.join(appBase, "electron", "mcp-manager.mjs"));
  const mgr = new McpManager(userData, appBase, false, null);
  await mgr.loadConfig();

  const commands = args.commands.length > 0 ? args.commands : ["uv", "uvx", "node", "npx", "python", "python3"];
  const before = await mgr.getRuntimeHealth({ commands });
  console.log("[mcp-runtime-smoke] health(before):");
  console.log(JSON.stringify(before, null, 2));

  if (args.repair) {
    const repaired = await mgr.repairRuntime({ commands });
    console.log("[mcp-runtime-smoke] repair result:");
    console.log(JSON.stringify(repaired, null, 2));
  }

  const after = await mgr.getRuntimeHealth({ commands });
  console.log("[mcp-runtime-smoke] health(after):");
  console.log(JSON.stringify(after, null, 2));
  await mgr.dispose();
}

main().catch((e) => {
  console.error("[mcp-runtime-smoke] failed:", e?.message || e);
  process.exit(1);
});
