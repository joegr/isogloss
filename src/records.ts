import { api } from "./api";
import { openRecord } from "./drilldown";
import { renderRecordDetail } from "./input";
import { filteredRecords, getState, setFilters, setState, subscribe } from "./state";
import type { GeoRecord, RecordKind } from "./types";
import { KINDS, KIND_LABEL, debounce, esc, formatTemporal, kindColor, snippet } from "./util";

export function initRecords(panel: HTMLElement, reload: () => void): void {
  panel.innerHTML = `
    <section class="card records-card">
      <div class="card-head"><h2>Records</h2><span class="hint" id="rec-count"></span></div>
      <div class="record-list" id="record-list" role="list"></div>
    </section>
    <section class="card detail-card" id="detail" hidden></section>`;
  const list = panel.querySelector<HTMLElement>("#record-list")!;
  const count = panel.querySelector<HTMLElement>("#rec-count")!;
  const detail = panel.querySelector<HTMLElement>("#detail")!;

  function renderList() {
    const s = getState();
    const sc = s.near?.scores;
    const recs = filteredRecords(s).slice().sort((a, b) =>
      sc && sc.size ? (sc.get(b.id) ?? 0) - (sc.get(a.id) ?? 0) : b.timestamp.value.localeCompare(a.timestamp.value));
    count.textContent = recs.length === s.records.length ? `${recs.length}` : `${recs.length} of ${s.records.length}`;
    list.innerHTML = recs.length
      ? recs.map((r) => recordCard(r, r.id === s.selectedId, sc?.get(r.id))).join("")
      : `<div class="empty">${s.records.length ? "No records match the filters." : "Nothing here yet. Resolve something on the left, or load the samples."}</div>`;
    list.querySelectorAll<HTMLButtonElement>(".open-btn").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      openRecord(b.dataset.open!);
    }));
    list.querySelectorAll<HTMLElement>(".record").forEach((el) => {
      el.addEventListener("dblclick", () => openRecord(el.dataset.id!));
      const pick = () => setState({ selectedId: getState().selectedId === el.dataset.id ? null : el.dataset.id! });
      el.addEventListener("click", (e) => { if (!(e.target as Element).closest("a")) pick(); });
      el.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick()));
    });
    panel.querySelector(".record.selected")?.scrollIntoView({ block: "nearest" });
  }

  function renderDetail() {
    const s = getState();
    const rec = s.records.find((r) => r.id === s.selectedId);
    detail.hidden = !rec;
    if (!rec) return;
    detail.innerHTML = `
      <div class="card-head"><h2>Record</h2>
        <span class="pill kind" style="--k:${kindColor(rec.kind)}">${KIND_LABEL[rec.kind]}</span>
        <code class="muted">${esc(rec.id)}</code>
        <span class="spacer"></span>
        <button type="button" class="btn small primary" id="d-open">Open ↗</button>
        <button type="button" class="btn ghost small" id="d-focus">Zoom to</button>
        <button type="button" class="btn ghost small danger" id="d-del">Delete</button>
        <button type="button" class="btn ghost small" id="d-close" aria-label="Close">×</button>
      </div>
      <div class="tabs small" role="tablist">
        <button type="button" class="tab active" data-tab="ontology">Ontology</button>
        <button type="button" class="tab" data-tab="related">Related</button>
        <button type="button" class="tab" data-tab="tokens">Tokens</button>
      </div>
      <div class="tab-body" data-body="ontology">${renderRecordDetail(rec, { editable: false })}</div>
      <div class="tab-body" data-body="related" hidden></div>
      <div class="tab-body" data-body="tokens" hidden></div>`;
    detail.querySelectorAll<HTMLButtonElement>(".tabs .tab").forEach((t) => t.addEventListener("click", () => {
      detail.querySelectorAll(".tabs .tab").forEach((x) => x.classList.toggle("active", x === t));
      detail.querySelectorAll<HTMLElement>(".tab-body").forEach((b) => (b.hidden = b.dataset.body !== t.dataset.tab));
      if (t.dataset.tab === "related") renderRelated(detail.querySelector<HTMLElement>('[data-body="related"]')!, rec);
      if (t.dataset.tab === "tokens") renderTokens(detail.querySelector<HTMLElement>('[data-body="tokens"]')!, rec);
    }));
    detail.querySelector("#d-close")!.addEventListener("click", () => setState({ selectedId: null }));
    detail.querySelector("#d-open")!.addEventListener("click", () => openRecord(rec.id));
    detail.querySelector("#d-focus")!.addEventListener("click", () =>
      window.dispatchEvent(new CustomEvent("geomap:focus", { detail: rec })));
    detail.querySelector("#d-del")!.addEventListener("click", async () => {
      if (!confirm("Delete this record?")) return;
      await api.remove(rec.id);
      setState({ selectedId: null });
      reload();
    });
  }

  subscribe((_s, changed) => {
    if (changed.has("records") || changed.has("filters") || changed.has("selectedId") || changed.has("near")) renderList();
    if (changed.has("records") || changed.has("selectedId")) renderDetail();
  });
  renderList();
}

