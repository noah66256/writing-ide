#!/usr/bin/env bash
set -euo pipefail

# Deploy CPU tool-call repair service on server.
#
# What it does:
# - Install llama.cpp prebuilt server binary (CPU)
# - Download Qwen2.5-1.5B-Instruct GGUF (q4_k_m)
# - Start it on 127.0.0.1:${REPAIR_PORT} via pm2 (name: tool-call-repair)
# - Enable Gateway feature flag + point Gateway to local repair server
# - Rebuild + restart Gateway pm2 app (writing-gateway)
#
# Run on server (as root):
#   bash scripts/deploy-tool-call-repair.sh
#

ROOT_DIR="${ROOT_DIR:-/www/wwwroot/writing-ide}"
NODE_BIN="${DEPLOY_NODE_BIN:-/www/server/nvm/versions/node/v22.21.1/bin}"
GATEWAY_PM2_APP="${DEPLOY_PM2_APP:-writing-gateway}"
GATEWAY_PORT="${DEPLOY_PORT:-8000}"

REPAIR_PM2_APP="tool-call-repair"
REPAIR_HOST="127.0.0.1"
# NOTE: 8001 is often used by admin-web in this repo's deployments.
# Use 8002 by default to avoid conflicts. Override via:
#   DEPLOY_REPAIR_PORT=8002 bash scripts/deploy-tool-call-repair.sh
REPAIR_PORT="${DEPLOY_REPAIR_PORT:-8002}"

LLAMA_VER="${LLAMA_VER:-b7813}"
LLAMA_TGZ="llama-${LLAMA_VER}-bin-ubuntu-x64.tar.gz"
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VER}/${LLAMA_TGZ}"

MODEL_NAME="${MODEL_NAME:-qwen2.5-1.5b-instruct-q4_k_m.gguf}"
MODEL_URL_1="https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/${MODEL_NAME}"
MODEL_URL_2="https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/${MODEL_NAME}"

echo "[tool-repair] root=${ROOT_DIR}"
cd "${ROOT_DIR}"

export PATH="${NODE_BIN}:$PATH"
node -v >/dev/null
npm -v >/dev/null
pm2 -v >/dev/null

mkdir -p .tool-call-repair/bin .tool-call-repair/models .tool-call-repair/tmp

echo "[tool-repair] installing llama.cpp server (${LLAMA_VER})"
if [[ ! -x ".tool-call-repair/bin/llama-server" ]]; then
  echo "[tool-repair] download: ${LLAMA_URL}"
  curl -fL --retry 3 --retry-delay 2 -o ".tool-call-repair/tmp/${LLAMA_TGZ}" "${LLAMA_URL}"
  rm -rf ".tool-call-repair/tmp/unpack"
  mkdir -p ".tool-call-repair/tmp/unpack"
  tar -xzf ".tool-call-repair/tmp/${LLAMA_TGZ}" -C ".tool-call-repair/tmp/unpack"
  python3 - <<'PY'
import os, glob, shutil, sys
root = ".tool-call-repair/tmp/unpack"
cands = []
for p in glob.glob(root + "/**/llama-server", recursive=True):
    if os.path.isfile(p):
        cands.append(p)
if not cands:
    print("NO_LLAMA_SERVER_FOUND", file=sys.stderr)
    sys.exit(2)
cands.sort(key=len)
src = cands[0]
src_dir = os.path.dirname(src)
dst_dir = ".tool-call-repair/bin"
os.makedirs(dst_dir, exist_ok=True)

# Copy executable + all shared libs shipped in the release bundle.
to_copy = [src]
to_copy += glob.glob(os.path.join(src_dir, "lib*.so*"))

copied = 0
for p in to_copy:
    if not os.path.isfile(p):
        continue
    dst = os.path.join(dst_dir, os.path.basename(p))
    shutil.copy2(p, dst)
    if os.path.basename(p) == "llama-server":
        os.chmod(dst, 0o755)
    copied += 1

