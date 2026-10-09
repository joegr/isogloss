import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end + visual tests for the D3 UI.
 *
 * Default: starts an isolated backend (temp SQLite, in-memory vectors, deterministic hash
 * embeddings) and the Vite dev server. Set E2E_BASE_URL (e.g. http://localhost:8080) to test an
 * already-running stack instead - such as the Docker gateway.
 */
const external = process.env.E2E_BASE_URL;
// A fresh database per run (workers inherit the env, so they all agree on the path).
const db = process.env.E2E_DB ?? path.join(os.tmpdir(), `geocrm-e2e-${Date.now()}-${process.pid}.db`);
process.env.E2E_DB = db;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  workers: 1, // one shared, seeded database
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["json", { outputFile: "test-results/results.json" }]],
  globalSetup: "./tests/e2e/global-setup.ts",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  // Generous waits: the backend runs spaCy + embeddings, and CI / busy laptops are slow.
  expect: { timeout: 15_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" } },
  use: {
    baseURL: external ?? "http://127.0.0.1:5174",
    reducedMotion: "reduce", // no globe auto-rotation, no CSS flow animations
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-dark", testMatch: /visual\.spec/, use: { viewport: { width: 1440, height: 900 }, colorScheme: "dark" } },
    { name: "desktop-light", testMatch: /visual\.spec/, use: { viewport: { width: 1440, height: 900 }, colorScheme: "light" } },
    { name: "mobile", testMatch: /visual\.spec/, use: { ...devices["Pixel 7"], colorScheme: "light" } },
    { name: "flows", testMatch: /flows\.spec/, dependencies: ["desktop-dark", "desktop-light", "mobile"],
      use: { viewport: { width: 1440, height: 900 }, colorScheme: "dark" } },
  ],
  webServer: external ? undefined : [
    {
      command: "uv --directory ../backend run flask --app geomap.app run --port 5055 --no-reload",
      url: "http://127.0.0.1:5055/api/healthz",
      env: { GEOMAP_DB: db, GEOMAP_VECTORS: ":memory:", GEOMAP_EMBEDDER: "hash" },
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: "ignore",
    },
    {
      command: "npx vite --host 127.0.0.1 --port 5174 --strictPort",
      url: "http://127.0.0.1:5174",
      env: { GEOMAP_BACKEND: "http://127.0.0.1:5055" },
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
