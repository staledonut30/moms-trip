// Saves FAA airport status for MCO and DTW to faa.json, so the page can read it.
// Run by .github/workflows/publish.yml every ~10 minutes. Usage: node scripts/faa.mjs [out.json]
import { writeFile } from 'node:fs/promises';
import { fetchFaa } from '../status.js';

const out = process.argv[2] || 'faa.json';
let data;
try {
  data = { ok: true, ...(await fetchFaa()) };
} catch (e) {
  // Write the failure (with its time) rather than keeping old data around.
  data = { ok: false, fetchedAt: Date.now(), error: String(e?.message || e).slice(0, 200) };
}
await writeFile(out, JSON.stringify(data) + '\n');
console.log(JSON.stringify(data));
