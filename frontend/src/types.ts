// Mirrors backend/geomap/ontology.py (GET /api/ontology returns the JSON Schema).

export type RecordKind = "string" | "text" | "label";
export type Provenance = "provided" | "detected" | "extracted" | "ingested" | "default";
export type Granularity = "year" | "month" | "day" | "datetime";

export interface Language {
  code: string;
  name: string | null;
  confidence: number;
  source: Provenance;
}

export interface Temporal {
  value: string;
  granularity: Granularity;
  source: Provenance;
  surface: string | null;
  span: [number, number] | null;
  start: string;
  end: string;
}

export interface Place {
  place_id: string;
  name: string;
  feature_class: string;
  lat: number;
  lon: number;
  country_code: string | null;
  country_name: string | null;
  iso_n3: string | null;
  admin1: string | null;
  population: number | null;
  subclass?: string | null;
  wikidata_id?: string | null;
  geonames_id?: string | null;
  bbox?: [number, number, number, number] | null;
  admin_path?: string[];
  nearest?: { place_id: string; name: string; distance_km: number; admin1?: string | null } | null;
}

export type Role = "event" | "origin" | "destination" | "route" | "topic" | "unspecified";

export interface Concept {
  text: string;
  type: "PER" | "ORG" | "MISC" | "TERM" | "LABEL";
  count: number;
  spans: [number, number][];
  source: "ner" | "terms" | "label";
}

export interface GeoMention {
  surface: string;
  span: [number, number] | null;
  place: Place;
  confidence: number;
  matched_name: string;
  matched_lang: string;
  match_type: "exact" | "alias" | "fuzzy" | "coordinates";
  alternatives: Place[];
  role?: Role;
  role_cue?: string | null;
  source?: "gazetteer" | "ner" | "coordinates" | "label" | "string";
  ner_label?: string | null;
  time?: Temporal | null;
}

export interface GeoRecord {
  id: string;
  kind: RecordKind;
  content: string;
  timestamp: Temporal;
  language: Language;
  ingested_at: string;
  labels: string[];
  geo: GeoMention[];
  temporal_mentions: Temporal[];
  centroid: { lat: number; lon: number } | null;
  metadata: Record<string, unknown>;
  concepts?: Concept[];
  primary?: number | null;
  extent?: [number, number, number, number] | null;
  dated?: boolean;
  document_time?: Temporal | null;
  ontology_version?: number;
  /** GeoCRM: people linked to this record (many-to-many), with exact name spans. */
  contacts?: ContactLink[];
  /** Names that fit several contacts and await a human decision (review queue). */
  pending_people?: PendingPerson[];
}

export type Tier = "bronze" | "silver" | "gold";

export interface AliasTier {
  alias: string;
  key: string;
  tier: Tier;
  evidence: { user: number; records: number; inferred: number };
}

export interface PendingPerson {
  id: string;
  record_id: string;
  text: string;
  mentions: PersonMention[];
  candidates: { id: string; name: string }[];
  record?: ContactRecord;
}

export interface PersonMention {
  text: string;
  start: number;
  end: number;
}

export interface ContactLink {
  contact_id: string;
  record_id: string;
  name: string;
  mentions: PersonMention[];
  confidence: number;
  method: "name" | "alias" | "surname" | "stem" | "context" | "known" | "new" | "manual";
  tier: Tier;
  confirmations: number;
}

export interface ContactPlace {
  place_id: string;
  name: string;
  lat: number;
  lon: number;
  country_code: string | null;
  country_name: string | null;
  iso_n3?: string | null;
  count: number;
  roles: Record<string, number>;
}

export interface ContactSummary {
  id: string;
  name: string;
  kind: "person";
  aliases: string[];
  alias_tiers: AliasTier[];
  tags: string[];
  manual: boolean;
  record_count: number;
  first_seen: Temporal | null;
  last_seen: Temporal | null;
  languages: Record<string, number>;
  places: ContactPlace[];
  countries: { country_code: string; country_name: string; iso_n3?: string | null; count: number }[];
  co_contacts: { id: string; name: string; shared_records: number }[];
  created_at: string;
  updated_at: string;
}

export interface ContactRecord {
  id: string;
  kind: RecordKind;
  content: string;
  timestamp: Temporal;
  dated: boolean;
  language: string;
  places: { name: string; place_id: string; lat: number; lon: number; country_code: string | null; role: string }[];
  mentions: PersonMention[];
  confidence: number;
  method: ContactLink["method"];
  tier: Tier;
  confirmations: number;
  contacts: ContactLink[];
}

