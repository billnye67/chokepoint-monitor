// Evidence builder: for a few chosen anomalies, gathers what else changed on the same dates and publishes it for the site.
// It never says what caused anything. It lines other public data up against the traffic dates.
// Usage: node analysis/evidence.js [--dry-run]
// Needs a GDELT rows file made by analysis/gdelt_pull.py (default: drafts/evidence-raw/gdelt-events-two-cases.jsonl).
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const root = path.join(__dirname, "..");
const vars = {};
try {
  for (const l of fs.readFileSync(path.join(root, ".dev.vars"), "utf8").split(/\r?\n/)) {
    if (l.includes("=") && !l.trim().startsWith("#")) vars[l.slice(0, l.indexOf("=")).trim()] = l.slice(l.indexOf("=") + 1).trim();
  }
} catch {}
const env = k => process.env[k] || vars[k] || "";
const BASE = env("INGEST_URL").replace(/\/ingest$/, ""), SECRET = env("INGEST_SECRET");
const dryRun = process.argv.includes("--dry-run");
const GDELT_FILE = path.join(root, "drafts", "evidence-raw", "gdelt-events-two-cases.jsonl");
const UA = { "user-agent": "chokepoint-monitor (non-commercial research project)" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(d + "T00:00:00Z") + n * 86400000);
const dayList = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const r2 = v => v == null ? null : Math.round(v * 100) / 100;

// The cases. "area" is the key used in the GDELT rows file; "places" keeps only rows in the right countries
// (the place-name search alone also matches Odessa, Texas).
const CASES = [
  {
    id: "hormuz-june-rebound", zone: "hormuz", metric: "total", from: "2026-06-15", to: "2026-07-13",
    title: "Strait of Hormuz: the late-June rebound",
    summary: "The 7-day average rose from 11.3 on 20 June to 31.9 on 29 June, then fell back to about 23 by early July.",
    area: "hormuz", places: /(Iran|Oman|United Arab Emirates|Oceans)\s*$/, where: "the Strait of Hormuz, Gulf of Oman and nearby ports",
    point: { lat: 26.4, lon: 56.4 }, sanctions: /Iran/i, sanctionsLabel: "Iran",
  },
  {
    id: "bosporus-decline", zone: "bosporus", metric: "total", from: "2026-06-01", to: "2026-11-22",
    title: "Bosporus: the decline from June to November",
    summary: "Traffic fell from about 82 ships a day in June to 48 in November, a fall of about 40%. The monitor rated it elevated, never abnormal.",
    area: "bosporus", places: /(Ukraine|Russia|Turkey|Romania|Bulgaria|Georgia|Oceans)\s*$/, where: "Black Sea ports and waters, and the Turkish straits",
    point: { lat: 41.1, lon: 29.1 }, sanctions: /Russia|Ukraine/i, sanctionsLabel: "Russia or Ukraine",
  },
];

async function get(url, as = "text") {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return as === "buffer" ? Buffer.from(await r.arrayBuffer()) : as === "json" ? await r.json() : await r.text();
      if (r.status < 500 && r.status !== 429) throw new Error(url + " answered " + r.status);
    } catch (e) { if (i === 2) throw e; }
    await sleep(3000 * (i + 1));
  }
  throw new Error(url + " failed after 3 tries");
}

// ---- sources ----
function gdelt(c) {
  const days = dayList(c.from, c.to), conflict = Object.fromEntries(days.map(d => [d, 0])), talk = Object.fromEntries(days.map(d => [d, 0])), rows = [];
  for (const line of fs.readFileSync(GDELT_FILE, "utf8").split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.area !== c.area || !c.places.test(r.place.trim())) continue;
    const d = `${r.event_day.slice(0, 4)}-${r.event_day.slice(4, 6)}-${r.event_day.slice(6, 8)}`;
    if (!(d in conflict)) continue;
    if (r.quad === "4") conflict[d]++; else talk[d]++;
    rows.push({ ...r, d });
  }
  // Most-reported stories, spread across the window: the top two in each seventh of it, one per site per day.
  const seen = new Set(), stories = [], span = days.length / 7, perBin = {};
  for (const r of rows.sort((a, b) => b.mentions - a.mentions)) {
    let host = ""; try { host = new URL(r.url).hostname.replace(/^www\./, ""); } catch { continue; }
    const slug = decodeURIComponent(r.url.split("?")[0].replace(/\/$/, "").split("/").pop() || "").replace(/\.(html?|php)$/i, "").replace(/^\d+[.-]/, "").replace(/[-_]+/g, " ").replace(/^(\d{1,4} )+/, "").trim();
    const words = slug.split(" ").filter(w => /[a-z]{3,}/i.test(w));
    const key = host + r.d, tkey = words.slice(0, 6).join(" ").toLowerCase();
    const bin = Math.floor(days.indexOf(r.d) / span);
    if (words.length < 4 || seen.has(key) || seen.has(tkey) || (perBin[bin] || 0) >= 2) continue;
    seen.add(key); seen.add(tkey); perBin[bin] = (perBin[bin] || 0) + 1;
    stories.push({ day: r.d, text: slug.charAt(0).toUpperCase() + slug.slice(1), site: host, url: r.url, kind: r.quad === "4" ? "conflict" : "statement", mentions: r.mentions });
    if (stories.length >= 14) break;
  }
  stories.sort((a, b) => a.day < b.day ? -1 : 1);
  return { conflict: days.map(d => conflict[d]), talk: days.map(d => talk[d]), stories, kept: rows.length };
}

