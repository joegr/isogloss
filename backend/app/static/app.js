/* Isogloss — browser client.
 *
 * Two things here are load-bearing:
 *  1. Recording captures raw PCM from a WebAudio graph and encodes a WAV in the
 *     page. MediaRecorder would hand us Opus, which means a codec dependency on
 *     the server and lossy compression between the speaker and a formant
 *     tracker. Neither is acceptable for this task.
 *  2. The map is a plain SVG renderer for GeoJSON. No tiles, no basemap, no
 *     network dependency — the only geometry drawn is what PostGIS returned,
 *     which keeps the picture honest about what the model actually knows.
 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Map                                                                  */
/* ------------------------------------------------------------------ */

const NS = "http://www.w3.org/2000/svg";
const tip = Object.assign(document.createElement("div"), { className: "tip" });
document.body.appendChild(tip);

class Map2D {
  constructor(svg) {
    this.svg = svg;
    this.g = document.createElementNS(NS, "g");
    this.svg.appendChild(this.g);
    this.layers = new Map();
    this.view = { cx: 0, cy: 50, k: 8 };
    this._drag = null;
    this._bind();
  }

  _bind() {
    this.svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      this.view.k = Math.max(0.3, Math.min(4000, this.view.k * f));
      this.render();
    }, { passive: false });

    this.svg.addEventListener("pointerdown", (e) => {
      this._drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy };
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener("pointermove", (e) => {
      if (!this._drag) return;
      const s = this.scale();
      this.view.cx = this._drag.cx - (e.clientX - this._drag.x) / s.x;
      this.view.cy = this._drag.cy + (e.clientY - this._drag.y) / s.y;
      this.render();
    });
    this.svg.addEventListener("pointerup", () => { this._drag = null; });
    this.svg.addEventListener("pointerleave", () => { tip.style.display = "none"; });
  }

  size() {
    const r = this.svg.getBoundingClientRect();
    return { w: r.width || 800, h: r.height || 500 };
  }

  /* Equirectangular, with longitude compressed by cos(latitude) so shapes are
     not absurdly stretched at high latitude. Good enough for a study area; this
     is not a navigation chart. */
  scale() {
    const c = Math.max(0.15, Math.cos((this.view.cy * Math.PI) / 180));
    return { x: this.view.k * c, y: this.view.k };
  }

  project(lon, lat) {
    const { w, h } = this.size();
    const s = this.scale();
    return [w / 2 + (lon - this.view.cx) * s.x, h / 2 - (lat - this.view.cy) * s.y];
  }

  fit(bbox, pad = 0.10) {
    const [x0, y0, x1, y1] = bbox;
    const { w, h } = this.size();
    this.view.cx = (x0 + x1) / 2;
    this.view.cy = (y0 + y1) / 2;
    const c = Math.max(0.15, Math.cos((this.view.cy * Math.PI) / 180));
    const kx = w / Math.max(1e-6, (x1 - x0) * c);
    const ky = h / Math.max(1e-6, y1 - y0);
    this.view.k = Math.min(kx, ky) * (1 - pad);
    this.render();
  }

  set(name, fc, style = {}) {
    if (!fc) this.layers.delete(name);
    else this.layers.set(name, { fc, style });
    this.render();
  }

  clear() { this.layers.clear(); this.render(); }

  render() {
    this.g.textContent = "";
    const order = [...this.layers.entries()].sort(
      (a, b) => (a[1].style.z || 0) - (b[1].style.z || 0));
    for (const [name, { fc, style }] of order) {
      if (!fc || !fc.features) continue;
      const layer = document.createElementNS(NS, "g");
      layer.setAttribute("data-layer", name);
      for (const f of fc.features) this._feature(layer, f, style);
      this.g.appendChild(layer);
    }
  }

  _feature(parent, f, style) {
    const geom = f.geometry;
    if (!geom) return;
    const p = f.properties || {};
    const fill = typeof style.fill === "function" ? style.fill(p) : style.fill;
    const stroke = typeof style.stroke === "function" ? style.stroke(p) : style.stroke;
    const width = typeof style.width === "function" ? style.width(p) : style.width;

    const mk = (d, isLine) => {
      const el = document.createElementNS(NS, "path");
      el.setAttribute("d", d);
      el.setAttribute("fill", isLine ? "none" : (fill || "none"));
      el.setAttribute("stroke", stroke || "none");
      el.setAttribute("stroke-width", width ?? 1);
      if (style.opacity != null) el.setAttribute("opacity", style.opacity);
      if (style.dash) el.setAttribute("stroke-dasharray", style.dash);
      el.setAttribute("stroke-linejoin", "round");
      el.setAttribute("vector-effect", "non-scaling-stroke");
      if (style.title) this._hover(el, style.title(p));
      parent.appendChild(el);
    };

    const ring = (r) => r.map(([x, y], i) => {
      const [px, py] = this.project(x, y);
      return `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`;
    }).join(" ");

    switch (geom.type) {
      case "Polygon": mk(geom.coordinates.map(ring).join(" ") + " Z", false); break;
      case "MultiPolygon":
        mk(geom.coordinates.map((poly) => poly.map(ring).join(" ") + " Z").join(" "), false);
        break;
      case "LineString": mk(ring(geom.coordinates), true); break;
      case "MultiLineString": mk(geom.coordinates.map(ring).join(" "), true); break;
      case "Point": {
        const [px, py] = this.project(...geom.coordinates);
        const el = document.createElementNS(NS, "circle");
        el.setAttribute("cx", px); el.setAttribute("cy", py);
        el.setAttribute("r", (typeof style.r === "function" ? style.r(p) : style.r) ?? 3);
        el.setAttribute("fill", fill || "#fff");
        el.setAttribute("stroke", stroke || "none");
        el.setAttribute("stroke-width", width ?? 1);
        if (style.title) this._hover(el, style.title(p));
        parent.appendChild(el);
        break;
      }
    }
  }

  _hover(el, text) {
    if (!text) return;
    el.style.cursor = "crosshair";
    el.addEventListener("pointerenter", (e) => {
      tip.textContent = text;
      tip.style.display = "block";
      tip.style.left = e.clientX + 12 + "px";
      tip.style.top = e.clientY + 12 + "px";
    });
    el.addEventListener("pointermove", (e) => {
      tip.style.left = e.clientX + 12 + "px";
      tip.style.top = e.clientY + 12 + "px";
    });
    el.addEventListener("pointerleave", () => { tip.style.display = "none"; });
  }
}

