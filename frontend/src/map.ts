import * as d3 from "d3";
import * as topojson from "topojson-client";
import type { Feature, FeatureCollection, Geometry, MultiLineString } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import world110 from "world-atlas/countries-110m.json";
import world50 from "world-atlas/countries-50m.json";
import { filteredRecords, getState, mentionPoints, setFilters, setState, subscribe } from "./state";
import type { CountryAggregate, GeoRecord, GraphLink, MentionPoint } from "./types";
import { openRecord } from "./drilldown";
import { KINDS, KIND_LABEL, anchorOf, esc, formatTemporal, kindColor, num, pct, tooltip } from "./util";

type CountryFeature = Feature<Geometry, { name: string }> & { id?: string };
type Topo = Topology<{ countries: GeometryCollection<{ name: string }> }>;
type Detail = { countries: CountryFeature[]; borders: MultiLineString; coast: MultiLineString };

function detail(raw: unknown): Detail {
  const t = raw as Topo;
  return {
    countries: (topojson.feature(t, t.objects.countries) as FeatureCollection<Geometry, { name: string }>).features as CountryFeature[],
    borders: topojson.mesh(t, t.objects.countries, (a, b) => a !== b) as MultiLineString,
    coast: topojson.mesh(t, t.objects.countries, (a, b) => a === b) as MultiLineString,
  };
}
const LOW = detail(world110);
const HIGH = detail(world50);
const HIGH_BY_ID = new Map(HIGH.countries.map((c) => [String(c.id), c]));

/** Sequential blue ramp (steps 150 -> 550) for mention density. */
const DENSITY = ["#b7d3f6", "#86b6ef", "#5598e7", "#2a78d6", "#1c5cab"];

type Mode = "globe" | "flat";

