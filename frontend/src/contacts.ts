import * as d3 from "d3";
import * as topojson from "topojson-client";
import type { FeatureCollection, Geometry } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import world110 from "world-atlas/countries-110m.json";
import { api, ApiError } from "./api";
import type { Route } from "./router";
import type { AliasTier, ContactDetail, ContactRecord, ContactSummary, GeoRecord, PendingPerson, Tier } from "./types";
import { esc, formatTemporal, num, placeLabels, snippet, tooltip } from "./util";

type Topo = Topology<{ countries: GeometryCollection<{ name: string }> }>;
const topo = world110 as unknown as Topo;
const LAND = (topojson.feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>).features;

const LANG_NAMES = new Intl.DisplayNames(["en"], { type: "language" });
const langName = (c: string) => {
  try {
    return c === "und" ? "Undetermined" : LANG_NAMES.of(c) ?? c;
  } catch {
    return c;
  }
};

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

const range = (c: ContactSummary) => {
  if (!c.first_seen) return '<span class="muted">undated</span>';
  const a = formatTemporal(c.first_seen), b = c.last_seen ? formatTemporal(c.last_seen) : a;
  return a === b ? esc(a) : `${esc(a)} – ${esc(b)}`;
};

/** A record as returned inside a contact (ContactRecord) shaped enough for the shared highlighter. */
const asRecord = (r: ContactRecord, pending: PendingPerson[] = []): GeoRecord => ({
  id: r.id, kind: r.kind, content: r.content, timestamp: r.timestamp, ingested_at: "", labels: [], geo: [],
  temporal_mentions: [], centroid: null, metadata: {}, language: { code: r.language, name: null, confidence: 1, source: "detected" },
  contacts: r.contacts, pending_people: pending,
});

const TIER_HELP: Record<Tier, string> = {
  bronze: "bronze: found automatically",
  silver: "silver: confirmed by a person",
  gold: "gold standard: confirmed by two or more independent sources",
};

export function tierBadge(tier: Tier): string {
  return `<span class="tier tier-${tier}" title="${TIER_HELP[tier]}">${tier}</span>`;
}

const aliasChip = (a: AliasTier, removable: boolean) =>
  `<span class="chip alias-chip" title="${esc(TIER_HELP[a.tier])} · ${a.evidence.records} record source(s), ${a.evidence.user} confirmation(s), ${a.evidence.inferred} inferred">
    ${tierBadge(a.tier)} ${esc(a.alias)}${removable ? `<button type="button" class="chip-x" data-remove-alias="${esc(a.alias)}" aria-label="Remove alias ${esc(a.alias)}">×</button>` : ""}</span>`;