const LAND = { fill: "#232833", stroke: "#39404f", width: 1, z: 0 };
const BARRIER_STYLE = { stroke: "#ff6b6b", width: 1.4, dash: "5 4", z: 6,
                        title: (p) => `${p.name} (${p.kind})` };

/* ------------------------------------------------------------------ */
/* Recording                                                            */
/* ------------------------------------------------------------------ */

class Recorder {
  constructor(onLevel) {
    this.onLevel = onLevel;
    this.chunks = [];
    this.sr = 16000;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false,
               autoGainControl: false },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    this.sr = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.node.onaudioprocess = (e) => {
      const buf = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(buf));
      let peak = 0;
      for (let i = 0; i < buf.length; i += 8) peak = Math.max(peak, Math.abs(buf[i]));
      this.onLevel?.(peak);
    };
    // A ScriptProcessor only pulls if it is connected to the destination, so it
    // goes through a muted gain node — connecting it directly would echo the
    // microphone back through the speakers and into the next recording.
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    src.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(this.ctx.destination);
  }

  stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return encodeWav(out, this.sr);
  }
}

function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

let META = null;
const maps = {};

async function boot() {
  $$("#tabs button").forEach((b) => b.addEventListener("click", () => {
    $$("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
    $$(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + b.dataset.tab));
    Object.values(maps).forEach((m) => m.render());
  }));

  maps.analyse = new Map2D($("#map-analyse"));
  maps.field = new Map2D($("#map-field"));
  maps.diffusion = new Map2D($("#map-diffusion"));

  try {
    META = await api("/api/meta");
  } catch (e) {
    setStatus("Cannot reach the backend: " + e.message, true);
    return;
  }

  const langSel = $("#langhint");
  for (const l of META.languages.filter((l) => l.sites > 0)) {
    langSel.append(new Option(`${l.name} (${l.sites} sites)`, l.code));
  }

  for (const sel of [$("#area"), $("#d-area")]) {
    for (const a of META.areas) sel.append(new Option(`${a.name} — ${a.sites} sites`, a.id));
  }
  for (const f of META.features) $("#isokey").append(new Option(f.label, f.key));
  for (const s of META.settlements.slice(0, 60)) {
    $("#d-origin").append(new Option(`${s.name} (${(s.population / 1e6).toFixed(2)}M)`, s.id));
  }

  await drawBase(maps.analyse, null);
  wireAnalyse();
  wireField();
  wireDiffusion();
  $("#area").value = META.areas[0]?.id;
  $("#d-area").value = "gb-ie";
  $("#d-origin").value = "london";
  await refreshField();
}

