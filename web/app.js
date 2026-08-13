import { PRESETS } from "./presets.js";
import { CircleView, frameAt } from "./visual.js";
import { FEATURES, PHRASES, SR, synthesise, toWav } from "./synth.js";

const $ = (s) => document.querySelector(s);

const state = {
  features: Object.fromEntries(FEATURES.map((f) => [f.key, defaultOf(f)])),
  phrase: "harvard",
  voice: "male",
  result: null,
  ctx: null,
  source: null,
  startedAt: 0,
  playing: false,
};

function defaultOf(f) {
  const p = PRESETS.find((x) => x.id === "rp") || PRESETS[0];
  return p ? p.features[f.key] : (f.lo + f.hi) / 2;
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

function buildSliders() {
  const host = $("#sliders");
  host.innerHTML = "";
  for (const f of FEATURES) {
    const row = document.createElement("div");
    row.className = "slider";
    row.innerHTML = `
      <label title="${f.hint}">
        <span>${f.label}</span>
        <output id="out-${f.key}"></output>
      </label>
      <input type="range" id="in-${f.key}" min="${f.lo}" max="${f.hi}" step="${f.step}">
      <p class="hint">${f.hint}</p>`;
    host.appendChild(row);
    const input = row.querySelector("input");
    input.value = state.features[f.key];
    input.addEventListener("input", () => {
      state.features[f.key] = parseFloat(input.value);
      paint(f);
      markCustom();
    });
    paint(f);
  }
}

function paint(f) {
  const v = state.features[f.key];
  const out = $(`#out-${f.key}`);
  if (out) out.textContent = f.unit ? `${round(v)} ${f.unit}` : round(v);
  const input = $(`#in-${f.key}`);
  if (input) input.value = v;
}

const round = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));

function markCustom() {
  $("#preset").value = "";
  $("#variety").textContent = "custom";
}

function applyPreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  Object.assign(state.features, p.features);
  for (const f of FEATURES) paint(f);
  $("#variety").textContent = `${p.label} · ${p.country}`;
}

function buildPresets() {
  const sel = $("#preset");
  sel.innerHTML = `<option value="">— custom —</option>`;
  let group = null;
  for (const p of PRESETS) {
    if (!group || group.label !== p.country) {
      group = document.createElement("optgroup");
      group.label = p.country;
      sel.appendChild(group);
    }
    group.appendChild(new Option(p.label, p.id));
  }
  sel.addEventListener("change", () => { if (sel.value) applyPreset(sel.value); });
}

function buildPhrases() {
  const sel = $("#phrase");
  for (const p of PHRASES) sel.appendChild(new Option(p.text, p.id));
  sel.value = state.phrase;
  sel.addEventListener("change", () => {
    state.phrase = sel.value;
    const p = PHRASES.find((x) => x.id === sel.value);
    $("#probe").textContent = p ? p.note : "";
  });
  $("#probe").textContent = PHRASES.find((p) => p.id === state.phrase).note;
}

/* ------------------------------------------------------------------ */
/* Audio                                                               */
/* ------------------------------------------------------------------ */

function ctx() {
  if (!state.ctx) state.ctx = new (window.AudioContext || window.webkitAudioContext)();
  return state.ctx;
}

async function speak() {
  const ac = ctx();
  if (ac.state === "suspended") await ac.resume();
  stop();

  $("#status").textContent = "synthesising…";
  // Yield first: rendering six seconds of audio blocks the main thread for a
  // beat, and a UI that freezes without saying why reads as broken.
  await new Promise((r) => setTimeout(r, 0));

  const t0 = performance.now();
  const res = synthesise(state.phrase, state.features, state.voice, 1);
  state.result = res;

  const buf = ac.createBuffer(1, res.samples.length, SR);
  buf.getChannelData(0).set(res.samples);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(ac.destination);
  src.onended = () => { state.playing = false; $("#play").textContent = "▶ Speak"; };
  src.start();

  state.source = src;
  state.startedAt = ac.currentTime;
  state.playing = true;
  $("#play").textContent = "■ Stop";
  $("#status").textContent =
    `${res.duration.toFixed(2)} s · ${res.timeline.length} segments · `
    + `rendered in ${(performance.now() - t0).toFixed(0)} ms · ${res.notes.join(", ")}`;
  $("#download").disabled = false;
}

function stop() {
  if (state.source) { try { state.source.stop(); } catch {} state.source = null; }
  state.playing = false;
  $("#play").textContent = "▶ Speak";
}

/* ------------------------------------------------------------------ */
/* Loop                                                                */
/* ------------------------------------------------------------------ */

let view = null;
let last = performance.now();

function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  let frame = null;
  if (state.playing && state.result) {
    const t = ctx().currentTime - state.startedAt;
    frame = frameAt(state.result.track, t);
    const seg = state.result.timeline.find((s) => t >= s.start && t < s.start + s.dur);
    $("#now").textContent = seg ? seg.token : "";
  } else {
    $("#now").textContent = "";
  }
  view.update(frame, dt);
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ */

function boot() {
  view = new CircleView($("#stage"));
  buildPresets();
  buildSliders();
  buildPhrases();
  applyPreset("rp");
  $("#preset").value = "rp";

  $("#play").addEventListener("click", () => (state.playing ? stop() : speak()));
  $("#voice").addEventListener("change", (e) => { state.voice = e.target.value; });
  $("#randomise").addEventListener("click", () => {
    for (const f of FEATURES) {
      state.features[f.key] = f.lo + Math.random() * (f.hi - f.lo);
      paint(f);
    }
    markCustom();
    speak();
  });
  $("#download").addEventListener("click", () => {
    if (!state.result) return;
    const url = URL.createObjectURL(toWav(state.result.samples));
    const a = document.createElement("a");
    a.href = url;
    a.download = `isogloss-${state.phrase}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  });
  $("#panel-toggle").addEventListener("click", () => {
    document.body.classList.toggle("panel-open");
  });

  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT") {
      e.preventDefault();
      state.playing ? stop() : speak();
    }
  });

  requestAnimationFrame(loop);
}

if (window.paper) boot();
else window.addEventListener("load", boot);
