import { api } from "./api";
import { getState, setState, subscribe } from "./state";
import { debounce, esc } from "./util";

/** Keyword-in-context over the spaCy token store: how a term is used across languages and time. */
export function initConcordance(panel: HTMLElement): void {
  const card = document.createElement("section");
  card.className = "card conc-card";
  card.innerHTML = `
    <div class="card-head"><h2>Concordance</h2><span class="hint">token store</span></div>
    <input type="search" id="conc-q" placeholder="Term, e.g. Berlin, 2011, 東京" aria-label="Concordance term" />
    <div class="conc-terms" id="conc-terms" aria-label="Frequent terms"></div>
    <ol class="conc-hits" id="conc-hits"></ol>`;
  panel.appendChild(card);
  const input = card.querySelector<HTMLInputElement>("#conc-q")!;
  const terms = card.querySelector<HTMLElement>("#conc-terms")!;
  const hits = card.querySelector<HTMLElement>("#conc-hits")!;

  async function loadTerms() {
    const f = getState().filters;
    try {
      const top = await api.topTerms({ ...f, q: "" });
      terms.innerHTML = top.length
        ? top.map((t) => `<button type="button" class="chip term${t.is_geo ? " geo" : ""}" data-term="${esc(t.term)}"
            title="${t.count} occurrences in ${t.records} records">${esc(t.term)}<span>${t.records}</span></button>`).join("")
        : `<span class="muted">No tokens yet.</span>`;
      terms.querySelectorAll<HTMLButtonElement>(".term").forEach((b) => b.addEventListener("click", () => {
        input.value = b.dataset.term!;
        search();
      }));
    } catch {
      terms.innerHTML = "";
    }
  }

  async function search() {
    const q = input.value.trim();
    terms.hidden = !!q;
    if (!q) {
      hits.innerHTML = "";
      return;
    }
    const res = await api.concordance(q);
    hits.innerHTML = res.length
      ? res.map((h) => `
        <li data-id="${h.record_id}" tabindex="0">
          <div class="conc-meta"><span>${esc(h.timestamp.slice(0, 10))}</span><span class="pill">${esc(h.language)}</span></div>
          <div class="conc-line" dir="auto"><span class="l">${esc(h.left)}</span> <mark>${esc(h.match)}</mark> <span class="r">${esc(h.right)}</span></div>
        </li>`).join("")
      : `<li class="muted empty-hit">No occurrences of “${esc(q)}”.</li>`;
    hits.querySelectorAll<HTMLElement>("[data-id]").forEach((li) => {
      const pick = () => setState({ selectedId: li.dataset.id! });
      li.addEventListener("click", pick);
      li.addEventListener("keydown", (e) => e.key === "Enter" && pick());
    });
  }

  input.addEventListener("input", debounce(search, 200));
  const loadTermsDebounced = debounce(loadTerms, 300);
  subscribe((_s, changed) => {
    if (changed.has("records") || changed.has("filters")) {
      loadTermsDebounced();
      if (input.value.trim()) search();
    }
  });
}
