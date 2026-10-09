import * as d3 from "d3";
import { api } from "./api";
import { openRecord } from "./drilldown";
import { getState, setFilters, setState, subscribe } from "./state";
import type { GraphData, GraphLink, GraphNode, GraphNodeType, LangScope, GeoScope } from "./types";
import { debounce, esc, kindColor, num, pct, tooltip } from "./util";

type N = GraphNode & d3.SimulationNodeDatum;
type L = Omit<GraphLink, "source" | "target"> & { source: N | string; target: N | string };
type Layout = "force" | "timelang";

const SHAPE: Record<GraphNodeType, d3.SymbolType> = {
  record: d3.symbolCircle,
  place: d3.symbolCircle,
  country: d3.symbolSquare,
  language: d3.symbolDiamond,
  branch: d3.symbolDiamond,
  family: d3.symbolDiamond,
  year: d3.symbolSquare,
  label: d3.symbolTriangle,
  contact: d3.symbolCircle,
};
const SIZE: Partial<Record<GraphNodeType, number>> = { contact: 120, place: 30, country: 90, language: 110, branch: 140, family: 190, year: 60, label: 50 };
const TYPE_LABEL: Record<GraphNodeType, string> = {
  record: "Record", place: "Place", country: "Country", language: "Language", branch: "Branch", family: "Family", year: "Year", label: "Label", contact: "Person",
};
/** Log-scale slider for the temporal window: 1 day … 100 years. */
const daysScale = d3.scaleLog().domain([1, 36525]).range([0, 100]);

function fmtDays(d: number): string {
  if (d < 60) return `${Math.round(d)} days`;
  if (d < 730) return `${Math.round(d / 30.44)} months`;
  return `${Math.round(d / 365.25)} years`;
}