async function drawBase(map, area) {
  const land = await api("/api/map/land" + (area ? `?area=${area}` : ""));
  map.set("land", land, LAND);
  const bbox = bboxOf(land);
  if (bbox) map.fit(bbox);
}

function bboxOf(fc) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]);
      y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
    } else c.forEach(walk);
  };
  for (const f of fc.features || []) if (f.geometry) walk(f.geometry.coordinates);
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

function setStatus(msg, err = false) {
  const el = $("#status");
  el.textContent = msg;
  el.classList.toggle("err", err);
}

/* ------------------------------------------------------------------ */
/* Analyse tab                                                          */
/* ------------------------------------------------------------------ */

function wireAnalyse() {
  let rec = null;

  $("#rec").addEventListener("click", async () => {
    try {
      rec = new Recorder((p) => { $("#meterbar").style.width = Math.min(100, p * 160) + "%"; });
      await rec.start();
      $("#rec").disabled = true; $("#stop").disabled = false;
      setStatus("Recording… read a paragraph aloud, 15–30 s is ideal.");
    } catch (e) {
      setStatus("Microphone unavailable: " + e.message, true);
    }
  });

  $("#stop").addEventListener("click", async () => {
    $("#rec").disabled = false; $("#stop").disabled = true;
    $("#meterbar").style.width = "0%";
    const blob = rec.stop();
    const pb = $("#playback");
    pb.src = URL.createObjectURL(blob);
    pb.hidden = false;
    await submit(blob);
  });

  $("#file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) {
      const pb = $("#playback");
      pb.src = URL.createObjectURL(f);
      pb.hidden = false;
      await submit(f);
    }
  });
}

async function submit(blob) {
  setStatus("Analysing…");
  const hint = $("#langhint").value;
  try {
    const r = await api("/api/analyse" + (hint ? `?language=${hint}` : ""), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
    });
    renderResult(r);
    setStatus(`Done in ${r.elapsed_s}s — ${r.duration_s}s of audio, `
      + `${r.bandwidth_hz} Hz effective bandwidth, VTLN warp ${r.vtln_warp}.`);
  } catch (e) {
    setStatus(e.message, true);
  }
}

