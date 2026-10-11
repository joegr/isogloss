import { defineConfig } from "vite";

// The backend: Demogi's API with Isogloss inside (joegr/demogi, private).
// In development Vite proxies to it, so config.js can keep apiBase empty.
const backend = process.env.SPEAKER_MAP_BACKEND ?? "http://127.0.0.1:5050";
const proxy = { target: backend, changeOrigin: true };

export default defineConfig({
  // Relative asset URLs: the site lives under /speaker-map/ on GitHub Pages.
  base: "./",
  server: {
    port: 5173,
    proxy: { "/api": proxy, "/classic": proxy },
  },
  build: { outDir: "dist", sourcemap: true },
});