print("copied_files:", copied)
print("llama-server:", src, "->", os.path.join(dst_dir, "llama-server"))
PY
fi

echo "[tool-repair] downloading model ${MODEL_NAME} (if missing)"
if [[ ! -f ".tool-call-repair/models/${MODEL_NAME}" ]]; then
  (curl -fL --retry 3 --retry-delay 2 -o ".tool-call-repair/models/${MODEL_NAME}" "${MODEL_URL_1}" || \
   curl -fL --retry 3 --retry-delay 2 -o ".tool-call-repair/models/${MODEL_NAME}" "${MODEL_URL_2}")
fi

echo "[tool-repair] (re)start pm2 app: ${REPAIR_PM2_APP}"
pm2 delete "${REPAIR_PM2_APP}" >/dev/null 2>&1 || true

# NOTE: llama-server is dynamically linked; we must set LD_LIBRARY_PATH.
export LD_LIBRARY_PATH="${ROOT_DIR}/.tool-call-repair/bin:${LD_LIBRARY_PATH:-}"

".tool-call-repair/bin/llama-server" --version || true

pm2 start bash --name "${REPAIR_PM2_APP}" -- -lc "
  export LD_LIBRARY_PATH='${ROOT_DIR}/.tool-call-repair/bin':\"\${LD_LIBRARY_PATH:-}\"
  exec '${ROOT_DIR}/.tool-call-repair/bin/llama-server' \
    --host '${REPAIR_HOST}' --port '${REPAIR_PORT}' \
    -m '${ROOT_DIR}/.tool-call-repair/models/${MODEL_NAME}' \
    -t 2 -c 2048 -b 64
"

echo "[tool-repair] waiting for http://${REPAIR_HOST}:${REPAIR_PORT}/v1/models"
ok=0
for i in $(seq 1 60); do
  if out="$(curl -fsS -m 2 "http://${REPAIR_HOST}:${REPAIR_PORT}/v1/models" 2>/dev/null)"; then
    echo "${out}"
    ok=1
    break
  fi
  sleep 1
done
if [[ "${ok}" != "1" ]]; then
  echo "[tool-repair] health FAILED"
  pm2 logs "${REPAIR_PM2_APP}" --lines 120 || true
  exit 9
fi

echo "[gateway] update .env"
python3 - <<PY
import pathlib, re
path = pathlib.Path("${ROOT_DIR}") / ".env"
text = path.read_text(encoding="utf-8") if path.exists() else ""
want = {
  "TOOL_CALL_REPAIR_ENABLED": "1",
  "LLM_TOOL_REPAIR_BASE_URL": "http://${REPAIR_HOST}:${REPAIR_PORT}",
  # llama.cpp uses the model id as provided in requests; keep it consistent
  # with what we downloaded (MODEL_NAME).
  "LLM_TOOL_REPAIR_MODEL": "${MODEL_NAME}",
  "LLM_TOOL_REPAIR_API_KEY": "",
}
lines = text.splitlines()
out = []
seen = set()
for line in lines:
  m = re.match(r"^([A-Z0-9_]+)=", line)
  if m and m.group(1) in want:
    k = m.group(1)
    out.append(f"{k}={want[k]}")
    seen.add(k)
  else:
    out.append(line)
for k, v in want.items():
  if k not in seen:
    out.append(f"{k}={v}")
path.write_text("\\n".join(out) + "\\n", encoding="utf-8")
print("env updated:", ", ".join(sorted(want.keys())))
PY

echo "[gateway] npm install"
npm install --no-audit --no-fund

echo "[gateway] build"
npm -w @writing-ide/gateway run build

echo "[gateway] pm2 restart ${GATEWAY_PM2_APP}"
pm2 restart "${GATEWAY_PM2_APP}" --update-env
pm2 save || true

echo "[gateway] health"
curl -fsS -m 2 "http://127.0.0.1:${GATEWAY_PORT}/api/health" || true

echo "[done] tool-call repair is enabled"

