import { api, ApiError } from "./api";
import { getState, setState, subscribe } from "./state";
import type { Candidate, GeoRecord, Place, RecordInput, RecordKind } from "./types";
import { KIND_LABEL, debounce, esc, formatTemporal, highlight, kindColor, num, pct } from "./util";

const LANGS: [string, string][] = [
  ["en", "English"], ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["pt", "Portuguese"],
  ["it", "Italian"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["uk", "Ukrainian"],
  ["tr", "Turkish"], ["ar", "Arabic"], ["he", "Hebrew"], ["fa", "Persian"], ["hi", "Hindi"],
  ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"],
];

const PLACEHOLDER: Record<RecordKind, string> = {
  string: "A place name, address-like string or coordinates — e.g. “Paris, Texas”, “Wien”, “東京”, “48.2N, 16.37E”",
  text: "Paste any text. Places, dates and the language are extracted — e.g. “Am 3. Oktober 1990 feierten die Menschen in Berlin und Leipzig…”",
  label: "Type a label and press Enter or comma",
};

export function initInput(panel: HTMLElement, onSaved: () => void): void {
  let kind: RecordKind = "text";
  let labels: string[] = [];
  let lastPreviewKey = "";

  panel.innerHTML = `
    <section class="card input-card">
      <div class="card-head"><h2>Resolve</h2></div>
      <div class="tabs" role="tablist">
        ${(["string", "text", "label"] as RecordKind[]).map((k) =>
          `<button type="button" role="tab" class="tab" data-kind="${k}"><span class="dot" style="background:${kindColor(k)}"></span>${KIND_LABEL[k]}</button>`).join("")}
      </div>
      <form id="input-form" autocomplete="off">
        <div class="field" id="field-main"></div>
        <div class="field-row">
          <label class="field"><span>Timestamp</span>
            <input id="in-ts" type="text" placeholder="auto (from text, else now)" />
          </label>
          <label class="field"><span>Language</span>
            <select id="in-lang"><option value="">auto-detect</option>
              ${LANGS.map(([c, n]) => `<option value="${c}">${n} (${c})</option>`).join("")}
            </select>
          </label>
        </div>
        <label class="field" id="tags-field"><span>Labels <em>(optional tags)</em></span>
          <input id="in-tags" type="text" placeholder="comma-separated, e.g. climate, news" />
        </label>
        <div class="actions">
          <button type="submit" class="btn primary" id="btn-save">Save record</button>
          <button type="button" class="btn" id="btn-preview">Preview</button>
          <span class="status" id="in-status" role="status"></span>
        </div>
      </form>
      <div class="suggest" id="suggest" hidden></div>
    </section>
    <section class="card preview-card" id="preview" hidden></section>`;

  const $ = <T extends HTMLElement>(sel: string) => panel.querySelector(sel) as T;
  const fieldMain = $("#field-main");
  const ts = $<HTMLInputElement>("#in-ts");
  const lang = $<HTMLSelectElement>("#in-lang");
  const tags = $<HTMLInputElement>("#in-tags");
  const status = $("#in-status");
  const suggest = $("#suggest");
  const previewEl = $("#preview");

  function renderField() {
    panel.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.kind === kind);
      t.setAttribute("aria-selected", String(t.dataset.kind === kind));
    });
    $("#tags-field").hidden = kind === "label";
    suggest.hidden = true;
    if (kind === "string") {
      fieldMain.innerHTML = `<input id="in-main" type="text" placeholder="${esc(PLACEHOLDER.string)}" />`;
    } else if (kind === "text") {
      fieldMain.innerHTML = `<textarea id="in-main" rows="7" placeholder="${esc(PLACEHOLDER.text)}"></textarea>`;
    } else {
      fieldMain.innerHTML = `<div class="tag-input" id="tag-box"><input id="in-main" type="text" placeholder="${esc(PLACEHOLDER.label)}" /></div>`;
      renderTags();
    }
    const main = $<HTMLInputElement>("#in-main");
    main.addEventListener("input", () => {
      if (kind === "string") liveGeocode(main.value);
    });
    if (kind === "label") {
      main.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === ",") && main.value.trim()) {
          e.preventDefault();
          labels.push(...main.value.split(",").map((s) => s.trim()).filter(Boolean));
          main.value = "";
          renderTags();
        } else if (e.key === "Backspace" && !main.value && labels.length) {
          labels.pop();
          renderTags();
        }
      });
    }
  }

  function renderTags() {
    const box = $("#tag-box");
    box.querySelectorAll(".tag").forEach((t) => t.remove());
    const input = $<HTMLInputElement>("#in-main");
    labels.forEach((l, i) => {
      const t = document.createElement("span");
      t.className = "tag";
      t.innerHTML = `${esc(l)}<button type="button" aria-label="Remove ${esc(l)}">×</button>`;
      t.querySelector("button")!.addEventListener("click", () => {
        labels.splice(i, 1);
        renderTags();
      });
      box.insertBefore(t, input);
    });
  }

  let geocodeCtl: AbortController | null = null;
  const liveGeocode = debounce(async (q: string) => {
    geocodeCtl?.abort();
    if (q.trim().length < 2) {
      suggest.hidden = true;
      return;
    }
    geocodeCtl = new AbortController();
    try {
      const cands = await api.geocode(q, lang.value || undefined, geocodeCtl.signal);
      renderSuggestions(cands);
    } catch (e) {
      if ((e as Error).name !== "AbortError") suggest.hidden = true;
    }
  }, 180);

  function renderSuggestions(cands: Candidate[]) {
    suggest.hidden = false;
    suggest.innerHTML = cands.length
      ? `<div class="suggest-head">Gazetteer candidates</div>` +
        cands.map((c) => `
          <div class="cand">
            <div class="cand-main"><b>${esc(c.place.name)}</b>
              <span class="muted">${esc([c.place.admin1, c.place.country_name].filter(Boolean).join(", "))}</span></div>
            <div class="cand-meta">
              <span class="pill">${esc(c.place.feature_class.replace("_", " "))}</span>
              <span class="pill">${esc(c.match_type)}${c.matched_lang !== "primary" ? ` · ${esc(c.matched_lang)}` : ""}</span>
              <span class="conf"><span class="conf-bar" style="width:${c.score * 100}%"></span></span>
              <span class="muted num">${pct(c.score)}</span>
            </div>
          </div>`).join("")
      : `<div class="muted">No gazetteer match.</div>`;
  }

  function collect(): RecordInput | null {
    const main = $<HTMLInputElement>("#in-main");
    const input: RecordInput = { kind };
    if (kind === "label") {
      const pending = main.value.split(",").map((s) => s.trim()).filter(Boolean);
      if (pending.length) {
        labels.push(...pending);
        main.value = "";
        renderTags();
      }
      if (!labels.length) return null;
      input.labels = [...labels];
    } else {
      if (!main.value.trim()) return null;
      input.content = main.value;
      const t = tags.value.split(",").map((s) => s.trim()).filter(Boolean);
      if (t.length) input.labels = t;
    }
    if (ts.value.trim()) input.timestamp = ts.value.trim();
    if (lang.value) input.language = lang.value;
    return input;
  }

  function setStatus(msg: string, err = false) {
    status.textContent = msg;
    status.classList.toggle("error", err);
  }

  async function preview() {
    const input = collect();
    if (!input) return setStatus("Enter something to resolve.", true);
    setStatus("Resolving…");
    try {
      const rec = await api.analyze(input);
      lastPreviewKey = JSON.stringify(input);
      setState({ preview: rec });
      setStatus(`${rec.geo.length} place${rec.geo.length === 1 ? "" : "s"} found`);
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : "Request failed", true);
    }
  }

  async function save() {
    const input = collect();
    if (!input) return setStatus("Enter something to resolve.", true);
    setStatus("Saving…");
    try {
      const p = getState().preview;
      // Save the previewed record (including any corrections made in the preview).
      const rec = p && lastPreviewKey === JSON.stringify(input) ? await api.save(p) : await api.create(input);
      setState({ preview: null, selectedId: rec.id });
      setStatus("Saved ✓");
      onSaved();
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : "Request failed", true);
    }
  }

  panel.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      kind = t.dataset.kind as RecordKind;
      setState({ preview: null });
      setStatus("");
      renderField();
    }),
  );
  $("#btn-preview").addEventListener("click", preview);
  $<HTMLFormElement>("#input-form").addEventListener("submit", (e) => {
    e.preventDefault();
    save();
  });
  lang.addEventListener("change", () => kind === "string" && liveGeocode($<HTMLInputElement>("#in-main").value));

  subscribe((s, changed) => {
    if (changed.has("preview")) renderPreview(previewEl, s.preview);
  });
  renderField();
}

