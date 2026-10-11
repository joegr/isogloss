// Writes dist/config.js, the site's only knowledge of its backend, from the
// API_BASE environment variable (the repository variable of the same name in
// CI). Empty → same origin; the page then says no backend is configured.
import { writeFileSync } from "node:fs";

const base = (process.env.API_BASE || "").trim();
if (base && !/^https:\/\//.test(base)) {
  console.error("API_BASE must be an https:// URL (Pages is HTTPS)");
  process.exit(1);
}
const js =
  "// Written by the Pages workflow from the API_BASE repository variable.\n" +
  `window.SPEAKER_MAP_CONFIG = { apiBase: ${JSON.stringify(base)} };\n`;
writeFileSync(new URL("../dist/config.js", import.meta.url), js);
process.stdout.write(js);
