/** Hash routes: #/ (explore), #/contacts, #/contacts/<id>, #/record/<id> (drilldown overlay). */

export type Page = "explore" | "contacts" | "contact";
export interface Route {
  page: Page;
  contactId?: string;
  recordId?: string;
}

export function parseHash(hash = location.hash): Route {
  const m = /^#\/(contacts|record)(?:\/([^/?#]+))?/.exec(hash);
  if (!m) return { page: "explore" };
  if (m[1] === "contacts") return m[2] ? { page: "contact", contactId: decodeURIComponent(m[2]) } : { page: "contacts" };
  return { page: "explore", recordId: m[2] ? decodeURIComponent(m[2]) : undefined };
}

let lastPage = "#/";

/** The last non-overlay location, so closing a record drilldown returns where you came from. */
export function lastPageHash(): string {
  return lastPage;
}

export function initRouter(onRoute: (r: Route) => void): void {
  const run = () => {
    const r = parseHash();
    if (!r.recordId) lastPage = location.hash || "#/";
    const section = parseHash(lastPage).page === "explore" ? "explore" : "contacts";
    document.querySelectorAll<HTMLAnchorElement>(".rail-link[data-nav]").forEach((a) => {
      const active = a.dataset.nav === section;
      a.classList.toggle("active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    onRoute(r);
  };
  window.addEventListener("hashchange", run);
  run();
}
