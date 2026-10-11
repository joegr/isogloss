import * as d3 from "d3";
import type { GeoRecord, RecordKind, Temporal } from "./types";

export const KINDS: RecordKind[] = ["string", "text", "label"];
export const KIND_LABEL: Record<RecordKind, string> = { string: "String", text: "Text", label: "Labels" };
/** Categorical slots 1-3 (validated all-pairs, so safe for a scatter map). */
export const kindColor = (k: RecordKind): string => `var(--series-${KINDS.indexOf(k) + 1})`;

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function formatTemporal(t: Temporal): string {
  const d = new Date(t.value);
  switch (t.granularity) {
    case "year":
      return d3.utcFormat("%Y")(d);
    case "month":
      return d3.utcFormat("%b %Y")(d);
    case "day":
      return d3.utcFormat("%-d %b %Y")(d);
    default:
      return d3.utcFormat("%-d %b %Y, %H:%M UTC")(d);
  }
}

export const pct = d3.format(".0%");
export const num = d3.format(",");

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: number | undefined;
  return (...a: A) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

/** A highlighted span inside a record's text. Higher ``prio`` wins on overlap. */
interface Mark {
  s: number;
  e: number;
  prio: number;
  open: string;
  close: string;
}

/**
 * Person names: linked contacts become links to the contact's CRM page; PER entities that are not
 * linked yet (e.g. an unsaved preview) are still highlighted, without a link.
 */
function personMarks(record: GeoRecord, emphasize?: string): Mark[] {
  const marks: Mark[] = [];
  const covered = new Set<string>();
  for (const c of record.contacts ?? []) {
    for (const m of c.mentions) {
      covered.add(`${m.start}:${m.end}`);
      const cls = `hl person tier-${c.tier ?? "bronze"}${c.contact_id === emphasize ? " focus" : ""}`;
      const how = c.tier === "gold" ? "gold standard" : c.tier === "silver" ? "confirmed" : "automatic";
      marks.push({
        s: m.start, e: m.end, prio: 4,
        open: `<a class="${cls}" href="#/contacts/${encodeURIComponent(c.contact_id)}" data-contact="${esc(c.contact_id)}" title="${esc(c.name)} · ${how} link — open contact">`,
        close: "</a>",
      });
    }
  }
  for (const p of record.pending_people ?? []) {
    for (const m of p.mentions) {
      covered.add(`${m.start}:${m.end}`);
      marks.push({
        s: m.start, e: m.end, prio: 4,
        open: `<a class="hl person pending" href="#/contacts" title="Who is “${esc(p.text)}”? ${esc(p.candidates.map((c) => c.name).join(" or "))} — needs review">`,
        close: "</a>",
      });
    }
  }
  for (const c of record.concepts ?? []) {
    if (c.type !== "PER") continue;
    for (const [s, e] of c.spans) {
      if (covered.has(`${s}:${e}`)) continue;
      marks.push({ s, e, prio: 4, open: `<span class="hl person unlinked" title="Person (becomes a contact when saved)">`, close: "</span>" });
    }
  }
  return marks;
}

function recordMarks(record: GeoRecord, activeMention = -1, emphasize?: string): Mark[] {
  const marks = personMarks(record, emphasize);
  record.geo.forEach((m, i) => m.span && marks.push({
    s: m.span[0], e: m.span[1], prio: 3,
    open: `<mark class="hl geo${i === activeMention ? " active" : ""}" data-mention="${i}">`, close: "</mark>",
  }));
  record.temporal_mentions.forEach((t) => t.span && marks.push({
    s: t.span[0], e: t.span[1], prio: 2, open: `<mark class="hl time">`, close: "</mark>",
  }));
  return marks;
}

/** Render ``text[from, to)`` with non-overlapping marks (clipped to the range). */
export function renderMarked(text: string, marks: Mark[], from = 0, to = text.length): string {
  const sorted = marks.filter((m) => m.e > from && m.s < to).sort((a, b) => a.s - b.s || b.prio - a.prio);
  const kept: Mark[] = [];
  for (const m of sorted) {
    const clash = kept.findIndex((k) => m.s < k.e && k.s < m.e);
    if (clash < 0) kept.push(m);
    else if (m.prio > kept[clash].prio) kept[clash] = m;
  }
  kept.sort((a, b) => a.s - b.s);
  let out = "";
  let pos = from;
  for (const m of kept) {
    const s = Math.max(m.s, from), e = Math.min(m.e, to);
    if (s < pos) continue;
    out += esc(text.slice(pos, s)) + m.open + esc(text.slice(s, e)) + m.close;
    pos = e;
  }
  return out + esc(text.slice(pos, to));
}

