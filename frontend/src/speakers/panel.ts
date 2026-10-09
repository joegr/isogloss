import { esc, num } from "../util";
import { api } from "./api";
import { toWav } from "./audio";
import { renderForm } from "./form";
import { getState, setFilters, setState, subscribe, visibleDots } from "./state";

/**
 * Left panel: which dots are shown, dropping a new one, and attaching the
 * archive's audio in bulk.
 */
export function initPanel(root: HTMLElement, reload: () => Promise<void>): void {
  root.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Speakers</h2><span class="hint" id="spk-count"></span></div>
      <div class="segmented" role="group" aria-label="First language" id="spk-seg">
        <button type="button" data-v="all" class="active">All</button>
        <button type="button" data-v="native">Native English</button>
        <button type="button" data-v="l2">Other L1</button>
      </div>
      <label class="field" style="margin-top:10px"><span>Native language</span>
        <select id="spk-lang"><option value="">Any</option></select></label>
      <div class="actions">
        <label class="check"><input type="checkbox" id="spk-audio"> Has audio</label>
        <label class="check"><input type="checkbox" id="spk-ui"> Created here</label>
      </div>
    </section>

    <section class="card" id="spk-add-card">
      <div class="card-head"><h2>Add a speaker</h2></div>
      <p class="hint" id="spk-add-hint">Drop a dot where the speaker was born. Saving creates the full record,
        geocodes the birthplace, runs NER over the text and attaches any audio.</p>
      <div class="actions"><button type="button" class="btn primary" id="spk-add">Drop a speaker on the map</button></div>
      <div id="spk-form"></div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Attach archive audio</h2></div>
      <p class="hint">Choose Speech Accent Archive files (or their folder). Each is matched to its speaker by
        name — <code>english656.mp3</code> → speaker 3034 — converted to 16 kHz WAV here, and uploaded.
        Re-sending a file is harmless.</p>
      <div class="actions">
        <label class="btn">Files…<input type="file" id="spk-bulk-files" accept="audio/*,.mp3,.wav" multiple hidden></label>
        <label class="btn">Folder…<input type="file" id="spk-bulk-dir" multiple hidden webkitdirectory></label>
      </div>
      <ol class="progress" id="spk-bulk-log" aria-live="polite"></ol>
    </section>

    <section class="card">
      <div class="card-head"><h2>Named entities</h2><span class="hint" id="spk-ner-model"></span></div>
      <p class="hint">New records run NER as they are created. This runs it over every record that has not had it,
        the archive's included.</p>
      <div class="actions"><button type="button" class="btn" id="spk-ner">Run NER on all records</button>
        <span class="status" id="spk-ner-status"></span></div>
    </section>`;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  // ---------- filters ----------
  root.querySelectorAll<HTMLButtonElement>("#spk-seg button").forEach((b) =>
    b.addEventListener("click", () => setFilters({ speakers: b.dataset.v as "all" | "native" | "l2" })));
  $<HTMLSelectElement>("spk-lang").addEventListener("change", (e) =>
    setFilters({ language: (e.target as HTMLSelectElement).value || null }));
  $<HTMLInputElement>("spk-audio").addEventListener("change", (e) => setFilters({ withAudio: (e.target as HTMLInputElement).checked }));
  $<HTMLInputElement>("spk-ui").addEventListener("change", (e) => setFilters({ createdHere: (e.target as HTMLInputElement).checked }));

  // ---------- add ----------
  const addBtn = $<HTMLButtonElement>("spk-add");
  addBtn.addEventListener("click", () => {
    const adding = getState().mode === "add";
    setState(adding ? { mode: "browse", pin: null } : { mode: "add", pin: null, selectedId: null, detail: null });
  });
  const formHost = $("spk-form");
  const form = renderForm(formHost, async (id) => {
    await reload();
    setState({ mode: "browse", pin: null, selectedId: id });
  });

  // ---------- bulk ----------
  const log = $<HTMLOListElement>("spk-bulk-log");
  const onFiles = (input: HTMLInputElement) => async () => {
    const files = Array.from(input.files ?? []).filter((f) => /\.(mp3|wav|ogg|m4a|flac|webm)$/i.test(f.name));
    input.value = "";
    if (files.length) await bulkAttach(files, log);
    await reload();
  };
  $<HTMLInputElement>("spk-bulk-files").addEventListener("change", (e) => onFiles(e.target as HTMLInputElement)());
  $<HTMLInputElement>("spk-bulk-dir").addEventListener("change", (e) => onFiles(e.target as HTMLInputElement)());

  // ---------- NER ----------
  $<HTMLButtonElement>("spk-ner").addEventListener("click", async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    const st = $("spk-ner-status");
    b.disabled = true;
    st.textContent = "running…";
    st.classList.remove("error");
    try {
      const r = await api.nerAll();
      st.textContent = `${num(r.entities)} entities in ${num(r.speakers)} records`;
      const sel = getState().selectedId;
      if (sel != null) setState({ detail: await api.get(sel) });
    } catch (err) {
      st.textContent = String((err as Error).message);
      st.classList.add("error");
    } finally {
      b.disabled = false;
    }
  });

  subscribe((s, changed) => {
    if (changed.has("schema") && s.schema) {
      $("spk-lang").innerHTML = `<option value="">Any</option>` +
        s.schema.languages.map((l) => `<option value="${esc(l.value)}">${esc(l.value)} (${num(l.n)})</option>`).join("");
      $("spk-ner-model").textContent = s.schema.ner_model;
      form.setSchema(s.schema);
    }
    if (changed.has("filters")) {
      root.querySelectorAll<HTMLButtonElement>("#spk-seg button").forEach((b) =>
        b.classList.toggle("active", b.dataset.v === s.filters.speakers));
    }
    if (changed.has("dots") || changed.has("filters")) {
      $("spk-count").textContent = `${num(visibleDots(s).length)} of ${num(s.dots.length)}`;
    }
    if (changed.has("mode")) {
      addBtn.textContent = s.mode === "add" ? "Cancel" : "Drop a speaker on the map";
      addBtn.classList.toggle("primary", s.mode !== "add");
      $("spk-add-card").classList.toggle("active", s.mode === "add");
    }
    if (changed.has("pin") || changed.has("mode")) form.setPin(s.mode === "add" ? s.pin : null);
  });
}

/** Match files to archive speakers by name, convert, upload — two at a time. */
async function bulkAttach(files: File[], log: HTMLOListElement): Promise<void> {
  log.innerHTML = `<li class="muted">matching ${files.length} file${files.length > 1 ? "s" : ""}…</li>`;
  const names = files.map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
  const { matched, unmatched } = await api.matchSamples(names);
  log.innerHTML = "";
  const line = (cls: string, html: string) => {
    const li = document.createElement("li");
    li.className = cls;
    li.innerHTML = html;
    log.append(li);
    return li;
  };
  if (unmatched.length) {
    line("warn", `${unmatched.length} not in the archive: ${esc(unmatched.slice(0, 6).join(", "))}${unmatched.length > 6 ? "…" : ""}`);
  }
  const queue = files.map((f, i) => ({ f, name: names[i], id: matched[names[i]] })).filter((q) => q.id != null);
  let done = 0;
  const count = queue.length; // the workers drain the queue, so fix the total now
  const total = line("muted", "");
  const tick = () => (total.textContent = `${done} / ${count} attached`);
  tick();
  const worker = async () => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      const li = line("", `${esc(q.f.name)} → #${q.id} <span class="muted">converting…</span>`);
      try {
        const c = await toWav(q.f);
        const r = await api.attach(q.id!, c.wav, q.f.name);
        li.className = r.duplicate ? "muted" : "ok";
        li.innerHTML = `${esc(q.f.name)} → #${q.id} ${r.duplicate ? "already attached" : `${c.seconds.toFixed(1)} s`}`;
      } catch (err) {
        li.className = "error";
        li.innerHTML = `${esc(q.f.name)} → #${q.id} ${esc((err as Error).message)}`;
      }
      done++;
      tick();
    }
  };
  await Promise.all([worker(), worker()]);
}
