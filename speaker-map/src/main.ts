// Self-hosted font: no third-party requests (works offline in Docker, deterministic in tests).
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./style.css";
import "./speakers/speakers.css";
import { apiUrl, backendMissing, config } from "./config";
import { esc, num } from "./util";
import { api } from "./speakers/api";
import { initDetail } from "./speakers/detail";
import { initSpeakerMap } from "./speakers/map";
import { initPanel } from "./speakers/panel";
import { getState, setState, subscribe, visibleDots } from "./speakers/state";

/**
 * The speaker map. Demogi's shell and globe, driving the speaker records of the
 * Demogi/Isogloss backend: one dot per speaker, a cascade behind every new dot.
 * A static site — the backend is wherever public/config.js points.
 *
 * Routes: #/ and #/speaker/<id>.
 */

const $ = (id: string) => document.getElementById(id)!;

async function reload(): Promise<void> {
  const fc = await api.dots();
  setState({ dots: fc.features });
}

function initRoute(): void {
  const read = () => {
    const m = /^#\/speaker\/(\d+)/.exec(location.hash);
    const id = m ? Number(m[1]) : null;
    if (id !== getState().selectedId) setState({ selectedId: id });
  };
  window.addEventListener("hashchange", read);
  subscribe((s, changed) => {
    if (!changed.has("selectedId")) return;
    const want = s.selectedId != null ? `#/speaker/${s.selectedId}` : "#/";
    if (location.hash !== want) history.replaceState(null, "", want);
  });
  read();
}

function initViews(map: { setMode: (m: "globe" | "flat") => void }) {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".view-switch button");
  const apply = (v: "globe" | "flat") => {
    buttons.forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    map.setMode(v);
    setState({ view: v });
    try { localStorage.setItem("isogloss-view", v); } catch { /* ignore */ }
  };
  buttons.forEach((b) => b.addEventListener("click", () => apply(b.dataset.view as "globe" | "flat")));
  let stored: string | null = null;
  try { stored = localStorage.getItem("isogloss-view"); } catch { /* ignore */ }
  if (stored === "flat") apply("flat");
}

function initTheme() {
  const btn = $("theme-toggle");
  let stored: string | null = null;
  try { stored = localStorage.getItem("isogloss-theme"); } catch { /* ignore */ }
  if (stored) document.documentElement.dataset.theme = stored;
  btn.addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("isogloss-theme", next); } catch { /* ignore */ }
  });
}

function renderStats() {
  const s = getState();
  const shown = visibleDots(s);
  const audio = shown.filter((d) => d.properties.recordings > 0).length;
  const langs = new Set(shown.map((d) => d.properties.native_language)).size;
  const ui = shown.filter((d) => d.properties.origin === "ui").length;
  $("stats").innerHTML = [["speakers", shown.length], ["languages", langs], ["with audio", audio], ["created here", ui]]
    .map(([k, v]) => `<span class="stat"><b>${num(v as number)}</b> ${k}</span>`).join("");
}

async function main() {
  initTheme();
  const map = initSpeakerMap($("map"), $("map-legend"), async (lon, lat) => {
    const s = getState();
    if (s.mode === "add") setState({ pin: { lon, lat } });
    else if (s.mode === "move" && s.selectedId != null) {
      const sp = await api.update(s.selectedId, { lon, lat });
      setState({ mode: "browse", detail: sp });
      await reload();
    }
  });
  initViews(map);
  initPanel($("input-panel"), reload);
  initDetail($("records-panel"), reload);

  subscribe(async (s, changed) => {
    if (changed.has("dots") || changed.has("filters")) renderStats();
    if (changed.has("selectedId")) {
      if (s.selectedId == null) {
        if (s.detail) setState({ detail: null });
        return;
      }
      try {
        const sp = await api.get(s.selectedId);
        if (getState().selectedId === sp.record.speakerid) setState({ detail: sp });
      } catch {
        setState({ selectedId: null, detail: null });
      }
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && getState().mode !== "browse") setState({ mode: "browse", pin: null });
  });

  const analyse = $("analyse-link") as HTMLAnchorElement;
  analyse.href = apiUrl("/classic/");

  if (backendMissing()) {
    analyse.removeAttribute("href");
    analyse.setAttribute("aria-disabled", "true");
    notice("No backend configured",
      `This site is static; its API lives elsewhere. Set <code>apiBase</code> in
       <code>config.js</code> — on GitHub Pages, the <code>API_BASE</code> repository
       variable — to the backend's HTTPS address, and list this site's origin in the
       backend's <code>GEOMAP_CORS_ORIGINS</code>.`);
    return;
  }
  try {
    const [schema] = await Promise.all([api.schema(), reload()]);
    setState({ schema });
    initRoute();
  } catch (err) {
    notice("Backend unreachable",
      `Could not reach <code>${esc(config().apiBase || location.origin)}</code>
       (${esc((err as Error).message)}). Check that it is running, served over HTTPS,
       and allows this origin (<code>${esc(location.origin)}</code>) in
       <code>GEOMAP_CORS_ORIGINS</code>.`);
  }
}

/** Say why there are no dots, where the record panel would be. */
function notice(title: string, html: string): void {
  $("stats").innerHTML = `<span class="stat error">${esc(title)}</span>`;
  $("records-panel").innerHTML = `<section class="card backend-notice" role="alert">
    <h2>${esc(title)}</h2><p class="hint">${html}</p></section>`;
}

void main();
