import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 8001);
const DIST_DIR = path.resolve(__dirname, "dist");
const GATEWAY_URL = String(process.env.GATEWAY_URL ?? "http://127.0.0.1:8000").trim();

function guessContentType(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function send(res, statusCode, body, headers) {
  res.statusCode = statusCode;
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      res.setHeader(k, v);
    }
  }
  if (body === null) return res.end();
  if (Buffer.isBuffer(body) || typeof body === "string") return res.end(body);
  return res.end(String(body));
}

function safeJoin(rootDir, urlPath) {
  const rel = String(urlPath || "").replaceAll("\\", "/");
  const clean = rel.split("?")[0].split("#")[0];
  const decoded = decodeURIComponent(clean);
  const joined = path.resolve(rootDir, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (!joined.startsWith(rootDir)) return null;
  return joined;
}

async function serveIndexHtml(req, res) {
  const file = path.join(DIST_DIR, "index.html");
  try {
    const buf = await fsp.readFile(file);
    return send(res, 200, buf, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
  } catch {
    return send(res, 500, "INDEX_NOT_FOUND", { "content-type": "text/plain; charset=utf-8" });
  }
}

async function handleStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "METHOD_NOT_ALLOWED", { "content-type": "text/plain; charset=utf-8" });

  const pathname = String(url.pathname || "/");
  const isAsset = pathname.startsWith("/assets/");
  const filePath =
    pathname === "/" || pathname === ""
      ? path.join(DIST_DIR, "index.html")
      : safeJoin(DIST_DIR, pathname);

  if (!filePath) return send(res, 400, "BAD_PATH", { "content-type": "text/plain; charset=utf-8" });

  try {
    const st = await fsp.stat(filePath);
    if (st.isDirectory()) return serveIndexHtml(req, res);
    if (!st.isFile()) return send(res, 404, "NOT_FOUND", { "content-type": "text/plain; charset=utf-8" });

    res.statusCode = 200;
    res.setHeader("content-type", guessContentType(filePath));
    res.setHeader("cache-control", isAsset ? "public, max-age=31536000, immutable" : "no-cache");

    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(filePath).pipe(res);
  } catch {
    // SPA fallback：非资源路径一律回 index.html
    if (!isAsset) return serveIndexHtml(req, res);
    return send(res, 404, "NOT_FOUND", { "content-type": "text/plain; charset=utf-8" });
  }
}

function proxyToGateway(req, res, url) {
  let target;
  try {
    target = new URL(GATEWAY_URL);
  } catch {
    return send(res, 500, "INVALID_GATEWAY_URL", { "content-type": "text/plain; charset=utf-8" });
  }

  const isHttps = target.protocol === "https:";
  const client = isHttps ? https : http;
  const port = target.port ? Number(target.port) : isHttps ? 443 : 80;

  const headers = { ...req.headers };
  // host 需要指向上游，否则某些网关/反代会拒绝
  headers.host = target.host;

  const upstreamReq = client.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
    },
    (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode || 502;
      for (const [k, v] of Object.entries(upstreamRes.headers || {})) {
        if (v === undefined) continue;
        res.setHeader(k, v);
      }
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", (e) => {
    send(res, 502, `BAD_GATEWAY: ${String(e?.message ?? e)}`, { "content-type": "text/plain; charset=utf-8" });
  });

  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  const rawUrl = String(req.url || "/");
  const url = new URL(rawUrl, `http://${req.headers.host || "localhost"}`);

  // 反代到 Gateway（同源消除跨端口/跨域问题）
  // - /api/*：Admin API（登录/配置/审计等）
  // - /help/*：对外分享的“使用说明视频”等静态/流式内容（Gateway 负责 Range）
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/help/")) {
    return proxyToGateway(req, res, url);
  }

  void handleStatic(req, res, url);
});

server.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`[admin-web] listening on :${PORT}, dist=${DIST_DIR}, gateway=${GATEWAY_URL}`);
});





