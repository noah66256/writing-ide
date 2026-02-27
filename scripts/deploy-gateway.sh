#!/usr/bin/env bash
set -euo pipefail

# 一键部署 Gateway + Admin-web
#
# 设计目标：
# - 部署过程尽量不受本机 http_proxy/https_proxy 影响
#   - 本脚本不会在本机 curl 你的服务器（health check 走 SSH 到服务器本机 127.0.0.1）
# - 适配服务器 nvm PATH（非交互 ssh 不加载 .bashrc）
# - ⚠️ 仅通过 git pull 更新代码，绝不触碰 data/ 目录
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
#   DEPLOY_ADMIN_WEB=1         # 1=同时部署 admin-web；0=仅部署 gateway

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
ADMIN_WEB="${DEPLOY_ADMIN_WEB:-1}"

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

remote_cmd=”$(cat <<EOF
set -euo pipefail
export PATH=${NODE_BIN}:\$PATH
cd ${DIR}

# ── 安全检查：确保 data/ 目录存在且不会被意外操作 ──
if [[ -d “${DIR}/apps/gateway/data” ]]; then
  echo “[remote] data/ OK ($(ls ${DIR}/apps/gateway/data/*.json 2>/dev/null | wc -l) json files)”
else
  echo “[remote] ⚠ data/ dir missing — will be created on first gateway start”
fi

echo “[remote] before=\$(git rev-parse --short HEAD)”
# 服务器上可能存在未提交的临时改动（例如排查时手改文件）。
# 为避免 git pull --rebase 直接失败，这里启用 autostash：先自动 stash，再 rebase，最后自动尝试恢复。
git pull --rebase --autostash origin ${BRANCH}
echo “[remote] after=\$(git rev-parse --short HEAD)”

# ── npm install（仅 gateway + admin-web workspace，跳过 desktop/electron 的平台限制） ──
echo “[remote] npm install (workspace-scoped)”
npm install -w @writing-ide/gateway -w @writing-ide/admin-web --no-audit --no-fund --force 2>&1 | tail -5

# ── 确保 Linux native 包存在（rollup/esbuild 可选依赖在 lock 中可能只有 darwin 版本） ──
echo “[remote] ensure linux native deps”
node -e 'try{require(“@esbuild/linux-x64”)}catch{process.exit(1)}' 2>/dev/null \
  || npm i --no-save --force --no-audit --no-fund @esbuild/linux-x64 2>&1 | tail -3
node -e 'try{require(“@rollup/rollup-linux-x64-gnu”)}catch{process.exit(1)}' 2>/dev/null \
  || npm i --no-save --force --no-audit --no-fund @rollup/rollup-linux-x64-gnu 2>&1 | tail -3

# ── 构建 Gateway ──
echo “[remote] build gateway”
npm -w @writing-ide/gateway run build

# ── 重启 Gateway ──
pm2 restart ${PM2_APP} --update-env

# ── 构建 + 部署 Admin-web（可选） ──
if [[ “${ADMIN_WEB}” == “1” ]]; then
  echo “[remote] build admin-web”
  cd ${DIR}/apps/admin-web
  npx tsc -b
  npx vite build
  cd ${DIR}

  echo “[remote] redeploy admin-web”
  pm2 delete writing-admin-web 2>/dev/null || true
  pm2 serve apps/admin-web/dist 8001 --name writing-admin-web --spa
fi

# ── Health check ──
echo “[remote] health”
health_ok=0
health_out=””
for i in {1..30}; do
  health_out=”\$(curl -fsS -m 2 http://127.0.0.1:${PORT}/api/health 2>/tmp/gateway-health.err || true)”
  if [[ -n “\${health_out}” ]]; then
    echo “gateway: \${health_out}”
    health_ok=1
    break
  fi
  echo “[remote] health retry \${i}/30 ...”
  sleep 1
done
if [[ “\${health_ok}” != “1” ]]; then
  echo “[remote] gateway health FAILED after retries (port=${PORT})”
  cat /tmp/gateway-health.err || true
fi

if [[ “${ADMIN_WEB}” == “1” ]]; then
  admin_out=”\$(curl -fsS -m 2 http://127.0.0.1:8001/ 2>/dev/null | head -c 50 || true)”
  if [[ -n “\${admin_out}” ]]; then
    echo “admin-web: OK”
  else
    echo “admin-web: FAILED (port 8001)”
  fi
fi

echo “[remote] pm2 status”
pm2 ls | sed -n “1,16p” || true

# ── data/ 完整性复查 ──
if [[ -f “${DIR}/apps/gateway/data/db.json” ]]; then
  user_count=”\$(node -e 'const d=JSON.parse(require(“fs”).readFileSync(“${DIR}/apps/gateway/data/db.json”,”utf8”));console.log((d.users||[]).length)' 2>/dev/null || echo '?')”
  echo “[remote] data/db.json users=\${user_count}”
else
  echo “[remote] ⚠ data/db.json not found”
fi

if [[ “\${health_ok}” != “1” ]]; then
  echo “[remote] err tail”
  tail -n 60 /root/.pm2/logs/${PM2_APP}-error.log || true
  exit 7
fi
EOF
)”

echo “[deploy] ssh ${HOST} ...”
ssh “${HOST}” “bash -lc $(printf '%q' “${remote_cmd}”)”

echo “[deploy] done”


