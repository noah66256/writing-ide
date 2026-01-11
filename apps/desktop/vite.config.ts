import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Electron file:// 加载时需要相对路径
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // 开发期：通过 Vite proxy 把 /api 转发到本地 Gateway，避免 Electron renderer 的跨域/CORS/localhost问题
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      }
    }
  },
});