function renderResult(r) {
  /* language */
  $("#langcard").hidden = false;
  const top = r.language.ranking[0];
  $("#langtop").innerHTML =
    `<div class="big">${top ? top.name : r.language.code}</div>` +
    `<div class="hint">${r.language.hinted ? "Language was specified, not inferred."
      : `${((r.language.confidence ?? 0) * 100).toFixed(1)}% posterior across `
        + `${r.language.ranking.length}+ candidates`}</div>`;
  $("#langtable").innerHTML =
    "<tr><th>Language</th><th>Family</th><th>p</th></tr>" +
    r.language.ranking.map((l) =>
      `<tr><td>${l.name}</td><td>${l.family || ""}</td>` +
      `<td>${(l.probability * 100).toFixed(1)}%</td></tr>`).join("");

  /* phones */
  $("#phonecard").hidden = false;
  const segs = r.phones.segments;
  const total = segs.length ? segs[segs.length - 1].end : 1;
  $("#phonestrip").innerHTML = segs.map((s) => {
    const w = Math.max(3, ((s.end - s.start) / total) * 100 * 8);
    return `<div class="seg ${s.manner}" style="flex:0 0 ${w}px" `
      + `title="${s.ipa} · ${Math.round((s.end - s.start) * 1000)} ms · conf ${s.confidence}">`
      + `${s.manner === "silence" ? "" : s.ipa}</div>`;
  }).join("");
  $("#phonestring").textContent = r.phones.string;

  /* accent measurements */
  $("#accentcard").hidden = false;
  $("#accenttable").innerHTML =
    "<tr><th>Feature</th><th class='val'>Value</th><th>Reliability</th><th class='val'>n</th></tr>" +
    r.accent.map((f) => {
      const weak = f.reliability < 0.25;
      const val = f.value == null ? "—"
        : `${f.value}${f.unit && f.unit !== "index" ? " " + f.unit : ""}`;
      return `<tr class="${weak ? "weak" : ""}" title="${f.note || ""}">` +
        `<td>${f.label}</td><td class="val">${val}</td>` +
        `<td><div class="bar ${weak ? "low" : ""}"><span style="width:${(f.reliability * 100).toFixed(0)}%"></span></div></td>` +
        `<td class="val">${f.tokens}</td></tr>`;
    }).join("");

  /* caveats */
  $("#caveatcard").hidden = !r.caveats.length;
  $("#caveats").innerHTML = r.caveats.map((c) => `<li>${c}</li>`).join("");

  renderLocation(r.location);
}

async function renderLocation(loc) {
  const map = maps.analyse;
  if (!loc || !loc.available) {
    $("#locsummary").innerHTML =
      `<div class="row"><span>No location</span><b>${loc?.reason || "unavailable"}</b></div>`;
    return;
  }

  const land = await api("/api/map/land");
  const keep = new Set(loc.areas);
  land.features = land.features.filter((f) => keep.has(f.properties.id));
  map.set("land", land, LAND);

  const poly = (geojson) => geojson
    ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: JSON.parse(geojson), properties: {} }] }
    : null;

  map.set("p95", poly(loc.regions.p95), { fill: "rgba(110,168,254,.30)", stroke: "rgba(110,168,254,.6)", width: 1, z: 1 });
  map.set("p80", poly(loc.regions.p80), { fill: "rgba(255,180,84,.34)", stroke: "rgba(255,180,84,.7)", width: 1, z: 2 });
  map.set("p50", poly(loc.regions.p50), { fill: "rgba(255,107,107,.45)", stroke: "rgba(255,107,107,.9)", width: 1.2, z: 3 });

  map.set("near", {
    type: "FeatureCollection",
    features: loc.nearest.map((n) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [n.lon, n.lat] },
      properties: n,
    })),
  }, {
    fill: (p) => `rgba(255,255,255,${0.25 + 0.7 * p.similarity})`,
    stroke: "#0b0e14", width: 1, r: (p) => 3 + 5 * p.similarity, z: 4,
    title: (p) => `${p.label} — similarity ${(p.similarity * 100).toFixed(0)}%`,
  });

  map.set("map", {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [loc.map.lon, loc.map.lat] }, properties: {} }],
  }, { fill: "#fff", stroke: "#0b0e14", width: 2, r: 5, z: 5 });

  const bbox = bboxOf(map.layers.get("p95")?.fc || land);
  if (bbox) map.fit(pad(bbox, 2.5));

  $("#locsummary").innerHTML = [
    row("Most probable origin", `${loc.nearest_settlement || "—"}`),
    row("Dialect region", loc.region_name || "not classified"),
    row("Posterior spread", `± ${Math.round(loc.spread_km)} km (1σ equivalent)`),
    row("Study areas searched", loc.areas.join(", ")),
    row("Features used", `${loc.features_used.length} of ${META.features.length}`),
    "<div class='hint' style='margin-top:10px'>Closest reference varieties: "
      + loc.nearest.map((n) => `${n.label} (${(n.similarity * 100).toFixed(0)}%)`).join(", ")
      + "</div>",
  ].join("");
}

