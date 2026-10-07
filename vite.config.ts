import { defineConfig } from "vite";

const backend = process.env.GEOMAP_BACKEND ?? "http://127.0.0.1:5050";

export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": { target: backend, changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});