export function initNetwork(container: HTMLElement): { activate: (on: boolean) => void } {
  const host = d3.select(container).append("div").attr("class", "net-host").style("display", "none");
  const svg = host.append("svg").attr("class", "net-svg").attr("role", "img").attr("aria-label", "Record network");
  const root = svg.append("g");
  const bandsG = root.append("g").attr("class", "bands");
  const axisG = root.append("g").attr("class", "axis x");
  const linkG = root.append("g").attr("class", "net-links");
  const nodeG = root.append("g").attr("class", "net-nodes");
  const labelG = root.append("g").attr("class", "net-labels");
  const statsEl = host.append("div").attr("class", "net-stats");

  // ---------- controls ----------
  const panel = host.append("form").attr("class", "net-ctrls").on("submit", (e: Event) => e.preventDefault());
  panel.html(`
    <button type="button" class="net-ctrls-toggle" aria-expanded="true">Proximity controls <span aria-hidden="true">▾</span></button>
    <div class="seg" role="group" aria-label="Layout">
      <button type="button" data-layout="force" class="active">Force</button>
      <button type="button" data-layout="timelang">Time × Language</button>
    </div>
    <label><span>Time window <b id="nc-days"></b></span><input id="nc-window" type="range" min="0" max="100" step="1" /></label>
    <label><span>Language scope</span>
      <select id="nc-lang">
        <option value="same">Same language</option><option value="branch">Same branch</option>
        <option value="family">Same family</option><option value="any">Any language</option>
      </select></label>
    <label><span>Geography</span>
      <select id="nc-geo"><option value="any">Anywhere</option><option value="country">Shared country</option><option value="place">Shared place</option></select></label>
    <label><span>Min. proximity <b id="nc-minw"></b></span><input id="nc-min" type="range" min="0" max="0.95" step="0.05" /></label>
    <label><span>Semantic weight <b id="nc-semw"></b></span><input id="nc-sem" type="range" min="0" max="3" step="0.25" /></label>
    <label class="check"><input id="nc-index" type="checkbox" checked /> Index nodes</label>
    <div class="net-legend">
      ${(["record", "contact", "place", "country", "language", "family", "year", "label"] as GraphNodeType[]).map((t) =>
        `<span><svg aria-hidden="true" width="12" height="12" viewBox="-6 -6 12 12"><path class="nl-${t}" d="${d3.symbol(SHAPE[t], t === "record" ? 50 : 40)()}"/></svg>${TYPE_LABEL[t]}</span>`).join("")}
      <span><svg aria-hidden="true" width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" class="nl-prox"/></svg>Proximity</span>
    </div>`);
  const q = <T extends HTMLElement>(sel: string) => panel.node()!.querySelector(sel) as T;
  let layout: Layout = "force";
  let includeIndex = true;
  let userZoomed = false;
  const toggleBtn = q<HTMLButtonElement>(".net-ctrls-toggle");
  const setCollapsed = (c: boolean) => {
    panel.classed("collapsed", c);
    toggleBtn.setAttribute("aria-expanded", String(!c));
  };
  toggleBtn.addEventListener("click", () => setCollapsed(!panel.classed("collapsed")));

  function syncControls() {
    const p = getState().proximity;
    q<HTMLInputElement>("#nc-window").value = String(daysScale(Math.max(1, p.max_days)));
    q("#nc-days").textContent = fmtDays(p.max_days);
    q<HTMLSelectElement>("#nc-lang").value = p.lang_scope;
    q<HTMLSelectElement>("#nc-geo").value = p.geo_scope;
    q<HTMLInputElement>("#nc-min").value = String(p.min_weight);
    q("#nc-minw").textContent = pct(p.min_weight);
    q<HTMLInputElement>("#nc-sem").value = String(p.w_sem);
    q("#nc-semw").textContent = `${p.w_sem}×`;
  }
  const setProx = (patch: Partial<ReturnType<typeof getState>["proximity"]>) =>
    setState({ proximity: { ...getState().proximity, ...patch } });
  q<HTMLInputElement>("#nc-window").addEventListener("input", (e) => {
    const d = Math.round(daysScale.invert(Number((e.target as HTMLInputElement).value)));
    q("#nc-days").textContent = fmtDays(d);
    setProxDebounced({ max_days: d });
  });
  const setProxDebounced = debounce(setProx, 180);
  q<HTMLSelectElement>("#nc-lang").addEventListener("change", (e) => setProx({ lang_scope: (e.target as HTMLSelectElement).value as LangScope }));
  q<HTMLSelectElement>("#nc-geo").addEventListener("change", (e) => setProx({ geo_scope: (e.target as HTMLSelectElement).value as GeoScope }));
  q<HTMLInputElement>("#nc-min").addEventListener("input", (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    q("#nc-minw").textContent = pct(v);
    setProxDebounced({ min_weight: v });
  });
  q<HTMLInputElement>("#nc-sem").addEventListener("input", (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    q("#nc-semw").textContent = `${v}×`;
    setProxDebounced({ w_sem: v });
  });
  q<HTMLInputElement>("#nc-index").addEventListener("change", (e) => {
    includeIndex = (e.target as HTMLInputElement).checked;
    load();
  });
  panel.selectAll<HTMLButtonElement, unknown>(".seg button").on("click", function () {
    layout = this.dataset.layout as Layout;
    userZoomed = false;
    if (layout === "timelang") svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
    panel.selectAll(".seg button").classed("active", false);
    d3.select(this).classed("active", true);
    applyLayout(true);
  });

  // ---------- zoom ----------
  const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.2, 6]).on("zoom", (ev) => {
    root.attr("transform", ev.transform.toString());
    if (ev.sourceEvent) userZoomed = true;
  });
  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", () => getState().selectedId && setState({ selectedId: null }));

  // ---------- simulation ----------
  let nodes: N[] = [];
  let links: L[] = [];
  let width = 800;
  let height = 500;
  let active = false;
  const sim = d3.forceSimulation<N>().alphaDecay(0.03).on("tick", ticked).on("end", () => fitView()).stop();

  /** Zoom to the graph's bounding box once the layout settles (unless the user has zoomed). */
  function fitView() {
    if (userZoomed || !nodes.length || layout === "timelang") return;
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const [x0, x1, y0, y1] = [d3.min(xs)!, d3.max(xs)!, d3.min(ys)!, d3.max(ys)!];
    const pad = 40;
    const k = Math.min(2, (width - pad * 2) / Math.max(1, x1 - x0), (height - pad * 2) / Math.max(1, y1 - y0));
    const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    svg.transition().duration(600).call(zoom.transform, t);
  }

  let bandOf = new Map<string, number>();
  let bands: { key: string; label: string; y0: number; y1: number; family: string }[] = [];
  let x = d3.scaleUtc();

  async function load() {
    if (!active) return;
    const s = getState();
    let data: GraphData;
    try {
      data = await api.graph(s.filters, s.proximity, includeIndex);
    } catch {
      return;
    }
    const prev = new Map(nodes.map((n) => [n.id, n]));
    nodes = data.nodes.map((n) => Object.assign(prev.get(n.id) ?? {}, n) as N);
    links = data.links.map((l) => ({ ...l }));
    statsEl.html(`<b>${num(data.stats.records)}</b> records · <b>${num(data.stats.proximity_edges)}</b> proximity edges · <b>${num(data.stats.components)}</b> clusters${includeIndex ? ` · <b>${num(data.stats.index_nodes)}</b> index nodes` : ""}`);
    render();
    applyLayout(false);
  }

  function computeBands() {
    // Language bands grouped by family -> branch, ordered so related languages are adjacent.
    const recs = nodes.filter((n) => n.type === "record");
    const langs = Array.from(new Set(recs.map((n) => n.language ?? "und")));
    const fam = (l: string) => FAMILY[l]?.[1] ?? "~";
    const br = (l: string) => FAMILY[l]?.[0] ?? "~";
    langs.sort((a, b) => d3.ascending(fam(a), fam(b)) || d3.ascending(br(a), br(b)) || d3.ascending(a, b));
    const top = 30;
    const bottom = height - 40;
    const h = (bottom - top) / Math.max(1, langs.length);
    bands = langs.map((l, i) => ({ key: l, label: l, family: fam(l), y0: top + i * h, y1: top + (i + 1) * h }));
    bandOf = new Map(bands.map((b, i) => [b.key, i]));
    const ts = recs.map((n) => new Date(n.timestamp!));
    const ext = d3.extent(ts) as [Date, Date];
    x = d3.scaleUtc().domain(ext[0] ? [d3.utcYear.offset(ext[0], -1), d3.utcYear.offset(ext[1], 1)] : [new Date(2000, 0), new Date()]).range([150, width - 30]).nice();
  }

  function applyLayout(reheat: boolean) {
    width = container.clientWidth;
    height = container.clientHeight;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const linkForce = d3.forceLink<N, L>(links).id((d) => d.id)
      .distance((l) => (l.type === "PROXIMITY" ? 30 + 90 * (1 - l.weight) : l.type === "MENTIONS" ? 34 : 46))
      .strength((l) => (l.type === "PROXIMITY" ? 0.15 + 0.5 * l.weight : 0.35));
    sim.nodes(nodes).force("link", linkForce)
      .force("charge", d3.forceManyBody<N>().strength((d) => (d.type === "record" ? -90 : -45)).distanceMax(320))
      .force("collide", d3.forceCollide<N>((d) => nodeRadius(d) + 3));
    if (layout === "force") {
      for (const n of nodes) { n.fx = null; n.fy = null; }
      sim.force("x", d3.forceX<N>(width / 2).strength(0.04)).force("y", d3.forceY<N>(height / 2).strength(0.06)).force("center", null);
      bandsG.selectAll("*").remove();
      axisG.selectAll("*").remove();
    } else {
      computeBands();
      for (const n of nodes) {
        n.fx = null;
        n.fy = null;
        if (n.type === "language" && bandOf.has(n.id.slice(9))) {
          const b = bands[bandOf.get(n.id.slice(9))!];
          n.fx = 70; n.fy = (b.y0 + b.y1) / 2;
        } else if (n.type === "year" && n.year) {
          n.fx = x(new Date(Date.UTC(n.year, 6, 1))); n.fy = height - 26;
        }
      }
      const bandY = (d: N) => {
        if (d.type === "record") {
          const b = bands[bandOf.get(d.language ?? "und") ?? 0];
          return b ? (b.y0 + b.y1) / 2 : height / 2;
        }
        return height / 2;
      };
      sim.force("x", d3.forceX<N>((d) => (d.type === "record" ? x(new Date(d.timestamp!)) : d.type === "branch" || d.type === "family" ? 24 : width / 2))
        .strength((d) => (d.type === "record" ? 0.9 : d.type === "branch" || d.type === "family" ? 0.3 : 0.01)))
        .force("y", d3.forceY<N>(bandY).strength((d) => (d.type === "record" ? 0.6 : 0.01)))
        .force("center", null);
      drawBands();
    }
    sim.alpha(reheat ? 0.9 : 0.6).restart();
  }

  function drawBands() {
    const famColor = new Map<string, number>();
    bands.forEach((b) => famColor.has(b.family) || famColor.set(b.family, famColor.size));
    bandsG.selectAll<SVGGElement, (typeof bands)[number]>("g.band").data(bands, (b) => b.key).join((e) => {
      const g = e.append("g").attr("class", "band");
      g.append("rect");
      g.append("text").attr("class", "band-label");
      g.append("text").attr("class", "band-family");
      return g;
    })
      .call((g) => g.select("rect").attr("x", 0).attr("width", width).attr("y", (b) => b.y0).attr("height", (b) => b.y1 - b.y0)
        .attr("class", (b) => `band-bg ${famColor.get(b.family)! % 2 ? "odd" : "even"}`))
      .call((g) => g.select(".band-label").attr("x", 92).attr("y", (b) => (b.y0 + b.y1) / 2 + 4).text((b) => LANG_NAME[b.key] ?? b.key))
      .call((g) => g.select(".band-family").attr("x", width - 8).attr("y", (b) => b.y0 + 13).attr("text-anchor", "end")
        .text((b, i) => (i === 0 || bands[i - 1].family !== b.family ? (b.family === "~" ? "unclassified" : b.family) : "")));
    axisG.attr("transform", `translate(0,${height - 40})`).call(d3.axisBottom(x).ticks(Math.max(3, width / 110)).tickSizeOuter(0));
  }

  const nodeRadius = (d: N) => (d.type === "record" ? 5 + Math.sqrt(d.degree) * 1.2 : Math.sqrt((SIZE[d.type] ?? 40) / Math.PI));

  function render() {
    const s = getState();
    linkG.selectAll<SVGLineElement, L>("line").data(links, (l) => `${idOf(l.source)}|${idOf(l.target)}|${l.type}`)
      .join("line")
      .attr("class", (l) => `nl ${l.type === "PROXIMITY" ? "prox" : "struct"} t-${l.type.toLowerCase()}`)
      .attr("stroke-width", (l) => (l.type === "PROXIMITY" ? 0.6 + 3.2 * l.weight : 0.7))
      .attr("stroke-opacity", (l) => (l.type === "PROXIMITY" ? 0.25 + 0.6 * l.weight : null))
      .on("mousemove", (ev: MouseEvent, l) => l.type === "PROXIMITY" && tooltip.show(proxTooltip(l as unknown as GraphLink), ev))
      .on("mouseleave", () => tooltip.hide());

    const sel = nodeG.selectAll<SVGPathElement, N>("path").data(nodes, (d) => d.id)
      .join((e) => e.append("path").call(drag))
      .attr("class", (d) => `nn nl-${d.type}`)
      .attr("d", (d) => d3.symbol(SHAPE[d.type], d.type === "record" ? Math.PI * nodeRadius(d) ** 2 : SIZE[d.type] ?? 40)())
      .style("fill", (d) => (d.type === "record" ? kindColor(d.kind!) : null))
      .classed("selected", (d) => d.record_id === s.selectedId)
      .on("mouseenter", (ev: MouseEvent, d) => focus(d, ev))
      .on("mousemove", (ev: MouseEvent, d) => tooltip.show(nodeTooltip(d), ev))
      .on("mouseleave", () => { tooltip.hide(); unfocus(); })
      .on("dblclick", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        if (d.type === "record") openRecord(d.record_id!);
      })
      .on("click", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        if (d.type === "record") setState({ selectedId: getState().selectedId === d.record_id ? null : d.record_id! });
        else if (d.type === "contact" && d.contact_id) location.hash = `#/contacts/${encodeURIComponent(d.contact_id)}`;
        else if (d.type === "country") setFilters({ country: d.id.slice(8) });
        else if (d.type === "language") setFilters({ language: d.id.slice(9) });
        else if (d.type === "year" && d.year) setFilters({ start: new Date(Date.UTC(d.year, 0, 1)), end: new Date(Date.UTC(d.year, 11, 31, 23, 59)) });
      });
    sel.raise();

    // Labels for hubs (high-degree index nodes) and the selected record.
    const hubs = nodes.filter((n) => n.type === "contact" || (n.type !== "record" && n.type !== "place" && n.degree >= 2) || n.type === "family" || n.type === "branch" || (n.type === "place" && n.degree >= 3) || n.record_id === s.selectedId);
    labelG.selectAll<SVGTextElement, N>("text").data(hubs, (d) => d.id).join("text")
      .attr("class", (d) => `net-label t-${d.type}`)
      .text((d) => (d.type === "record" ? d.label.slice(0, 32) : d.label));
    ticked();
  }

  function ticked() {
    linkG.selectAll<SVGLineElement, L>("line")
      .attr("x1", (l) => (l.source as N).x ?? 0).attr("y1", (l) => (l.source as N).y ?? 0)
      .attr("x2", (l) => (l.target as N).x ?? 0).attr("y2", (l) => (l.target as N).y ?? 0);
    nodeG.selectAll<SVGPathElement, N>("path").attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    labelG.selectAll<SVGTextElement, N>("text").attr("x", (d) => (d.x ?? 0) + nodeRadius(d) + 4).attr("y", (d) => (d.y ?? 0) + 3);
  }

  function focus(d: N, _ev: MouseEvent) {
    const nb = new Set([d.id]);
    for (const l of links) {
      if (idOf(l.source) === d.id) nb.add(idOf(l.target));
      if (idOf(l.target) === d.id) nb.add(idOf(l.source));
    }
    svg.classed("focusing", true);
    nodeG.selectAll<SVGPathElement, N>("path").classed("lit", (n) => nb.has(n.id));
    linkG.selectAll<SVGLineElement, L>("line").classed("lit", (l) => idOf(l.source) === d.id || idOf(l.target) === d.id);
    labelG.selectAll<SVGTextElement, N>("text").classed("lit", (n) => nb.has(n.id));
  }
  function unfocus() {
    svg.classed("focusing", false);
    nodeG.selectAll(".lit").classed("lit", false);
    linkG.selectAll(".lit").classed("lit", false);
    labelG.selectAll(".lit").classed("lit", false);
  }

  const drag = (sel: d3.Selection<SVGPathElement, N, SVGGElement, unknown>) =>
    sel.call(d3.drag<SVGPathElement, N>()
      .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on("end", (ev, d) => {
        if (!ev.active) sim.alphaTarget(0);
        const pinned = layout === "timelang" && (d.type === "language" || d.type === "year");
        if (!pinned) { d.fx = null; d.fy = null; }
      }));

  function nodeTooltip(d: N): string {
    if (d.type === "record") {
      const rec = getState().records.find((r) => r.id === d.record_id);
      return `<div class="tt-title">${esc(d.label)}</div>
        <div class="tt-row"><span>Time</span><b>${esc(d.timestamp?.slice(0, 10))}</b></div>
        <div class="tt-row"><span>Language</span><b>${esc(LANG_NAME[d.language ?? ""] ?? d.language)}</b></div>
        <div class="tt-row"><span>Places</span><b>${esc(rec?.geo.map((m) => m.place.name).join(", ") ?? "")}</b></div>
        <div class="tt-row"><span>Connections</span><b>${d.degree}</b></div>`;
    }
    const hint = d.type === "contact" ? `<div class="tt-foot">Click to open contact</div>`
      : d.type === "country" || d.type === "language" || d.type === "year" ? `<div class="tt-foot">Click to filter</div>` : "";
    return `<div class="tt-title">${esc(d.label)}</div><div class="tt-muted">${TYPE_LABEL[d.type]} · ${d.degree} connections</div>${hint}`;
  }

  function resize() {
    if (!active) return;
    applyLayout(false);
  }
  new ResizeObserver(resize).observe(container);

  const loadDebounced = debounce(load, 250);
  subscribe((s, changed) => {
    if (changed.has("proximity")) syncControls();
    if (!active) return;
    if (changed.has("records") || changed.has("filters") || changed.has("proximity")) loadDebounced();
    if (changed.has("selectedId")) {
      nodeG.selectAll<SVGPathElement, N>("path").classed("selected", (d) => d.record_id === s.selectedId);
      render();
    }
  });
  syncControls();

  return {
    activate(on: boolean) {
      active = on;
      host.style("display", on ? "block" : "none");
      if (on) setCollapsed(container.clientHeight < 560 || container.clientWidth < 700);
      if (on) load();
      else sim.stop();
    },
  };
}

