import { esc } from "../util";
import { api } from "./api";
import { toWav } from "./audio";
import { setState } from "./state";
import type { FieldSpec, Schema, Speaker } from "./types";

const PLACE_FIELDS = ["city", "state_or_province", "country"];

/**
 * The create form. Its fields are GET /api/speakers/schema's, so the form is
 * exactly the record — nothing to keep in step by hand.
 *
 * Dropping the pin prefills the birthplace from the nearest populated place
 * (spelt the archive's way, so the new speaker joins existing birthplaces);
 * anything typed by hand is never overwritten.
 */
export function renderForm(root: HTMLElement, onCreated: (id: number) => Promise<void>) {
  // The form is rebuilt for each pin; the report of the last save lives beside
  // it so leaving add mode does not wipe what the cascade just did.
  root.innerHTML = `<div class="f-body"></div><div class="f-result" aria-live="polite"></div>`;
  const host = root.querySelector<HTMLElement>(".f-body")!;
  const result = root.querySelector<HTMLElement>(".f-result")!;
  let schema: Schema | null = null;
  let pin: { lon: number; lat: number } | null = null;
  const touched = new Set<string>();

  function input(f: FieldSpec): string {
    const id = `f-${f.name}`;
    const req = f.required ? " required" : "";
    const help = f.help ? ` title="${esc(f.help)}"` : "";
    let ctl: string;
    if (f.kind === "select") {
      ctl = `<select id="${id}" name="${f.name}"${req}><option value=""></option>${(f.options ?? [])
        .map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    } else if (f.kind === "textarea") {
      ctl = `<textarea id="${id}" name="${f.name}" rows="3"${help}></textarea>`;
    } else if (f.kind === "number") {
      ctl = `<input type="number" id="${id}" name="${f.name}" min="${f.min ?? ""}" max="${f.max ?? ""}" step="0.5"${req}>`;
    } else {
      const list = f.name === "native_language" ? ' list="dl-languages"' : f.name === "country" ? ' list="dl-countries"' : "";
      ctl = `<input type="text" id="${id}" name="${f.name}" autocomplete="off"${list}${req}${help}>`;
    }
    return `<label class="field" for="${id}"><span>${esc(f.label)}${f.required ? " *" : ""}${f.help ? ` <em>${esc(f.help)}</em>` : ""}</span>${ctl}</label>`;
  }

  function render() {
    if (!schema || !pin) {
      host.innerHTML = "";
      return;
    }
    const fields = schema.fields.filter((f) => f.kind !== "auto");
    const pairs = new Set(["age", "gender", "onset_age", "length_of_residence"]);
    let body = "";
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (pairs.has(f.name) && pairs.has(fields[i + 1]?.name)) {
        body += `<div class="field-row">${input(f)}${input(fields[i + 1])}</div>`;
        i++;
      } else body += input(f);
    }
    host.innerHTML = `
      <form class="spk-form" novalidate>
        <div class="spk-pinline"><span class="dot pin-dot"></span>
          <span class="num">${pin.lat.toFixed(4)}, ${pin.lon.toFixed(4)}</span>
          <span class="muted" id="f-near"></span></div>
        <datalist id="dl-languages">${schema.languages.map((l) => `<option value="${esc(l.value)}">`).join("")}</datalist>
        <datalist id="dl-countries">${schema.countries.map((c) => `<option value="${esc(c.value)}">`).join("")}</datalist>
        ${body}
        <div class="actions"><button type="button" class="btn small ghost" id="f-find">Move pin to typed birthplace</button></div>
        <label class="field"><span>Audio <em>any format the browser plays; converted to 16 kHz WAV before upload</em></span>
          <input type="file" id="f-audio" accept="audio/*,.mp3,.wav"></label>
        <div class="actions"><button type="submit" class="btn primary">Create speaker</button>
          <span class="status" id="f-status" role="status"></span></div>
      </form>`;
    const form = host.querySelector("form")!;
    form.addEventListener("input", (e) => touched.add((e.target as HTMLInputElement).name));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void submit(form);
    });
    host.querySelector<HTMLButtonElement>("#f-find")!.addEventListener("click", () => void findTyped(form));
    void prefill(form);
  }

  async function prefill(form: HTMLFormElement) {
    if (!pin) return;
    const at = pin;
    try {
      const r = await api.reverse(at.lon, at.lat);
      if (pin !== at) return; // moved again meanwhile
      host.querySelector("#f-near")!.textContent = `near ${r.name}, ${r.country} (${Math.round(r.distance_km)} km)`;
      for (const k of PLACE_FIELDS) {
        const el = form.elements.namedItem(k) as HTMLInputElement | null;
        const v = r.suggest[k as keyof typeof r.suggest];
        if (el && !touched.has(k)) el.value = v ?? "";
      }
    } catch {
      host.querySelector("#f-near")!.textContent = "";
    }
  }

  async function findTyped(form: HTMLFormElement) {
    const q = PLACE_FIELDS.map((k) => (form.elements.namedItem(k) as HTMLInputElement).value.trim()).filter(Boolean).join(", ");
    const st = host.querySelector("#f-status")!;
    if (!q) return;
    try {
      const r = await api.search(q);
      PLACE_FIELDS.forEach((k) => touched.add(k));
      setState({ pin: { lon: r.lon, lat: r.lat } });
    } catch (err) {
      st.textContent = (err as Error).message;
      st.classList.add("error");
    }
  }

  async function submit(form: HTMLFormElement) {
    if (!schema || !pin) return;
    const st = host.querySelector<HTMLElement>("#f-status")!;
    const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    st.classList.remove("error");
    const fields: Record<string, unknown> = { lon: pin.lon, lat: pin.lat };
    for (const f of schema.fields) {
      const el = form.elements.namedItem(f.name) as HTMLInputElement | null;
      if (el && el.value.trim() !== "") fields[f.name] = el.value;
    }
    if (!fields.native_language) {
      st.textContent = "Native language is required.";
      st.classList.add("error");
      return;
    }
    btn.disabled = true;
    const file = form.querySelector<HTMLInputElement>("#f-audio")!.files?.[0];
    try {
      // Convert before creating anything, so a file the browser cannot read
      // does not leave a speaker without the audio it was meant to have.
      let wav: ArrayBuffer | null = null;
      if (file) {
        st.textContent = "converting audio…";
        wav = (await toWav(file)).wav;
        fields.speech_sample = file.name;
      }
      st.textContent = "creating…";
      const sp: Speaker = await api.create(fields);
      const steps = describe(sp);
      if (wav && file) {
        st.textContent = "attaching audio…";
        const a = await api.attach(sp.record.speakerid, wav, file.name);
        steps.push(`audio: ${a.recording.duration_s.toFixed(1)} s, phones <span class="mono">${esc((a.phone_string ?? "").slice(0, 40))}…</span>`);
      }
      result.innerHTML = `<div class="suggest-head">Created speaker #${sp.record.speakerid}</div>` +
        `<ol class="cascade">${steps.map((x) => `<li>${x}</li>`).join("")}</ol>`;
      st.textContent = "";
      touched.clear();
      await onCreated(sp.record.speakerid);
    } catch (err) {
      st.textContent = (err as Error).message;
      st.classList.add("error");
    } finally {
      btn.disabled = false;
    }
  }

  return {
    setSchema(s: Schema) {
      schema = s;
      render();
    },
    setPin(p: { lon: number; lat: number } | null) {
      const had = pin != null;
      pin = p;
      const form = host.querySelector("form");
      if (p && had && form) {
        host.querySelector(".spk-pinline .num")!.textContent = `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
        void prefill(form as HTMLFormElement);
      } else render();
    },
  };
}

/** The cascade's own report, as the steps the user just caused. */
export function describe(sp: Speaker): string[] {
  const out: string[] = [];
  for (const s of sp.cascade ?? []) {
    if (s.step === "record") out.push(`record #${s.speakerid} · sample <b>${esc(String(s.speech_sample))}</b>`);
    if (s.step === "place") {
      const bp = s.birthplace as { query: string; match: string | null; new: boolean } | null;
      out.push(`placed at the pin${bp ? ` · birthplace “${esc(bp.query)}” ${bp.new ? "geocoded" : "known"} (${esc(bp.match ?? "unresolved")})` : ""}`);
    }
    if (s.step === "entities") out.push(`NER (${esc(String(s.model))}): ${s.count} entities, ${s.places} linked to places`);
  }
  return out;
}