/** Record content with people (linked to contacts), places and dates highlighted. */
export function highlight(record: GeoRecord, activeMention = -1, emphasize?: string): string {
  if (record.kind === "label") {
    return record.labels
      .map((l) => {
        const i = record.geo.findIndex((m) => m.surface === l);
        return i >= 0
          ? `<mark class="hl geo${i === activeMention ? " active" : ""}" data-mention="${i}">${esc(l)}</mark>`
          : `<span class="hl none">${esc(l)}</span>`;
      })
      .join(" ");
  }
  return renderMarked(record.content, recordMarks(record, activeMention, emphasize));
}

/** A short highlighted excerpt, centred on the first person (or the start) of the text. */
export function snippet(record: GeoRecord, max = 160, emphasize?: string): string {
  if (record.kind === "label") return highlight(record);
  const text = record.content;
  if (text.length <= max) return highlight(record, -1, emphasize);
  const people = (record.contacts ?? []).filter((c) => !emphasize || c.contact_id === emphasize).flatMap((c) => c.mentions);
  const anchor = people.length ? Math.min(...people.map((m) => m.start)) : 0;
  let from = Math.max(0, anchor - Math.floor(max / 3));
  let to = Math.min(text.length, from + max);
  from = Math.max(0, to - max);
  // don't cut words
  if (from > 0) from = text.indexOf(" ", from) + 1 || from;
  if (to < text.length) to = text.lastIndexOf(" ", to) > from ? text.lastIndexOf(" ", to) : to;
  return `${from > 0 ? "… " : ""}${renderMarked(text, recordMarks(record, -1, emphasize), from, to)}${to < text.length ? " …" : ""}`;
}

export const tooltip = {
  el: () => document.getElementById("tooltip")!,
  show(html: string, ev: MouseEvent) {
    const el = this.el();
    el.innerHTML = html;
    el.hidden = false;
    const { innerWidth: w, innerHeight: h } = window;
    const r = el.getBoundingClientRect();
    let x = ev.clientX + 14;
    let y = ev.clientY + 14;
    if (x + r.width > w - 8) x = ev.clientX - r.width - 14;
    if (y + r.height > h - 8) y = ev.clientY - r.height - 14;
    el.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  },
  hide() {
    this.el().hidden = true;
  },
};

/** Where a record "is": its primary place, else its (compact) centroid. */
export function anchorOf(r: import("./types").GeoRecord): { lat: number; lon: number } | null {
  if (r.primary != null && r.geo[r.primary]) return { lat: r.geo[r.primary].place.lat, lon: r.geo[r.primary].place.lon };
  return r.centroid;
}

export interface LabelBox {
  x: number;
  y: number;
  anchor: "start" | "end" | "middle";
  visible: boolean;
}

/**
 * Greedy collision-free label placement for point labels (most important first).
 * Tries right, left, above, below each point; hides a label that fits nowhere.
 * Width is estimated from the character count, so it also works where text can't be measured.
 */
export function placeLabels(items: { x: number; y: number; r: number; text: string }[], charW = 6.4, h = 12,
                            bounds?: { w: number; h: number }): LabelBox[] {
  const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const hit = (a: { x0: number; y0: number; x1: number; y1: number }) =>
    taken.some((b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1);
  return items.map(({ x, y, r, text }) => {
    const w = text.length * charW + 4;
    const options: (LabelBox & { box: { x0: number; y0: number; x1: number; y1: number } })[] = [
      { x: x + r + 3, y: y + 4, anchor: "start", visible: true, box: { x0: x + r + 3, y0: y - h / 2, x1: x + r + 3 + w, y1: y + h / 2 } },
      { x: x - r - 3, y: y + 4, anchor: "end", visible: true, box: { x0: x - r - 3 - w, y0: y - h / 2, x1: x - r - 3, y1: y + h / 2 } },
      { x, y: y - r - 4, anchor: "middle", visible: true, box: { x0: x - w / 2, y0: y - r - 4 - h, x1: x + w / 2, y1: y - r - 4 } },
      { x, y: y + r + h, anchor: "middle", visible: true, box: { x0: x - w / 2, y0: y + r + 2, x1: x + w / 2, y1: y + r + 2 + h } },
    ];
    const inside = (b: { x0: number; y0: number; x1: number; y1: number }) =>
      !bounds || (b.x0 >= 0 && b.y0 >= 0 && b.x1 <= bounds.w && b.y1 <= bounds.h);
    const ok = options.find((o) => inside(o.box) && !hit(o.box));
    if (!ok) return { x, y, anchor: "start", visible: false };
    taken.push(ok.box);
    return { x: ok.x, y: ok.y, anchor: ok.anchor, visible: true };
  });
}
