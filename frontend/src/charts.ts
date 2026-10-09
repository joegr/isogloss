import * as d3 from "d3";
import { filteredRecords, getState, setFilters, subscribe } from "./state";
import type { GeoRecord } from "./types";
import { esc, num, tooltip } from "./util";

const M = { top: 8, right: 12, bottom: 24, left: 32 };

/** Histogram of record timestamps with a brush that sets the time filter. */
export function initTimeline(container: HTMLElement): void {
  const svg = d3.select(container).append("svg").attr("class", "chart-svg").attr("role", "img")
    .attr("aria-label", "Histogram of records over time; drag to filter by date");
  const gx = svg.append("g").attr("class", "axis x");
  const gy = svg.append("g").attr("class", "axis y");
  const grid = svg.append("g").attr("class", "grid");
  const bars = svg.append("g");
  const brushG = svg.append("g").attr("class", "brush");
  const empty = d3.select(container).append("div").attr("class", "empty").text("No records yet");

  let width = 0;
  let height = 0;
  let x = d3.scaleUtc();
  let suppress = false;

  const brush = d3.brushX().on("end", (ev: d3.D3BrushEvent<unknown>) => {
    if (suppress || !ev.sourceEvent) return;
    if (!ev.selection) {
      setFilters({ start: null, end: null });
      return;
    }
    const [a, b] = (ev.selection as [number, number]).map((v) => x.invert(v));
    setFilters({ start: a, end: b });
  });

  function render() {
    width = container.clientWidth;
    height = container.clientHeight;
    // Hidden page (e.g. while Contacts is open): skip; the ResizeObserver re-renders when shown.
    if (width < M.left + M.right + 20 || height < M.top + M.bottom + 10) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const s = getState();
    // Time histogram reflects every filter except time itself, so the brush has context.
    const all = filteredRecords(s, ["start", "end"]);
    const recs = all.filter((r) => r.dated !== false); // undated records have no position in time
    const hint = container.closest(".card")?.querySelector(".card-head .hint");
    const extra = all.length - recs.length;
    if (hint) hint.textContent = `drag to filter${extra ? ` · ${extra} undated not shown` : ""}`;
    empty.style("display", recs.length ? "none" : "grid");
    const dates = recs.map((r) => new Date(r.timestamp.value));
    const ext = d3.extent(dates) as [Date | undefined, Date | undefined];
    const lo = ext[0] ?? new Date(Date.UTC(2000, 0, 1));
    const hi = ext[1] ?? new Date();
    x = d3.scaleUtc().domain([d3.utcYear.floor(lo), d3.utcYear.offset(d3.utcYear.floor(hi), 1)]).nice()
      .range([M.left, width - M.right]);
    const bins = d3.bin<GeoRecord, Date>().value((r) => new Date(r.timestamp.value))
      .domain(x.domain() as [Date, Date]).thresholds(x.ticks(Math.max(10, Math.floor(width / 14))))(recs);
    const y = d3.scaleLinear().domain([0, Math.max(1, d3.max(bins, (b) => b.length) ?? 1)]).nice()
      .range([height - M.bottom, M.top]);

    gx.attr("transform", `translate(0,${height - M.bottom})`)
      .call(d3.axisBottom(x).ticks(Math.max(2, width / 90)).tickSizeOuter(0));
    gy.attr("transform", `translate(${M.left},0)`).call(d3.axisLeft(y).ticks(3).tickSize(0).tickFormat(d3.format("d")))
      .call((g) => g.select(".domain").remove());
    grid.selectAll("line").data(y.ticks(3)).join("line")
      .attr("x1", M.left).attr("x2", width - M.right).attr("y1", (d) => y(d)).attr("y2", (d) => y(d));

    const f = s.filters;
    bars.selectAll<SVGPathElement, d3.Bin<GeoRecord, Date>>("path").data(bins.filter((b) => b.length))
      .join("path")
      .attr("class", "bar")
      .classed("out", (b) => !!(f.start && f.end) && (b.x1! <= f.start! || b.x0! >= f.end!))
      .attr("d", (b) => {
        const x0 = x(b.x0!) + 1;
        const w = Math.max(1, x(b.x1!) - x(b.x0!) - 2); // 2px surface gap between bars
        return roundedTop(x0, y(b.length), w, y(0) - y(b.length), Math.min(4, w / 2));
      })
      .on("mousemove", (ev: MouseEvent, b) => {
        const fmt = d3.utcFormat("%b %Y");
        tooltip.show(
          `<div class="tt-title">${fmt(b.x0!)} – ${fmt(b.x1!)}</div>
           <div class="tt-row"><span>Records</span><b>${num(b.length)}</b></div>
           <div class="tt-snippet">${b.slice(0, 3).map((r) => esc(r.content.slice(0, 60))).join("<br>")}${b.length > 3 ? "<br>…" : ""}</div>`,
          ev,
        );
      })
      .on("mouseleave", () => tooltip.hide());

    brush.extent([[M.left, M.top], [width - M.right, height - M.bottom]]);
    brushG.call(brush);
    suppress = true;
    brushG.call(brush.move, f.start && f.end ? [x(f.start), x(f.end)] : null);
    suppress = false;
    // Let the bars receive hover under the brush overlay.
    brushG.select(".overlay").on("mousemove.tt", (ev: MouseEvent) => {
      const t = x.invert(d3.pointer(ev)[0]);
      const b = bins.find((bb) => bb.x0! <= t && t < bb.x1!);
      if (b && b.length) {
        const fmt = d3.utcFormat("%b %Y");
        tooltip.show(`<div class="tt-title">${fmt(b.x0!)} – ${fmt(b.x1!)}</div><div class="tt-row"><span>Records</span><b>${num(b.length)}</b></div>`, ev);
      } else tooltip.hide();
    }).on("mouseleave.tt", () => tooltip.hide());
  }

  new ResizeObserver(render).observe(container);
  subscribe((_s, changed) => {
    if (changed.has("records") || changed.has("filters")) render();
  });
}

