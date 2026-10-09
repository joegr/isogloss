import type { AttachResult, Dots, Reverse, Schema, Speaker } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body as { detail?: unknown }).detail;
    throw new ApiError(res.status, typeof detail === "string" ? detail : res.statusText);
  }
  return body as T;
}

const json = (method: string, data: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

export const api = {
  dots: () => request<Dots>("/api/speakers"),
  schema: () => request<Schema>("/api/speakers/schema"),
  get: (id: number) => request<Speaker>(`/api/speakers/${id}`),
  /** The cascade: record → place → entities. */
  create: (fields: Record<string, unknown>) => request<Speaker>("/api/speakers", json("POST", fields)),
  update: (id: number, fields: Record<string, unknown>) => request<Speaker>(`/api/speakers/${id}`, json("PATCH", fields)),
  remove: (id: number) => request<{ deleted: number }>(`/api/speakers/${id}`, { method: "DELETE" }),
  /** Audio, already converted to 16 kHz mono WAV in the browser. */
  attach: (id: number, wav: ArrayBuffer, filename?: string) =>
    request<AttachResult>(`/api/speakers/${id}/audio${filename ? `?filename=${encodeURIComponent(filename)}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    }),
  removeRecording: (recId: string) =>
    request<{ deleted: string }>(`/api/recordings/${encodeURIComponent(recId)}`, { method: "DELETE" }),
  matchSamples: (filenames: string[]) =>
    request<{ matched: Record<string, number>; unmatched: string[] }>("/api/speakers/match-samples", json("POST", { filenames })),
  nerAll: () => request<{ speakers: number; entities: number; model: string }>("/api/speakers/ner", { method: "POST" }),
  reverse: (lon: number, lat: number) => request<Reverse>(`/api/geo/reverse?lon=${lon}&lat=${lat}`),
  search: (q: string) =>
    request<{ lon: number; lat: number; match: string; name: string }>(`/api/geo/search?q=${encodeURIComponent(q)}`),
  audioUrl: (recId: string) => `/api/recordings/${encodeURIComponent(recId)}/audio`,
};
