import type { Dot, Filters, Schema, Speaker } from "./types";

/**
 * One small store for the speaker module, same shape as the GeoCRM one it
 * replaces: set a patch, every subscriber hears which keys changed.
 *
 * `mode` is what a click on the globe means: select a dot, drop a new
 * speaker's pin, or move the selected speaker's pin.
 */
export interface SpeakerState {
  dots: Dot[];
  schema: Schema | null;
  filters: Filters;
  selectedId: number | null;
  detail: Speaker | null;
  mode: "browse" | "add" | "move";
  pin: { lon: number; lat: number } | null;
  view: "globe" | "flat";
}

type Key = keyof SpeakerState;
type Listener = (s: SpeakerState, changed: Set<Key>) => void;

const state: SpeakerState = {
  dots: [],
  schema: null,
  filters: { speakers: "all", language: null, withAudio: false, createdHere: false },
  selectedId: null,
  detail: null,
  mode: "browse",
  pin: null,
  view: "globe",
};
const listeners: Listener[] = [];

export const getState = (): SpeakerState => state;

export function setState(patch: Partial<SpeakerState>): void {
  const changed = new Set(Object.keys(patch) as Key[]);
  Object.assign(state, patch);
  for (const l of listeners) l(state, changed);
}

export function subscribe(l: Listener): void {
  listeners.push(l);
}

export function setFilters(patch: Partial<Filters>): void {
  setState({ filters: { ...state.filters, ...patch } });
}

export function visibleDots(s: SpeakerState = state): Dot[] {
  const f = s.filters;
  return s.dots.filter((d) => {
    const p = d.properties;
    if (f.speakers === "native" && !p.native_english) return false;
    if (f.speakers === "l2" && p.native_english) return false;
    if (f.language && p.native_language !== f.language) return false;
    if (f.withAudio && !p.recordings) return false;
    if (f.createdHere && p.origin !== "ui") return false;
    return true;
  });
}