function recordCard(r: GeoRecord, selected: boolean, score?: number): string {
  const text = r.kind === "label" ? r.labels.join(" · ") : r.content;
  const when = r.dated === false ? "undated" : formatTemporal(r.timestamp);
  const places = [...new Set(r.geo.map((m) => m.place.name))];
  return `
    <div class="record${selected ? " selected" : ""}" role="listitem" tabindex="0" data-id="${r.id}">
      <div class="record-meta">
        <span class="dot" style="background:${kindColor(r.kind)}" title="${KIND_LABEL[r.kind]}"></span>
        <span>${esc(when)}</span>
        <span class="pill">${esc(r.language.code)}</span>
        <span class="spacer"></span>
        ${score != null ? `<span class="pill score" title="similarity">${Math.round(score * 100)}%</span>` : ""}
        <span class="muted">${r.geo.length} place${r.geo.length === 1 ? "" : "s"}</span>
        <button type="button" class="open-btn" data-open="${r.id}" title="Open drilldown" aria-label="Open drilldown">↗</button>
      </div>
      <div class="record-text" dir="auto">${r.kind === "label" ? esc(text) : snippet(r, 150)}</div>
      ${places.length ? `<div class="record-places">${places.slice(0, 5).map((p) => `<span class="chip">${esc(p)}</span>`).join("")}${places.length > 5 ? `<span class="muted">+${places.length - 5}</span>` : ""}</div>` : ""}
    </div>`;
}

