// Mirrors backend/app/speakers.py. GET /api/speakers/schema is the source of
// truth for which fields a speaker record has.

import type { Feature, FeatureCollection, Point } from "geojson";

export interface DotProps {
  id: number;
  native_language: string;
  gender: string | null;
  age: number | null;
  birthplace: string | null;
  match: string | null; // how the point was found: pin | city+state | city | city~ | state | country
  recordings: number;
  origin: "archive" | "ui";
  speech_sample: string;
  native_english: boolean;
}
export type Dot = Feature<Point, DotProps>;
export type Dots = FeatureCollection<Point, DotProps>;

export interface FieldSpec {
  name: string;
  label: string;
  kind: "text" | "number" | "select" | "textarea" | "auto";
  required?: boolean;
  options?: string[];
  min?: number;
  max?: number;
  help?: string;
}

export interface Schema {
  fields: FieldSpec[];
  languages: { value: string; n: number; code: string | null }[];
  countries: { value: string; n: number }[];
  ner_model: string;
}

export interface Entity {
  field: string;
  start: number;
  end: number;
  text: string;
  label: string; // LOC PER ORG MISC DATE DURATION AGE_RANGE COURSE
  source: string;
  place: string | null;
  match: string | null;
  lon: number | null;
  lat: number | null;
}

export interface Recording {
  id: string;
  duration_s: number;
  source_file: string | null;
  phone_string: string;
  created: string;
  feature_version: string;
  node_id?: string;
}

export type SpeakerRecord = Record<string, string | number | null> & { speakerid: number; speech_sample: string };

export interface CascadeStep {
  step: "record" | "place" | "entities";
  [k: string]: unknown;
}

export interface Speaker {
  record: SpeakerRecord;
  origin: "archive" | "ui";
  native_english: boolean;
  geo: {
    lon: number | null;
    lat: number | null;
    birthplace: string | null;
    match: string | null;
    source: string | null;
    matched_name: string | null;
    admin1: string | null;
    country_code: string | null;
  };
  entities: Entity[];
  recordings: Recording[];
  ner: { model: string | null; at: string | null };
  created: string;
  cascade?: CascadeStep[];
}

export interface Reverse {
  name: string;
  admin1: string;
  country: string;
  country_code: string;
  lon: number;
  lat: number;
  distance_km: number;
  suggest: { city: string; state_or_province: string | null; country: string };
}

export interface AttachResult {
  recording: Recording;
  duplicate: boolean;
  node_id: string;
  phone_string?: string;
  notes?: string[];
}

export interface Filters {
  speakers: "all" | "native" | "l2";
  language: string | null;
  withAudio: boolean;
  createdHere: boolean;
}
