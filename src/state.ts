import type { CountryAggregate, Filters, GeoRecord, GraphData, MentionPoint, NearFilter, ProximityParams } from "./types";

export interface AppState {
  records: GeoRecord[];
  countries: CountryAggregate[];
  filters: Filters;
  selectedId: string | null;
  preview: GeoRecord | null;
  /** Proximity parameters shared by the network view, globe arcs and the "near" filter. */
  proximity: ProximityParams;
  /** Restrict everything to records proximate to one record (from the graph backend). */
  near: NearFilter | null;
  /** Record-only proximity graph for the current filters (drawn as arcs on the globe). */
  proxGraph: GraphData | null;
  view: "globe" | "flat" | "network";
}

type Listener = (s: AppState, changed: Set<keyof AppState>) => void;

const state: AppState = {
  records: [],
  countries: [],
  filters: { kind: null, language: null, country: null, start: null, end: null, q: "" },
  selectedId: null,
  preview: null,
  proximity: { max_days: 3650, lang_scope: "any", geo_scope: "any", min_weight: 0.35, w_time: 1, w_lang: 1, w_geo: 1, w_sem: 1, k: 6 },
  near: null,
  proxGraph: null,
  view: "globe",
};

const listeners: Listener[] = [];

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  const changed = new Set(Object.keys(patch) as (keyof AppState)[]);
  Object.assign(state, patch);
  for (const l of listeners) l(state, changed);
}

export function setFilters(patch: Partial<Filters>): void {
  setState({ filters: { ...state.filters, ...patch } });
}

export function subscribe(l: Listener): void {
  listeners.push(l);
}

/** Client-side filtering, so brushing and clicking feel instant. */
export function filteredRecords(s: AppState = state, ignore: (keyof Filters)[] = []): GeoRecord[] {
  const f = s.filters;
  const skip = new Set(ignore);
  const q = f.q.trim().toLowerCase();
  return s.records.filter((r) => {
    if (s.near && r.id !== s.near.anchor && !s.near.ids.has(r.id)) return false;
    if (!skip.has("kind") && f.kind && r.kind !== f.kind) return false;
    if (!skip.has("language") && f.language && r.language.code !== f.language) return false;
    if (!skip.has("country") && f.country && !r.geo.some((m) => m.place.country_code === f.country)) return false;
    const t = new Date(r.timestamp.value);
    if (!skip.has("start") && f.start && t < f.start) return false;
    if (!skip.has("end") && f.end && t > f.end) return false;
    if (!skip.has("q") && q && !r.content.toLowerCase().includes(q) && !r.labels.some((l) => l.toLowerCase().includes(q)))
      return false;
    return true;
  });
}

export function mentionPoints(records: GeoRecord[]): MentionPoint[] {
  return records.flatMap((record) => record.geo.map((mention, index) => ({ record, mention, index })));
}