export function initContacts(page: HTMLElement, onChange: () => Promise<void>): { route: (r: Route) => void; refreshCount: () => void } {
  let token = 0;
  let listQuery = "";
  let sort: "records" | "name" | "recent" = "records";

  const refreshCount = async () => {
    try {
      const all = await api.contacts();
      const el = document.getElementById("contact-count");
      if (el) el.textContent = all.length ? num(all.length) : "";
    } catch {
      /* backend down: leave it */
    }
  };

  async function changed() {
    await onChange();
    refreshCount();
  }

  /* ---------------------------------------------------------------- directory */
  async function renderList() {
    const my = ++token;
    page.innerHTML = `
      <header class="page-head">
        <div>
          <h1>Contacts</h1>
          <p class="muted">People recognised in your records (spaCy NER), linked across records and languages.</p>
        </div>
        <div class="page-actions">
          <input type="search" id="c-q" placeholder="Search people or aliases…" aria-label="Search contacts" value="${esc(listQuery)}" />
          <select id="c-sort" aria-label="Sort contacts">
            <option value="records">Most records</option><option value="recent">Recently seen</option><option value="name">Name</option>
          </select>
          <button type="button" class="btn primary" id="c-new">New contact</button>
        </div>
      </header>
      <form class="card new-contact" id="c-form" hidden>
        <div class="field-row three">
          <label class="field"><span>Name</span><input name="name" required placeholder="e.g. Marie Curie" /></label>
          <label class="field"><span>Aliases <em>(comma-separated)</em></span><input name="aliases" placeholder="Curie, Maria Skłodowska" /></label>
          <label class="field"><span>Tags</span><input name="tags" placeholder="science, nobel" /></label>
        </div>
        <div class="actions"><button class="btn primary" type="submit">Create</button><button class="btn" type="button" id="c-cancel">Cancel</button><span class="status" id="c-status"></span></div>
      </form>
      <section class="card review-card" id="c-review" hidden></section>
      <section class="card contacts-table-card"><div id="c-list" class="contacts-list" aria-busy="true"><div class="empty">Loading…</div></div></section>`;
    const q = page.querySelector<HTMLInputElement>("#c-q")!;
    const sel = page.querySelector<HTMLSelectElement>("#c-sort")!;
    sel.value = sort;
    const form = page.querySelector<HTMLFormElement>("#c-form")!;
    page.querySelector("#c-new")!.addEventListener("click", () => { form.hidden = false; form.querySelector<HTMLInputElement>("input")!.focus(); });
    page.querySelector("#c-cancel")!.addEventListener("click", () => { form.hidden = true; });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const split = (k: string) => String(fd.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      try {
        const c = await api.createContact({ name: String(fd.get("name")).trim(), aliases: split("aliases"), tags: split("tags") });
        await changed();
        location.hash = `#/contacts/${encodeURIComponent(c.id)}`;
      } catch (err) {
        page.querySelector("#c-status")!.textContent = err instanceof ApiError ? err.message : "Failed";
      }
    });
    let timer: number | undefined;
    q.addEventListener("input", () => { window.clearTimeout(timer); timer = window.setTimeout(() => { listQuery = q.value; fill(); }, 200); });
    sel.addEventListener("change", () => { sort = sel.value as typeof sort; fill(); });

    async function fill() {
      const me = ++token;
      const list = page.querySelector<HTMLElement>("#c-list")!;
      let contacts: ContactSummary[];
      try {
        contacts = await api.contacts(listQuery);
      } catch {
        list.innerHTML = `<div class="empty error">Couldn't load contacts — is the backend running?</div>`;
        return;
      }
      if (me !== token) return;
      contacts.sort((a, b) =>
        sort === "name" ? a.name.localeCompare(b.name)
          : sort === "recent" ? (b.last_seen?.value ?? "").localeCompare(a.last_seen?.value ?? "")
            : b.record_count - a.record_count || a.name.localeCompare(b.name));
      list.removeAttribute("aria-busy");
      list.innerHTML = contacts.length ? `
        <table class="contacts-table">
          <thead><tr><th>Person</th><th class="num">Records</th><th>Places</th><th>Languages</th><th>Seen</th><th>Often with</th></tr></thead>
          <tbody>${contacts.map((c) => `
            <tr data-id="${esc(c.id)}">
              <td><a class="person-cell" href="#/contacts/${encodeURIComponent(c.id)}">
                <span class="avatar" aria-hidden="true">${esc(initials(c.name))}</span>
                <span><b class="hl person">${esc(c.name)}</b>
                ${c.alias_tiers.filter((a) => a.alias !== c.name).length ? `<span class="muted small aliases">${c.alias_tiers.filter((a) => a.alias !== c.name).slice(0, 3).map((a) => `${esc(a.alias)}<span class="tier-dot tier-${a.tier}" title="${TIER_HELP[a.tier]}"></span>`).join(" · ")}</span>` : ""}
                ${c.tags.length ? `<span class="tags">${c.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join("")}</span>` : ""}</span>
              </a></td>
              <td class="num"><b>${num(c.record_count)}</b></td>
              <td>${c.places.slice(0, 3).map((p) => `<span class="chip">${esc(p.name)}${p.count > 1 ? ` <span class="muted">${p.count}</span>` : ""}</span>`).join("") || '<span class="muted">—</span>'}</td>
              <td>${Object.keys(c.languages).map((l) => `<span class="pill" title="${esc(langName(l))}">${esc(l)}</span>`).join("")}</td>
              <td class="nowrap">${range(c)}</td>
              <td>${c.co_contacts.slice(0, 2).map((o) => `<a class="hl person" href="#/contacts/${encodeURIComponent(o.id)}">${esc(o.name)}</a>`).join(" ") || '<span class="muted">—</span>'}</td>
            </tr>`).join("")}</tbody>
        </table>`
        : `<div class="empty">${listQuery ? `No contacts match “${esc(listQuery)}”.` : "No contacts yet. Load the samples or add records that mention people — they appear here automatically."}</div>`;
      list.querySelectorAll<HTMLTableRowElement>("tr[data-id]").forEach((tr) => tr.addEventListener("click", (e) => {
        if (!(e.target as Element).closest("a")) location.hash = `#/contacts/${encodeURIComponent(tr.dataset.id!)}`;
      }));
    }
    if (my === token) { fill(); fillReview(); }
  }

  /** Ambiguous names: radio buttons to say who each one is (confirmations make links silver/gold). */
  async function fillReview() {
    const box = page.querySelector<HTMLElement>("#c-review");
    if (!box) return;
    let items: PendingPerson[] = [];
    try {
      items = await api.review();
    } catch {
      return;
    }
    box.hidden = !items.length;
    if (!items.length) return;
    box.innerHTML = `
      <div class="card-head"><h2>Needs review</h2><span class="pill warn-pill">${items.length}</span>
        <span class="hint">these names fit more than one person — your answer becomes a confirmed (silver) link</span></div>
      <div class="review-list">${items.map((it) => `
        <form class="review-item" data-id="${esc(it.id)}">
          <div class="review-text" dir="auto">${it.record ? snippet(asRecord(it.record, [it]), 220) : esc(it.text)}</div>
          <fieldset>
            <legend>Who is “${esc(it.text)}” here?</legend>
            ${it.candidates.map((c, i) => `<label class="radio"><input type="radio" name="who-${esc(it.id)}" value="link:${esc(c.id)}" ${i === 0 ? "" : ""} />
              <a class="hl person" href="#/contacts/${encodeURIComponent(c.id)}">${esc(c.name)}</a></label>`).join("")}
            <label class="radio"><input type="radio" name="who-${esc(it.id)}" value="new" /> Someone new (“${esc(it.text)}”)</label>
            <label class="radio"><input type="radio" name="who-${esc(it.id)}" value="ignore" /> Not a person / skip</label>
          </fieldset>
          <div class="actions"><button type="submit" class="btn small primary" disabled>Confirm</button>
            ${it.record ? `<a class="btn ghost small" href="#/record/${encodeURIComponent(it.record_id)}">Open record ↗</a>` : ""}</div>
        </form>`).join("")}</div>`;
    box.querySelectorAll<HTMLFormElement>(".review-item").forEach((f) => {
      const btn = f.querySelector<HTMLButtonElement>("button[type=submit]")!;
      f.addEventListener("change", () => { btn.disabled = !f.querySelector("input:checked"); });
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const v = (f.querySelector<HTMLInputElement>("input:checked")?.value) ?? "";
        btn.disabled = true;
        const id = f.dataset.id!;
        if (v.startsWith("link:")) await api.resolveReview(id, { action: "link", contact_id: v.slice(5) });
        else if (v === "new") await api.resolveReview(id, { action: "new" });
        else await api.resolveReview(id, { action: "ignore" });
        await changed();
        renderList();
      });
    });
  }

  /* ---------------------------------------------------------------- detail */
  async function renderDetail(id: string) {
    const my = ++token;
    page.innerHTML = `<div class="empty">Loading contact…</div>`;
    let c: ContactDetail;
    try {
      c = await api.contact(id);
    } catch (e) {
      if (my !== token) return;
      page.innerHTML = `<a class="back" href="#/contacts">← Contacts</a><div class="empty error">${e instanceof ApiError && e.status === 404 ? "This contact no longer exists." : "Couldn't load this contact."}</div>`;
      return;
    }
    if (my !== token) return;
    page.innerHTML = `
      <a class="back" href="#/contacts">← Contacts</a>
      <header class="contact-hero">
        <span class="avatar xl" aria-hidden="true">${esc(initials(c.name))}</span>
        <div class="hero-main">
          <h1><span class="hl person focus">${esc(c.name)}</span></h1>
          <p class="aliases">${c.alias_tiers.map((a) => aliasChip(a, a.alias !== c.name)).join(" ")}</p>
          ${c.tags.length ? `<p class="tags">${c.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join("")}</p>` : ""}
        </div>
        <div class="hero-actions">
          <button type="button" class="btn" id="d-edit">Edit</button>
          <button type="button" class="btn" id="d-merge">Merge…</button>
          <button type="button" class="btn ghost" id="d-notperson" title="Delete and stop recognising these names as people">Not a person</button>
          <button type="button" class="btn ghost danger" id="d-delete">Delete</button>
        </div>
      </header>
      <form class="card edit-contact" id="d-form" hidden>
        <div class="field-row three">
          <label class="field"><span>Name</span><input name="name" value="${esc(c.name)}" required /></label>
          <label class="field"><span>Add aliases <em>(comma-separated; existing ones are kept)</em></span><input name="aliases" value="" placeholder="e.g. Mutti" /></label>
          <label class="field"><span>Tags</span><input name="tags" value="${esc(c.tags.join(", "))}" /></label>
        </div>
        <div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="d-cancel">Cancel</button><span class="status" id="d-status"></span></div>
      </form>
      <form class="card merge-contact" id="d-mergeform" hidden>
        <label class="field"><span>Merge another contact into <b>${esc(c.name)}</b> (its names and records move here)</span>
          <select name="other" id="d-other"><option value="">Loading…</option></select></label>
        <div class="actions"><button class="btn primary" type="submit">Merge</button><button class="btn" type="button" id="d-mcancel">Cancel</button></div>
      </form>
      <div class="stat-tiles">
        ${tile("Records", num(c.record_count))}
        ${tile("Places", num(c.places.length))}
        ${tile("Countries", num(c.countries.length))}
        ${tile("Languages", Object.keys(c.languages).map((l) => esc(l)).join(" · ") || "—")}
        ${tile("First seen", c.first_seen ? esc(formatTemporal(c.first_seen)) : "—")}
        ${tile("Last seen", c.last_seen ? esc(formatTemporal(c.last_seen)) : "—")}
      </div>
      <div class="contact-grid">
        <section class="card c-map-card"><div class="card-head"><h2>Where they appear</h2><span class="hint">${num(c.places.length)} places in ${num(c.countries.length)} countries</span></div><div class="c-map" id="d-map"></div></section>
        <section class="card c-time-card"><div class="card-head"><h2>When</h2><span class="hint">records by date</span></div><div class="c-time" id="d-time"></div></section>
        <section class="card c-notes-card"><div class="card-head"><h2>Notes</h2><span class="status" id="n-status"></span></div>
          <textarea id="d-notes" rows="4" placeholder="Add notes about ${esc(c.name)}…">${esc(c.notes)}</textarea>
          <div class="actions"><button type="button" class="btn small" id="n-save">Save notes</button></div></section>
        <section class="card c-co-card"><div class="card-head"><h2>Often mentioned with</h2></div>
          ${c.co_contacts.length ? `<ul class="co-list">${c.co_contacts.map((o) => `<li><a class="hl person" href="#/contacts/${encodeURIComponent(o.id)}">${esc(o.name)}</a><span class="muted small">${o.shared_records} shared record${o.shared_records > 1 ? "s" : ""}</span></li>`).join("")}</ul>` : `<div class="muted">Nobody else appears in the same records yet.</div>`}
          ${c.countries.length ? `<h3 class="sub">Countries</h3><p>${c.countries.map((k) => `<span class="chip">${esc(k.country_name)} <span class="muted">${k.count}</span></span>`).join(" ")}</p>` : ""}
        </section>
        <section class="card c-records-card"><div class="card-head"><h2>Mentioned in ${num(c.record_count)} record${c.record_count === 1 ? "" : "s"}</h2></div>
          ${c.records.length ? `<ol class="c-records">${c.records.map((r) => `
            <li>
              <div class="record-meta"><span>${r.dated ? esc(formatTemporal(r.timestamp)) : "undated"}</span><span class="pill">${esc(r.language)}</span>
                ${r.places.slice(0, 4).map((p) => `<span class="chip">${esc(p.name)}</span>`).join("")}
                <span class="spacer"></span>
                ${tierBadge(r.tier)}<span class="muted small" title="how this record was linked">${esc(r.method)} · ${Math.round(r.confidence * 100)}%</span>
              </div>
              <div class="c-snippet" dir="auto">${snippet(asRecord(r), 260, c.id)}</div>
              <fieldset class="verdict" data-record="${esc(r.id)}">
                <legend>Is this ${esc(c.name)}?</legend>
                <label class="radio"><input type="radio" name="v-${esc(r.id)}" value="yes" ${r.tier !== "bronze" ? "checked" : ""} /> Yes</label>
                <label class="radio"><input type="radio" name="v-${esc(r.id)}" value="no" /> No, someone else</label>
                ${r.tier === "bronze" ? `<span class="muted small">unconfirmed</span>` : `<span class="muted small">confirmed ${r.confirmations}×</span>`}
              </fieldset>
              <div class="actions"><a class="btn small" href="#/record/${encodeURIComponent(r.id)}">Open record ↗</a></div>
            </li>`).join("")}</ol>` : `<div class="muted">Not linked to any record.</div>`}
        </section>
      </div>`;

    const $ = <T extends Element>(s: string) => page.querySelector(s) as T;
    const form = $<HTMLFormElement>("#d-form");
    $("#d-edit").addEventListener("click", () => { form.hidden = !form.hidden; });
    $("#d-cancel").addEventListener("click", () => { form.hidden = true; });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const split = (k: string) => String(fd.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      try {
        await api.updateContact(c.id, { name: String(fd.get("name")).trim(), aliases: split("aliases"), tags: split("tags") });
        await changed();
        renderDetail(c.id);
      } catch (err) {
        $("#d-status").textContent = err instanceof ApiError ? err.message : "Failed";
      }
    });
    const mform = $<HTMLFormElement>("#d-mergeform");
    $("#d-merge").addEventListener("click", async () => {
      mform.hidden = !mform.hidden;
      if (mform.hidden) return;
      const all = (await api.contacts()).filter((o) => o.id !== c.id);
      $<HTMLSelectElement>("#d-other").innerHTML = `<option value="">Choose a contact…</option>` +
        all.map((o) => `<option value="${esc(o.id)}">${esc(o.name)} (${o.record_count})</option>`).join("");
    });
    $("#d-mcancel").addEventListener("click", () => { mform.hidden = true; });
    mform.addEventListener("submit", async (e) => {
      e.preventDefault();
      const other = $<HTMLSelectElement>("#d-other").value;
      if (!other) return;
      await api.mergeContacts(c.id, other);
      await changed();
      renderDetail(c.id);
    });
    $("#d-notperson").addEventListener("click", async () => {
      if (!confirm(`Remove “${c.name}” and stop treating ${c.aliases.length > 1 ? "these names" : "this name"} as a person?`)) return;
      await api.notAPerson(c.id);
      await changed();
      location.hash = "#/contacts";
    });
    $("#d-delete").addEventListener("click", async () => {
      if (!confirm(`Delete contact “${c.name}”? It may be re-created if new records mention this person.`)) return;
      await api.deleteContact(c.id);
      await changed();
      location.hash = "#/contacts";
    });
    $("#n-save").addEventListener("click", async () => {
      await api.updateContact(c.id, { notes: $<HTMLTextAreaElement>("#d-notes").value });
      $("#n-status").textContent = "Saved ✓";
    });
    page.querySelectorAll<HTMLFieldSetElement>("fieldset.verdict").forEach((fs) => fs.addEventListener("change", async (e) => {
      const v = (e.target as HTMLInputElement).value as "yes" | "no";
      await api.verdict(c.id, fs.dataset.record!, v);
      await changed();
      renderDetail(c.id);
    }));
    page.querySelectorAll<HTMLButtonElement>("[data-remove-alias]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm(`Remove the alias “${b.dataset.removeAlias}” from ${c.name}?`)) return;
      await api.removeAlias(c.id, b.dataset.removeAlias!);
      await changed();
      renderDetail(c.id);
    }));
    drawMap($("#d-map"), c);
    drawTimeline($("#d-time"), c);
  }

  function route(r: Route) {
    if (r.recordId) return; // the record drilldown is an overlay: keep whichever page is underneath
    const onContacts = r.page !== "explore";
    page.hidden = !onContacts;
    document.getElementById("app")!.hidden = onContacts;
    if (r.page === "contacts") renderList();
    else if (r.page === "contact" && r.contactId) renderDetail(r.contactId);
    if (onContacts) window.scrollTo(0, 0);
  }

  refreshCount();
  return { route, refreshCount };
}

