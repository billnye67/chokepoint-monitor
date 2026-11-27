// Analysis: reads stored data from the worker, works out each chokepoint's normal range from its own history,
// finds anomaly episodes and rerouting signals, and publishes the result for the public site.
// Usage: node analysis/build.js [--dry-run]
// Reads INGEST_URL and INGEST_SECRET from the environment, or from .dev.vars when run locally.
const fs = require("fs");
const path = require("path");

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
if (!BASE || !SECRET) { console.error("INGEST_URL or INGEST_SECRET is not set"); process.exit(1); }

const PORTS = require("../worker/src/portwatch-ports.json");
const ZONES = require("../zones.json");

// The rules. Every range comes from the zone's own history; these only say how that history is read.
const P = {
  avg_days: 7,          // values are 7-day averages, to smooth weekday swings
  window_days: 365,     // normal range is read from one year of the zone's own values
  lag_days: 30,         // ...ending 30 days before the day being judged
  min_days: 180,        // with fewer baseline days than this, the zone says "collecting baseline"
  band_low: 2.5,        // normal range = the middle 95% of the baseline year
  band_high: 97.5,
  open_days: 7,         // an episode opens after 7 days in a row outside the range
                        // abnormal = the gap to the range is bigger than the range's own spread (as a ratio), on at least 7 days of the episode
  close_days: 7,        // ...and closes after 7 days in a row back inside it
  new_normal_days: 365, // a level that has held for a full year becomes the new normal
  lookback_days: 800,   // how far back the baseline may reach when recent days are excluded
};
const SLUG = { chokepoint6: "hormuz", chokepoint1: "suez", chokepoint4: "bab-el-mandeb", chokepoint7: "cape", chokepoint2: "panama", chokepoint5: "malacca", chokepoint3: "bosporus" };
const METRICS = ["total", "tanker", "cargo"];
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

function pct(sorted, p) {
  const i = (sorted.length - 1) * p / 100, a = Math.floor(i), b = Math.ceil(i);
  return sorted[a] + (sorted[b] - sorted[a]) * (i - a);
}

// One series for one chokepoint. Returns the smoothed values, the normal range for every day, and the episodes.
function analyse(x) {
  const n = x.length, s = new Array(n).fill(null), lo = new Array(n).fill(null), hi = new Array(n).fill(null),
        mn = new Array(n).fill(null), mx = new Array(n).fill(null), flag = new Array(n).fill(0), excluded = new Array(n).fill(false);
  const episodes = [];
  let cur = null, pend = null;
  const open = (dir, start, d) => {
    cur = { dir, start, lastFlag: start, quiet: 0, level: 1, abnDays: 0, peak: null, peakDay: null, opp: null };
    for (let j = start; j <= d; j++) if (Math.sign(flag[j]) === dir) mark(j);
  };
  const mark = j => {
    // Once an episode is abnormal, all of its days are kept out of later baselines, so neither the crisis nor a partial
    // rebound inside it can turn into "normal". Episodes that only reach elevated stay in, so the range follows slow drift.
    cur.lastFlag = j; cur.quiet = 0;
    if (Math.abs(flag[j]) === 2) cur.abnDays++;
    if (cur.abnDays >= P.open_days && cur.level < 2) { cur.level = 2; for (let k = cur.start; k <= j; k++) excluded[k] = true; }
    if (cur.level === 2) excluded[j] = true;
    if (cur.peak == null || (cur.dir < 0 ? s[j] < cur.peak : s[j] > cur.peak)) { cur.peak = s[j]; cur.peakDay = j; }
  };
  const close = (end, note) => { episodes.push({ ...cur, end, note: note || "" }); cur = null; };

  for (let d = 0; d < n; d++) {
    if (d >= P.avg_days - 1) { let t = 0; for (let j = d - P.avg_days + 1; j <= d; j++) t += x[j]; s[d] = t / P.avg_days; }
    if (s[d] == null) continue;
    const vals = [];
    for (let j = d - P.lag_days; j >= Math.max(P.avg_days - 1, d - P.lag_days - P.lookback_days) && vals.length < P.window_days; j--) if (!excluded[j]) vals.push(s[j]);
    if (vals.length < P.min_days) continue;
    vals.sort((a, b) => a - b);
    lo[d] = pct(vals, P.band_low); hi[d] = pct(vals, P.band_high);
    // Abnormal: the gap to the range is bigger than the range itself, measured as a ratio.
    // If normal is 45 to 100, the top is 2.2 times the bottom, so abnormal starts below 45 / 2.2 or above 100 x 2.2.
    const spread = lo[d] > 0 ? hi[d] / lo[d] : null;
    mn[d] = spread ? lo[d] / spread : 0; mx[d] = spread ? hi[d] * spread : null;
    flag[d] = s[d] < lo[d] ? (s[d] < mn[d] ? -2 : -1) : s[d] > hi[d] ? (mx[d] != null && s[d] > mx[d] ? 2 : 1) : 0;
    const f = Math.sign(flag[d]);

    if (cur) {
      if (f === cur.dir) { mark(d); cur.opp = null; }
      else {
        cur.quiet++; if (cur.level === 2) excluded[d] = true;
        if (f !== 0) cur.opp = cur.opp ? { ...cur.opp, count: cur.opp.count + 1 } : { start: d, count: 1 }; else cur.opp = null;
        if (cur.opp && cur.opp.count >= P.open_days) { const o = cur.opp; close(cur.lastFlag); open(f, o.start, d); }
        else if (cur.quiet >= P.close_days) { for (let k = cur.lastFlag + 1; k <= d; k++) excluded[k] = false; close(cur.lastFlag); }
      }
      if (cur && d - cur.start >= P.new_normal_days) {
        for (let j = cur.start; j <= d; j++) excluded[j] = false;
        close(d, "Held for a full year, so this level became the new normal.");
      }
      pend = null;
    } else if (f !== 0) {
      pend = pend && pend.dir === f ? { ...pend, count: pend.count + 1 } : { dir: f, start: d, count: 1 };
      if (pend.count >= P.open_days) { open(f, pend.start, d); pend = null; }
    } else pend = null;
  }
  if (cur) episodes.push({ ...cur, end: null, note: "" });
  return { s, lo, hi, mn, mx, flag, episodes };
}

