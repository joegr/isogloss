import { expect, type Page } from "@playwright/test";
import { auditSvg } from "../svg-audit";

export const FIXED_NOW = new Date("2026-06-21T12:00:00Z"); // stable day/night terminator

/** Collect console errors and uncaught exceptions for the whole test. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

export async function open(page: Page, hash: string) {
  // The app must not depend on third-party hosts; fail loudly if it tries.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
  await page.clock.setFixedTime(FIXED_NOW);
  await page.goto(`/${hash}`);
  await page.waitForLoadState("networkidle");
}

/** Run the SVG audit inside the real browser. */
export async function expectCleanSvg(page: Page) {
  const issues = await page.evaluate(`(${auditSvg.toString()})(document)`);
  expect(issues, "SVG audit").toEqual([]);
}

export async function expectNoHorizontalOverflow(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "page scrolls horizontally").toBeLessThanOrEqual(1);
}