function tile(label: string, value: string): string {
  return `<div class="stat-tile"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`;
}

/**
 * Equal Earth projection framing the given points: fitted to their extent with a margin, but never
 * zoomed past ~4x world scale (a single place, or places in one city, would otherwise produce a
 * zero-size extent and an infinite scale). No points: the whole world.
 */
export function frameProjection(pts: [number, number][], width: number, height: number): d3.GeoProjection {
  const world = d3.geoEqualEarth().fitExtent([[8, 8], [width - 8, height - 8]], { type: "Sphere" });
  if (!pts.length) return world;
  const maxScale = world.scale() * 4;
  const mp = { type: "MultiPoint" as const, coordinates: pts };
  if (pts.length > 1) {
    const fitted = d3.geoEqualEarth().fitExtent([[40, 30], [width - 40, height - 30]], mp);
    if (Number.isFinite(fitted.scale()) && fitted.scale() <= maxScale) return fitted;
  }
  const centre = d3.geoCentroid(mp);
  const proj = d3.geoEqualEarth().rotate([-centre[0], 0]).scale(maxScale).translate([width / 2, height / 2]);
  const xy = proj(centre)!;
  return proj.translate([width - xy[0], height - xy[1]]); // put the centre in the middle
}

export function drawMap(host: HTMLElement, c: ContactDetail) {
  const width = host.clientWidth || 560;
  const height = Math.max(240, Math.round(width * 0.5));
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("class", "c-map-svg")
    .attr("role", "img").attr("aria-label", `Map of ${c.places.length} places where ${c.name} appears`);
  const pts = c.places.map((p) => [p.lon, p.lat] as [number, number]);
  const projection = frameProjection(pts, width, height);
  const path = d3.geoPath(projection);
  const present = new Set(c.countries.map((k) => String(k.iso_n3 ?? "").padStart(3, "0")));
  svg.append("path").attr("class", "c-sphere").attr("d", path({ type: "Sphere" }));
  svg.append("g").selectAll("path").data(LAND).join("path")
    .attr("class", (f) => `c-land${present.has(String(f.id)) ? " present" : ""}`).attr("d", path);
  const r = d3.scaleSqrt().domain([1, d3.max(c.places, (p) => p.count) ?? 1]).range([5, 13]);
  const g = svg.append("g");
  g.selectAll("circle").data(c.places).join("circle").attr("class", "c-pt")
    .attr("cx", (p) => projection([p.lon, p.lat])?.[0] ?? -99).attr("cy", (p) => projection([p.lon, p.lat])?.[1] ?? -99)
    .attr("r", (p) => r(p.count))
    .on("mousemove", (ev: MouseEvent, p) => tooltip.show(`<div class="tt-title">${esc(p.name)}</div>
      <div class="tt-muted">${esc(p.country_name ?? "")}</div>
      <div class="tt-row"><span>Records</span><b>${p.count}</b></div>
      <div class="tt-row"><span>As</span><b>${esc(Object.entries(p.roles).map(([k, v]) => `${k} ${v}`).join(", "))}</b></div>`, ev))
    .on("mouseleave", () => tooltip.hide());
  const top = c.places.slice(0, 8).map((p) => {
    const [x, y] = projection([p.lon, p.lat]) ?? [-99, -99];
    return { x, y, r: r(p.count), text: p.name };
  });
  const boxes = placeLabels(top, 6.4, 12, { w: width, h: height });
  g.selectAll("text").data(top.map((t, i) => ({ ...t, ...boxes[i] })).filter((t) => t.visible)).join("text")
    .attr("class", "place-label").attr("x", (t) => t.x).attr("y", (t) => t.y).attr("text-anchor", (t) => t.anchor).text((t) => t.text);
}

