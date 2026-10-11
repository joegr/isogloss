import { describe, expect, it } from "vitest";
import { highlight, renderMarked, snippet } from "../../src/util";
import { record, spanOf } from "./fixtures";

const dom = (html: string) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};

describe("person highlighting", () => {
  it("links every mention of a linked contact to its CRM page", () => {
    const el = dom(highlight(record));
    const links = [...el.querySelectorAll("a.hl.person")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Angela Merkel", "#/contacts/c_am"],
      ["Emmanuel Macron", "#/contacts/c_em"],
      ["Merkel", "#/contacts/c_am"],
    ]);
  });

  it("encodes the evidence tier on the link", () => {
    const el = dom(highlight(record));
    expect(el.querySelector('a[href="#/contacts/c_am"]')!.className).toContain("tier-gold");
    expect(el.querySelector('a[href="#/contacts/c_em"]')!.className).toContain("tier-bronze");
  });

  it("still highlights places and dates around people", () => {
    const el = dom(highlight(record));
    expect([...el.querySelectorAll("mark.geo")].map((m) => m.textContent)).toEqual(["Sibiu", "Berlin"]);
    expect(el.querySelector("mark.time")!.textContent).toBe("9 May 2019");
  });

  it("escapes record text (no HTML injection)", () => {
    const el = dom(highlight(record));
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain("<script>alert(1)</script>");
  });

  it("preserves the text exactly", () => {
    expect(dom(highlight(record)).textContent).toBe(record.content);
  });

  it("people win over overlapping places", () => {
    const marks = [
      { s: 0, e: 5, prio: 3, open: "<mark>", close: "</mark>" },
      { s: 0, e: 12, prio: 4, open: "<a>", close: "</a>" },
    ];
    expect(renderMarked("Paris Hilton visits", marks)).toBe("<a>Paris Hilton</a> visits");
  });

  it("marks unsaved PER entities without a link", () => {
    const preview = { ...record, contacts: [], pending_people: [] };
    const el = dom(highlight(preview));
    const span = el.querySelector(".hl.person.unlinked")!;
    expect(span.tagName).toBe("SPAN");
    expect(span.textContent).toBe("Angela Merkel");
  });

  it("marks ambiguous names awaiting review", () => {
    const pending = { ...record, contacts: [], pending_people: [
      { id: "p1", record_id: "r1", text: "Merkel", mentions: [{ text: "Merkel", start: spanOf("Merkel", 1)[0], end: spanOf("Merkel", 1)[1] }], candidates: [{ id: "a", name: "A" }, { id: "b", name: "B" }] },
    ] };
    const el = dom(highlight(pending));
    expect(el.querySelector("a.hl.person.pending")!.getAttribute("title")).toContain("A or B");
  });
});

describe("snippets", () => {
  it("clip around the emphasised person without breaking marks", () => {
    const long = { ...record, content: "x ".repeat(200) + record.content, contacts: record.contacts!.map((c) => ({
      ...c, mentions: c.mentions.map((m) => ({ ...m, start: m.start + 400, end: m.end + 400 })) })), geo: [], temporal_mentions: [] };
    const el = dom(snippet(long, 120, "c_am"));
    expect(el.textContent!.startsWith("… ")).toBe(true);
    expect(el.querySelector("a.hl.person.focus")!.textContent).toBe("Angela Merkel");
    expect(el.textContent!.length).toBeLessThanOrEqual(130);
  });
});
