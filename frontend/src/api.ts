import type { Candidate, ContactDetail, PendingPerson, Tier, ContactSummary, CountryAggregate, Drilldown, Filters, GeoRecord, GraphData, Neighbor, PathStep, ProximityParams, RecordInput, SearchHit, TokenRow } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.message ?? res.statusText);
  return body as T;
}

function filterParams(f: Partial<Filters>): string {
  const p = new URLSearchParams();
  if (f.kind) p.set("kind", f.kind);
  if (f.language) p.set("language", f.language);
  if (f.country) p.set("country", f.country);
  if (f.start) p.set("start", f.start.toISOString());
  if (f.end) p.set("end", f.end.toISOString());
  if (f.q) p.set("q", f.q);
  return p.toString();
}

function proxParams(p: Partial<ProximityParams>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null) q.set(k, String(v));
  return q.toString();
}

export const api = {
  records: (f: Partial<Filters> = {}) =>
    request<{ records: GeoRecord[] }>(`/api/records?limit=5000&${filterParams(f)}`).then((r) => r.records),
  analyze: (input: RecordInput) => request<GeoRecord>("/api/analyze", { method: "POST", body: JSON.stringify(input) }),
  create: (input: RecordInput) => request<GeoRecord>("/api/records", { method: "POST", body: JSON.stringify(input) }),
  /** Persist a previously analysed (and possibly user-corrected) record as-is. */
  save: (record: GeoRecord) =>
    request<GeoRecord>("/api/records", { method: "POST", body: JSON.stringify({ record }) }),
  remove: (id: string) => request<{ deleted: string }>(`/api/records/${id}`, { method: "DELETE" }),
  clear: () => request<{ deleted: boolean }>("/api/records", { method: "DELETE" }),
  geocode: (q: string, lang?: string, signal?: AbortSignal) =>
    request<{ candidates: Candidate[] }>(
      `/api/geocode?limit=8&q=${encodeURIComponent(q)}${lang ? `&lang=${lang}` : ""}`,
      { signal },
    ).then((r) => r.candidates),
  byCountry: (f: Partial<Filters>) =>
    request<{ countries: CountryAggregate[] }>(`/api/aggregate/country?${filterParams(f)}`).then((r) => r.countries),
  graph: (f: Partial<Filters>, p: Partial<ProximityParams>, index = true) =>
    request<GraphData>(`/api/graph?${filterParams(f)}&${proxParams(p)}&index=${index ? 1 : 0}`),
  neighbors: (id: string, p: Partial<ProximityParams>) =>
    request<{ neighbors: Neighbor[] }>(`/api/graph/neighbors/${id}?${proxParams(p)}`).then((r) => r.neighbors),
  path: (from: string, to: string) =>
    request<{ path: PathStep[] }>(`/api/graph/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then((r) => r.path),
  search: (q: string, f: Partial<Filters>, geo?: { lat: number; lon: number; radius_km: number }, level = "records") =>
    request<{ hits: SearchHit[] }>(
      `/api/search?k=50&level=${level}&q=${encodeURIComponent(q)}&${filterParams(f)}${geo ? `&lat=${geo.lat}&lon=${geo.lon}&radius_km=${geo.radius_km}` : ""}`,
    ).then((r) => r.hits),
  similar: (id: string, opts: { radius_km?: number; start?: Date | null; end?: Date | null } = {}) =>
    request<{ hits: SearchHit[] }>(
      `/api/records/${id}/similar?k=8${opts.radius_km ? `&near=1&radius_km=${opts.radius_km}` : ""}${opts.start ? `&start=${opts.start.toISOString()}` : ""}${opts.end ? `&end=${opts.end.toISOString()}` : ""}`,
    ).then((r) => r.hits),
  tokens: (id: string) =>
    request<{ tokens: TokenRow[]; ents: { text: string; start: number; end: number; label: string }[] }>(`/api/records/${id}/tokens`),
  concordance: (q: string) =>
    request<{ hits: { record_id: string; timestamp: string; language: string; left: string; match: string; right: string }[] }>(
      `/api/tokens/concordance?q=${encodeURIComponent(q)}`,
    ).then((r) => r.hits),
  topTerms: (f: Partial<Filters>) =>
    request<{ terms: { term: string; count: number; records: number; is_geo: boolean }[] }>(`/api/tokens/top?n=24&${filterParams(f)}`).then((r) => r.terms),
  drilldown: (id: string, windowDays = 3650, radiusKm = 1500) =>
    request<Drilldown>(`/api/records/${encodeURIComponent(id)}/drilldown?window_days=${windowDays}&radius_km=${radiusKm}`),
  contacts: (q = "") => request<{ contacts: ContactSummary[] }>(`/api/contacts${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => r.contacts),
  contact: (id: string) => request<ContactDetail>(`/api/contacts/${encodeURIComponent(id)}`),
  createContact: (body: { name: string; aliases?: string[]; notes?: string; tags?: string[] }) =>
    request<ContactDetail>("/api/contacts", { method: "POST", body: JSON.stringify(body) }),
  updateContact: (id: string, body: Partial<{ name: string; aliases: string[]; notes: string; tags: string[] }>) =>
    request<ContactDetail>(`/api/contacts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteContact: (id: string) => request<{ deleted: string }>(`/api/contacts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  mergeContacts: (keep: string, other: string) =>
    request<ContactDetail>(`/api/contacts/${encodeURIComponent(keep)}/merge`, { method: "POST", body: JSON.stringify({ other_id: other }) }),
  notAPerson: (id: string) => request<{ deleted: string; ignored: string[] }>(`/api/contacts/${encodeURIComponent(id)}/not-a-person`, { method: "POST" }),
  unlinkContact: (id: string, recordId: string) =>
    request<{ unlinked: string[] }>(`/api/contacts/${encodeURIComponent(id)}/records/${encodeURIComponent(recordId)}`, { method: "DELETE" }),
  review: () => request<{ items: PendingPerson[] }>("/api/contacts/review").then((r) => r.items),
  resolveReview: (id: string, body: { action: "link"; contact_id: string } | { action: "new"; name?: string } | { action: "ignore" }) =>
    request<{ resolved: string; contact_id: string | null }>(`/api/contacts/review/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) }),
  verdict: (contactId: string, recordId: string, verdict: "yes" | "no") =>
    request<{ tier: Tier | null }>(`/api/contacts/${encodeURIComponent(contactId)}/records/${encodeURIComponent(recordId)}/verdict`,
      { method: "POST", body: JSON.stringify({ verdict }) }),
  removeAlias: (contactId: string, alias: string) =>
    request<ContactDetail>(`/api/contacts/${encodeURIComponent(contactId)}/aliases?alias=${encodeURIComponent(alias)}`, { method: "DELETE" }),
  health: () => request<Record<string, any>>("/api/health"),
  samples: () => request<{ records: number }>("/api/samples", { method: "POST" }),
};
