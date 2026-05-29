import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy API + static file serving to the backend during dev.
      "/api": { target: BACKEND, changeOrigin: true },
      "/files": { target: BACKEND, changeOrigin: true },
      "/health": { target: BACKEND, changeOrigin: true },
    },
  },
});
