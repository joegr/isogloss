import { beforeEach, describe, expect, it } from "vitest";
import { drawMap, drawTimeline } from "../../src/contacts";
import { auditSvg } from "../svg-audit";
import { contact } from "./fixtures";

function host(width = 640, height = 320) {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: width });
  Object.defineProperty(el, "clientHeight", { value: height });
  document.body.appendChild(el);
  return el;
}

beforeEach(() => { document.body.querySelectorAll("div:not(#tooltip)").forEach((d) => d.remove()); });

describe("contact map", () => {
  it("draws one point per place, labels, and tints countries", () => {
    const el = host();
    drawMap(el, contact);
    expect(el.querySelectorAll("circle.c-pt")).toHaveLength(2);
    expect([...el.querySelectorAll("text.place-label")].map((t) => t.textContent)).toEqual(["Paris", "Sibiu"]);
    expect(el.querySelectorAll("path.c-land.present").length).toBeGreaterThan(0);
    expect(el.querySelector("svg")!.getAttribute("aria-label")).toContain("Angela Merkel");
  });

  it("is structurally clean (no NaN, no negative sizes, labelled)", () => {
    const el = host();
    drawMap(el, contact);
    expect(auditSvg(el)).toEqual([]);
  });

  it("scales point radius by record count", () => {
    const el = host();
    drawMap(el, contact);
    const [paris, sibiu] = [...el.querySelectorAll("circle.c-pt")].map((c) => Number(c.getAttribute("r")));
    expect(paris).toBeGreaterThan(sibiu);
  });

  it("copes with a contact who has no places", () => {
    const el = host();
    drawMap(el, { ...contact, places: [], countries: [] });
    expect(el.querySelectorAll("circle.c-pt")).toHaveLength(0);
    expect(auditSvg(el)).toEqual([]);
  });

  it("keeps a single point from zooming in absurdly", () => {
    const el = host();
    drawMap(el, { ...contact, places: [contact.places[0]] });
    const land = el.querySelectorAll("path.c-land");
    expect([...land].some((p) => (p.getAttribute("d") ?? "").length > 0)).toBe(true); // surrounding land is visible
    expect(auditSvg(el)).toEqual([]);
  });
});

describe("contact timeline", () => {
  it("draws one tick per dated record inside the axis range", () => {
    const el = host();
    drawTimeline(el, contact);
    const xs = [...el.querySelectorAll("circle.c-tick")].map((c) => Number(c.getAttribute("cx")));
    expect(xs).toHaveLength(2);
    xs.forEach((x) => { expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(640); });
    expect(xs[0]).toBeGreaterThan(xs[1]); // 2019 is right of 2017
    expect(auditSvg(el)).toEqual([]);
  });

  it("says so when nothing is dated", () => {
    const el = host();
    drawTimeline(el, { ...contact, records: contact.records.map((r) => ({ ...r, dated: false })) });
    expect(el.textContent).toContain("No dated records");
  });
});

describe("svg audit itself", () => {
  it("catches the classic d3 failure modes", () => {
    const el = document.createElement("div");
    el.innerHTML = `<svg><rect width="-4" height="2"/><circle r="NaN"/><text>undefined</text><g id="a"/><g id="a"/></svg>`;
    expect(auditSvg(el).map((i) => i.rule).sort()).toEqual(["bad-number", "bad-text", "duplicate-id", "negative-size", "svg-label"]);
  });
});

describe("map framing", () => {
  it("centres a single place and stays finite", async () => {
    const { frameProjection } = await import("../../src/contacts");
    const proj = frameProjection([[2.35, 48.86]], 640, 320);
    const [x, y] = proj([2.35, 48.86])!;
    expect(Math.round(x)).toBe(320);
    expect(Math.round(y)).toBe(160);
    expect(Number.isFinite(proj.scale())).toBe(true);
  });

  it("keeps every place of a multi-place contact inside the frame", async () => {
    const { frameProjection } = await import("../../src/contacts");
    const pts: [number, number][] = [[-74, 40.7], [139.7, 35.7], [18.4, -33.9]];
    const proj = frameProjection(pts, 640, 320);
    for (const p of pts) {
      const [x, y] = proj(p)!;
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(640);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(320);
    }
  });
});

describe("label placement", () => {
  it("never overlaps two visible labels", async () => {
    const { placeLabels } = await import("../../src/util");
    // Hamburg and Berlin are ~10px apart on a European map
    const boxes = placeLabels([
      { x: 300, y: 100, r: 5, text: "Hamburg" },
      { x: 305, y: 108, r: 5, text: "Berlin" },
      { x: 302, y: 104, r: 5, text: "Potsdam" },
    ], 6.4, 12, { w: 640, h: 320 });
    const shown = boxes.filter((b) => b.visible);
    expect(shown.length).toBeGreaterThanOrEqual(2);
    const rects = shown.map((b, i) => {
      const w = ["Hamburg", "Berlin", "Potsdam"][i].length * 6.4 + 4;
      const x0 = b.anchor === "start" ? b.x : b.anchor === "end" ? b.x - w : b.x - w / 2;
      return { x0, x1: x0 + w, y0: b.y - 12, y1: b.y };
    });
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++)
        expect(rects[i].x0 < rects[j].x1 && rects[j].x0 < rects[i].x1 && rects[i].y0 < rects[j].y1 && rects[j].y0 < rects[i].y1).toBe(false);
  });
});