let ofacCache = null;
async function ofacActions(since) {
  if (ofacCache) return ofacCache;
  const out = [];
  for (let page = 0; page < 40; page++) {
    const html = await get("https://ofac.treasury.gov/recent-actions?page=" + page);
    const found = [...html.matchAll(/<a href="\/recent-actions\/(\d{8})"[^>]*>([^<]+)<\/a>/g)].map(m => ({ day: `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`, title: m[2].replace(/&amp;/g, "&").trim(), url: "https://ofac.treasury.gov/recent-actions/" + m[1] }));
    if (!found.length) break;
    out.push(...found);
    if (found[found.length - 1].day < since) break;
    await sleep(1200);
  }
  return ofacCache = out;
}

async function wind(c) {
  const start = addDays(c.from, -365);
  const j = await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${c.point.lat}&longitude=${c.point.lon}&start_date=${start}&end_date=${c.to}&daily=wind_speed_10m_max&timezone=UTC`, "json");
  const by = Object.fromEntries(j.daily.time.map((t, i) => [t, j.daily.wind_speed_10m_max[i]]));
  const prior = j.daily.time.filter(t => t < c.from).map(t => by[t]).filter(v => v != null).sort((a, b) => a - b);
  const p95 = prior[Math.floor((prior.length - 1) * 0.95)];
  return { values: dayList(c.from, c.to).map(d => by[d] ?? null), p95: r2(p95), baseDays: prior.length };
}

const eiaCache = {};
async function eia(file) {
  if (eiaCache[file]) return eiaCache[file];
  const wb = XLSX.read(await get(`https://www.eia.gov/dnav/${file}`, "buffer"), { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["Data 1"], { header: 1, raw: true }).filter(r => r[0] instanceof Date && typeof r[1] === "number");
  return eiaCache[file] = Object.fromEntries(rows.map(r => [iso(r[0].getTime() + 12 * 3600000), r[1]]));
}

let monthlyCache = null;
async function monthly() {
  if (monthlyCache) return monthlyCache;
  const bls = await get("https://api.bls.gov/publicAPI/v1/timeseries/data/PCU483111483111", "json");
  const freight = {};
  for (const d of bls.Results.series[0].data) if (/^M(0[1-9]|1[0-2])$/.test(d.period)) freight[`${d.year}-${d.period.slice(1)}`] = { value: +d.value, prelim: (d.footnotes || []).some(f => f.code === "P") };
  const wb = XLSX.read(await get("https://www.newyorkfed.org/medialibrary/research/interactives/gscpi/downloads/gscpi_data.xlsx", "buffer"), { cellDates: true });
  const gscpi = {};
  for (const r of XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true })) {
    if (!r[0] || typeof r[1] !== "number") continue;
    const t = r[0] instanceof Date ? r[0] : new Date(r[0] + " UTC");
    if (!isNaN(t)) gscpi[iso(t.getTime() + 12 * 3600000).slice(0, 7)] = r[1];
  }
  return monthlyCache = { freight, gscpi };
}
const monthsIn = (a, b) => [...new Set(dayList(addDays(a, -31), b).map(d => d.slice(0, 7)))];