/** Ontology view of a record: time / language / geo facets with highlighted content. */
export function renderRecordDetail(rec: GeoRecord, opts: { editable: boolean }): string {
  const t = rec.timestamp;
  return `
    <div class="content-hl" dir="auto">${highlight(rec)}</div>
    <dl class="facets">
      <div class="facet"><dt>Time</dt><dd><b>${esc(formatTemporal(t))}</b>
        <span class="pill">${esc(t.granularity)}</span><span class="pill src-${t.source}">${esc(t.source)}</span>
        ${t.surface && t.source !== "provided" ? `<span class="muted">from “${esc(t.surface)}”</span>` : ""}</dd></div>
      <div class="facet"><dt>Language</dt><dd><b>${esc(rec.language.name ?? rec.language.code)}</b>
        <span class="pill">${esc(rec.language.code)}</span><span class="pill src-${rec.language.source}">${esc(rec.language.source)}</span>
        <span class="muted">${pct(rec.language.confidence)}</span></dd></div>
      <div class="facet"><dt>Geo</dt><dd>${rec.geo.length ? `<b>${rec.geo.length}</b> mention${rec.geo.length > 1 ? "s" : ""}` : '<span class="muted">none resolved</span>'}
        ${rec.centroid ? `<span class="muted">centroid ${rec.centroid.lat.toFixed(2)}, ${rec.centroid.lon.toFixed(2)}</span>` : ""}</dd></div>
      ${rec.concepts?.length ? `<div class="facet"><dt>Concepts</dt><dd>${rec.concepts.map((c) => `<span class="pill" title="${esc(c.type)}">${esc(c.text)}</span>`).join("")}</dd></div>` : ""}
      ${rec.labels.length ? `<div class="facet"><dt>Labels</dt><dd>${rec.labels.map((l) => `<span class="pill">${esc(l)}</span>`).join("")}</dd></div>` : ""}
      ${rec.temporal_mentions.length > 1 ? `<div class="facet"><dt>Dates</dt><dd>${rec.temporal_mentions.map((m) => `<span class="pill time">${esc(formatTemporal(m))}</span>`).join("")}</dd></div>` : ""}
    </dl>
    <ol class="mentions">
      ${rec.geo.map((m, i) => `
        <li class="mention" data-mention="${i}">
          <div class="mention-head">
            <span class="surface">“${esc(m.surface)}”</span><span class="arrow">→</span>
            <b>${esc(m.place.name)}</b>
            <span class="muted">${esc([m.place.admin1, m.place.country_name].filter(Boolean).join(", "))}</span>
          </div>
          <div class="mention-meta">
            ${m.role && m.role !== "unspecified" ? `<span class="role-badge role-${m.role}">${esc(m.role)}${m.role_cue ? ` · “${esc(m.role_cue)}”` : ""}</span>` : ""}
            <span class="pill">${esc(m.place.feature_class.replace(/_/g, " "))}</span>
            <span class="pill">${esc(m.match_type)}${m.matched_lang && !["primary", "alt", "und"].includes(m.matched_lang) ? ` · ${esc(m.matched_lang)}` : ""}</span>
            <span class="conf"><span class="conf-bar" style="width:${m.confidence * 100}%"></span></span>
            <span class="num muted">${pct(m.confidence)}</span>
            <span class="num muted">${m.place.lat.toFixed(3)}, ${m.place.lon.toFixed(3)}</span>
            ${m.place.population ? `<span class="num muted">pop ${num(Math.round(m.place.population))}</span>` : ""}
          </div>
          ${m.alternatives.length ? `<div class="alts"><span class="muted">${opts.editable ? "Not right? Use:" : "Alternatives:"}</span>
            ${m.alternatives.map((a, j) => opts.editable
              ? `<button type="button" class="alt" data-mention="${i}" data-alt="${j}">${esc(placeLabel(a))}</button>`
              : `<span class="alt static">${esc(placeLabel(a))}</span>`).join("")}</div>` : ""}
        </li>`).join("")}
    </ol>
    <details class="raw"><summary>Ontology JSON</summary><pre>${esc(JSON.stringify(rec, null, 2))}</pre></details>`;
}

