#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export VITE_GATEWAY_URL="${VITE_GATEWAY_URL:-http://127.0.0.1:8000}"
DESKTOP_PID=""

echo "[dev-local] Gateway target: $VITE_GATEWAY_URL"
echo "[dev-local] starting gateway + desktop..."

npm run dev:gateway &
GATEWAY_PID=$!

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [[ -n "$DESKTOP_PID" ]]; then
    kill "$DESKTOP_PID" 2>/dev/null || true
  fi
  kill "$GATEWAY_PID" 2>/dev/null || true
  if [[ -n "$DESKTOP_PID" ]]; then
    wait "$DESKTOP_PID" 2>/dev/null || true
  fi
  wait "$GATEWAY_PID" 2>/dev/null || true
  exit "$code"
}

trap cleanup EXIT INT TERM

sleep 2
npm run dev:desktop &
DESKTOP_PID=$!

while true; do
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    wait "$GATEWAY_PID"
    break
  fi
  if [[ -n "$DESKTOP_PID" ]] && ! kill -0 "$DESKTOP_PID" 2>/dev/null; then
    wait "$DESKTOP_PID"
    break
  fi
  sleep 2
done