(async () => {
  const built = new Date().toISOString(), cases = [];
  for (const c of CASES) {
    const days = dayList(c.from, c.to), rows = [], missing = [];
    const add = async (fn, failLabel) => { try { await fn(); } catch (e) { missing.push({ label: failLabel, reason: "The source did not answer when this was built (" + String(e.message).slice(0, 120) + ")." }); } };

    let stories = [];
    await add(async () => {
      const g = gdelt(c); stories = g.stories;
      rows.push({ group: "Conflict", label: "Reported conflict events", unit: "events a day", kind: "bars", color: "conflict", values: g.conflict,
        source: "GDELT Project", source_url: "https://www.gdeltproject.org/", frequency: "daily",
        note: `News reports of attacks, strikes and other physical conflict located at ${c.where}. Counts reports, not verified events; heavier coverage raises the count.` });
      rows.push({ group: "Sanctions and politics", label: "Reported statements and diplomacy", unit: "events a day", kind: "bars", color: "talk", values: g.talk,
        source: "GDELT Project", source_url: "https://www.gdeltproject.org/", frequency: "daily",
        note: `News reports of talks, statements, threats and agreements located at ${c.where}.` });
    }, "News events (GDELT)");

    await add(async () => {
      const acts = (await ofacActions(c.from)).filter(a => a.day >= c.from && a.day <= c.to && c.sanctions.test(a.title));
      rows.push({ group: "Sanctions and politics", label: `US Treasury sanctions actions naming ${c.sanctionsLabel}`, unit: "", kind: "marks",
        marks: acts.map(a => ({ day: a.day, text: a.title, url: a.url })).sort((a, b) => a.day < b.day ? -1 : 1),
        source: "US Treasury, Office of Foreign Assets Control", source_url: "https://ofac.treasury.gov/recent-actions", frequency: "as announced",
        note: `Each mark is a dated Treasury announcement whose title names ${c.sanctionsLabel}. Titles only; it does not check which vessels or companies were listed.` });
    }, "Sanctions actions (US Treasury)");

    await add(async () => {
      const w = await wind(c);
      rows.push({ group: "Weather", label: "Strongest wind of the day", unit: "km/h", kind: "line", values: w.values, ref: w.p95, ref_label: `windier than 95% of this spot's days in the year before (${w.p95} km/h)`,
        source: "Open-Meteo", source_url: "https://open-meteo.com/", frequency: "daily",
        note: "Weather model data for one point at the chokepoint. Named storms (NOAA) are not connected yet." });
    }, "Weather (Open-Meteo)");

    await add(async () => {
      const brent = await eia("pet/hist_xls/RBRTEd.xls"), gas = await eia("ng/hist_xls/RNGWHHDd.xls");
      rows.push({ group: "Prices", label: "Brent crude oil", unit: "$ a barrel", kind: "line", values: days.map(d => brent[d] ?? null), gaps: "no price on weekends and holidays",
        source: "US Energy Information Administration", source_url: "https://www.eia.gov/dnav/pet/hist/RBRTEd.htm", frequency: "daily, trading days" });
      rows.push({ group: "Prices", label: "Henry Hub natural gas", unit: "$ per million Btu", kind: "line", values: days.map(d => gas[d] ?? null), gaps: "no price on weekends and holidays",
        source: "US Energy Information Administration", source_url: "https://www.eia.gov/dnav/ng/hist/rngwhhdD.htm", frequency: "daily, trading days",
        note: "A US gas price. It is a weak guide to gas prices in Europe or Asia." });
    }, "Oil and gas prices (EIA)");

    await add(async () => {
      const m = await monthly(), months = monthsIn(c.from, c.to);
      const pts = (obj, f) => months.filter(k => obj[k] != null).map(k => ({ month: k, value: r2(f(obj[k])), prelim: !!obj[k].prelim }));
      rows.push({ group: "Prices", label: "Deep sea freight price index (monthly)", unit: "index", kind: "monthly", points: pts(m.freight, v => v.value),
        source: "US Bureau of Labor Statistics, series PCU483111483111", source_url: "https://data.bls.gov/timeseries/PCU483111483111", frequency: "monthly",
        note: "One value a month, so it cannot show day-to-day moves. Latest months are preliminary." });
      rows.push({ group: "Prices", label: "Global Supply Chain Pressure Index (monthly)", unit: "index", kind: "monthly", points: pts(m.gscpi, v => v),
        source: "Federal Reserve Bank of New York", source_url: "https://www.newyorkfed.org/research/policy/gscpi", frequency: "monthly",
        note: "0 is the long-run average; higher means more strain. One value a month." });
    }, "Monthly freight series");

    missing.push({ label: "Maritime incident warnings", reason: "Left out. The UK Navy's UKMTO feed only returns its latest 80 incidents (from 28 September 2026), covers only the Gulf and Indian Ocean, and blocked automated requests. The US anti-shipping message server was unavailable." });
    missing.push({ label: "Physical signs (fires, radar detections with no ship signal)", reason: "Not connected to this panel yet." });
    missing.push({ label: "Daily and weekly shipping rates", reason: "No source found whose terms allow display here. Monthly series only." });

    cases.push({ id: c.id, zone: c.zone, metric: c.metric, from: c.from, to: c.to, title: c.title, summary: c.summary, rows, stories, missing });
    console.log(c.id, "rows", rows.map(r => `${r.label} [${r.kind}${r.values ? " " + r.values.filter(v => v != null).length + "/" + r.values.length : r.marks ? " " + r.marks.length : " " + r.points.length}]`).join("; "));
    console.log("  stories", stories.length, "| missing", missing.length, missing.slice(0, -3).map(m => m.label + ": " + m.reason).join(" | "));
  }
  const body = JSON.stringify({ built, cases });
  console.log("bytes", body.length);
  if (dryRun) { fs.writeFileSync(path.join(root, "evidence-preview.json"), body); return; }
  const r = await fetch(BASE + "/publish-evidence", { method: "POST", headers: { authorization: "Bearer " + SECRET, "content-type": "application/json" }, body });
  console.log("publish:", r.status, (await r.text()).slice(0, 200));
  if (!r.ok) process.exit(1);
})();
