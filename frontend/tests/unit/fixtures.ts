import type { ContactDetail, GeoRecord, Temporal } from "../../src/types";

export const t = (value: string, granularity: Temporal["granularity"] = "day"): Temporal =>
  ({ value, granularity, source: "extracted", surface: null, span: null, start: value, end: value });

const place = (name: string, lat: number, lon: number, cc: string, n3: string) => ({
  place_id: `ne:${name}`, name, feature_class: "capital", lat, lon, country_code: cc, country_name: cc, iso_n3: n3,
  admin1: null, population: null,
});

const TEXT = "On 9 May 2019 Angela Merkel met Emmanuel Macron in Sibiu. Merkel later flew to Berlin <script>alert(1)</script>.";
/** [start, end) of the n-th occurrence of ``word`` (fixtures never hand-count offsets). */
const span = (word: string, nth = 0): [number, number] => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = TEXT.indexOf(word, i + 1);
  return [i, i + word.length];
};
const m = (word: string, nth = 0) => ({ text: word, start: span(word, nth)[0], end: span(word, nth)[1] });

export const record: GeoRecord = {
  id: "r1", kind: "text",
  content: TEXT,
  timestamp: t("2019-05-09T00:00:00+00:00"), language: { code: "en", name: "English", confidence: 1, source: "detected" },
  ingested_at: "", labels: [], centroid: null, metadata: {},
  geo: [
    { surface: "Sibiu", span: span("Sibiu"), place: place("Sibiu", 45.8, 24.15, "ROU", "642"), confidence: 0.9, matched_name: "Sibiu", matched_lang: "en", match_type: "exact", alternatives: [] },
    { surface: "Berlin", span: span("Berlin"), place: place("Berlin", 52.52, 13.4, "DEU", "276"), confidence: 0.9, matched_name: "Berlin", matched_lang: "en", match_type: "exact", alternatives: [] },
  ],
  temporal_mentions: [{ ...t("2019-05-09T00:00:00+00:00"), span: span("9 May 2019") }],
  contacts: [
    { contact_id: "c_am", record_id: "r1", name: "Angela Merkel", confidence: 0.95, method: "name", tier: "gold", confirmations: 2,
      mentions: [m("Angela Merkel"), m("Merkel", 1)] },
    { contact_id: "c_em", record_id: "r1", name: "Emmanuel Macron", confidence: 0.95, method: "name", tier: "bronze", confirmations: 0,
      mentions: [m("Emmanuel Macron")] },
  ],
  concepts: [{ text: "Angela Merkel", type: "PER", count: 1, spans: [span("Angela Merkel")], source: "ner" }],
};

export const contact: ContactDetail = {
  id: "c_am", name: "Angela Merkel", kind: "person", aliases: ["Angela Merkel", "Merkel"],
  alias_tiers: [
    { alias: "Angela Merkel", key: "angela merkel", tier: "gold", evidence: { user: 2, records: 2, inferred: 0 } },
    { alias: "Merkel", key: "merkel", tier: "bronze", evidence: { user: 0, records: 2, inferred: 0 } },
  ],
  tags: [], manual: false, record_count: 2, notes: "",
  first_seen: t("2017-06-01T00:00:00+00:00", "month"), last_seen: t("2019-05-09T00:00:00+00:00"),
  languages: { en: 2 },
  places: [
    { place_id: "ne:Paris", name: "Paris", lat: 48.86, lon: 2.35, country_code: "FRA", country_name: "France", iso_n3: "250", count: 2, roles: { event: 2 } },
    { place_id: "ne:Sibiu", name: "Sibiu", lat: 45.8, lon: 24.15, country_code: "ROU", country_name: "Romania", iso_n3: "642", count: 1, roles: { event: 1 } },
  ],
  countries: [{ country_code: "FRA", country_name: "France", iso_n3: "250", count: 2 }],
  co_contacts: [{ id: "c_em", name: "Emmanuel Macron", shared_records: 2 }],
  created_at: "", updated_at: "",
  records: [
    { id: "r1", kind: "text", content: record.content, timestamp: t("2019-05-09T00:00:00+00:00"), dated: true, language: "en",
      places: [], mentions: [], confidence: 1, method: "name", tier: "gold", confirmations: 2, contacts: record.contacts! },
    { id: "r2", kind: "text", content: "In June 2017 Angela Merkel visited Paris.", timestamp: t("2017-06-01T00:00:00+00:00", "month"), dated: true,
      language: "en", places: [], mentions: [], confidence: 1, method: "name", tier: "bronze", confirmations: 0, contacts: [] },
  ],
};

export { span as spanOf };
