import * as d3 from "d3";
import * as topojson from "topojson-client";
import type { Feature, FeatureCollection, Geometry, MultiLineString } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import world110 from "world-atlas/countries-110m.json";
import world50 from "world-atlas/countries-50m.json";
import { esc, num, tooltip } from "../util";
import { getState, setState, subscribe, visibleDots } from "./state";
import type { Dot, Entity } from "./types";

/**
 * The speaker globe. The rendering engine — lighting, atmosphere, terminator,
 * d3.zoom-driven rotate/zoom, globe ⇄ flat — is GeoCRM's map.ts; what it draws
 * is new: one dot per speaker, the pending pin of a speaker being created, and
 * the places NER found in the selected speaker's record, linked to their dot.
 *
 * A click on empty map means what `mode` says: deselect (browse), drop the new
 * speaker's pin (add), or move the selected speaker (move).
 */

type CountryFeature = Feature<Geometry, { name: string }> & { id?: string };
type Topo = Topology<{ countries: GeometryCollection<{ name: string }> }>;
type Detail = { countries: CountryFeature[]; borders: MultiLineString; coast: MultiLineString };
type Mode = "globe" | "flat";

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

export const dotColor = (d: Dot): string => (d.properties.native_english ? "var(--series-1)" : "var(--series-2)");

export interface SpeakerMap {
  setMode: (m: Mode) => void;
  focus: (lon: number, lat: number, k?: number) => void;
}

