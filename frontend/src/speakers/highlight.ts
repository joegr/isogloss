import { esc } from "../util";
import type { Entity } from "./types";

/** Colour family per entity label: places share the GeoCRM geo highlight,
 * times share its time highlight, so the two apps read the same way. */
export function entityClass(label: string): string {
  if (label === "LOC") return "geo";
  if (label === "DATE" || label === "DURATION" || label === "AGE_RANGE") return "time";
  if (label === "PER") return "per";
  return "other";
}

/** One field's text with its entities marked. Overlaps cannot happen (the
 * backend keeps one entity per span) but are skipped defensively. */
export function highlightField(text: string, entities: Entity[]): string {
  const marks = [...entities].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const e of marks) {
    if (e.start < pos || e.end > text.length) continue;
    const title = e.place ? `${e.label} → ${e.place} (${e.match})` : `${e.label} · ${e.source.split(":")[0]}`;
    out += esc(text.slice(pos, e.start));
    out += `<mark class="hl ${entityClass(e.label)}" title="${esc(title)}" data-label="${esc(e.label)}">${esc(text.slice(e.start, e.end))}</mark>`;
    pos = e.end;
  }
  return out + esc(text.slice(pos));
}