/** Filter bar: search, kind segmented control, and chips for active filters. */
export function initFilters(bar: HTMLElement): void {
  bar.innerHTML = `
    <div class="search-wrap">
      <input type="search" id="f-q" class="search" placeholder="Search records…" aria-label="Search records" />
      <label class="sem-toggle" title="Multilingual semantic search (vector store), constrained by the active time and language filters">
        <input type="checkbox" id="f-sem" /> semantic</label>
    </div>
    <div class="segmented" role="group" aria-label="Record kind">
      <button type="button" data-kind="">All</button>
      ${KINDS.map((k) => `<button type="button" data-kind="${k}"><span class="dot" style="background:${kindColor(k)}"></span>${KIND_LABEL[k]}</button>`).join("")}
    </div>
    <div class="chips" id="f-chips"></div>`;
  const q = bar.querySelector<HTMLInputElement>("#f-q")!;
  const chips = bar.querySelector<HTMLElement>("#f-chips")!;
  const sem = bar.querySelector<HTMLInputElement>("#f-sem")!;
  const runSearch = debounce(async () => {
    if (!sem.checked) {
      if (getState().near?.label.startsWith("≈")) setState({ near: null });
      setFilters({ q: q.value });
      return;
    }
    setFilters({ q: "" });
    const text = q.value.trim();
    if (!text) return setState({ near: null });
    const f = getState().filters;
    const hits = await api.search(text, { ...f, q: "", country: null });
    const keep = hits.filter((h) => h.score >= 0.2);
    setState({ near: { label: `≈ “${text}”`, anchor: null, ids: new Set(keep.map((h) => h.record_id)),
      scores: new Map(keep.map((h) => [h.record_id, h.score])) } });
  }, 250);
  q.addEventListener("input", runSearch);
  sem.addEventListener("change", runSearch);
  bar.querySelectorAll<HTMLButtonElement>(".segmented button").forEach((b) =>
    b.addEventListener("click", () => setFilters({ kind: (b.dataset.kind || null) as RecordKind | null })));

  function render() {
    const { filters: f, countries } = getState();
    bar.querySelectorAll<HTMLButtonElement>(".segmented button").forEach((b) => {
      const on = (b.dataset.kind || null) === f.kind;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const items: [string, string, () => void][] = [];
    if (f.country) {
      const name = countries.find((c) => c.country_code === f.country)?.country_name ?? f.country;
      items.push(["Country", name, () => setFilters({ country: null })]);
    }
    if (f.language) items.push(["Language", f.language, () => setFilters({ language: null })]);
    if (f.start && f.end) items.push(["Time", `${fmt(f.start)} → ${fmt(f.end)}`, () => setFilters({ start: null, end: null })]);
    const near = getState().near;
    if (near) items.push([near.anchor ? "Near" : "Semantic", `${near.label} (${near.ids.size})`, () => setState({ near: null })]);
    chips.innerHTML = items.map(([k, v], i) => `<button type="button" class="chip filter" data-i="${i}">${esc(k)}: <b>${esc(v)}</b> ×</button>`).join("") +
      (items.length > 1 ? `<button type="button" class="btn ghost small" id="f-clear">Clear all</button>` : "");
    chips.querySelectorAll<HTMLButtonElement>(".chip.filter").forEach((c) => c.addEventListener("click", () => items[Number(c.dataset.i)][2]()));
    chips.querySelector("#f-clear")?.addEventListener("click", () =>
      { setState({ near: null }); setFilters({ country: null, language: null, start: null, end: null }); });
  }
  subscribe((_s, changed) => {
    if (changed.has("filters") || changed.has("countries") || changed.has("near")) render();
  });
  render();
}

async function renderRelated(el: HTMLElement, rec: GeoRecord) {
  el.innerHTML = `<div class="muted">Loading…</div>`;
  const s = getState();
  const [neigh, sim, simNear] = await Promise.all([
    api.neighbors(rec.id, s.proximity),
    api.similar(rec.id),
    rec.centroid ? api.similar(rec.id, { radius_km: 2000 }) : Promise.resolve([]),
  ]);
  const byId = new Map(s.records.map((r) => [r.id, r]));
  const title = (id: string) => esc((byId.get(id)?.content ?? id).slice(0, 70));
  const bar = (v: number | null | undefined) => `<span class="conf"><span class="conf-bar" style="width:${(v ?? 0) * 100}%"></span></span>`;
  el.innerHTML = `
    <h3 class="sub">Graph proximity <span class="muted">time × language × place × meaning</span></h3>
    ${neigh.length ? `<ol class="related">${neigh.map((n) => `
      <li data-id="${n.id}"><div class="rel-title">${title(n.id)}</div>
        <div class="rel-axes">
          <span>time ${bar(n.time)}</span><span>lang <em>${esc(n.lang_relation)}</em> ${bar(n.lang)}</span>
          <span>geo ${bar(n.geo)}</span>${n.sem != null ? `<span>sem ${bar(n.sem)}</span>` : ""}
          <b class="num">${Math.round(n.weight * 100)}%</b></div></li>`).join("")}</ol>
      <button type="button" class="btn small" id="near-filter">Show only these on map & charts</button>`
      : `<div class="muted">No neighbours within the current proximity settings (see Network view).</div>`}
    <h3 class="sub">Semantically similar <span class="muted">vector store · any place, any time</span></h3>
    ${simList(sim, title)}
    ${rec.centroid ? `<h3 class="sub">Similar within 2,000 km <span class="muted">vector + geo filter</span></h3>${simList(simNear, title)}` : ""}`;
  el.querySelectorAll<HTMLElement>("[data-id]").forEach((li) => li.addEventListener("click", () => setState({ selectedId: li.dataset.id! })));
  el.querySelector("#near-filter")?.addEventListener("click", () =>
    setState({ near: { label: rec.content.slice(0, 24), anchor: rec.id, ids: new Set(neigh.map((n) => n.id)),
      scores: new Map(neigh.map((n) => [n.id, n.weight])) } }));
}

function simList(hits: { record_id: string; score: number; ts: string; language: string }[], title: (id: string) => string): string {
  return hits.length
    ? `<ol class="related">${hits.map((h) => `<li data-id="${h.record_id}"><div class="rel-title">${title(h.record_id)}</div>
        <div class="rel-axes"><span class="muted">${esc(h.ts.slice(0, 10))} · ${esc(h.language)}</span><b class="num">${Math.round(h.score * 100)}%</b></div></li>`).join("")}</ol>`
    : `<div class="muted">None.</div>`;
}

async function renderTokens(el: HTMLElement, rec: GeoRecord) {
  el.innerHTML = `<div class="muted">Loading…</div>`;
  const t = await api.tokens(rec.id);
  el.innerHTML = `
    <div class="token-flow" dir="auto">${t.tokens.map((tok) => `<span class="tok${tok.geo_place ? " geo" : ""}${tok.time_value ? " time" : ""}${tok.ent_type ? " ent" : ""}${tok.sent_start && tok.i ? " sent" : ""}"
        title="${esc(`#${tok.i} norm=${tok.norm} shape=${tok.shape}${tok.ent_type ? ` ent=${tok.ent_iob}-${tok.ent_type}` : ""}${tok.geo_place ? ` kb=${tok.geo_place}` : ""}${tok.time_value ? ` time=${tok.time_value.slice(0, 10)}` : ""}`)}">${esc(tok.text)}${tok.ent_type ? `<sub>${esc(tok.ent_type)}</sub>` : ""}</span>`).join("")}</div>
    <div class="muted small-note">${t.tokens.length} tokens · ${t.ents.length} NER entities (xx_ent_wiki_sm) · hover a token for its attributes</div>
    <table class="tok-table"><thead><tr><th>#</th><th>text</th><th>norm</th><th>NER</th><th>KB entity</th><th>time</th></tr></thead>
      <tbody>${t.tokens.filter((x) => !x.is_punct).map((x) => `<tr class="${x.geo_place ? "geo" : ""}${x.time_value ? " time" : ""}">
        <td class="num">${x.i}</td><td>${esc(x.text)}</td><td class="muted">${esc(x.norm)}</td><td>${esc(x.ent_type ?? "")}</td>
        <td><code>${esc(x.geo_place ?? "")}</code></td><td>${esc(x.time_value?.slice(0, 10) ?? "")}</td></tr>`).join("")}</tbody></table>`;
}
