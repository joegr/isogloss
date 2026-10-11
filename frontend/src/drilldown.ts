import * as d3 from "d3";
import * as topojson from "topojson-client";
import type { Feature, FeatureCollection, Geometry, MultiLineString } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import world50 from "world-atlas/countries-50m.json";
import { api } from "./api";
import { lastPageHash } from "./router";
import { getState } from "./state";
import type { Concept, Drilldown, GeoMention, GeoRecord, PathStep, RecordSummary, Role } from "./types";
import { KIND_LABEL, esc, formatTemporal, kindColor, num, pct, tooltip } from "./util";

/* ------------------------------------------------------------------ routing */

const ROUTE = /^#\/record\/([^/?#]+)/;

export function openRecord(id: string): void {
  location.hash = `#/record/${encodeURIComponent(id)}`;
}

export function closeDrilldown(): void {
  location.hash = lastPageHash(); // back to the page the record was opened from
}

/* ------------------------------------------------------------------ constants */

const ROLE_LABEL: Record<Role, string> = {
  event: "Event location", origin: "Origin", destination: "Destination", route: "Route", topic: "Topic", unspecified: "Mentioned",
};
/** Three categorical slots for the roles that carry the story; the rest are neutral + shape. */
const ROLE_COLOR: Record<Role, string> = {
  event: "var(--series-1)", origin: "var(--series-2)", destination: "var(--series-3)",
  route: "var(--role-neutral)", topic: "var(--role-neutral)", unspecified: "var(--role-neutral)",
};
const ROLE_SHAPE: Record<Role, d3.SymbolType> = {
  event: d3.symbolCircle, origin: d3.symbolCircle, destination: d3.symbolCircle,
  route: d3.symbolSquare, topic: d3.symbolDiamond, unspecified: d3.symbolCircle,
};
const CONCEPT_LABEL: Record<Concept["type"], string> = {
  PER: "People", ORG: "Organisations", MISC: "Other entities", TERM: "Key terms", LABEL: "Labels",
};

type Topo = Topology<{ countries: GeometryCollection<{ name: string }> }>;
const topo = world50 as unknown as Topo;
const LAND = (topojson.feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>).features;
const BORDERS = topojson.mesh(topo, topo.objects.countries, (a, b) => a !== b) as MultiLineString;

const roleOf = (m: GeoMention): Role => m.role ?? "unspecified";

/* ------------------------------------------------------------------ view */

export function initDrilldown(): void {
  const el = document.createElement("div");
  el.id = "drilldown";
  el.className = "dd";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Record drilldown");
  document.body.appendChild(el);

  let current: Drilldown | null = null;
  let windowDays = 3650;
  let token = 0;
  let lastFocus: Element | null = null;

  async function show(id: string) {
    const my = ++token;
    if (el.hidden) lastFocus = document.activeElement;
    el.hidden = false;
    document.body.classList.add("dd-open");
    if (!current || current.record.id !== id) el.innerHTML = `<div class="dd-loading">Loading record…</div>`;
    try {
      const data = await api.drilldown(id, windowDays);
      if (my !== token) return;
      current = data;
      render(el, data, {
        setWindow: (d) => { windowDays = d; show(id); },
        windowDays,
      });
      el.querySelector<HTMLElement>(".dd-close")?.focus({ preventScroll: true });
      el.scrollTop = 0;
    } catch (e) {
      if (my !== token) return;
      el.innerHTML = `<div class="dd-loading error">Couldn't load this record (${esc((e as Error).message)}). <button type="button" class="btn small dd-close">Close</button></div>`;
      el.querySelector(".dd-close")?.addEventListener("click", closeDrilldown);
    }
  }

  function hide() {
    token++;
    el.hidden = true;
    el.innerHTML = "";
    current = null;
    document.body.classList.remove("dd-open");
    tooltip.hide();
    if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
  }

  function route() {
    const m = ROUTE.exec(location.hash);
    if (m) show(decodeURIComponent(m[1]));
    else if (!el.hidden) hide();
  }

  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (e) => {
    if (el.hidden || !current) return;
    if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
    if (e.key === "Escape") closeDrilldown();
    else if (e.key === "ArrowLeft" && current.nav.prev) openRecord(current.nav.prev);
    else if (e.key === "ArrowRight" && current.nav.next) openRecord(current.nav.next);
  });
  route();
}

interface Opts {
  windowDays: number;
  setWindow: (days: number) => void;
}