function placeLabel(p: Place): string {
  return [p.name, p.admin1, p.country_code].filter(Boolean).join(", ");
}

function renderPreview(el: HTMLElement, rec: GeoRecord | null) {
  el.hidden = !rec;
  if (!rec) return;
  el.innerHTML = `<div class="card-head"><h2>Preview</h2>
      <span class="pill kind" style="--k:${kindColor(rec.kind)}">${KIND_LABEL[rec.kind]}</span>
      <button type="button" class="btn ghost small" id="pv-close" aria-label="Close preview">×</button></div>
    ${renderRecordDetail(rec, { editable: true })}`;
  el.querySelector("#pv-close")!.addEventListener("click", () => setState({ preview: null }));
  el.querySelectorAll<HTMLButtonElement>("button.alt").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.mention);
      const j = Number(b.dataset.alt);
      const geo = rec.geo.map((m, k) => {
        if (k !== i) return m;
        const chosen = m.alternatives[j];
        return { ...m, place: chosen, alternatives: [m.place, ...m.alternatives.filter((_, x) => x !== j)],
          confidence: 1, match_type: m.match_type };
      });
      const edited: GeoRecord = { ...rec, geo, metadata: { ...rec.metadata, corrected: true } };
      setState({ preview: edited });
    }),
  );
}