export function initMap(container: HTMLElement, legend: HTMLElement): { setMode: (m: Mode) => void } {
  const host = d3.select(container).append("div").attr("class", "world-host");
  const svg = host.append("svg").attr("class", "map-svg").attr("role", "img")
    .attr("aria-label", "World map of resolved geographic mentions");

  // ---------- defs: lighting, atmosphere, glow ----------
  const defs = svg.append("defs");
  const ocean = defs.append("radialGradient").attr("id", "g-ocean").attr("cx", "38%").attr("cy", "32%").attr("r", "75%");
  ocean.append("stop").attr("offset", "0%").attr("style", "stop-color: var(--ocean-hi)");
  ocean.append("stop").attr("offset", "62%").attr("style", "stop-color: var(--ocean)");
  ocean.append("stop").attr("offset", "100%").attr("style", "stop-color: var(--ocean-deep)");
  const shade = defs.append("radialGradient").attr("id", "g-shade").attr("cx", "36%").attr("cy", "30%").attr("r", "78%");
  shade.append("stop").attr("offset", "0%").attr("style", "stop-color: #fff; stop-opacity: var(--spec)");
  shade.append("stop").attr("offset", "45%").attr("style", "stop-color: #fff; stop-opacity: 0");
  shade.append("stop").attr("offset", "82%").attr("style", "stop-color: #000; stop-opacity: 0");
  shade.append("stop").attr("offset", "100%").attr("style", "stop-color: #000; stop-opacity: var(--limb)");
  const atmo = defs.append("radialGradient").attr("id", "g-atmo").attr("gradientUnits", "userSpaceOnUse");
  atmo.append("stop").attr("class", "atmo-0").attr("style", "stop-color: var(--atmo); stop-opacity: 0.55");
  atmo.append("stop").attr("class", "atmo-1").attr("style", "stop-color: var(--atmo); stop-opacity: 0.12");
  atmo.append("stop").attr("offset", "100%").attr("style", "stop-color: var(--atmo); stop-opacity: 0");
  const glow = defs.append("filter").attr("id", "f-glow").attr("x", "-100%").attr("y", "-100%").attr("width", "300%").attr("height", "300%");
  glow.append("feGaussianBlur").attr("stdDeviation", 2.2).attr("result", "b");
  const gm = glow.append("feMerge");
  gm.append("feMergeNode").attr("in", "b");
  gm.append("feMergeNode").attr("in", "SourceGraphic");
  const relief = defs.append("filter").attr("id", "f-relief").attr("x", "-5%").attr("y", "-5%").attr("width", "110%").attr("height", "110%");
  relief.append("feDropShadow").attr("dx", 0).attr("dy", 0.8).attr("stdDeviation", 1.1).attr("style", "flood-color: var(--relief); flood-opacity: 0.5");

  // ---------- layers ----------
  const halo = svg.append("circle").attr("class", "halo").attr("fill", "url(#g-atmo)");
  const sphere = svg.append("path").attr("class", "sphere").attr("fill", "url(#g-ocean)");
  const graticule = svg.append("path").attr("class", "graticule");
  const landG = svg.append("g").attr("class", "countries").attr("filter", "url(#f-relief)");
  const coast = svg.append("path").attr("class", "coast");
  const borders = svg.append("path").attr("class", "borders");
  const night = svg.append("g").attr("class", "night");
  const shadeP = svg.append("path").attr("class", "shade").attr("fill", "url(#g-shade)");
  const rim = svg.append("path").attr("class", "rim");
  const arcs = svg.append("g").attr("class", "arcs");
  const links = svg.append("g").attr("class", "links");
  const points = svg.append("g").attr("class", "points").attr("filter", "url(#f-glow)");
  const previewLayer = svg.append("g").attr("class", "preview-points");
  const labels = svg.append("g").attr("class", "place-labels");

  // ---------- controls ----------
  const ctrls = host.append("div").attr("class", "map-ctrls");
  const btnSpin = ctrls.append("button").attr("type", "button").attr("class", "icon-btn").attr("title", "Auto-rotate")
    .attr("aria-pressed", String(!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)).html("⟳");
  const btnNight = ctrls.append("button").attr("type", "button").attr("class", "icon-btn").attr("title", "Day / night terminator")
    .attr("aria-pressed", "true").html("☾");
  const btnArcs = ctrls.append("button").attr("type", "button").attr("class", "icon-btn").attr("title", "Proximity arcs")
    .attr("aria-pressed", "true").html("⌒");
  const btnReset = ctrls.append("button").attr("type", "button").attr("class", "icon-btn").attr("title", "Reset view").html("⌂");

  let mode: Mode = "globe";
  let width = 0;
  let height = 0;
  let baseScale = 1;
  let baseTranslate: [number, number] = [0, 0];
  let zoomK = 1;
  let rotate: [number, number, number] = [-10, -25, 0];
  // Respect "reduce motion": no auto-rotation (also makes the globe deterministic for visual tests).
  let spinning = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let showNight = true;
  let showArcs = true;
  let interacting = false;
  let lastInteraction = 0;
  let quality: "low" | "high" = "high";
  let projection: d3.GeoProjection = d3.geoOrthographic();
  let path = d3.geoPath(projection);
  let byIso = new Map<string, CountryAggregate>();
  let color = d3.scaleQuantize<string>().domain([1, 2]).range(DENSITY);
  let pointData: MentionPoint[] = [];

  function makeProjection() {
    projection = mode === "globe" ? d3.geoOrthographic().clipAngle(90).precision(0.4) : d3.geoEqualEarth().precision(0.3);
    path = d3.geoPath(projection);
    svg.classed("is-globe", mode === "globe").classed("is-flat", mode === "flat");
  }

  function fit() {
    width = container.clientWidth;
    height = container.clientHeight;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const pad = mode === "globe" ? Math.min(width, height) * 0.055 : 10;
    projection.rotate(mode === "globe" ? rotate : [rotate[0], 0, 0]);
    projection.fitExtent([[pad, pad], [width - pad, height - pad]], { type: "Sphere" });
    baseScale = projection.scale();
    baseTranslate = projection.translate();
    applyZoom();
  }

  function applyZoom(t: d3.ZoomTransform = d3.zoomTransform(svg.node()!)) {
    zoomK = t.k;
    projection.scale(baseScale * t.k);
    if (mode === "flat") projection.translate([baseTranslate[0] * t.k + t.x, baseTranslate[1] * t.k + t.y]);
    else projection.translate(baseTranslate);
  }

  // ---------- interaction: d3.zoom drives scale; drag rotates the globe / pans the map ----------
  let prev = { x: 0, y: 0 };
  const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.8, 40])
    .on("start", (ev) => {
      interacting = true;
      quality = "low";
      prev = { x: ev.transform.x, y: ev.transform.y };
    })
    .on("zoom", (ev: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
      if (mode === "globe") {
        const src = ev.sourceEvent as Event | null;
        if (src && src.type !== "wheel") {
          const s = 0.25 / zoomK;
          rotate = [rotate[0] + (ev.transform.x - prev.x) * s, Math.max(-85, Math.min(85, rotate[1] - (ev.transform.y - prev.y) * s)), 0];
          projection.rotate(rotate);
        }
        prev = { x: ev.transform.x, y: ev.transform.y };
      }
      applyZoom(ev.transform);
      draw();
    })
    .on("end", () => {
      interacting = false;
      lastInteraction = performance.now();
      quality = "high";
      draw();
    });
  svg.call(zoom).on("dblclick.zoom", null);

  function resetView() {
    rotate = [-10, -25, 0];
    projection.rotate(mode === "globe" ? rotate : [0, 0, 0]);
    svg.transition().duration(700).call(zoom.transform, d3.zoomIdentity);
  }

  // ---------- geometry rendering ----------
  function countriesFor(): CountryFeature[] {
    return quality === "low" ? LOW.countries : HIGH.countries;
  }

  function visible(lon: number, lat: number): boolean {
    if (mode !== "globe") return true;
    const r = projection.rotate();
    return d3.geoDistance([lon, lat], [-r[0], -r[1]]) < Math.PI / 2 - 0.02;
  }

  function draw() {
    const R = projection.scale();
    const [cx, cy] = projection.translate();
    if (mode === "globe") {
      halo.attr("cx", cx).attr("cy", cy).attr("r", R * 1.16).attr("display", null);
      atmo.attr("cx", cx).attr("cy", cy).attr("r", R * 1.16);
      atmo.select(".atmo-0").attr("offset", `${(100 * R) / (R * 1.16) - 0.5}%`);
      atmo.select(".atmo-1").attr("offset", `${(100 * R * 1.05) / (R * 1.16)}%`);
    } else halo.attr("display", "none");
    const sph = path({ type: "Sphere" });
    sphere.attr("d", sph);
    shadeP.attr("d", sph).attr("display", mode === "globe" ? null : "none");
    rim.attr("d", sph);
    graticule.attr("d", path(d3.geoGraticule10()));

    const data = countriesFor();
    landG.selectAll<SVGPathElement, CountryFeature>("path.country")
      .data(data, (d) => String(d.id ?? d.properties.name))
      .join((enter) => enter.append("path").attr("class", "country").call(bindCountry))
      .attr("d", path)
      .attr("fill", (d) => {
        const a = byIso.get(String(d.id));
        return a ? color(a.mentions) : null;
      })
      .classed("has-data", (d) => byIso.has(String(d.id)))
      .classed("selected", (d) => !!getState().filters.country && byIso.get(String(d.id))?.country_code === getState().filters.country);
    const det = quality === "low" ? LOW : HIGH;
    coast.attr("d", path(det.coast));
    borders.attr("d", path(det.borders));

    drawNight();
    drawPoints();
    drawArcs();
    drawLinks();
    drawPreview();
    drawLabels();
    btnReset.classed("hidden", Math.abs(zoomK - 1) < 0.01 && mode === "flat");
  }

  function bindCountry(sel: d3.Selection<SVGPathElement, CountryFeature, SVGGElement, unknown>) {
    sel.on("mousemove", (ev: MouseEvent, d) => {
      const agg = byIso.get(String(d.id));
      const name = HIGH_BY_ID.get(String(d.id))?.properties.name ?? d.properties.name;
      tooltip.show(
        `<div class="tt-title">${esc(name)}</div>` +
          (agg
            ? `<div class="tt-row"><span>Mentions</span><b>${num(agg.mentions)}</b></div>
               <div class="tt-row"><span>Records</span><b>${num(agg.records)}</b></div>
               <div class="tt-row"><span>Mean confidence</span><b>${pct(agg.mean_confidence)}</b></div>
               <div class="tt-row"><span>Languages</span><b>${esc(agg.languages.join(", "))}</b></div>
               <div class="tt-foot">Click to filter by country</div>`
            : `<div class="tt-muted">No mentions</div>`),
        ev,
      );
    })
      .on("mouseleave", () => tooltip.hide())
      .on("click", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        const agg = byIso.get(String(d.id));
        if (!agg) return;
        const f = getState().filters;
        setFilters({ country: f.country === agg.country_code ? null : agg.country_code });
      });
  }

  // ---------- day / night ----------
  function subsolar(date = new Date()): [number, number] {
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    const day = (date.getTime() - start) / 864e5;
    const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (day + 10));
    const hours = date.getUTCHours() + date.getUTCMinutes() / 60;
    return [(12 - hours) * 15, decl];
  }

  function drawNight() {
    const [lon, lat] = subsolar();
    const anti: [number, number] = [lon + 180, -lat];
    // Night core plus civil / nautical / astronomical twilight bands.
    // Many thin, faint bands from 96° to 72° give a smooth terminator gradient.
    const bands = showNight ? d3.range(96, 71, -2) : [];
    night.selectAll<SVGPathElement, number>("path").data(bands).join("path")
      .attr("d", (r) => path(d3.geoCircle().center(anti).radius(r).precision(2)()));
  }

  // ---------- points ----------
  const radius = (m: MentionPoint) => 2.6 + 3.6 * m.mention.confidence;

  function updatePointData() {
    const s = getState();
    pointData = mentionPoints(filteredRecords(s));
    pointData.sort((a, b) => Number(a.record.id === s.selectedId) - Number(b.record.id === s.selectedId) || a.mention.confidence - b.mention.confidence);
    points.selectAll<SVGCircleElement, MentionPoint>("circle")
      .data(pointData, (d) => `${d.record.id}:${d.index}`)
      .join(
        (enter) => enter.append("circle").attr("class", "pt").attr("r", 0)
          .call((e) => e.transition().duration(500).ease(d3.easeBackOut).attr("r", (d) => ptR(d))),
        (update) => update,
        (exit) => exit.transition().duration(200).attr("r", 0).remove(),
      )
      .attr("fill", (d) => kindColor(d.record.kind))
      .classed("selected", (d) => d.record.id === s.selectedId)
      .classed("dimmed", (d) => !!s.selectedId && d.record.id !== s.selectedId)
      .on("mousemove", (ev: MouseEvent, d) => tooltip.show(mentionTooltip(d), ev))
      .on("mouseleave", () => tooltip.hide())
      .on("dblclick", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        openRecord(d.record.id);
      })
      .on("click", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        setState({ selectedId: getState().selectedId === d.record.id ? null : d.record.id });
      })
      .order();
  }

  const ptR = (d: MentionPoint) => radius(d) * Math.min(2, Math.pow(zoomK, 0.35));

  function drawPoints() {
    points.selectAll<SVGCircleElement, MentionPoint>("circle").each(function (d) {
      const p = d.mention.place;
      const on = visible(p.lon, p.lat);
      const xy = on ? projection([p.lon, p.lat]) : null;
      const el = d3.select(this);
      if (!xy) el.attr("display", "none");
      else el.attr("display", null).attr("cx", xy[0]).attr("cy", xy[1]);
      if (!el.attr("r") || Number(el.attr("r")) > 0) el.attr("r", ptR(d));
    });
  }

  // ---------- great-circle links ----------
  function recordLinks(rec: GeoRecord | null): [number, number][][] {
    const out: [number, number][][] = [];
    if (rec) for (let i = 1; i < rec.geo.length; i++) {
      const a = rec.geo[i - 1].place;
      const b = rec.geo[i].place;
      out.push([[a.lon, a.lat], [b.lon, b.lat]]);
    }
    return out;
  }

  function drawLinks() {
    const s = getState();
    const rec = s.records.find((r) => r.id === s.selectedId) ?? null;
    links.selectAll<SVGPathElement, [number, number][]>("path").data(recordLinks(rec)).join("path").attr("class", "link")
      .attr("d", (d) => path({ type: "LineString", coordinates: d }));
  }

  function drawArcs() {
    const s = getState();
    const g = s.proxGraph;
    if (!showArcs || !g) {
      arcs.selectAll("path").remove();
      return;
    }
    const byId = new Map(s.records.map((r) => [r.id, r]));
    const shown = new Set(filteredRecords(s).map((r) => r.id));
    const data = g.links.filter((l) => l.type === "PROXIMITY").map((l) => {
      const a = byId.get(l.source.slice(7));
      const b = byId.get(l.target.slice(7));
      return { l, a, b };
    }).filter((d) => d.a && d.b && anchorOf(d.a) && anchorOf(d.b) && shown.has(d.a.id) && shown.has(d.b.id)) as { l: GraphLink; a: GeoRecord; b: GeoRecord }[];
    arcs.selectAll<SVGPathElement, (typeof data)[number]>("path").data(data, (d) => `${d.a.id}-${d.b.id}`).join("path")
      .attr("class", "arc")
      .classed("hot", (d) => !!s.selectedId && (d.a.id === s.selectedId || d.b.id === s.selectedId))
      .attr("stroke-opacity", (d) => 0.15 + 0.6 * d.l.weight)
      .attr("stroke-width", (d) => 0.6 + 1.8 * d.l.weight)
      .attr("d", (d) => {
        const a = anchorOf(d.a)!, b = anchorOf(d.b)!;
        return path({ type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] });
      })
      .on("mousemove", (ev: MouseEvent, d) => tooltip.show(arcTooltip(d.l, d.a, d.b), ev))
      .on("mouseleave", () => tooltip.hide());
  }

  function drawPreview() {
    const p = getState().preview;
    const data = p ? p.geo.map((mention, index) => ({ record: p, mention, index })) : [];
    previewLayer.selectAll<SVGPathElement, [number, number][]>("path").data(recordLinks(p)).join("path").attr("class", "link preview")
      .attr("d", (d) => path({ type: "LineString", coordinates: d }));
    previewLayer.selectAll<SVGCircleElement, MentionPoint>("circle.pv").data(data).join("circle").attr("class", "pv")
      .each(function (d) {
        const pl = d.mention.place;
        const xy = visible(pl.lon, pl.lat) ? projection([pl.lon, pl.lat]) : null;
        d3.select(this).attr("display", xy ? null : "none").attr("cx", xy?.[0] ?? 0).attr("cy", xy?.[1] ?? 0);
      })
      .attr("r", 8)
      .on("mousemove", (ev: MouseEvent, d) => tooltip.show(mentionTooltip(d, true), ev))
      .on("mouseleave", () => tooltip.hide());
  }

  function drawLabels() {
    const s = getState();
    const rec = s.preview ?? s.records.find((r) => r.id === s.selectedId) ?? null;
    const seen = new Set<string>();
    const data = (rec?.geo ?? []).filter((m) => !seen.has(m.place.place_id) && seen.add(m.place.place_id));
    labels.selectAll<SVGTextElement, (typeof data)[number]>("text").data(data, (d) => d.place.place_id).join("text")
      .attr("class", "place-label")
      .text((d) => d.place.name)
      .each(function (d) {
        const xy = visible(d.place.lon, d.place.lat) ? projection([d.place.lon, d.place.lat]) : null;
        d3.select(this).attr("display", xy ? null : "none").attr("x", (xy?.[0] ?? 0) + 9).attr("y", (xy?.[1] ?? 0) + 4);
      });
  }

  // ---------- choropleth / legend ----------
  function updateChoropleth() {
    const s = getState();
    byIso = new Map(s.countries.filter((c) => c.iso_n3).map((c) => [String(c.iso_n3).padStart(3, "0"), c]));
    const max = d3.max(s.countries, (c) => c.mentions) ?? 1;
    color = d3.scaleQuantize<string>().domain([1, Math.max(max, 2)]).range(DENSITY);
    legend.innerHTML =
      KINDS.map((kd) => `<span class="legend-item"><span class="dot" style="background:${kindColor(kd)}"></span>${KIND_LABEL[kd]}</span>`).join("") +
      `<span class="legend-item"><span class="arc-swatch"></span>proximity</span>` +
      `<span class="legend-item ramp"><span class="ramp-label">1</span>${DENSITY.map((c) => `<span class="ramp-step" style="background:${c}"></span>`).join("")}<span class="ramp-label">${num(max)}</span><span class="legend-caption">mentions / country</span></span>`;
  }

  // ---------- camera ----------
  function focusOn(rec: GeoRecord | null) {
    if (!rec?.geo.length) return;
    const pts = rec.geo.map((m) => [m.place.lon, m.place.lat] as [number, number]);
    const c = d3.geoCentroid({ type: "MultiPoint", coordinates: pts });
    const spread = d3.max(pts, (p) => d3.geoDistance(p, c)) ?? 0;
    const k = Math.max(1, Math.min(6, 0.9 / Math.max(spread, 0.05)));
    if (mode === "globe") {
      spinning = false;
      btnSpin.attr("aria-pressed", "false");
      const from = projection.rotate() as [number, number, number];
      const ri = d3.interpolate(from, [-c[0], -c[1], 0] as [number, number, number]);
      const k0 = zoomK;
      d3.transition().duration(1200).ease(d3.easeCubicInOut).tween("rotate", () => (t) => {
        rotate = ri(t) as [number, number, number];
        projection.rotate(rotate);
        const kk = k0 + (Math.min(k, 3) - k0) * t;
        svg.property("__zoom", d3.zoomIdentity.scale(kk));
        applyZoom(d3.zoomIdentity.scale(kk));
        quality = t < 1 ? "low" : "high";
        draw();
      });
    } else {
      const xy = projection.scale(baseScale).translate(baseTranslate)(c)!;
      const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-xy[0], -xy[1]);
      svg.transition().duration(900).call(zoom.transform, t);
    }
  }

  // ---------- auto-rotation ----------
  d3.timer((elapsed) => {
    if (mode !== "globe" || !spinning || interacting || performance.now() - lastInteraction < 2500 || document.hidden) return;
    rotate = [rotate[0] + 0.06, rotate[1], 0];
    projection.rotate(rotate);
    quality = "low";
    draw();
    if (elapsed % 1000 < 20) quality = "high";
  });

  btnSpin.on("click", () => {
    spinning = !spinning;
    btnSpin.attr("aria-pressed", String(spinning));
    if (!spinning) { quality = "high"; draw(); }
  });
  btnNight.on("click", () => {
    showNight = !showNight;
    btnNight.attr("aria-pressed", String(showNight));
    drawNight();
  });
  btnArcs.on("click", () => {
    showArcs = !showArcs;
    btnArcs.attr("aria-pressed", String(showArcs));
    drawArcs();
  });
  btnReset.on("click", resetView);
  svg.on("click", () => getState().selectedId && setState({ selectedId: null }));
  window.setInterval(() => showNight && drawNight(), 60_000);

  function setMode(m: Mode) {
    mode = m;
    btnSpin.classed("hidden", m !== "globe");
    svg.property("__zoom", d3.zoomIdentity);
    makeProjection();
    fit();
    quality = "high";
    draw();
  }

  new ResizeObserver(() => {
    if (!container.clientWidth) return;
    fit();
    draw();
  }).observe(container);

  subscribe((s, changed) => {
    if (changed.has("countries") || changed.has("filters")) updateChoropleth();
    if (changed.has("records") || changed.has("filters") || changed.has("selectedId") || changed.has("near")) {
      updatePointData();
      draw();
    } else if (changed.has("countries") || changed.has("proxGraph")) draw();
    if (changed.has("preview")) {
      draw();
      if (s.preview) focusOn(s.preview);
    }
    if (changed.has("selectedId") && s.selectedId) focusOn(s.records.find((r) => r.id === s.selectedId) ?? null);
  });
  window.addEventListener("geomap:focus", (e) => focusOn((e as CustomEvent<GeoRecord>).detail));

  makeProjection();
  fit();
  updateChoropleth();
  updatePointData();
  draw();
  return { setMode };
}

