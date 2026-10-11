/**
 * Runtime configuration, from public/config.js — a plain script loaded before
 * the bundle and never compiled, so pointing the site at another backend is a
 * one-line edit (or the API_BASE repo variable, which the Pages workflow
 * writes into it), not a rebuild.
 *
 *   window.SPEAKER_MAP_CONFIG = { apiBase: "https://api.example.org" };
 *
 * An empty apiBase means "same origin": what local development uses, with
 * Vite proxying /api to a backend on this machine.
 */

export interface SpeakerMapConfig {
  apiBase: string;
}

declare global {
  interface Window {
    SPEAKER_MAP_CONFIG?: Partial<SpeakerMapConfig>;
  }
}

export function config(): SpeakerMapConfig {
  const raw = (typeof window !== "undefined" && window.SPEAKER_MAP_CONFIG) || {};
  return { apiBase: String(raw.apiBase ?? "").trim().replace(/\/+$/, "") };
}

/** An API path ("/api/speakers") as a URL on the configured backend. */
export function apiUrl(path: string): string {
  return `${config().apiBase}${path}`;
}

/** True when the site is served from somewhere other than its backend and no
 * backend has been configured — e.g. GitHub Pages before API_BASE is set. */
export function backendMissing(): boolean {
  return !config().apiBase && !import.meta.env.DEV;
}
