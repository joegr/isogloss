import fs from "node:fs";
import { request, type FullConfig } from "@playwright/test";

/** Seed a known dataset: the samples plus a deliberately ambiguous name for the review queue. */
export default async function globalSetup(config: FullConfig) {
  const base = config.projects[0].use.baseURL!;
  const api = await request.newContext({ baseURL: base });
  for (let i = 0; i < 120; i++) {
    const ok = await api.get("/api/healthz").then((r) => r.ok()).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!process.env.E2E_BASE_URL && process.env.E2E_DB) {
    // fresh DB per run is created by the server; clear anything left in it
    await api.delete("/api/records");
  }
  const existing = (await (await api.get("/api/records")).json()).records.length;
  if (!existing) {
    await api.post("/api/samples");
    await api.post("/api/records", { data: { kind: "text", content: "In 1968 Robert F. Kennedy campaigned in Los Angeles." } });
    await api.post("/api/records", { data: { kind: "text", content: "Kennedy was mentioned.", language: "en" } });
  }
  await api.dispose();
  fs.mkdirSync("test-results", { recursive: true });
}