export function initSpeakerMap(container: HTMLElement, legend: HTMLElement,
                               onPlace: (lon: number, lat: number) => void): SpeakerMap {
  const host = d3.select(container).append("div").attr("class", "world-host");
  const svg = host.append("svg").attr("class", "map-svg").attr("role", "img")
    .attr("aria-label", "Globe of speakers, one dot per speaker at their birthplace");

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
  const links = svg.append("g").attr("class", "links");
  const dotsG = svg.append("g").attr("class", "spk-dots");
  const placesG = svg.append("g").attr("class", "spk-places");
  const pinG = svg.append("g").attr("class", "spk-pin");

  // ---------- controls ----------
  const ctrls = host.append("div").attr("class", "map-ctrls");
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const btnSpin = ctrls.append("button").attr("type", "button").attr("class", "icon-btn").attr("title", "Auto-rotate")
    .attr("aria-pressed", String(!reduce)).html("⟳");
  const btnNight = ctrls.append("button").attr("type", "button").attr("class", "icon-btn").attr("title", "Day / night terminator")
    .attr("aria-pressed", "true").html("☾");
  const btnReset = ctrls.append("button").attr("type", "button").attr("class", "icon-btn").attr("title", "Reset view").html("⌂");
  const hint = host.append("div").attr("class", "spk-hint").attr("role", "status").attr("hidden", true);

  let mode: Mode = "globe";
  let width = 0;
  let height = 0;
  let baseScale = 1;
  let baseTranslate: [number, number] = [0, 0];
  let zoomK = 1;
  let rotate: [number, number, number] = [96, -32, 0];
  let spinning = !reduce;
  let showNight = true;
  let interacting = false;
  let lastInteraction = 0;
  let quality: "low" | "high" = "high";
  let projection: d3.GeoProjection = d3.geoOrthographic();
  let path = d3.geoPath(projection);

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

  // ---------- interaction ----------
  let prev = { x: 0, y: 0 };
  const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.8, 60])
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

  // A click on the map itself (not on a dot): place, or deselect.
  svg.on("click", (ev: MouseEvent) => {
    const s = getState();
    if (s.mode === "browse") {
      if (s.selectedId != null) setState({ selectedId: null, detail: null });
      return;
    }
    const [x, y] = d3.pointer(ev, svg.node());
    const ll = projection.invert?.([x, y]);
    if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return;
    if (mode === "globe" && d3.geoDistance(ll, [-projection.rotate()[0], -projection.rotate()[1]]) > Math.PI / 2) return;
    onPlace(+ll[0].toFixed(5), +ll[1].toFixed(5));
  });

  function resetView() {
    rotate = [96, -32, 0];
    projection.rotate(mode === "globe" ? rotate : [0, 0, 0]);
    svg.transition().duration(700).call(zoom.transform, d3.zoomIdentity);
  }

  // ---------- rendering ----------
  function visible(lon: number, lat: number): boolean {
    if (mode !== "globe") return true;
    const r = projection.rotate();
    return d3.geoDistance([lon, lat], [-r[0], -r[1]]) < Math.PI / 2 - 0.02;
  }

  function place(sel: d3.Selection<SVGGraphicsElement, [number, number], SVGGElement, unknown>) {
    sel.each(function (ll) {
      const xy = visible(ll[0], ll[1]) ? projection(ll) : null;
      const el = d3.select(this);
      if (!xy) el.attr("display", "none");
      else el.attr("display", null).attr("transform", `translate(${xy[0]},${xy[1]})`);
    });
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
    const det = quality === "low" ? LOW : HIGH;
    landG.selectAll<SVGPathElement, CountryFeature>("path.country")
      .data(det.countries, (d) => String(d.id ?? d.properties.name))
      .join("path").attr("class", "country").attr("d", path);
    coast.attr("d", path(det.coast));
    borders.attr("d", path(det.borders));
    drawNight();
    drawDots();
    drawPlaces();
    drawPin();
  }

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
    const bands = showNight ? d3.range(96, 71, -2) : [];
    night.selectAll<SVGPathElement, number>("path").data(bands).join("path")
      .attr("d", (r) => path(d3.geoCircle().center(anti).radius(r).precision(2)()));
  }

  // ---------- speaker dots ----------
  const dotR = (d: Dot) => (d.properties.recordings ? 3.6 : 2.4) * Math.min(2.2, Math.pow(zoomK, 0.4));

  function updateDots() {
    const s = getState();
    const data = visibleDots(s).slice().sort((a, b) =>
      Number(a.properties.id === s.selectedId) - Number(b.properties.id === s.selectedId));
    dotsG.selectAll<SVGCircleElement, Dot>("circle")
      .data(data, (d) => String(d.properties.id))
      .join(
        (enter) => enter.append("circle").attr("class", "spk-dot"),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr("fill", dotColor)
      .classed("ui", (d) => d.properties.origin === "ui")
      .classed("audio", (d) => d.properties.recordings > 0)
      .classed("coarse", (d) => d.properties.match === "state" || d.properties.match === "country")
      .classed("selected", (d) => d.properties.id === s.selectedId)
      .classed("dimmed", (d) => s.selectedId != null && d.properties.id !== s.selectedId)
      .on("mousemove", (ev: MouseEvent, d) => tooltip.show(dotTooltip(d), ev))
      .on("mouseleave", () => tooltip.hide())
      .on("click", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        if (getState().mode !== "browse") return;
        setState({ selectedId: d.properties.id });
      })
      .order();
  }

  function drawDots() {
    dotsG.selectAll<SVGCircleElement, Dot>("circle").each(function (d) {
      const [lon, lat] = d.geometry.coordinates;
      const xy = visible(lon, lat) ? projection([lon, lat]) : null;
      const el = d3.select(this);
      if (!xy) el.attr("display", "none");
      else el.attr("display", null).attr("cx", xy[0]).attr("cy", xy[1]).attr("r", dotR(d) * (el.classed("selected") ? 1.9 : 1));
    });
  }

  // ---------- NER places of the selected speaker ----------
  function linkedPlaces(): Entity[] {
    const d = getState().detail;
    if (!d) return [];
    const seen = new Set<string>();
    return d.entities.filter((e) => e.lon != null && e.lat != null && !seen.has(`${e.lon},${e.lat}`) && !!seen.add(`${e.lon},${e.lat}`));
  }

  function drawPlaces() {
    const d = getState().detail;
    const places = linkedPlaces();
    const from: [number, number] | null = d && d.geo.lon != null ? [d.geo.lon, d.geo.lat!] : null;
    links.selectAll<SVGPathElement, Entity>("path").data(from ? places : []).join("path").attr("class", "link spk-link")
      .attr("d", (e) => path({ type: "LineString", coordinates: [from!, [e.lon!, e.lat!]] }));
    placesG.selectAll<SVGPathElement, Entity>("path")
      .data(places, (e) => `${e.lon},${e.lat}`)
      .join("path").attr("class", "spk-place").attr("d", d3.symbol(d3.symbolDiamond, 46)())
      .datum((e) => e)
      .on("mousemove", (ev: MouseEvent, e) => tooltip.show(
        `<div class="tt-title">${esc(e.place ?? e.text)}</div><div class="tt-muted">mentioned as “${esc(e.text)}” in ${esc(e.field.replace("_", " "))}</div>` +
        `<div class="tt-row"><span>Linked</span><b>${esc(e.match ?? "")}</b></div><div class="tt-row"><span>Found by</span><b>${esc(e.source.split(":")[0])}</b></div>`, ev))
      .on("mouseleave", () => tooltip.hide())
      .each(function (e) {
        const xy = visible(e.lon!, e.lat!) ? projection([e.lon!, e.lat!]) : null;
        d3.select(this).attr("display", xy ? null : "none").attr("transform", xy ? `translate(${xy[0]},${xy[1]})` : null);
      });
  }

  // ---------- the pin being placed ----------
  function drawPin() {
    const p = getState().pin;
    const data: [number, number][] = p ? [[p.lon, p.lat]] : [];
    const g = pinG.selectAll<SVGGElement, [number, number]>("g").data(data).join((enter) => {
      const e = enter.append("g").attr("class", "pin");
      e.append("circle").attr("class", "pin-pulse").attr("r", 9);
      e.append("circle").attr("class", "pin-core").attr("r", 4.5);
      return e;
    });
    place(g as unknown as d3.Selection<SVGGraphicsElement, [number, number], SVGGElement, unknown>);
  }

  // ---------- legend ----------
  function updateLegend() {
    const s = getState();
    const all = visibleDots(s);
    const nat = all.filter((d) => d.properties.native_english).length;
    legend.innerHTML =
      `<span class="legend-item"><span class="dot" style="background:var(--series-1)"></span>Native English <b class="num">${num(nat)}</b></span>` +
      `<span class="legend-item"><span class="dot" style="background:var(--series-2)"></span>Other first language <b class="num">${num(all.length - nat)}</b></span>` +
      `<span class="legend-item"><span class="dot ring"></span>Created here</span>` +
      `<span class="legend-item"><span class="dot big"></span>Has audio</span>` +
      `<span class="legend-item"><span class="diamond"></span>Place in record</span>`;
  }

  // ---------- camera ----------
  function focus(lon: number, lat: number, k = 2.2) {
    if (mode === "globe") {
      spinning = false;
      btnSpin.attr("aria-pressed", "false");
      const from = projection.rotate() as [number, number, number];
      const ri = d3.interpolate(from, [-lon, -lat, 0] as [number, number, number]);
      const k0 = zoomK;
      d3.transition().duration(reduce ? 0 : 1000).ease(d3.easeCubicInOut).tween("rotate", () => (t) => {
        rotate = ri(t) as [number, number, number];
        projection.rotate(rotate);
        const kk = k0 + (Math.max(k0, k) - k0) * t;
        svg.property("__zoom", d3.zoomIdentity.scale(kk));
        applyZoom(d3.zoomIdentity.scale(kk));
        quality = t < 1 ? "low" : "high";
        draw();
      });
    } else {
      const xy = projection.scale(baseScale).translate(baseTranslate)([lon, lat])!;
      const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-xy[0], -xy[1]);
      svg.transition().duration(reduce ? 0 : 800).call(zoom.transform, t);
    }
  }

  // ---------- auto-rotation ----------
  d3.timer(() => {
    if (mode !== "globe" || !spinning || interacting || getState().mode !== "browse"
        || performance.now() - lastInteraction < 2500 || document.hidden) return;
    rotate = [rotate[0] + 0.06, rotate[1], 0];
    projection.rotate(rotate);
    quality = "low";
    draw();
  });

  btnSpin.on("click", (ev: MouseEvent) => {
    ev.stopPropagation();
    spinning = !spinning;
    btnSpin.attr("aria-pressed", String(spinning));
    quality = "high";
    draw();
  });
  btnNight.on("click", (ev: MouseEvent) => {
    ev.stopPropagation();
    showNight = !showNight;
    btnNight.attr("aria-pressed", String(showNight));
    drawNight();
  });
  btnReset.on("click", (ev: MouseEvent) => {
    ev.stopPropagation();
    resetView();
  });
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
    if (changed.has("dots") || changed.has("filters") || changed.has("selectedId")) {
      updateDots();
      updateLegend();
      draw();
    }
    if (changed.has("detail") || changed.has("pin")) draw();
    if (changed.has("mode")) {
      svg.classed("placing", s.mode !== "browse");
      hint.attr("hidden", s.mode === "browse" ? true : null)
        .text(s.mode === "add" ? "Click the map where the speaker was born" : "Click the map to move this speaker");
    }
    if (changed.has("detail") && s.detail?.geo.lon != null) focus(s.detail.geo.lon, s.detail.geo.lat!);
  });

  makeProjection();
  fit();
  updateDots();
  updateLegend();
  draw();
  return { setMode, focus };
}

function dotTooltip(d: Dot): string {
  const p = d.properties;
  const who = [p.gender, p.age != null ? `${p.age}` : null].filter(Boolean).join(", ");
  return `
    <div class="tt-title">${esc(p.native_language)}${p.origin === "ui" ? ' <span class="tt-badge">created here</span>' : ""}</div>
    <div class="tt-muted">${esc(p.birthplace ?? "no birthplace")}</div>
    ${who ? `<div class="tt-row"><span>Speaker</span><b>${esc(who)}</b></div>` : ""}
    <div class="tt-row"><span>Placed by</span><b>${esc(p.match ?? "—")}</b></div>
    <div class="tt-row"><span>Sample</span><b>${esc(p.speech_sample)}</b></div>
    <div class="tt-row"><span>Recordings</span><b>${p.recordings}</b></div>
    <div class="tt-foot">Click to open the record</div>`;
}
