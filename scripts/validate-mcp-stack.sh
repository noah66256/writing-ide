#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-quick}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$MODE" != "quick" && "$MODE" != "full" ]]; then
  echo "usage: bash scripts/validate-mcp-stack.sh [quick|full]" >&2
  exit 2
fi

run() {
  echo
  echo ">>> $*"
  "$@"
}

echo "[validate-mcp-stack] mode=$MODE"

echo "[validate-mcp-stack] 1/5 syntax + core build"
run node --check apps/desktop/electron/mcp-manager.mjs
run npm -w @ohmycrab/tools run build
run npm -w @ohmycrab/agent-core run build

echo "[validate-mcp-stack] 2/5 gateway focused tests"
run npm -w @ohmycrab/gateway run test:mcp-selection
run npm -w @ohmycrab/gateway run smoke:mcp-server-first
run npm -w @ohmycrab/gateway run test:runner-turn
if [[ "${VALIDATE_INCLUDE_STALE_RUNTIME_PARITY:-0}" == "1" ]]; then
  echo "[validate-mcp-stack] include quarantined smoke:runtime-parity"
  run npm -w @ohmycrab/gateway run smoke:runtime-parity
else
  echo "skip: smoke:runtime-parity (known stale baseline; set VALIDATE_INCLUDE_STALE_RUNTIME_PARITY=1 to include)"
fi

echo "[validate-mcp-stack] 3/5 desktop MCP runtime smoke"
if [[ "${VALIDATE_SKIP_DESKTOP_MCP_RUNTIME:-0}" == "1" ]]; then
  echo "skip: VALIDATE_SKIP_DESKTOP_MCP_RUNTIME=1"
else
  run npm -w @ohmycrab/desktop run mcp:smoke-runtime
fi

if [[ "$MODE" == "full" ]]; then
  echo "[validate-mcp-stack] 4/5 endpoint parity"
  run npm -w @ohmycrab/gateway run smoke:endpoints

  echo "[validate-mcp-stack] 5/5 regression sweep"
  run npm -w @ohmycrab/gateway run regress:agent
fi

echo "[validate-mcp-stack] done ($MODE)"
