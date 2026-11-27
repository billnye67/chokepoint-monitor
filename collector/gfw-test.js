// Global Fishing Watch check: what the AIS presence and SAR (radar) datasets return for each zone.
// Usage: node collector/gfw-test.js [days]      (default 30)
// Needs GFW_API_KEY in .dev.vars at the project root.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const days = Number(process.argv[2] || 30);
const vars = Object.fromEntries(
  fs.readFileSync(path.join(root, ".dev.vars"), "utf8").split(/\r?\n/)
    .filter(l => l.includes("=") && !l.trim().startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const KEY = vars.GFW_API_KEY;
if (!KEY) { console.error("GFW_API_KEY is empty in .dev.vars"); process.exit(1); }
const zones = JSON.parse(fs.readFileSync(path.join(root, "zones.json"), "utf8")).zones;
const API = "https://gateway.api.globalfishingwatch.org/v3";
const H = { Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const day = d => d.toISOString().slice(0, 10);

async function report(dataset, zone, from, to, filter) {
  const [[a, b], [c, d]] = zone.box;
  const s = Math.min(a, c), n = Math.max(a, c), w = Math.min(b, d), e = Math.max(b, d);
  const q = new URLSearchParams({
    "spatial-resolution": "LOW", "temporal-resolution": "DAILY", "spatial-aggregation": "true",
    "datasets[0]": dataset, "date-range": `${from},${to}`, format: "JSON",
  });
  if (filter) q.set("filters[0]", filter);
  const body = JSON.stringify({ geojson: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${API}/4wings/report?${q}`, { method: "POST", headers: H, body });
    if (r.status === 429 || r.status === 524 || r.status === 503) { await sleep(8000 * (attempt + 1)); continue; }
    const text = await r.text();
    if (!r.ok) return { error: `${r.status} ${text.slice(0, 200)}` };
    const rows = Object.values(JSON.parse(text).entries?.[0] || {})[0] || [];
    return { rows };
  }
  return { error: "still busy after 6 tries" };
}

(async () => {
  const meta = {};
  for (const ds of ["public-global-presence:latest", "public-global-sar-presence:latest"]) {
    const o = await (await fetch(`${API}/datasets/${ds}`, { headers: H })).json();
    meta[ds] = o; console.log(ds, "->", o.id, "runs to", o.endDate);
  }
  const out = [];
  let sample = null;
  for (const z of zones) {
    const row = { zone: z.id };
    for (const [label, ds, filter] of [
      ["ais", "public-global-presence:latest", null],
      ["sar_all", "public-global-sar-presence:latest", null],
      ["sar_unmatched", "public-global-sar-presence:latest", "matched='false'"],
    ]) {
      const end = new Date(meta[ds].endDate), start = new Date(end - days * 86400000);
      const res = await report(ds, z, day(start), day(end), filter);
      if (res.error) { row[label] = "ERR"; row[label + "_err"] = res.error; continue; }
      sample ??= res.rows[0];
      const dates = [...new Set(res.rows.map(r => (r.date || "").slice(0, 10)))].sort();
      const field = label === "ais" ? "vesselIDs" : "detections";
      row[label + "_days"] = dates.length;
      row[label + "_total"] = Math.round(res.rows.reduce((t, r) => t + (r[field] ?? r.detections ?? r.hours ?? 0), 0));
      row[label + "_last"] = dates[dates.length - 1] || "";
      await sleep(1500);
    }
    console.log(JSON.stringify(row));
    out.push(row);
  }
  console.log("\nsample row:", JSON.stringify(sample));
  console.table(out.map(({ zone, ais_days, ais_total, ais_last, sar_all_days, sar_all_total, sar_all_last, sar_unmatched_total }) =>
    ({ zone, ais_days, ais_total, ais_last, sar_all_days, sar_all_total, sar_all_last, sar_unmatched_total })));
  fs.writeFileSync(path.join(root, `coverage-gfw-${day(new Date())}.json`), JSON.stringify({ days, out, sample }, null, 2));
})();
