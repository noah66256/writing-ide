import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: process.env.VITE_GATEWAY_URL || "http://120.26.6.147:8000",
        changeOrigin: true,
      },
    },
  },
});