const row = (k, v) => `<div class="row"><span>${k}</span><b>${v}</b></div>`;
const pad = ([x0, y0, x1, y1], d) => [x0 - d, y0 - d, x1 + d, y1 + d];

/* ------------------------------------------------------------------ */
/* Field tab                                                            */
/* ------------------------------------------------------------------ */

function wireField() {
  $("#area").addEventListener("change", refreshField);
  $("#isokey").addEventListener("change", refreshField);
  ["cells", "regions", "iso", "bundles", "barriers", "corridors", "edges"]
    .forEach((n) => $("#l-" + n).addEventListener("change", refreshField));
  $("#recluster").addEventListener("click", async () => {
    $("#fieldinfo").textContent = "Clustering…";
    try {
      await api(`/api/regions/rebuild?area=${$("#area").value}&language=en&k=6`,
                { method: "POST" });
      await refreshField();
    } catch (e) {
      $("#fieldinfo").textContent = e.message;
    }
  });
}

async function refreshField() {
  const area = $("#area").value;
  if (!area) return;
  const map = maps.field;
  const on = (n) => $("#l-" + n).checked;

  const land = await api(`/api/map/land?area=${area}`);
  map.set("land", land, LAND);

  map.set("cells", on("cells") ? await api(`/api/map/cells?area=${area}`) : null, {
    fill: "none", stroke: "#333c4d", width: 0.6, z: 1,
    title: (p) => p.label,
  });

  map.set("regions", on("regions") ? await api(`/api/map/regions?area=${area}`) : null, {
    fill: (p) => `hsla(${(p.cluster * 57) % 360} 55% 55% / .30)`,
    stroke: (p) => `hsl(${(p.cluster * 57) % 360} 60% 62%)`, width: 1.2, z: 2,
    title: (p) => `${p.label} — ${p.members} varieties`,
  });

  map.set("bundles", on("bundles") ? await api(`/api/map/bundles?area=${area}`) : null, {
    fill: (p) => `rgba(255,107,107,${Math.min(0.5, 0.07 * p.weight)})`,
    stroke: "none", z: 3, title: (p) => `${p.weight} isoglosses bundled here`,
  });

  const key = $("#isokey").value;
  map.set("iso", on("iso")
    ? await api(`/api/map/isoglosses?area=${area}` + (key ? `&key=${key}` : "")) : null, {
    stroke: "#ffb454", width: 1.4, z: 4,
    title: (p) => `${p.label} @ ${p.threshold} — ${p.length_km} km`,
  });

  map.set("barriers", on("barriers") ? await api("/api/map/barriers") : null, {
    stroke: "#ff6b6b", width: (p) => 1 + 1.6 * p.resistance, dash: "5 4", z: 5,
    title: (p) => `${p.name} (${p.kind}, resistance ${p.resistance})`,
  });

  map.set("corridors", on("corridors") ? await api("/api/map/corridors") : null, {
    stroke: "#4ade80", width: 1.6, dash: "2 5", z: 5,
    title: (p) => `${p.name} (${p.kind})`,
  });

  map.set("edges", on("edges") ? await api(`/api/map/edges?area=${area}&limit=260`) : null, {
    stroke: "rgba(167,139,250,.45)", width: 0.7, z: 6,
    title: (p) => `${p.a_id}–${p.b_id}: ${p.d_geo_km} km geo, ${p.d_eff_km} km effective`
      + (p.barriers > 0 ? ` (barriers ${p.barriers})` : ""),
  });

  map.set("sites", await api("/api/map/sites?language=en"), {
    fill: "#e7eaf0", stroke: "#0b0e14", width: 1, r: 3, z: 7,
    title: (p) => `${p.label} (${p.country})`,
  });

  const bbox = bboxOf(land);
  if (bbox) map.fit(bbox);

  const iso = map.layers.get("iso");
  $("#fieldinfo").innerHTML = [
    row("Reference varieties", map.layers.get("sites").fc.features.length),
    row("Isoglosses drawn", iso ? iso.fc.features.length : 0),
    "<div class='hint' style='margin-top:8px'>Isoglosses are not drawn by hand: each is the "
    + "shared boundary between the union of Thiessen cells above the feature's midpoint and "
    + "the union below it. Where several run together you are looking at a dialect boundary "
    + "in Bloomfield's sense — turn on <b>Bundles</b> to see them counted.</div>",
  ].join("");
}

