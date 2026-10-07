// Self-hosted font: no third-party requests (works offline in Docker, deterministic in tests).
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "./style.css";
import { api } from "./api";
import { initLanguages, initTimeline } from "./charts";
import { initConcordance } from "./concordance";
import { initContacts } from "./contacts";
import { initRouter } from "./router";
import { initDrilldown } from "./drilldown";
import { initInput } from "./input";
import { initMap } from "./map";
import { initNetwork } from "./network";
import { initFilters, initRecords } from "./records";
import { filteredRecords, getState, setState, subscribe } from "./state";
import { debounce, num } from "./util";

const $ = (id: string) => document.getElementById(id)!;

async function reload(): Promise<void> {
  const records = await api.records();
  setState({ records });
  await refreshCountries();
}

/** Country aggregation runs server-side (GeoPandas spatial join) with the active filters. */
const refreshCountries = async () => {
  const f = getState().filters;
  const countries = await api.byCountry({ ...f, country: null });
  setState({ countries });
};
const refreshCountriesDebounced = debounce(refreshCountries, 200);

/** Record-only proximity graph, drawn as great-circle arcs on the globe. */
const refreshProxGraph = debounce(async () => {
  const s = getState();
  try {
    setState({ proxGraph: await api.graph({ ...s.filters, country: null }, s.proximity, false) });
  } catch {
    /* backend unavailable */
  }
}, 300);

function initViews(world: { setMode: (m: "globe" | "flat") => void }, network: { activate: (on: boolean) => void }) {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".view-switch button");
  const legend = $("map-legend");
  const apply = (v: "globe" | "flat" | "network") => {
    buttons.forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    const worldHost = document.querySelector<HTMLElement>(".world-host")!;
    worldHost.style.display = v === "network" ? "none" : "";
    legend.style.visibility = v === "network" ? "hidden" : "";
    network.activate(v === "network");
    if (v !== "network") world.setMode(v);
    setState({ view: v });
    try { localStorage.setItem("geomap-view", v); } catch { /* ignore */ }
  };
  buttons.forEach((b) => b.addEventListener("click", () => apply(b.dataset.view as "globe" | "flat" | "network")));
  let stored: string | null = null;
  try { stored = localStorage.getItem("geomap-view"); } catch { /* ignore */ }
  if (stored === "flat" || stored === "network") apply(stored);
}

function initFullscreen() {
  const card = $("map-card");
  const btn = $("fullscreen");
  const sync = () => {
    const on = document.fullscreenElement === card || card.classList.contains("pseudo-fullscreen");
    card.classList.toggle("is-fullscreen", on);
    btn.textContent = on ? "✕" : "⛶";
    btn.title = on ? "Exit full screen (F / Esc)" : "Full screen (F)";
  };
  const setPseudo = (on: boolean) => {
    card.classList.toggle("pseudo-fullscreen", on);
    sync();
  };
  const toggle = () => {
    if (document.fullscreenElement) return void document.exitFullscreen();
    if (card.classList.contains("pseudo-fullscreen")) return setPseudo(false);
    // Native fullscreen where allowed; embedded browsers may ignore the request silently,
    // so fall back to a window-filling card if it hasn't engaged shortly after.
    const req = card.requestFullscreen?.();
    req?.catch(() => setPseudo(true));
    window.setTimeout(() => document.fullscreenElement !== card && setPseudo(true), 300);
    if (!req) setPseudo(true);
  };
  btn.addEventListener("click", toggle);
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
    if (!document.getElementById("drilldown")?.hidden) return; // drilldown owns the keyboard while open
    if (e.key === "f" || e.key === "F") toggle();
    if (e.key === "Escape" && card.classList.contains("pseudo-fullscreen")) setPseudo(false);
  });
}

function renderStats() {
  const s = getState();
  const recs = filteredRecords(s);
  const mentions = recs.reduce((n, r) => n + r.geo.length, 0);
  const langs = new Set(recs.map((r) => r.language.code)).size;
  const countries = new Set(recs.flatMap((r) => r.geo.map((m) => m.place.country_code).filter(Boolean))).size;
  $("stats").innerHTML = [
    ["records", recs.length],
    ["mentions", mentions],
    ["countries", countries],
    ["languages", langs],
  ].map(([k, v]) => `<span class="stat"><b>${num(v as number)}</b> ${k}</span>`).join("");
}

function initTheme() {
  const btn = $("theme-toggle");
  const stored = (() => {
    try {
      return localStorage.getItem("geomap-theme");
    } catch {
      return null;
    }
  })();
  if (stored) document.documentElement.dataset.theme = stored;
  btn.addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("geomap-theme", next);
    } catch {
      /* ignore */
    }
  });
}

async function main() {
  initTheme();
  initFilters($("filters"));
  const world = initMap($("map"), $("map-legend"));
  const network = initNetwork($("map"));
  initViews(world, network);
  initFullscreen();
  initTimeline($("timeline"));
  initLanguages($("languages"));
  initInput($("input-panel"), reload);
  initConcordance($("input-panel"));
  initRecords($("records-panel"), reload);
  const contacts = initContacts($("page-contacts"), reload);
  initDrilldown();
  initRouter(contacts.route);
  subscribe((_s, changed) => changed.has("records") && contacts.refreshCount());

  subscribe((_s, changed) => {
    if (changed.has("records") || changed.has("filters") || changed.has("near")) renderStats();
    if (changed.has("filters")) refreshCountriesDebounced();
    if (changed.has("records") || changed.has("filters") || changed.has("proximity")) refreshProxGraph();
  });

  $("load-samples").addEventListener("click", async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    b.disabled = true;
    b.textContent = "Loading…";
    try {
      await api.samples();
      await reload();
    } finally {
      b.disabled = false;
      b.textContent = "Load samples";
    }
  });

  try {
    await reload();
  } catch {
    $("stats").innerHTML = `<span class="stat error">Backend unreachable — start Flask on :5050</span>`;
  }
}

main();