function render(el: HTMLElement, d: Drilldown, opts: Opts) {
  const r = d.record;
  const primary = r.primary != null ? r.geo[r.primary] : null;
  const title = primary ? `${primary.place.name}${r.dated === false ? "" : `, ${formatTemporal(r.timestamp)}`}` : r.dated === false ? "Undated record" : formatTemporal(r.timestamp);
  el.innerHTML = `
    <header class="dd-bar">
      <button type="button" class="btn ghost dd-close" aria-label="Close drilldown (Esc)">← All records</button>
      <div class="dd-nav">
        <button type="button" class="icon-btn" id="dd-prev" ${d.nav.prev ? "" : "disabled"} aria-label="Previous record (←)">‹</button>
        <span class="num">${d.nav.index + 1} / ${d.nav.total}</span>
        <button type="button" class="icon-btn" id="dd-next" ${d.nav.next ? "" : "disabled"} aria-label="Next record (→)">›</button>
      </div>
      <span class="hint">ordered by time · ← → to step</span>
    </header>
    <div class="dd-grid">
      <section class="card dd-article">
        <div class="dd-kicker">
          <span class="pill kind" style="--k:${kindColor(r.kind)}">${KIND_LABEL[r.kind]}</span>
          <span class="pill">${esc(r.language.name ?? r.language.code)} · ${esc(r.language.code)}</span>
          ${r.dated === false ? `<span class="pill warn">undated — shown at ingest time</span>` : `<span class="pill time">${esc(intervalLabel(r))}</span>`}
          <code class="muted">${esc(r.id)}</code>
        </div>
        <h1 class="dd-title">${esc(title)}</h1>
        <p class="dd-sub">${esc(subtitle(r))}</p>
        <div class="dd-text" dir="auto">${articleHtml(r, d)}</div>
        <div class="dd-legend">${legendHtml(r)}</div>
      </section>

      <section class="card dd-map-card">
        <div class="card-head"><h2>Where</h2><span class="hint">drag to rotate · scroll to zoom</span></div>
        <div class="dd-map" id="dd-map"></div>
      </section>

      <section class="card dd-places">
        <div class="card-head"><h2>Places &amp; coordinates</h2><span class="hint">${r.geo.length} mention${r.geo.length === 1 ? "" : "s"}${r.extent ? ` · extent ${r.extent.map((v) => v.toFixed(2)).join(", ")}` : ""}</span></div>
        ${placesTable(r)}
      </section>

      <section class="card dd-time">
        <div class="card-head"><h2>When</h2>
          <label class="dd-window">window
            <select id="dd-window">
              ${[[365, "± 1 year"], [1826, "± 5 years"], [3650, "± 10 years"], [9131, "± 25 years"], [36525, "± 100 years"]]
                .map(([v, l]) => `<option value="${v}" ${Number(v) === opts.windowDays ? "selected" : ""}>${l}</option>`).join("")}
            </select></label>
        </div>
        <div id="dd-axis" class="dd-axis"></div>
        ${timeFacts(r)}
      </section>

      <section class="card dd-concepts">
        <div class="card-head"><h2>Concepts</h2><span class="hint">click to see usage across records</span></div>
        ${conceptsHtml(r)}
        <ol class="conc-hits dd-kwic" id="dd-kwic"></ol>
      </section>

      <section class="card dd-context">
        <div class="card-head"><h2>Context</h2></div>
        ${contextHtml(d, opts.windowDays)}
      </section>

      <section class="card dd-ontology">
        <details><summary>Ontology record (v${r.ontology_version ?? 1}) · JSON</summary><pre>${esc(JSON.stringify(r, null, 2))}</pre></details>
      </section>
    </div>`;

  el.querySelector(".dd-close")!.addEventListener("click", closeDrilldown);
  el.querySelector("#dd-prev")?.addEventListener("click", () => d.nav.prev && openRecord(d.nav.prev));
  el.querySelector("#dd-next")?.addEventListener("click", () => d.nav.next && openRecord(d.nav.next));
  el.querySelector<HTMLSelectElement>("#dd-window")!.addEventListener("change", (e) => opts.setWindow(Number((e.target as HTMLSelectElement).value)));
  el.querySelectorAll<HTMLElement>("[data-open]").forEach((n) => {
    n.addEventListener("click", () => openRecord(n.dataset.open!));
    n.addEventListener("keydown", (e) => e.key === "Enter" && openRecord(n.dataset.open!));
  });
  el.querySelectorAll<HTMLButtonElement>("[data-concept]").forEach((b) => b.addEventListener("click", () => kwic(el, b.dataset.concept!, r.id)));

  const map = drawLocator(el.querySelector<HTMLElement>("#dd-map")!, d);
  drawAxis(el.querySelector<HTMLElement>("#dd-axis")!, d, opts.windowDays);

  // Linked highlighting: text mark ↔ table row ↔ map point.
  const link = (i: number | null) => {
    el.querySelectorAll("[data-m]").forEach((n) => n.classList.toggle("lit", i !== null && (n as HTMLElement).dataset.m === String(i)));
    el.classList.toggle("linking", i !== null);
    map.highlight(i);
  };
  el.querySelectorAll<HTMLElement>("[data-m]").forEach((n) => {
    n.addEventListener("mouseenter", () => link(Number(n.dataset.m)));
    n.addEventListener("mouseleave", () => link(null));
    n.addEventListener("focus", () => link(Number(n.dataset.m)));
    n.addEventListener("blur", () => link(null));
  });
  map.onHover = link;
}

