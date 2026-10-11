import { defineConfig } from "@playwright/test";

/**
 * The speaker map, driven in a real browser against a running backend (Demogi's
 * API with Isogloss inside, on a PostGIS built from infra/postgis/*.sql).
 *
 * Same origin, through Vite's proxy:
 *   SPK_FIXTURES=/path/to/audio E2E_BASE_URL=http://127.0.0.1:5173 npm run test:e2e
 *
 * Cross-origin, as on GitHub Pages — the built site served statically with
 * config.js pointing at the API, which must allow the site's origin (CORS):
 *   SPK_FIXTURES=… E2E_BASE_URL=http://127.0.0.1:4173 \
 *     SPEAKER_MAP_API=http://127.0.0.1:5050 npm run test:e2e
 *
 * SPK_FIXTURES holds my-speaker.mp3, english656.mp3, english1.mp3 and
 * not-in-archive.wav (CI makes them from the synthesiser with ffmpeg).
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /speakers\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  expect: { timeout: 30_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    reducedMotion: "reduce", // no auto-rotation: the globe opens on North America, deterministically
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    trace: "retain-on-failure",
    // A preinstalled Chromium, when the pinned Playwright's own is not downloaded.
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
});
