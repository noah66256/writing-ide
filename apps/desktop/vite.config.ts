import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function resolveDevPort(defaultPort = 5173) {
  const raw = String(process.env.DESKTOP_DEV_PORT ?? "").trim();
  if (!raw) return defaultPort;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultPort;
  return Math.floor(n);
}

const devPort = resolveDevPort();

export default defineConfig({
  // Electron file:// 加载时需要相对路径
  base: "./",
  plugins: [react()],
  server: {
    port: devPort,
    strictPort: true,
    // 开发期：通过 Vite proxy 把 /api 转发到本地 Gateway，避免 Electron renderer 的跨域/CORS/localhost问题
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});


