#!/usr/bin/env bash
set -euo pipefail

# 一键部署 Gateway（适配：Windows Git Bash / macOS / Linux）
#
# 设计目标：
# - 部署过程尽量不受本机 http_proxy/https_proxy 影响
#   - 本脚本不会在本机 curl 你的服务器（health check 走 SSH 到服务器本机 127.0.0.1）
# - 适配服务器 nvm PATH（非交互 ssh 不加载 .bashrc）
#
# 使用：
#   bash scripts/deploy-gateway.sh
#
# 可选环境变量（必要时覆盖）：
#   DEPLOY_SSH_HOST=writing
#   DEPLOY_BRANCH=master
#   DEPLOY_DIR=/www/wwwroot/writing-ide
#   DEPLOY_NODE_BIN=/www/server/nvm/versions/node/v22.21.1/bin
#   DEPLOY_PM2_APP=writing-gateway
#   DEPLOY_PORT=8000
#   DEPLOY_PUSH=1              # 1=部署前先 git push；0=跳过 push
#   DEPLOY_ALLOW_DIRTY=0       # 0=工作区必须干净；1=允许有未提交改动

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" ]]; then
  echo "[deploy] ERROR: not in a git repo"
  exit 1
fi
cd "${ROOT}"

HOST="${DEPLOY_SSH_HOST:-writing}"
BRANCH="${DEPLOY_BRANCH:-master}"
DIR="${DEPLOY_DIR:-/www/wwwroot/writing-ide}"
NODE_BIN="${DEPLOY_NODE_BIN:-/www/server/nvm/versions/node/v22.21.1/bin}"
PM2_APP="${DEPLOY_PM2_APP:-writing-gateway}"
PORT="${DEPLOY_PORT:-8000}"
DEPLOY_PUSH="${DEPLOY_PUSH:-1}"
ALLOW_DIRTY="${DEPLOY_ALLOW_DIRTY:-0}"

echo "[deploy] repo=${ROOT}"
echo "[deploy] branch=$(git rev-parse --abbrev-ref HEAD) head=$(git rev-parse --short HEAD)"

if [[ "${ALLOW_DIRTY}" != "1" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "[deploy] ABORT: working tree is not clean. commit/stash first, or set DEPLOY_ALLOW_DIRTY=1"
    git status --porcelain
    exit 2
  fi
fi

if [[ "${DEPLOY_PUSH}" == "1" ]]; then
  echo "[deploy] git push origin ${BRANCH}"
  git push origin "${BRANCH}"
fi

remote_cmd="$(cat <<EOF
set -euo pipefail
export PATH=${NODE_BIN}:\$PATH
cd ${DIR}

echo "[remote] before=\$(git rev-parse --short HEAD)"
git pull --rebase origin ${BRANCH}
echo "[remote] after=\$(git rev-parse --short HEAD)"

npm -w @writing-ide/gateway run build

pm2 restart ${PM2_APP} --update-env

echo "[remote] health"
curl -fsS -m 3 http://127.0.0.1:${PORT}/api/health
echo

echo "[remote] listen"
ss -ltnp | grep -E ":${PORT}\\\\b" || true

echo "[remote] pm2 (top)"
pm2 ls | sed -n "1,16p" || true

echo "[remote] err tail"
tail -n 60 /root/.pm2/logs/${PM2_APP}-error.log || true
EOF
)"

echo "[deploy] ssh ${HOST} ..."
ssh "${HOST}" "bash -lc $(printf '%q' "${remote_cmd}")"

echo "[deploy] done"


