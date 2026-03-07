#!/bin/bash
# ─────────────────────────────────────────────
# Oh My Crab 本地开发一键启动
# 用法：./dev.sh          （前后端 + Electron）
#       ./dev.sh --no-electron （仅前后端，浏览器访问 http://localhost:5173）
# ─────────────────────────────────────────────
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

cleanup() {
  echo -e "\n${CYAN}[dev] 正在关闭所有子进程...${NC}"
  kill $GW_PID $VITE_PID $ELECTRON_PID 2>/dev/null
  wait $GW_PID $VITE_PID $ELECTRON_PID 2>/dev/null
  echo -e "${GREEN}[dev] 已退出${NC}"
}
trap cleanup EXIT INT TERM

# ── 1. Gateway ──
echo -e "${CYAN}[dev] 启动 Gateway (port 8000)...${NC}"
# 先杀掉旧的 8000 端口进程
OLD_PID=$(lsof -iTCP:8000 -sTCP:LISTEN -P -n -t 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  echo -e "${RED}[dev] 端口 8000 被占用 (PID $OLD_PID)，正在关闭...${NC}"
  kill $OLD_PID 2>/dev/null || true
  sleep 1
fi

npx tsx apps/gateway/src/index.ts &
GW_PID=$!

# 等 Gateway 就绪
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/api/llm/selector > /dev/null 2>&1; then
    echo -e "${GREEN}[dev] Gateway 就绪${NC}"
    break
  fi
  if [ $i -eq 30 ]; then
    echo -e "${RED}[dev] Gateway 启动超时${NC}"
    exit 1
  fi
  sleep 1
done

# ── 2. Vite Dev Server ──
echo -e "${CYAN}[dev] 启动 Vite (port 5173)...${NC}"
OLD_VITE=$(lsof -iTCP:5173 -sTCP:LISTEN -P -n -t 2>/dev/null || true)
if [ -n "$OLD_VITE" ]; then
  echo -e "${RED}[dev] 端口 5173 被占用 (PID $OLD_VITE)，正在关闭...${NC}"
  kill $OLD_VITE 2>/dev/null || true
  sleep 1
fi

npx vite apps/desktop &
VITE_PID=$!

# 等 Vite 就绪
for i in $(seq 1 30); do
  if curl -sf http://localhost:5173 > /dev/null 2>&1; then
    echo -e "${GREEN}[dev] Vite 就绪${NC}"
    break
  fi
  if [ $i -eq 30 ]; then
    echo -e "${RED}[dev] Vite 启动超时${NC}"
    exit 1
  fi
  sleep 1
done

# ── 3. Electron（可选） ──
ELECTRON_PID=""
if [ "$1" != "--no-electron" ]; then
  echo -e "${CYAN}[dev] 启动 Electron...${NC}"
  # 杀掉旧 Electron 实例（single-instance lock）
  pkill -f "electron apps/desktop" 2>/dev/null || true
  sleep 1

  VITE_DEV_SERVER_URL=http://localhost:5173 npx electron apps/desktop/electron/main.cjs &
  ELECTRON_PID=$!
  echo -e "${GREEN}[dev] Electron 已启动 (PID $ELECTRON_PID)${NC}"
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Gateway:  http://localhost:8000${NC}"
echo -e "${GREEN}  Vite:     http://localhost:5173${NC}"
if [ -n "$ELECTRON_PID" ]; then
  echo -e "${GREEN}  Electron: PID $ELECTRON_PID${NC}"
fi
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${CYAN}  按 Ctrl+C 关闭全部${NC}"
echo ""

# 前台等待，任一子进程退出则全部关闭
wait
