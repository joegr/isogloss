import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

const FIX = process.env.SPK_FIXTURES ?? "";
const fx = (name: string) => path.join(FIX, name);

/** Everything this spec creates or attaches, removed afterwards. */
const created: number[] = [];
const archiveRecordings: string[] = [];

test.afterAll(async ({ request }) => {
  for (const id of created) await request.delete(`/api/speakers/${id}`);
  for (const rec of archiveRecordings) await request.delete(`/api/recordings/${rec}`);
});

async function recordingsOf(request: APIRequestContext, id: number): Promise<string[]> {
  const r = await (await request.get(`/api/speakers/${id}`)).json();
  return r.recordings.map((x: { id: string }) => x.id);
}

test.describe.configure({ mode: "serial" });

test("the archive is on the globe and filterable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#stats")).toContainText(/3,0\d\d\s+speakers/);
  expect(await page.locator("circle.spk-dot").count()).toBeGreaterThanOrEqual(3027);
  await page.getByRole("button", { name: "Native English" }).click();
  await expect(page.locator("#stats")).toContainText(/658\s+speakers/);
  await page.getByRole("button", { name: "All", exact: true }).click();
});

test("a record opens with every field and its geocode", async ({ page }) => {
  await page.goto("/#/speaker/3036");
  const card = page.locator(".detail-card");
  await expect(card.getByRole("heading")).toHaveText("#3036 · english");
  await expect(card).toContainText("lansing, michigan, usa");
  await expect(card).toContainText("city+state");
  await expect(card).toContainText("english658.mp3");
});

test("dropping a dot cascades: record → place → entities → audio", async ({ page }) => {
  test.skip(!FIX, "SPK_FIXTURES not set");
  await page.goto("/");
  await expect(page.locator("#stats")).toContainText("speakers");
  await page.getByRole("button", { name: "Drop a speaker on the map" }).click();
  await expect(page.locator(".spk-hint")).toHaveText("Click the map where the speaker was born");

  // The globe opens centred on North America; click its middle.
  const map = page.locator("#map");
  const box = (await map.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".spk-pinline")).toBeVisible();
  // Prefilled from the nearest populated place, spelt the archive's way.
  await expect(page.locator("#f-country")).toHaveValue("usa");
  await expect(page.locator("#f-near")).toContainText("near");

  await page.locator("#f-native_language").fill("English");
  await page.locator("#f-age").fill("34");
  await page.locator("#f-gender").selectOption("female");
  await page.locator("#f-english_residence").fill("usa, uk");
  await page.locator("#f-notes").fill("10 july 2015. LING523. residence: dallas,0-18; austin,18-40");
  await page.locator("#f-audio").setInputFiles(fx("my-speaker.mp3"));
  await page.getByRole("button", { name: "Create speaker" }).click();

  const report = page.locator(".f-result");
  await expect(report).toContainText(/Created speaker #(\d+)/);
  const id = Number((await report.textContent())!.match(/#(\d+)/)![1]);
  created.push(id);
  expect(id).toBeGreaterThanOrEqual(100001);
  await expect(report).toContainText("placed at the pin");
  await expect(report).toContainText(/NER .*: \d+ entities, \d+ linked to places/);
  await expect(report).toContainText(/audio: \d+\.\d s/);

  // The new record is selected: entities highlighted, places drawn, audio playable.
  const card = page.locator(".detail-card");
  await expect(card.getByRole("heading")).toHaveText(`#${id} · english`);
  await expect(card.locator('mark.hl.time[data-label="DATE"]')).toHaveText("10 july 2015");
  await expect(card.locator('mark.hl.geo[data-label="LOC"]', { hasText: "austin" })).toHaveAttribute("title", /Austin/);
  await expect(page.locator(".mentions")).toContainText("austin → Austin");
  expect(await page.locator("path.spk-place").count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator(".rec-list audio")).toHaveCount(1);
  await expect(page.locator(".rec-list")).toContainText("my-speaker.mp3");
  await expect(page.locator(`circle.spk-dot.ui.audio`)).toHaveCount(1);
});

test("a folder of archive files attaches by name", async ({ page, request }) => {
  test.skip(!FIX, "SPK_FIXTURES not set");
  const before = [...(await recordingsOf(request, 3034)), ...(await recordingsOf(request, 61))];
  await page.goto("/");
  await expect(page.locator("#stats")).toContainText("speakers");
  await page.locator("#spk-bulk-files").setInputFiles([fx("english656.mp3"), fx("english1.mp3"), fx("not-in-archive.wav")]);
  const log = page.locator("#spk-bulk-log");
  await expect(log).toContainText("1 not in the archive: not-in-archive.wav");
  await expect(log).toContainText("2 / 2 attached");
  await expect(log.locator("li.ok")).toHaveCount(2);
  const after = [...(await recordingsOf(request, 3034)), ...(await recordingsOf(request, 61))];
  archiveRecordings.push(...after.filter((r) => !before.includes(r)));
  expect(after.length - before.length).toBe(2);

  // Sending the same file again is harmless.
  await page.locator("#spk-bulk-files").setInputFiles([fx("english656.mp3")]);
  await expect(log).toContainText("already attached");

  await page.goto("/#/speaker/3034");
  await expect(page.locator(".rec-list")).toContainText("english656.mp3");
  await expect(page.locator(".rec-list .phones")).not.toBeEmpty();
});