/* ------------------------------------------------------------------ article */

function intervalLabel(r: GeoRecord): string {
  const t = r.timestamp;
  const src = t.source === "provided" ? "provided" : t.source === "extracted" ? `from “${t.surface ?? ""}”` : t.source;
  return `${formatTemporal(t)} · ${t.granularity} · ${src}`;
}

function subtitle(r: GeoRecord): string {
  const by = (role: Role) => unique(r.geo.filter((m) => roleOf(m) === role).map((m) => m.place.name));
  const ev = by("event"), other = by("unspecified");
  const parts: string[] = [];
  if (ev.length) parts.push(`in ${ev.join(", ")}`);
  if (other.length) parts.push(ev.length ? `also ${other.join(", ")}` : other.join(" · "));
  for (const [role, word] of [["origin", "from"], ["route", "via"], ["destination", "to"], ["topic", "about"]] as [Role, string][]) {
    const xs = by(role);
    if (xs.length) parts.push(`${word} ${xs.join(", ")}`);
  }
  const people = (r.concepts ?? []).filter((c) => c.type === "PER").map((c) => c.text);
  if (people.length) parts.push(`with ${people.join(", ")}`);
  return parts.join(" — ");
}

const unique = <T,>(xs: T[]) => [...new Set(xs)];

function articleHtml(r: GeoRecord, d: Drilldown): string {
  if (r.kind === "label") {
    return `<ul class="dd-labels">${r.labels.map((l) => {
      const i = r.geo.findIndex((m) => m.surface === l);
      return i >= 0
        ? `<li><mark class="hl geo role-${roleOf(r.geo[i])}" data-m="${i}" tabindex="0">${esc(l)}</mark></li>`
        : `<li><span class="hl none">${esc(l)}</span></li>`;
    }).join("")}</ul>`;
  }
  type Mark = { s: number; e: number; html: (inner: string) => string; prio: number };
  const marks: Mark[] = [];
  // People first: linked contacts are links to their CRM page (highest priority on overlap).
  (r.contacts ?? []).forEach((c) => c.mentions.forEach((pm) => marks.push({ s: pm.start, e: pm.end, prio: 5,
    html: (x) => `<a class="hl person" href="#/contacts/${encodeURIComponent(c.contact_id)}" title="${esc(c.name)} — open contact">${x}</a>` })));
  r.geo.forEach((m, i) => m.span && marks.push({ s: m.span[0], e: m.span[1], prio: 3,
    html: (x) => `<mark class="hl geo role-${roleOf(m)}" data-m="${i}" tabindex="0" title="${esc(`${m.place.name} · ${ROLE_LABEL[roleOf(m)]}${m.role_cue ? ` (“${m.role_cue}”)` : ""}`)}">${x}</mark>` }));
  r.temporal_mentions.forEach((t) => t.span && marks.push({ s: t.span[0], e: t.span[1], prio: 2,
    html: (x) => `<mark class="hl time" title="${esc(`${formatTemporal(t)} · ${t.granularity}`)}">${x}</mark>` }));
  (r.concepts ?? []).filter((c) => c.type !== "LABEL").forEach((c) => c.spans.forEach(([s, e]) => marks.push({ s, e, prio: c.type === "TERM" ? 0 : 1,
    html: (x) => `<span class="hl concept c-${c.type.toLowerCase()}" title="${esc(CONCEPT_LABEL[c.type])}">${x}</span>` })));
  marks.sort((a, b) => a.s - b.s || b.prio - a.prio);
  let out = "";
  let pos = 0;
  for (const m of marks) {
    if (m.s < pos) continue;
    out += esc(r.content.slice(pos, m.s)) + m.html(esc(r.content.slice(m.s, m.e)));
    pos = m.e;
  }
  out += esc(r.content.slice(pos));
  return d.sentences.length > 1 ? out.replace(/\n/g, "<br>") : out;
}

