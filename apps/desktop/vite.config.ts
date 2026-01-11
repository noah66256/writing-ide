import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Electron file:// 加载时需要相对路径
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
});


