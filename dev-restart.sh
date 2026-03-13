#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[dev-restart] Root: ${ROOT_DIR}"

echo "[dev-restart] Killing existing gateway/desktop dev processes (if any)..."
if command -v pkill >/dev/null 2>&1; then
  # 这些模式尽量只命中当前仓库里的 dev 进程
  pkill -f "@ohmycrab/gateway@0.0.0 dev" || true
  pkill -f "apps/gateway/src/index.ts" || true
  pkill -f "@ohmycrab/desktop@0.1.3 dev" || true
  pkill -f "apps/desktop/scripts/dev-electron.cjs" || true
  pkill -f "vite.*apps/desktop" || true
else
  echo "[dev-restart] pkill not found, skip auto-kill. You may need to stop old dev processes manually."
fi

echo "[dev-restart] Starting gateway dev..."
(
  cd "${ROOT_DIR}"
  npm run -w @ohmycrab/gateway dev
) &

echo "[dev-restart] Starting desktop dev..."
(
  cd "${ROOT_DIR}"
  npm run -w @ohmycrab/desktop dev
) &

echo "[dev-restart] Done. Gateway and Desktop dev are starting in the background."