const idOf = (v: N | string) => (typeof v === "string" ? v : v.id);

export function proxTooltip(l: Partial<GraphLink> & { weight: number }): string {
  const yrs = (l.dt_days ?? 0) / 365.25;
  const dt = yrs >= 1 ? `${yrs.toFixed(1)} yr` : `${Math.round(l.dt_days ?? 0)} d`;
  const bar = (v: number | null | undefined) => `<span class="conf"><span class="conf-bar" style="width:${(v ?? 0) * 100}%"></span></span>`;
  return `
    <div class="tt-title">Proximity ${pct(l.weight)}</div>
    <div class="tt-row"><span>Time · Δ ${dt}</span><b>${bar(l.time)} ${pct(l.time ?? 0)}</b></div>
    <div class="tt-row"><span>Language · ${esc(l.lang_relation ?? "")}</span><b>${bar(l.lang)} ${pct(l.lang ?? 0)}</b></div>
    <div class="tt-row"><span>Geography</span><b>${bar(l.geo)} ${pct(l.geo ?? 0)}</b></div>
    ${l.sem != null ? `<div class="tt-row"><span>Semantic</span><b>${bar(l.sem)} ${pct(l.sem)}</b></div>` : ""}
    <div class="tt-row"><span>Linguistic × time</span><b>${pct(l.ling_time ?? 0)}</b></div>`;
}

