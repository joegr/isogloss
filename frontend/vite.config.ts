import { defineConfig } from "vite";

// The Isogloss API (backend/app/main.py, `make up` serves it on :8000).
const backend = process.env.ISOGLOSS_BACKEND ?? "http://127.0.0.1:8000";
const proxy = { target: backend, changeOrigin: true };

export default defineConfig({
  server: {
    port: 5173,
    // /classic is the original analyser UI the API serves at its root.
    proxy: { "/api": proxy, "/static": proxy, "/classic": { ...proxy, rewrite: () => "/" } },
  },
  build: { outDir: "dist", sourcemap: true },
});