export function drawTimeline(host: HTMLElement, c: ContactDetail) {
  const recs = c.records.filter((r) => r.dated);
  if (!recs.length) {
    host.innerHTML = `<div class="muted">No dated records.</div>`;
    return;
  }
  const width = host.clientWidth || 560;
  const height = 96;
  const dates = recs.map((r) => new Date(r.timestamp.value));
  const ext = d3.extent(dates) as [Date, Date];
  const x = d3.scaleUtc().domain([d3.utcYear.offset(ext[0], -1), d3.utcYear.offset(ext[1], 1)]).range([16, width - 16]).nice();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("class", "chart-svg")
    .attr("role", "img").attr("aria-label", `Timeline of ${recs.length} dated records`);
  const y = 44;
  svg.append("line").attr("class", "dd-axis-line").attr("x1", 16).attr("x2", width - 16).attr("y1", y).attr("y2", y);
  svg.append("g").selectAll("circle").data(recs).join("circle").attr("class", "c-tick")
    .attr("cx", (r) => x(new Date(r.timestamp.value))).attr("cy", y).attr("r", 7)
    .on("mousemove", (ev: MouseEvent, r) => tooltip.show(`<div class="tt-title">${esc(formatTemporal(r.timestamp))}</div>
      <div class="tt-snippet">${esc(r.content.slice(0, 120))}${r.content.length > 120 ? "…" : ""}</div><div class="tt-foot">Click to open</div>`, ev))
    .on("mouseleave", () => tooltip.hide())
    .on("click", (_ev, r) => { location.hash = `#/record/${encodeURIComponent(r.id)}`; });
  svg.append("g").attr("class", "axis x").attr("transform", `translate(0,${y + 18})`)
    .call(d3.axisBottom(x).ticks(Math.max(3, width / 100)).tickSizeOuter(0));
}