(async () => {
  const res = await fetch(BASE + "/export", { headers: { authorization: "Bearer " + SECRET } });
  if (!res.ok) { console.error("export failed", res.status, (await res.text()).slice(0, 200)); process.exit(1); }
  const data = await res.json();
  const built = new Date().toISOString();

  // Group PortWatch rows by chokepoint and check that every day is present.
  const by = {};
  for (const [day, portid, total, tanker, cargo] of data.portwatch) (by[portid] ??= []).push({ day, total, tanker, cargo });
  const firstDay = "2019-01-01";
  const zones = [], episodes = [], epByZone = {};
  let dataTo = null;
  for (const port of PORTS) {
    const rows = (by[port.portid] || []).sort((a, b) => a.day < b.day ? -1 : 1);
    if (!rows.length) continue;
    // Fill a continuous day list; a missing day stays missing (carried as the previous 7-day picture is not allowed).
    const days = [], idx = new Map(rows.map(r => [r.day, r]));
    for (let t = Date.parse(rows[0].day); t <= Date.parse(rows[rows.length - 1].day); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
    const missing = days.filter(d => !idx.has(d) || idx.get(d).total == null);
    if (missing.length) console.warn(`${port.name}: ${missing.length} missing days, first ${missing[0]}`);
    const last = days[days.length - 1];
    if (!dataTo || last < dataTo) dataTo = last;
    const id = SLUG[port.portid];
    const ourZones = ZONES.zones.filter(z => port.zones.includes(z.id));
    const lat = ourZones.reduce((t, z) => t + (z.box[0][0] + z.box[1][0]) / 2, 0) / ourZones.length;
    const lon = ourZones.reduce((t, z) => t + (z.box[0][1] + z.box[1][1]) / 2, 0) / ourZones.length;
    const zone = { id, name: port.name, portid: port.portid, lat: r1(lat), lon: r1(lon), live_zones: port.zones, start: days[0], end: last, missing_days: missing.length, status: {}, band_from: Math.max(0, days.length - 400), band: {} };
    let worst = "normal";
    for (const m of METRICS) {
      const x = days.map(d => idx.get(d)?.[m] ?? 0);
      const a = analyse(x);
      const L = days.length - 1;
      zone[m] = x;
      zone.band[m] = { lo: a.lo.slice(zone.band_from).map(r1), hi: a.hi.slice(zone.band_from).map(r1), mn: a.mn.slice(zone.band_from).map(r1), mx: a.mx.slice(zone.band_from).map(r1) };
      const openEp = a.episodes.find(e => e.end == null);
      // The state describes the latest day only. An episode can still be open while the latest days are back inside the range
      // (it closes after close_days inside); in that case the state is normal and inside_days says how far along the close is.
      const outside = openEp && Math.sign(a.flag[L]) === openEp.dir;
      const state = a.lo[L] == null ? "baseline" : outside ? (openEp.level === 2 && Math.abs(a.flag[L]) === 2 ? "abnormal" : "elevated") : "normal";
      zone.status[m] = { state, direction: openEp ? (openEp.dir < 0 ? "below" : "above") : null, since: openEp ? days[openEp.start] : null,
                         inside_days: openEp && !outside ? openEp.quiet : 0,
                         value: r1(a.s[L]), lo: r1(a.lo[L]), hi: r1(a.hi[L]), mn: r1(a.mn[L]), mx: r1(a.mx[L]), year_ago: r1(a.s[L - 365]) };
      if (state === "abnormal" || (state === "elevated" && worst !== "abnormal") || (state === "baseline" && worst === "normal" && m === "total")) worst = state;
      for (const e of a.episodes) {
        const bound = e.dir < 0 ? a.lo[e.peakDay] : a.hi[e.peakDay];
        const ep = {
          zone: id, source: "portwatch", metric: m, direction: e.dir < 0 ? "below" : "above",
          started_day: days[e.start], ended_day: e.end == null ? null : days[e.end], last_checked_day: last,
          level: e.level === 2 ? "abnormal" : "elevated",
          peak_value: r1(e.peak), peak_day: days[e.peakDay], normal_low: r1(a.lo[e.peakDay]), normal_high: r1(a.hi[e.peakDay]),
          peak_score: bound ? Math.round((e.peak - bound) / bound * 100) : null,
          latest_value: r1(a.s[e.end == null ? L : e.end]), detail: e.note,
          inside_days: e.end == null ? e.quiet : 0,
        };
        episodes.push(ep); (epByZone[id + "|" + m] ??= []).push(ep);
      }
    }
    zone.state = worst;
    zones.push(zone);
  }

  // Rerouting: the "falls" chokepoint is in a below-range episode at the same time as the "rises" one is in an above-range episode.
  const toCp = zid => { const p = PORTS.find(p => p.zones.includes(zid)); return p ? SLUG[p.portid] : null; };
  const nameOf = id => zones.find(z => z.id === id)?.name || ZONES.zones.find(z => z.id === id)?.name || id;
  const pairs = [];
  for (const pair of ZONES.rerouting_pairs) {
    const falls = [...new Set(pair.falls.map(toCp))], rises = [...new Set(pair.rises.map(z => toCp(z) || z))];
    const haveData = rises.filter(r => zones.some(z => z.id === r));
    const pid = falls.join("+") + ">" + rises.join("+");
    const p = { id: pid, falls, rises, falls_names: falls.map(nameOf), rises_names: rises.map(nameOf), state: "normal", since: null, episodes: 0 };
    if (!haveData.length) { p.state = "no-data"; pairs.push(p); continue; }
    for (const f of falls) for (const r of haveData) {
      for (const a of (epByZone[f + "|total"] || []).filter(e => e.direction === "below")) {
        for (const b of (epByZone[r + "|total"] || []).filter(e => e.direction === "above")) {
          const start = a.started_day > b.started_day ? a.started_day : b.started_day;
          const endA = a.ended_day || "9999", endB = b.ended_day || "9999", end = endA < endB ? endA : endB;
          if (start > end) continue;
          const lastDay = end === "9999" ? dataTo : end;
          const len = (Date.parse(lastDay) - Date.parse(start)) / 86400000 + 1;
          if (len < P.open_days) continue;
          const ep = {
            zone: pid, source: "portwatch", metric: "rerouting", direction: "shift",
            started_day: start, ended_day: end === "9999" ? null : end, last_checked_day: dataTo,
            level: a.level === "abnormal" && b.level === "abnormal" ? "abnormal" : "elevated",
            peak_value: null, peak_day: null, normal_low: null, normal_high: null, peak_score: null, latest_value: null,
            detail: `${nameOf(f)} below its normal range while ${nameOf(r)} was above its normal range, for ${len} days.`,
          };
          episodes.push(ep); p.episodes++;
          if (!ep.ended_day) { p.state = ep.level; p.since = start; }
        }
      }
    }
    pairs.push(p);
  }

  // Match against the stored log so each episode keeps the date and time it was first raised.
  const firstBuild = data.anomalies.length === 0;
  const send = [];
  for (const ep of episodes) {
    const old = data.anomalies.find(o => o.zone === ep.zone && o.source === ep.source && o.metric === ep.metric && o.direction === ep.direction &&
      o.started_day <= (ep.ended_day || "9999") && ep.started_day <= (o.ended_day || "9999"));
    if (old) {
      ep.id = old.id; ep.flagged_at = old.flagged_at; ep.found_by = old.found_by;
      const changed = ["started_day", "ended_day", "level", "peak_value", "peak_day", "latest_value", "last_checked_day", "detail"].some(k => (old[k] ?? null) !== (ep[k] ?? null));
      if (changed) send.push(ep);
    } else {
      ep.id = null; ep.flagged_at = built; ep.found_by = firstBuild ? "history backfill" : "daily check";
      send.push(ep);
    }
  }
  episodes.sort((a, b) => a.started_day < b.started_day ? 1 : -1);

  // Status line, in plain words.
  const fmt = d => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const abn = zones.filter(z => z.state === "abnormal"), elev = zones.filter(z => z.state === "elevated");
  const describe = z => {
    const m = METRICS.find(m => z.status[m].state === z.state) || "total", st = z.status[m];
    const what = m === "total" ? "ships" : m === "tanker" ? "tankers" : "cargo ships";
    return `${z.name} is averaging ${st.value} ${what} a day, ${st.direction} its normal range of ${st.lo} to ${st.hi}, since ${fmt(st.since)}.`;
  };
  let line = abn.length + elev.length === 0
    ? `All ${zones.length} chokepoints inside normal range`
    : `${abn.length + elev.length} of ${zones.length} chokepoints outside normal range`;
  const details = [...abn, ...elev].map(describe);
  const rer = pairs.filter(p => p.state === "elevated" || p.state === "abnormal");
  for (const p of rer) details.push(`Rerouting signal: ${p.falls_names.join(" and ")} down while ${p.rises_names.join(" and ")} up, since ${fmt(p.since)}.`);

  const site = {
    built, data_from: firstDay, data_to: dataTo, first_build: firstBuild,
    status_line: line, status_details: details,
    counts: { abnormal: abn.length, elevated: elev.length, normal: zones.filter(z => z.state === "normal").length, baseline: zones.filter(z => z.state === "baseline").length },
    params: P, zones, pairs,
    bypass: ZONES.zones.filter(z => z.kind === "bypass" && !toCp(z.id)).map(z => ({ id: z.id, name: z.name, lat: r1((z.box[0][0] + z.box[1][0]) / 2), lon: r1((z.box[0][1] + z.box[1][1]) / 2) })),
    live_zones: ZONES.zones.map(z => ({ id: z.id, name: z.name })),
    episodes,
  };

  const open = episodes.filter(e => !e.ended_day);
  console.log("abnormal episodes:", episodes.filter(e => e.level === "abnormal").length, "open:", open.map(e => `${e.zone}/${e.metric}/${e.direction}/${e.level}/${e.started_day}`).join("  "));
  for (const e of episodes.filter(e => e.level === "abnormal" && e.metric === "total")) console.log("  ABN", e.zone, e.direction, e.started_day, "to", e.ended_day, "peak", e.peak_value, "range", e.normal_low, e.normal_high, e.detail.slice(0, 20));
  for (const e of episodes.filter(e => e.metric === "rerouting")) console.log("  REROUTE", e.zone, e.started_day, e.ended_day, e.level);
  console.log(`data to ${dataTo}; ${episodes.length} episodes (${open.length} open); ${send.length} to save; first build: ${firstBuild}`);
  console.log(line); for (const d of details) console.log(" -", d);
  const tally = {}; for (const e of episodes) { const k = `${e.zone} ${e.metric}`; tally[k] = (tally[k] || 0) + 1; }
  console.log(JSON.stringify(tally));
  for (const z of zones) console.log(z.id.padEnd(14), z.state.padEnd(9), METRICS.map(m => `${m} ${z.status[m].value} [${z.status[m].lo}, ${z.status[m].hi}] ${z.status[m].state}`).join(" | "));
  const body = JSON.stringify({ built, site, episodes: send, runner: process.env.GITHUB_ACTIONS ? "github-actions" : "local", note: `data to ${dataTo}, ${episodes.length} episodes, ${open.length} open` });
  console.log("payload bytes", body.length);
  if (dryRun) { fs.writeFileSync(path.join(root, "site-preview.json"), JSON.stringify(site)); return; }
  const pub = await fetch(BASE + "/publish", { method: "POST", headers: { authorization: "Bearer " + SECRET, "content-type": "application/json" }, body });
  console.log("publish:", pub.status, (await pub.text()).slice(0, 300));
  if (!pub.ok) process.exit(1);
})();