/** Horizontal bars: records per language; click a bar to filter. */
export function initLanguages(container: HTMLElement): void {
  const list = d3.select(container).append("div").attr("class", "lang-bars");

  function render() {
    const s = getState();
    const recs = filteredRecords(s, ["language"]);
    const rolled = d3.rollups(recs, (v) => ({ n: v.length, name: v[0].language.name ?? v[0].language.code }), (r) => r.language.code)
      .sort((a, b) => b[1].n - a[1].n);
    const MAX = 8;
    const rows = rolled.slice(0, MAX).map(([code, v]) => ({ code, name: v.name, n: v.n }));
    if (rolled.length > MAX) {
      rows.push({ code: "__other", name: `Other (${rolled.length - MAX})`, n: d3.sum(rolled.slice(MAX), (d) => d[1].n) });
    }
    const max = d3.max(rows, (r) => r.n) ?? 1;
    const sel = s.filters.language;

    list.selectAll<HTMLButtonElement, (typeof rows)[number]>("button.lang-row")
      .data(rows, (d) => d.code)
      .join((enter) => {
        const b = enter.append("button").attr("type", "button").attr("class", "lang-row");
        b.append("span").attr("class", "lang-name");
        const track = b.append("span").attr("class", "lang-track");
        track.append("span").attr("class", "lang-fill");
        b.append("span").attr("class", "lang-count");
        return b;
      })
      .classed("active", (d) => sel === d.code)
      .classed("muted", (d) => !!sel && sel !== d.code)
      .attr("disabled", (d) => (d.code === "__other" ? "" : null))
      .attr("aria-pressed", (d) => String(sel === d.code))
      .on("click", (_ev, d) => setFilters({ language: sel === d.code ? null : d.code }))
      .call((b) => b.select(".lang-name").html((d) => `${esc(d.name)} <span class="code">${esc(d.code === "__other" ? "" : d.code)}</span>`))
      .call((b) => b.select<HTMLSpanElement>(".lang-fill").style("width", (d) => `${(100 * d.n) / max}%`))
      .call((b) => b.select(".lang-count").text((d) => num(d.n)));

    d3.select(container).selectAll(".empty").data(rows.length ? [] : [0]).join("div").attr("class", "empty").text("No records yet");
  }

  subscribe((_s, changed) => {
    if (changed.has("records") || changed.has("filters")) render();
  });
  render();
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return "";
  r = Math.min(r, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
