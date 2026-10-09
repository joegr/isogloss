import { defineConfig } from "@playwright/test";

/**
 * The speaker-dot module, driven in a real browser against a running stack:
 * the API (backend, on a database built from db/*.sql) behind Vite or the
 * gateway. Start them first, then:
 *
 *   SPK_FIXTURES=/path/to/audio E2E_BASE_URL=http://127.0.0.1:5173 \
 *     npx playwright test -c playwright.speakers.config.ts
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
