import { esc } from "../util";
import { api } from "./api";
import { toWav } from "./audio";
import { entityClass, highlightField } from "./highlight";
import { getState, setState, subscribe } from "./state";
import type { Entity, Speaker } from "./types";

const COARSE = new Set(["state", "country"]);

/**
 * Right panel: one speaker's whole record — every field, the entities NER
 * found (highlighted where they occur and drawn on the globe), recordings
 * with playback, and the actions the record allows.
 */
export function initDetail(root: HTMLElement, reload: () => Promise<void>): void {
  const render = (sp: Speaker | null) => {
    if (!sp) {
      root.innerHTML = `<section class="card empty"><h2>No speaker selected</h2>
        <p class="hint">Click a dot to open a record, or use “Drop a speaker on the map” to create one.</p></section>`;
      return;
    }
    const r = sp.record;
    const s = getState().schema;
    const label = (name: string) => s?.fields.find((f) => f.name === name)?.label ?? name.replace(/_/g, " ");
    const byField = (f: string) => sp.entities.filter((e) => e.field === f);
    const shown = ["native_language", "alternative_native_language", "age", "gender", "onset_age",
      "english_residence", "length_of_residence", "learning_style", "ethnologue_language_code"];
    const facet = (k: string) => {
      const v = r[k];
      if (v == null || v === "") return "";
      const html = k === "english_residence" ? highlightField(String(v), byField(k)) : esc(String(v));
      return `<div class="facet"><dt>${esc(label(k))}</dt><dd>${html}</dd></div>`;
    };
    const g = sp.geo;
    const placed = g.lon != null
      ? `${esc(g.birthplace ?? "pinned")} <span class="pill${COARSE.has(g.match ?? "") ? " warn" : ""}" title="how the point was found">${esc(g.match ?? "")}</span>
         <div class="hint num">${g.lat!.toFixed(4)}, ${g.lon.toFixed(4)}${g.matched_name && g.match !== "pin" ? ` · ${esc(g.matched_name)}${g.admin1 ? `, ${esc(g.admin1)}` : ""}` : ""}</div>`
      : `<span class="muted">not placed</span>`;

    root.innerHTML = `
      <section class="card detail-card">
        <div class="card-head"><h2>#${r.speakerid} · ${esc(r.native_language)}</h2>
          ${sp.native_english ? '<span class="pill">native English</span>' : ""}
          ${sp.origin === "ui" ? '<span class="pill">created here</span>' : '<span class="pill">archive</span>'}</div>
        <dl class="facets">
          <div class="facet"><dt>Born</dt><dd>${placed}</dd></div>
          ${shown.map(facet).join("")}
          <div class="facet"><dt>Sample</dt><dd class="mono">${esc(r.speech_sample)}</dd></div>
        </dl>
        ${r.notes ? `<div class="suggest-head">Notes</div><div class="content-hl">${highlightField(String(r.notes), byField("notes"))}</div>` : ""}
        <div class="actions">
          <button type="button" class="btn small" id="d-move">Move pin</button>
          ${sp.origin === "ui" ? '<button type="button" class="btn small danger" id="d-delete">Delete</button>' : ""}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Entities</h2><span class="hint">${esc(sp.ner.model ?? "NER not run")}</span></div>
        ${entityList(sp.entities)}
      </section>

      <section class="card">
        <div class="card-head"><h2>Recordings</h2><span class="hint">${sp.recordings.length}</span></div>
        <ul class="rec-list">${sp.recordings.map((x) => `
          <li><audio controls preload="none" src="${api.audioUrl(x.id)}"></audio>
            <div class="hint">${esc(x.source_file ?? x.id)} · ${x.duration_s.toFixed(1)} s
              <button type="button" class="btn small ghost danger" data-remove="${esc(x.id)}">Remove</button></div>
            <div class="mono phones" title="recognised phones">${esc(x.phone_string)}</div></li>`).join("")
          || '<li class="muted">No audio yet.</li>'}</ul>
        <div class="actions">
          <label class="btn">Attach audio…<input type="file" id="d-audio" accept="audio/*,.mp3,.wav" hidden></label>
          <span class="status" id="d-status" role="status"></span>
        </div>
      </section>`;

    root.querySelector("#d-move")!.addEventListener("click", () => setState({ mode: "move" }));
    root.querySelector("#d-delete")?.addEventListener("click", async () => {
      if (!confirm(`Delete speaker #${r.speakerid}, their entities and audio?`)) return;
      await api.remove(r.speakerid);
      setState({ selectedId: null, detail: null });
      await reload();
    });
    root.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Remove this recording?")) return;
      await api.removeRecording(b.dataset.remove!);
      setState({ detail: await api.get(r.speakerid) });
      await reload();
    }));
    const st = root.querySelector<HTMLElement>("#d-status")!;
    root.querySelector<HTMLInputElement>("#d-audio")!.addEventListener("change", async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      st.classList.remove("error");
      try {
        st.textContent = "converting…";
        const c = await toWav(file);
        st.textContent = "uploading…";
        const a = await api.attach(r.speakerid, c.wav, file.name);
        st.textContent = a.duplicate ? "already attached" : [`attached ${c.seconds.toFixed(1)} s`, ...(a.notes ?? [])].join(" · ");
        setState({ detail: await api.get(r.speakerid) });
        await reload();
      } catch (err) {
        st.textContent = (err as Error).message;
        st.classList.add("error");
      }
    });
  };

  subscribe((s, changed) => {
    if (changed.has("detail") || changed.has("schema")) render(s.detail);
  });
  render(null);
}

function entityList(ents: Entity[]): string {
  if (!ents.length) return `<p class="muted">None found.</p>`;
  const groups = new Map<string, Entity[]>();
  for (const e of ents) groups.set(e.label, [...(groups.get(e.label) ?? []), e]);
  return `<ul class="mentions">${[...groups].map(([label, es]) => `
    <li class="mention"><div class="mention-head"><mark class="hl ${entityClass(label)}">${esc(label)}</mark>
      ${es.map((e) => `<span class="ent" title="${esc(e.source)} · ${esc(e.field)}">${esc(e.text)}${
        e.place ? ` <span class="muted">→ ${esc(e.place)}</span>` : ""}</span>`).join('<span class="muted">·</span>')}
    </div></li>`).join("")}</ul>`;
}