// Mirrors backend LANGUAGE_TREE (branch, family) for band ordering.
const FAMILY: Record<string, [string, string]> = {
  en: ["Germanic", "Indo-European"], de: ["Germanic", "Indo-European"], nl: ["Germanic", "Indo-European"],
  sv: ["Germanic", "Indo-European"], da: ["Germanic", "Indo-European"], no: ["Germanic", "Indo-European"],
  fr: ["Romance", "Indo-European"], es: ["Romance", "Indo-European"], pt: ["Romance", "Indo-European"],
  it: ["Romance", "Indo-European"], ro: ["Romance", "Indo-European"], ca: ["Romance", "Indo-European"],
  ru: ["Slavic", "Indo-European"], uk: ["Slavic", "Indo-European"], pl: ["Slavic", "Indo-European"],
  cs: ["Slavic", "Indo-European"], bg: ["Slavic", "Indo-European"], hr: ["Slavic", "Indo-European"],
  sl: ["Slavic", "Indo-European"], el: ["Hellenic", "Indo-European"], hi: ["Indo-Aryan", "Indo-European"],
  ur: ["Indo-Aryan", "Indo-European"], bn: ["Indo-Aryan", "Indo-European"], fa: ["Iranian", "Indo-European"],
  ar: ["Semitic", "Afro-Asiatic"], he: ["Semitic", "Afro-Asiatic"], zh: ["Sinitic", "Sino-Tibetan"],
  ja: ["Japonic", "Japonic"], ko: ["Koreanic", "Koreanic"], tr: ["Oghuz", "Turkic"], hu: ["Ugric", "Uralic"],
  fi: ["Finnic", "Uralic"], vi: ["Vietic", "Austroasiatic"], th: ["Tai", "Kra-Dai"], id: ["Malayo-Polynesian", "Austronesian"],
  sw: ["Bantu", "Niger-Congo"],
};
const LANG_NAME: Record<string, string> = {
  en: "English", de: "German", fr: "French", es: "Spanish", pt: "Portuguese", it: "Italian", nl: "Dutch",
  ru: "Russian", uk: "Ukrainian", pl: "Polish", ja: "Japanese", zh: "Chinese", ko: "Korean", ar: "Arabic",
  he: "Hebrew", hi: "Hindi", tr: "Turkish", sv: "Swedish", el: "Greek", fa: "Persian", und: "Undetermined",
};
