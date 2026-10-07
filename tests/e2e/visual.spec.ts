import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectCleanSvg, expectNoHorizontalOverflow, open, watchErrors } from "./helpers";

async function axe(page: import("@playwright/test").Page, include: string) {
  const res = await new AxeBuilder({ page }).include(include).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
}

test.describe("Explore", () => {
  test("globe, charts and record list render cleanly", async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, "#/");
    await expect(page.locator(".map-svg path.country").first()).toBeVisible();
    await expect(page.locator(".map-svg circle.pt").nth(20)).toBeAttached();
    await expect(page.locator(".record a.hl.person").nth(5)).toBeVisible();
    const mobile = (page.viewportSize()?.width ?? 1000) < 760;
    if (!mobile) {
      expect(await page.locator("#timeline path.bar").count()).toBeGreaterThan(5);
      expect(await page.locator(".lang-row").count()).toBeGreaterThan(3);
    }
    expect(await page.locator(".record a.hl.person").count()).toBeGreaterThan(5);
    await expectCleanSvg(page);
    await expectNoHorizontalOverflow(page);
    await expect(page).toHaveScreenshot("explore.png", { fullPage: false });
    expect(errors).toEqual([]);
  });

  test("flat map and network views", async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, "#/");
    await page.getByRole("button", { name: "Flat" }).click();
    await expect(page.locator(".map-svg.is-flat")).toBeVisible();
    await expectCleanSvg(page);
    await page.getByRole("button", { name: "Network" }).click();
    await expect(page.locator(".net-svg path.nl-contact").first()).toBeAttached();
    await page.waitForTimeout(2500); // let the force layout settle
    await expectCleanSvg(page);
    expect(await page.locator(".net-svg path.nl-contact").count()).toBeGreaterThanOrEqual(8);
    await page.getByRole("button", { name: "Globe" }).click(); // leave the default view for later tests
    expect(errors).toEqual([]);
  });

  test("person names are highlighted links on a coloured background", async ({ page }) => {
    await open(page, "#/");
    const link = page.locator(".record a.hl.person", { hasText: "Angela Merkel" }).first();
    await expect(link).toBeVisible();
    const bg = await link.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    await expect(link).toHaveAttribute("href", /#\/contacts\/c_/);
  });

  test("accessibility (axe, WCAG A/AA)", async ({ page }) => {
    await open(page, "#/");
    await axe(page, "#app");
  });
});

test.describe("Contacts", () => {
  test("directory", async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, "#/contacts");
    // the list and the review queue load asynchronously: wait (auto-retrying) rather than count once
    await expect(page.locator(".contacts-table tbody tr").nth(7)).toBeVisible();
    await expect(page.locator("#c-review .review-item")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator("#c-review input[type=radio]").first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expect(page).toHaveScreenshot("contacts.png");
    await axe(page, "#page-contacts");
    expect(errors).toEqual([]);
  });

  test("contact detail: map, timeline, tiers, radios", async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, "#/contacts");
    await page.locator(".contacts-table a.person-cell", { hasText: "Angela Merkel" }).click();
    await expect(page.locator(".contact-hero h1")).toHaveText("Angela Merkel");
    await expect(page.locator(".c-map-svg circle.c-pt")).toHaveCount(4);
    await expect(page.locator(".c-time circle.c-tick")).toHaveCount(2);
    await expect(page.locator(".alias-chip .tier").first()).toBeVisible();
    await expect(page.locator("fieldset.verdict")).toHaveCount(2);
    await expectCleanSvg(page);
    await expectNoHorizontalOverflow(page);
    await expect(page).toHaveScreenshot("contact-detail.png", { fullPage: true, mask: [page.locator(".hero-actions")] });
    await axe(page, "#page-contacts");
    expect(errors).toEqual([]);
  });

  test("record drilldown links people back to the CRM", async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, "#/contacts");
    await page.locator(".contacts-table a.person-cell", { hasText: "Konrad Adenauer" }).click();
    await page.locator(".c-records a.btn", { hasText: "Open record" }).first().click();
    await expect(page.locator("#drilldown")).toBeVisible();
    await expect(page.locator("#drilldown .dd-text a.hl.person").first()).toBeVisible();
    await expectCleanSvg(page);
    await page.locator("#drilldown .dd-close").click();
    await expect(page).toHaveURL(/#\/contacts\/c_/);
    expect(errors).toEqual([]);
  });
});
