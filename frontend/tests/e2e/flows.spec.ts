import { expect, test } from "@playwright/test";
import { open, watchErrors } from "./helpers";

// These change data, so they run after all visual projects (see playwright.config.ts).

test("review queue: a radio choice confirms who an ambiguous name is", async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, "#/contacts");
  const item = page.locator("#c-review .review-item").first();
  await expect(item).toContainText("Kennedy");
  await item.getByRole("radio", { name: "Robert F. Kennedy" }).check();
  await item.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator("#c-review")).toBeHidden();
  await page.locator(".contacts-table a.person-cell", { hasText: "Robert F. Kennedy" }).click();
  await expect(page.locator(".c-records li")).toHaveCount(2);
  await expect(page.locator(".c-records .tier.tier-silver")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("verdict radios grade a link silver, then gold", async ({ page }) => {
  await open(page, "#/contacts");
  await page.locator(".contacts-table a.person-cell", { hasText: "Nelson Mandela" }).click();
  const fs = page.locator("fieldset.verdict").first();
  await fs.getByRole("radio", { name: "Yes" }).check();
  await expect(page.locator(".c-records .tier.tier-silver")).toHaveCount(1);
  // second independent confirmation (e.g. another reviewer) -> gold
  const contactId = page.url().split("/").pop()!;
  const recordId = await page.locator("fieldset.verdict").first().getAttribute("data-record");
  await page.request.post(`/api/contacts/${contactId}/records/${recordId}/verdict`, { data: { verdict: "yes" } });
  await page.reload();
  await expect(page.locator(".c-records .tier.tier-gold")).toHaveCount(1);
});