/* ------------------------------------------------------------------ */
/* Diffusion tab                                                        */
/* ------------------------------------------------------------------ */

let RUN = null;
let TIMER = null;

function wireDiffusion() {
  $("#d-area").addEventListener("change", async () => {
    await drawBase(maps.diffusion, $("#d-area").value);
  });

  $("#d-run").addEventListener("click", async () => {
    $("#d-info").textContent = "Simulating…";
    const body = {
      regime: $("#d-regime").value,
      origin: $("#d-origin").value,
      area: $("#d-area").value,
      steps: +$("#d-steps").value,
      contact: +$("#d-contact").value,
      resistance: +$("#d-res").value,
      identity: +$("#d-identity").value,
    };
    try {
      const res = await api("/api/diffusion/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const fronts = await api(`/api/diffusion/${res.run_id}/fronts`);
      const lines = await api(`/api/diffusion/${res.run_id}/front-lines`);
      RUN = { res, fronts, lines };
      $("#d-t").max = fronts.features.length - 1;
      $("#d-t").value = 0;
      await drawBase(maps.diffusion, body.area);
      maps.diffusion.set("barriers", await api("/api/map/barriers"), BARRIER_STYLE);
      showFrame(0);
      const sig = res.signature || {};
      $("#d-info").innerHTML = [
        row("Regime", res.regime),
        row("Origin", res.origin),
        row("Final adoption (population-weighted)",
            `${(res.share[res.share.length - 1] * 100).toFixed(1)}%`),
        row("Adoption time vs log population",
            sig.t_vs_log_population == null ? "—" : sig.t_vs_log_population.toFixed(2)),
        row("Adoption time vs distance from origin",
            sig.t_vs_distance_km == null ? "—" : sig.t_vs_distance_km.toFixed(2)),
        "<div class='hint' style='margin-top:8px'>Those last two are the signature. A wave "
        + "correlates with distance and not much with size; a cascade correlates with "
        + "population and can be almost independent of distance.</div>",
      ].join("");
    } catch (e) {
      $("#d-info").textContent = e.message;
    }
  });

  $("#d-t").addEventListener("input", (e) => showFrame(+e.target.value));

  $("#d-play").addEventListener("click", () => {
    if (TIMER) { clearInterval(TIMER); TIMER = null; $("#d-play").textContent = "▶ Play"; return; }
    if (!RUN) return;
    $("#d-play").textContent = "❚❚ Pause";
    let t = 0;
    TIMER = setInterval(() => {
      showFrame(t);
      $("#d-t").value = t;
      t += 1;
      if (t > +$("#d-t").max) t = 0;
    }, 240);
  });
}

function showFrame(t) {
  if (!RUN) return;
  const map = maps.diffusion;
  const f = RUN.fronts.features[t];
  const line = RUN.lines.features.find((x) => x.properties.t === t);

  map.set("adopted", f ? { type: "FeatureCollection", features: [f] } : null,
    { fill: "rgba(110,168,254,.35)", stroke: "rgba(110,168,254,.75)", width: 1, z: 2 });
  map.set("front", line ? { type: "FeatureCollection", features: [line] } : null,
    { stroke: "#ffb454", width: 2.2, z: 3 });

  const share = f ? f.properties.share : 0;
  $("#d-label").textContent = `t = ${t} · ${(share * 100).toFixed(1)}% adopted`;
}

boot();