function mentionTooltip(d: MentionPoint, preview = false): string {
  const { mention: m, record: r } = d;
  const p = m.place;
  const where = [p.admin1, p.country_name].filter(Boolean).join(", ");
  const snippet = r.content.length > 120 ? `${r.content.slice(0, 117)}…` : r.content;
  return `
    <div class="tt-title">${esc(p.name)}${preview ? ' <span class="tt-badge">preview</span>' : ""}</div>
    <div class="tt-muted">${esc(where)} · ${esc(p.feature_class.replace("_", " "))}</div>
    <div class="tt-row"><span>Surface</span><b>“${esc(m.surface)}”</b></div>
    ${r.contacts?.length ? `<div class="tt-row"><span>People</span><b class="tt-people">${r.contacts.map((c) => esc(c.name)).join(", ")}</b></div>` : ""}
    <div class="tt-row"><span>Confidence</span><b>${pct(m.confidence)} · ${esc(m.match_type)}</b></div>
    <div class="tt-row"><span>Time</span><b>${esc(formatTemporal(r.timestamp))}</b></div>
    <div class="tt-row"><span>Language</span><b>${esc(r.language.name ?? r.language.code)}</b></div>
    <div class="tt-row"><span>Coordinates</span><b>${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}</b></div>
    <div class="tt-snippet">${esc(snippet)}</div>
    <div class="tt-foot">Click to select · double-click to open</div>`;
}

export function arcTooltip(l: GraphLink, a: GeoRecord, b: GeoRecord): string {
  const yrs = (l.dt_days ?? 0) / 365.25;
  const dt = yrs >= 1 ? `${yrs.toFixed(1)} yr` : `${Math.round(l.dt_days ?? 0)} d`;
  const bar = (v = 0) => `<span class="conf"><span class="conf-bar" style="width:${v * 100}%"></span></span>`;
  return `
    <div class="tt-title">Proximity ${pct(l.weight)}</div>
    <div class="tt-muted">${esc(a.content.slice(0, 40))}… ↔ ${esc(b.content.slice(0, 40))}…</div>
    <div class="tt-row"><span>Time (Δ ${dt})</span><b>${bar(l.time)} ${pct(l.time ?? 0)}</b></div>
    <div class="tt-row"><span>Language (${esc(l.lang_relation ?? "")})</span><b>${bar(l.lang)} ${pct(l.lang ?? 0)}</b></div>
    <div class="tt-row"><span>Geo</span><b>${bar(l.geo)} ${pct(l.geo ?? 0)}</b></div>
    <div class="tt-row"><span>Linguistic × time</span><b>${pct(l.ling_time ?? 0)}</b></div>`;
}