export interface ContactDetail extends ContactSummary {
  notes: string;
  records: ContactRecord[];
}

export interface RecordSummary {
  id: string;
  kind: RecordKind;
  content: string;
  timestamp: Temporal;
  language: string;
  dated: boolean;
  places: string[];
}

export interface Drilldown {
  record: GeoRecord;
  nav: { index: number; total: number; prev: string | null; next: string | null };
  anchor: { lat: number; lon: number } | null;
  countries: import("geojson").FeatureCollection<import("geojson").Geometry, { country_code: string; country_name: string }>;
  sentences: [number, number][];
  ents: { text: string; label: string; span: [number, number] }[];
  context: {
    same_place_time: (RecordSummary & { score: ProximityScore })[];
    same_time: (RecordSummary & { gap_days: number })[];
    same_concepts: (RecordSummary & { shared: string[] })[];
    nearby_semantic: (RecordSummary & { similarity: number })[];
  };
  paths: Record<string, PathStep[]>;
  params: { window_days: number; radius_km: number };
}

export interface Candidate {
  place: Place;
  score: number;
  rank: number;
  matched_name: string;
  matched_lang: string;
  match_type: GeoMention["match_type"];
}

export interface CountryAggregate {
  country_code: string;
  iso_n3: string | null;
  country_name: string;
  mentions: number;
  records: number;
  mean_confidence: number;
  languages: string[];
}

export interface RecordInput {
  kind: RecordKind;
  content?: string;
  labels?: string[];
  timestamp?: string;
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface Filters {
  kind: RecordKind | null;
  language: string | null;
  country: string | null; // ISO alpha-3
  start: Date | null;
  end: Date | null;
  q: string;
}

/** A flattened mention used by the map layer. */
export interface MentionPoint {
  record: GeoRecord;
  mention: GeoMention;
  index: number;
}

export type LangScope = "same" | "branch" | "family" | "any";
export type GeoScope = "place" | "country" | "any";

export interface ProximityParams {
  max_days: number;
  lang_scope: LangScope;
  geo_scope: GeoScope;
  min_weight: number;
  w_time: number;
  w_lang: number;
  w_geo: number;
  w_sem: number;
  k: number;
}

export interface ProximityScore {
  weight: number;
  time: number;
  lang: number;
  geo: number;
  sem: number | null;
  ling_time: number;
  dt_days: number;
  lang_relation: "same" | "branch" | "family" | "other" | "unknown";
  shared_places: string[];
  shared_countries: string[];
}

export type GraphNodeType = "record" | "place" | "country" | "language" | "branch" | "family" | "year" | "label" | "contact";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  degree: number;
  record_id?: string;
  kind?: RecordKind;
  language?: string;
  timestamp?: string;
  year?: number;
  lat?: number;
  lon?: number;
  contact_id?: string;
}

export interface GraphLink extends Partial<ProximityScore> {
  source: string;
  target: string;
  type: "PROXIMITY" | "MENTIONS" | "IN" | "WRITTEN_IN" | "BRANCH" | "FAMILY" | "AT" | "NEXT" | "TAGGED" | "MENTIONS_PERSON";
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: { records: number; index_nodes: number; proximity_edges: number; components: number };
}

export interface Neighbor extends ProximityScore {
  id: string;
}

export interface PathStep {
  id: string;
  type: GraphNodeType;
  label: string;
  via?: GraphLink["type"];
}

/** Restricts all views to a set of records (graph neighbours or semantic search hits). */
export interface NearFilter {
  label: string;
  anchor: string | null; // record the set was derived from (kept visible)
  ids: Set<string>;
  scores: Map<string, number>;
}

export interface SearchHit {
  score: number;
  record_id: string;
  text: string;
  ts: string;
  language: string;
  kind: RecordKind;
  place_name?: string;
  surface?: string;
  location?: { lat: number; lon: number };
}

export interface TokenRow {
  i: number;
  text: string;
  norm: string;
  shape: string;
  idx: number;
  ws: string;
  is_alpha: number;
  is_punct: number;
  sent_start: number;
  ent_type: string | null;
  ent_iob: string | null;
  geo_place: string | null;
  time_value: string | null;
}
