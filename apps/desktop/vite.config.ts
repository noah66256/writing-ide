import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

function resolveDevPort(defaultPort = 5173) {
  const raw = String(process.env.DESKTOP_DEV_PORT ?? "").trim();
  if (!raw) return defaultPort;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultPort;
  return Math.floor(n);
}

const devPort = resolveDevPort();

// Gateway 地址：优先环境变量，否则用服务器（本地调试 Gateway 时可改回 127.0.0.1:8000）
const gatewayTarget = process.env.VITE_GATEWAY_URL || "http://120.26.6.147:8000";

export default defineConfig({
  // Electron file:// 加载时需要相对路径
  base: "./",
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: devPort,
    strictPort: true,
    // 开发期：通过 Vite proxy 把 /api 转发到 Gateway，避免 Electron renderer 的跨域/CORS/localhost问题
    proxy: {
      "/api": {
        target: gatewayTarget,
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    // 显式包含 qrcode，避免动态导入时 Vite 优化缓存失效导致 504 错误
    include: ["qrcode"],
  },
});