function legendHtml(r: GeoRecord): string {
  const roles = unique(r.geo.map(roleOf));
  return roles.map((role) => `<span class="legend-item"><svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true"><path d="${d3.symbol(ROLE_SHAPE[role], 60)()}" style="fill:${ROLE_COLOR[role]}"/></svg>${ROLE_LABEL[role]}</span>`).join("")
    + (r.temporal_mentions.length ? `<span class="legend-item"><span class="sw time"></span>date</span>` : "")
    + ((r.concepts ?? []).some((c) => c.type !== "TERM" && c.type !== "LABEL") ? `<span class="legend-item"><span class="sw ent"></span>named entity</span>` : "")
    + ((r.concepts ?? []).some((c) => c.type === "TERM") ? `<span class="legend-item"><span class="sw term"></span>key term</span>` : "");
}

/* ------------------------------------------------------------------ places table */

function placesTable(r: GeoRecord): string {
  if (!r.geo.length) return `<div class="empty">No places resolved in this record.</div>`;
  return `<div class="dd-table-wrap"><table class="dd-table">
    <thead><tr><th>#</th><th>Mention → place</th><th>Role</th><th>Coordinates</th><th>Date</th><th>Conf.</th><th>IDs</th></tr></thead>
    <tbody>${r.geo.map((m, i) => {
      const p = m.place;
      const role = roleOf(m);
      const sub = [p.subclass ?? p.feature_class.replace(/_/g, " "), ...(p.admin_path ?? [])].filter(Boolean).join(" · ");
      return `<tr data-m="${i}" tabindex="0" class="${r.primary === i ? "primary" : ""}">
        <td class="num">${i + 1}${r.primary === i ? '<span class="star" title="Primary place">★</span>' : ""}</td>
        <td><span class="muted">“${esc(m.surface)}” →</span> <b>${esc(p.name)}</b><div class="muted small">${esc(sub)}${p.nearest ? ` · nearest: ${esc(p.nearest.name)} (${num(p.nearest.distance_km)} km)` : ""}</div></td>
        <td><span class="role-badge" style="--rc:${ROLE_COLOR[role]}">${ROLE_LABEL[role]}</span>${m.role_cue ? `<div class="muted small">cue “${esc(m.role_cue)}”</div>` : ""}</td>
        <td class="num coords"><span>${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</span>${p.bbox && (p.bbox[0] !== p.bbox[2] || p.bbox[1] !== p.bbox[3]) ? `<div class="muted small">bbox ${p.bbox.map((v) => v.toFixed(1)).join(", ")}</div>` : ""}</td>
        <td>${m.time ? esc(formatTemporal(m.time)) : '<span class="muted">—</span>'}</td>
        <td><span class="conf" title="${pct(m.confidence)} · ${esc(m.match_type)}${m.ner_label ? ` · NER ${esc(m.ner_label)}` : ""}"><span class="conf-bar" style="width:${m.confidence * 100}%"></span></span> <span class="num muted">${pct(m.confidence)}</span></td>
        <td class="ids">${p.wikidata_id ? `<a href="https://www.wikidata.org/wiki/${esc(p.wikidata_id)}" target="_blank" rel="noopener noreferrer">${esc(p.wikidata_id)}</a>` : ""}
          ${p.geonames_id ? `<a href="https://www.geonames.org/${esc(p.geonames_id)}" target="_blank" rel="noopener noreferrer">GN ${esc(p.geonames_id)}</a>` : ""}
          <code class="muted">${esc(p.place_id)}</code></td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
}

/* ------------------------------------------------------------------ locator globe */

interface Locator {
  highlight: (i: number | null) => void;
  onHover: (i: number | null) => void;
}

function drawLocator(host: HTMLElement, d: Drilldown): Locator {
  const r = d.record;
  const api: Locator = { highlight: () => {}, onHover: () => {} };
  const width = host.clientWidth || 420;
  const height = host.clientHeight || 360;
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("class", "dd-svg")
    .attr("role", "img").attr("aria-label", `Locator map of ${r.geo.length} places`);
  const defs = svg.append("defs");
  const g = defs.append("radialGradient").attr("id", "dd-ocean").attr("cx", "38%").attr("cy", "32%").attr("r", "75%");
  g.append("stop").attr("offset", "0%").attr("style", "stop-color: var(--ocean-hi)");
  g.append("stop").attr("offset", "100%").attr("style", "stop-color: var(--ocean-deep)");
  const marker = defs.append("marker").attr("id", "dd-arrow").attr("viewBox", "0 -4 8 8").attr("refX", 7).attr("refY", 0)
    .attr("markerWidth", 7).attr("markerHeight", 7).attr("orient", "auto");
  marker.append("path").attr("d", "M0,-4L8,0L0,4").attr("class", "dd-arrowhead");

  const pts = r.geo.map((m) => [m.place.lon, m.place.lat] as [number, number]);
  const bboxPts = r.geo.flatMap((m) => (m.place.bbox && m.place.feature_class !== "country"
    ? [[m.place.bbox[0], m.place.bbox[1]], [m.place.bbox[2], m.place.bbox[3]]] as [number, number][] : []));
  const center: [number, number] = d.anchor ? [d.anchor.lon, d.anchor.lat]
    : pts.length ? d3.geoCentroid({ type: "MultiPoint", coordinates: pts }) : [0, 20];
  const spread = d3.max([...pts, ...bboxPts], (p) => d3.geoDistance(p, center)) ?? 0;
  const base = Math.min(width, height) / 2 - 10;
  // Zoom so the furthest mention sits ~75% of the way to the rim (or show the whole globe).
  const k0 = Math.max(1, Math.min(14, 0.75 / Math.max(Math.sin(Math.min(spread, Math.PI / 2)), 0.06)));
  const projection = d3.geoOrthographic().clipAngle(90).precision(0.3).translate([width / 2, height / 2])
    .scale(base * k0).rotate([-center[0], -center[1], 0]);
  const path = d3.geoPath(projection);

  const sphere = svg.append("path").attr("class", "dd-sphere").attr("fill", "url(#dd-ocean)");
  const grat = svg.append("path").attr("class", "graticule");
  const land = svg.append("g");
  const focus = svg.append("g");
  const borders = svg.append("path").attr("class", "borders");
  const regions = svg.append("g");
  const routes = svg.append("g");
  const ptsG = svg.append("g");
  const labels = svg.append("g");

  const physical = r.geo.map((m, i) => ({ m, i })).filter(({ m }) => m.place.bbox && ["physical_region", "marine"].includes(m.place.feature_class));
  // Route arrows follow the story: origins → event/unspecified → destinations, in text order.
  const order: Role[] = ["origin", "route", "event", "unspecified", "destination"];
  const seq = r.geo.map((m, i) => ({ m, i })).filter(({ m }) => order.includes(roleOf(m)))
    .sort((a, b) => order.indexOf(roleOf(a.m)) - order.indexOf(roleOf(b.m)) || a.i - b.i);
  const hasMovement = r.geo.some((m) => ["origin", "destination", "route"].includes(roleOf(m)));
  const legs = hasMovement ? d3.pairs(seq).filter(([a, b]) => a.m.place.place_id !== b.m.place.place_id) : [];

  const visible = (p: [number, number]) => {
    const rot = projection.rotate();
    return d3.geoDistance(p, [-rot[0], -rot[1]]) < Math.PI / 2 - 0.01;
  };

  function draw() {
    sphere.attr("d", path({ type: "Sphere" }));
    grat.attr("d", path(d3.geoGraticule10()));
    land.selectAll<SVGPathElement, Feature>("path").data(LAND).join("path").attr("class", "dd-land").attr("d", path);
    focus.selectAll<SVGPathElement, Feature>("path").data(d.countries.features).join("path").attr("class", "dd-focus").attr("d", path as never)
      .on("mousemove", (ev: MouseEvent, f) => tooltip.show(`<div class="tt-title">${esc((f.properties as { country_name: string }).country_name)}</div><div class="tt-muted">country of a mentioned place</div>`, ev))
      .on("mouseleave", () => tooltip.hide());
    borders.attr("d", path(BORDERS));
    regions.selectAll<SVGPathElement, (typeof physical)[number]>("path").data(physical).join("path").attr("class", "dd-region")
      .attr("d", ({ m }) => {
        const [w, s, e, n] = m.place.bbox!;
        return path({ type: "Polygon", coordinates: [[[w, s], [w, n], [e, n], [e, s], [w, s]]] });
      });
    routes.selectAll<SVGPathElement, (typeof legs)[number]>("path").data(legs).join("path").attr("class", "dd-route")
      .attr("marker-end", "url(#dd-arrow)")
      .attr("d", ([a, b]) => path({ type: "LineString", coordinates: [[a.m.place.lon, a.m.place.lat], [b.m.place.lon, b.m.place.lat]] }));
    ptsG.selectAll<SVGPathElement, GeoMention>("path").data(r.geo).join("path")
      .attr("class", (m, i) => `dd-pt role-${roleOf(m)}${r.primary === i ? " primary" : ""}`)
      .attr("data-i", (_m, i) => i)
      .attr("d", (m, i) => d3.symbol(ROLE_SHAPE[roleOf(m)], r.primary === i ? 190 : 110)())
      .style("fill", (m) => ROLE_COLOR[roleOf(m)])
      .attr("display", (m) => (visible([m.place.lon, m.place.lat]) ? null : "none"))
      .attr("transform", (m) => {
        const xy = projection([m.place.lon, m.place.lat]) ?? [0, 0];
        return `translate(${xy[0]},${xy[1]})`;
      })
      .on("mouseenter", (_ev, m) => api.onHover(r.geo.indexOf(m)))
      .on("mousemove", (ev: MouseEvent, m) => tooltip.show(`<div class="tt-title">${esc(m.place.name)}</div>
          <div class="tt-muted">${ROLE_LABEL[roleOf(m)]}${m.role_cue ? ` · “${esc(m.role_cue)}”` : ""}</div>
          <div class="tt-row"><span>Coordinates</span><b>${m.place.lat.toFixed(4)}, ${m.place.lon.toFixed(4)}</b></div>
          ${m.time ? `<div class="tt-row"><span>Date</span><b>${esc(formatTemporal(m.time))}</b></div>` : ""}`, ev))
      .on("mouseleave", () => { tooltip.hide(); api.onHover(null); });
    const seen = new Set<string>();
    const lab = r.geo.map((m, i) => ({ m, i })).filter(({ m }) => !seen.has(m.place.place_id) && seen.add(m.place.place_id));
    labels.selectAll<SVGTextElement, (typeof lab)[number]>("text").data(lab).join("text").attr("class", "place-label")
      .text(({ m, i }) => `${i + 1} ${m.place.name}`)
      .attr("display", ({ m }) => (visible([m.place.lon, m.place.lat]) ? null : "none"))
      .attr("x", ({ m }) => (projection([m.place.lon, m.place.lat])?.[0] ?? 0) + 9)
      .attr("y", ({ m }) => (projection([m.place.lon, m.place.lat])?.[1] ?? 0) + 4);
  }

  // Drag rotates, wheel zooms.
  let k = 1;
  svg.call(d3.drag<SVGSVGElement, unknown>().on("drag", (ev) => {
    const rot = projection.rotate();
    const degPerPx = 180 / Math.PI / projection.scale(); // arc length at the globe's centre
    projection.rotate([rot[0] + ev.dx * degPerPx, Math.max(-89, Math.min(89, rot[1] - ev.dy * degPerPx)), 0]);
    draw();
  }));
  svg.on("wheel", (ev: WheelEvent) => {
    ev.preventDefault();
    k = Math.max(0.5, Math.min(8, k * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
    projection.scale(base * k0 * k);
    draw();
  }, { passive: false } as never);

  draw();
  api.highlight = (i) => {
    ptsG.selectAll<SVGPathElement, GeoMention>("path").classed("lit", (_m, j) => j === i).classed("faded", (_m, j) => i !== null && j !== i);
    if (i !== null) ptsG.selectAll<SVGPathElement, GeoMention>("path").filter((_m, j) => j === i).raise();
  };
  return api;
}

/* ------------------------------------------------------------------ time axis */

function drawAxis(host: HTMLElement, d: Drilldown, windowDays: number) {
  const r = d.record;
  const all = getState().records.filter((x) => x.dated !== false);
  const width = host.clientWidth || 600;
  const height = 92;
  const M = { l: 12, r: 12 };
  const ext = d3.extent(all.flatMap((x) => [new Date(x.timestamp.start ?? x.timestamp.value), new Date(x.timestamp.end ?? x.timestamp.value)])) as [Date?, Date?];
  const lo = d3.min([ext[0] ?? new Date(r.timestamp.start), new Date(r.timestamp.start)])!;
  const hi = d3.max([ext[1] ?? new Date(r.timestamp.end), new Date(r.timestamp.end)])!;
  const x = d3.scaleUtc().domain([d3.utcYear.offset(lo, -1), d3.utcYear.offset(hi, 1)]).range([M.l, width - M.r]).nice();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("class", "chart-svg")
    .attr("role", "img").attr("aria-label", "Record time on the timeline of all records");
  const y0 = 46;
  if (r.dated !== false) {
    const s = new Date(r.timestamp.start), e = new Date(r.timestamp.end);
    const ws = d3.utcDay.offset(s, -windowDays), we = d3.utcDay.offset(e, windowDays);
    svg.append("rect").attr("class", "dd-window-band").attr("x", x(ws)).attr("width", Math.max(0, x(we) - x(ws)))
      .attr("y", y0 - 18).attr("height", 36).attr("rx", 4);
  }
  svg.append("line").attr("class", "dd-axis-line").attr("x1", M.l).attr("x2", width - M.r).attr("y1", y0).attr("y2", y0);
  const others = new Set([...d.context.same_place_time, ...d.context.same_time].map((o) => o.id));
  svg.append("g").selectAll("circle").data(all.filter((x) => x.id !== r.id)).join("circle")
    .attr("class", (o) => `dd-tick${others.has(o.id) ? " near" : ""}`)
    .attr("cx", (o) => x(new Date(o.timestamp.value))).attr("cy", y0).attr("r", (o) => (others.has(o.id) ? 4 : 2.5))
    .on("mousemove", (ev: MouseEvent, o) => tooltip.show(`<div class="tt-title">${esc(formatTemporal(o.timestamp))}</div><div class="tt-snippet">${esc(o.content.slice(0, 90))}</div><div class="tt-foot">Click to open</div>`, ev))
    .on("mouseleave", () => tooltip.hide())
    .on("click", (_ev, o) => openRecord(o.id));
  if (r.dated !== false) {
    const s = new Date(r.timestamp.start), e = new Date(r.timestamp.end);
    const w = Math.max(6, x(e) - x(s));
    svg.append("rect").attr("class", "dd-self").attr("x", x(s) - (w === 6 ? 3 : 0)).attr("width", w).attr("y", y0 - 8).attr("height", 16).attr("rx", 3);
    r.temporal_mentions.forEach((t, i) => {
      const tx = x(new Date(t.value));
      svg.append("line").attr("class", "dd-tmark").attr("x1", tx).attr("x2", tx).attr("y1", y0 - 22).attr("y2", y0 - 9);
      svg.append("text").attr("class", "dd-tlabel").attr("x", tx).attr("y", y0 - 26 - (i % 2) * 11).attr("text-anchor", "middle").text(t.surface ?? "");
    });
  }
  svg.append("g").attr("class", "axis x").attr("transform", `translate(0,${y0 + 18})`)
    .call(d3.axisBottom(x).ticks(Math.max(3, width / 90)).tickSizeOuter(0));
}

function timeFacts(r: GeoRecord): string {
  const t = r.timestamp;
  const rows = [
    ["Event time", r.dated === false ? "unknown (no date given or found)" : `${esc(t.start.slice(0, 10))} → ${esc(t.end.slice(0, 10))}`],
    ["Granularity · source", `${esc(t.granularity)} · ${esc(t.source)}${t.surface ? ` (“${esc(t.surface)}”)` : ""}`],
    ["Document time", r.document_time ? esc(formatTemporal(r.document_time)) : '<span class="muted">not given</span>'],
    ["Ingested", esc(r.ingested_at.slice(0, 19).replace("T", " "))],
  ];
  if (r.temporal_mentions.length) rows.push(["Dates in text", r.temporal_mentions.map((m) => `<span class="pill time">${esc(m.surface ?? "")} → ${esc(formatTemporal(m))}</span>`).join(" ")]);
  return `<dl class="facets dd-facts">${rows.map(([k, v]) => `<div class="facet"><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
}

/* ------------------------------------------------------------------ concepts */

function conceptsHtml(r: GeoRecord): string {
  const cs = r.concepts ?? [];
  if (!cs.length) return `<div class="empty">No concepts extracted${r.kind !== "text" ? " (short record)" : ""}.</div>`;
  const groups = d3.groups(cs, (c) => c.type).sort((a, b) => Object.keys(CONCEPT_LABEL).indexOf(a[0]) - Object.keys(CONCEPT_LABEL).indexOf(b[0]));
  return groups.map(([type, items]) => `
    <div class="dd-cgroup"><div class="dd-ctype">${CONCEPT_LABEL[type]}</div>
      ${items.map((c) => {
        const contact = type === "PER" ? (r.contacts ?? []).find((k) => k.mentions.some((m) => m.text === c.text)) : undefined;
        return contact
          ? `<a class="chip term c-per hl person" href="#/contacts/${encodeURIComponent(contact.contact_id)}" title="Open contact">${esc(contact.name)}${c.count > 1 ? `<span>${c.count}</span>` : ""}</a>`
          : `<button type="button" class="chip term c-${type.toLowerCase()}" data-concept="${esc(c.text)}">${esc(c.text)}${c.count > 1 ? `<span>${c.count}</span>` : ""}</button>`;
      }).join("")}
    </div>`).join("");
}

async function kwic(el: HTMLElement, term: string, self: string) {
  const list = el.querySelector<HTMLElement>("#dd-kwic")!;
  list.innerHTML = `<li class="muted empty-hit">Searching “${esc(term)}”…</li>`;
  const hits = await api.concordance(term);
  list.innerHTML = hits.length
    ? hits.map((h) => `<li data-open="${esc(h.record_id)}" tabindex="0" class="${h.record_id === self ? "self" : ""}">
        <div class="conc-meta"><span>${esc(h.timestamp.slice(0, 10))}</span><span class="pill">${esc(h.language)}</span>${h.record_id === self ? '<span class="pill">this record</span>' : ""}</div>
        <div class="conc-line" dir="auto"><span class="l">${esc(h.left)}</span> <mark>${esc(h.match)}</mark> <span class="r">${esc(h.right)}</span></div></li>`).join("")
    : `<li class="muted empty-hit">“${esc(term)}” only occurs as a multi-token or non-indexed form.</li>`;
  list.querySelectorAll<HTMLElement>("[data-open]").forEach((n) => n.addEventListener("click", () => n.dataset.open !== self && openRecord(n.dataset.open!)));
}

/* ------------------------------------------------------------------ context */

function contextHtml(d: Drilldown, windowDays: number): string {
  const c = d.context;
  const yrs = Math.round(windowDays / 365.25);
  const item = (o: RecordSummary, extra: string) => `
    <li data-open="${esc(o.id)}" tabindex="0">
      <div class="conc-meta"><span class="dot" style="background:${kindColor(o.kind)}"></span><span>${o.dated ? esc(formatTemporal(o.timestamp)) : "undated"}</span><span class="pill">${esc(o.language)}</span><span class="spacer"></span>${extra}</div>
      <div class="rel-title" dir="auto">${esc(o.content)}</div>
      ${o.places.length ? `<div class="muted small">${esc(o.places.join(" · "))}</div>` : ""}
      ${d.paths[o.id]?.length ? `<div class="dd-path">${pathHtml(d.paths[o.id])}</div>` : ""}
    </li>`;
  const sec = (title: string, hint: string, body: string) => `<h3 class="sub">${title} <span class="muted">${hint}</span></h3>${body}`;
  const list = (xs: string[], empty: string) => (xs.length ? `<ol class="related dd-related">${xs.join("")}</ol>` : `<div class="muted small dd-none">${empty}</div>`);
  return [
    sec("Same place, same time", `shared country · ±${yrs} yr`, list(c.same_place_time.map((o) => item(o,
      `<b class="num">${Math.round(o.score.weight * 100)}%</b>`)), "Nothing else in these countries within the window.")),
    sec("Same time, anywhere", `±${yrs} yr, by gap`, list(c.same_time.map((o) => item(o,
      `<span class="muted num">${o.gap_days === 0 ? "overlaps" : `${fmtGap(o.gap_days)} apart`}</span>`)), "No other dated records in the window.")),
    sec("Same concepts elsewhere", "shared entities / terms / labels", list(c.same_concepts.map((o) => item(o,
      `<span class="muted">${esc(o.shared.join(", "))}</span>`)), "No other record shares a concept.")),
    sec("Similar nearby", `meaning · within ${num(d.params.radius_km)} km of the primary place`, list(c.nearby_semantic.map((o) => item(o,
      `<b class="num">${Math.round(o.similarity * 100)}%</b>`)), "No semantically similar records near this place.")),
  ].join("");
}

function fmtGap(days: number): string {
  if (days < 60) return `${Math.round(days)} d`;
  if (days < 730) return `${Math.round(days / 30.44)} mo`;
  return `${(days / 365.25).toFixed(1)} yr`;
}

function pathHtml(steps: PathStep[]): string {
  return `<span class="muted">why:</span> ` + steps.map((s, i) => `${i ? `<span class="dd-via">${esc((s.via ?? "").toLowerCase().replace("_", " "))}</span>` : ""}<span class="dd-step t-${s.type}">${esc(s.type === "record" ? "record" : s.label)}</span>`).join("");
}
