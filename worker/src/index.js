// Chokepoint Monitor: storage and status.
// POST /ingest   the collector sends one run here (needs the ingest secret)
// GET  /status   private status page (needs the status key)
// Daily job      builds daily summaries and deletes raw records older than 90 days

const RAW_DAYS = 90;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function ingest(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!env.INGEST_SECRET || !sameText(auth, "Bearer " + env.INGEST_SECRET)) return json({ error: "not allowed" }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  if (b.source !== "aisstream" || !Array.isArray(b.zones) || !b.ts) return json({ error: "bad payload" }, 400);
  const ok = b.ok ? 1 : 0;

  const run = await env.DB.prepare(
    "INSERT INTO runs (ts, source, ok, listen_seconds, messages, reconnects, runner, note) VALUES (?,?,?,?,?,?,?,?) RETURNING id")
    .bind(b.ts, b.source, ok, b.listen_seconds ?? null, b.messages ?? null, b.reconnects ?? null, b.runner ?? null, b.note ?? null)
    .first();

  // The database does the counting, so this stays inside the free plan's small processing allowance.
  const stmts = [];
  if (Array.isArray(b.types) && b.types.length) {
    stmts.push(env.DB.prepare(
      `INSERT INTO ship_types (mmsi, type, updated)
       SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), ?1 FROM json_each(?2)
       WHERE json_extract(value,'$[1]') > 0
       ON CONFLICT(mmsi) DO UPDATE SET type = excluded.type, updated = excluded.updated`)
      .bind(b.ts, JSON.stringify(b.types)));
  }
  stmts.push(env.DB.prepare(
    `INSERT INTO measurements (run_id, ts, zone, source, ok, messages, vessels, moving, stopped, tanker, cargo, other, unknown)
     SELECT ?1, ?2, json_extract(z.value,'$.zone'), ?3, ?4, json_extract(z.value,'$.messages'),
            count(s.value),
            coalesce(sum(json_extract(s.value,'$[1]') = 0), 0),
            coalesce(sum(json_extract(s.value,'$[1]') = 1), 0),
            coalesce(sum(t.type BETWEEN 80 AND 89), 0),
            coalesce(sum(t.type BETWEEN 70 AND 79), 0),
            coalesce(sum(t.type IS NOT NULL AND t.type NOT BETWEEN 70 AND 89), 0),
            coalesce(sum(s.value IS NOT NULL AND t.type IS NULL), 0)
     FROM json_each(?5) z
     LEFT JOIN json_each(z.value, '$.ships') s
     LEFT JOIN ship_types t ON t.mmsi = json_extract(s.value,'$[0]')
     GROUP BY z.key`)
    .bind(run.id, b.ts, b.source, ok, JSON.stringify(b.zones)));
  await env.DB.batch(stmts);
  return json({ saved: true, run_id: run.id, zones: b.zones.length });
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = ts => {
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

async function status(request, env) {
  const key = new URL(request.url).searchParams.get("key") || "";
  if (!env.STATUS_KEY || !sameText(key, env.STATUS_KEY)) return new Response("Not found", { status: 404 });
  const [sources, zones, counts, days] = await env.DB.batch([
    env.DB.prepare(
      `SELECT r.source, r.ts, r.ok, r.messages, r.listen_seconds, r.reconnects, r.runner, r.note,
              (SELECT count(*) FROM runs x WHERE x.source = r.source AND x.ts > datetime('now','-1 day')) AS runs_24h,
              (SELECT count(*) FROM runs x WHERE x.source = r.source AND x.ok = 1 AND x.ts > datetime('now','-1 day')) AS ok_24h,
              (SELECT count(*) FROM runs x WHERE x.source = r.source) AS runs_all,
              (SELECT min(ts) FROM runs x WHERE x.source = r.source) AS first_ts
       FROM runs r WHERE r.id IN (SELECT max(id) FROM runs GROUP BY source)`),
    env.DB.prepare(
      `SELECT m.*,
              (SELECT count(*) FROM measurements x WHERE x.zone = m.zone AND x.source = m.source AND x.ts > datetime('now','-1 day')) AS runs_24h,
              (SELECT count(*) FROM measurements x WHERE x.zone = m.zone AND x.source = m.source AND x.ok = 1 AND x.messages > 0 AND x.ts > datetime('now','-1 day')) AS heard_24h,
              (SELECT max(ts) FROM measurements x WHERE x.zone = m.zone AND x.source = m.source AND x.ok = 1 AND x.messages > 0) AS last_heard
       FROM measurements m
       WHERE m.run_id IN (SELECT max(id) FROM runs GROUP BY source)
       ORDER BY m.source, m.vessels DESC, m.zone`),
    env.DB.prepare(
      `SELECT (SELECT count(*) FROM runs) AS runs, (SELECT count(*) FROM measurements) AS measurements,
              (SELECT count(*) FROM ship_types) AS ship_types, (SELECT count(*) FROM daily) AS daily`),
    env.DB.prepare("SELECT max(day) AS last_day FROM daily"),
  ]);
  const c = counts.results[0] || {};
  const srcRows = sources.results.map(r => `<tr>
    <td>${esc(r.source)}</td><td class="${r.ok ? "ok" : "bad"}">${r.ok ? "responded" : "did not respond properly"}</td>
    <td>${esc(r.ts)}<br><small>${ago(r.ts)}</small></td><td>${r.messages ?? ""}</td><td>${r.listen_seconds ?? ""} s</td>
    <td>${r.ok_24h} of ${r.runs_24h}</td><td>${r.runs_all}<br><small>since ${esc(r.first_ts)}</small></td>
    <td>${esc(r.runner)}</td><td>${esc(r.note)}</td></tr>`).join("");
  const zoneRows = zones.results.map(m => {
    const heard = m.ok && m.messages > 0;
    const n = v => heard ? v : "";
    return `<tr><td>${esc(m.zone)}</td><td>${esc(m.source)}</td>
    <td class="${heard ? "ok" : "bad"}">${heard ? "heard" : m.ok ? "nothing heard" : "source failed"}</td>
    <td>${n(m.vessels)}</td><td>${n(m.moving)}</td><td>${n(m.stopped)}</td><td>${n(m.tanker)}</td><td>${n(m.cargo)}</td><td>${n(m.other)}</td><td>${n(m.unknown)}</td>
    <td>${m.messages}</td><td>${m.heard_24h} of ${m.runs_24h}</td><td>${m.last_heard ? esc(m.last_heard) + "<br><small>" + ago(m.last_heard) + "</small>" : "never"}</td></tr>`;
  }).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Chokepoint Monitor: collector status</title>
<style>body{font:14px/1.45 system-ui,sans-serif;background:#0d1117;color:#d6dde6;margin:24px}h1{font-size:20px}h2{font-size:15px;margin-top:28px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #222b36;vertical-align:top}
th{color:#8b98a8;font-weight:500}small{color:#8b98a8}.ok{color:#5fd38d}.bad{color:#f0a04b}.wrap{overflow-x:auto}</style></head><body>
<h1>Chokepoint Monitor: collector status</h1>
<p><small>Page built ${new Date().toISOString()} UTC. Stored: ${c.runs} runs, ${c.measurements} zone records, ${c.ship_types} known ship types, ${c.daily} daily summaries${days.results[0]?.last_day ? " (latest day " + esc(days.results[0].last_day) + ")" : ""}.</small></p>
<h2>Last run per source</h2><div class="wrap"><table><tr><th>Source</th><th>Result</th><th>Finished (UTC)</th><th>Messages</th><th>Listened</th><th>Good runs, last 24 h</th><th>All runs</th><th>Ran on</th><th>Note</th></tr>${srcRows || '<tr><td colspan="9">No runs saved yet.</td></tr>'}</table></div>
<h2>Last run per zone</h2>
<p><small>"Nothing heard" means the live feed sent no messages from that zone. It does not mean the zone was empty. Numbers are blank in that case.</small></p>
<div class="wrap"><table><tr><th>Zone</th><th>Source</th><th>Result</th><th>Ships</th><th>Moving</th><th>Stopped</th><th>Tanker</th><th>Cargo</th><th>Other</th><th>Type not known yet</th><th>Messages</th><th>Runs heard, last 24 h</th><th>Last heard (UTC)</th></tr>${zoneRows || '<tr><td colspan="13">No zone records yet.</td></tr>'}</table></div>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function daily(env) {
  await env.DB.batch([
    // Rebuild the last three finished days, in case a late run arrived.
    env.DB.prepare(
      `INSERT OR REPLACE INTO daily (day, zone, source, runs, runs_heard, vessels_avg, vessels_min, vessels_max,
                                     moving_avg, stopped_avg, tanker_avg, cargo_avg, other_avg, unknown_avg)
       SELECT substr(ts,1,10), zone, source, count(*), sum(ok = 1 AND messages > 0),
              avg(CASE WHEN ok = 1 AND messages > 0 THEN vessels END), min(CASE WHEN ok = 1 AND messages > 0 THEN vessels END), max(CASE WHEN ok = 1 AND messages > 0 THEN vessels END),
              avg(CASE WHEN ok = 1 AND messages > 0 THEN moving END), avg(CASE WHEN ok = 1 AND messages > 0 THEN stopped END),
              avg(CASE WHEN ok = 1 AND messages > 0 THEN tanker END), avg(CASE WHEN ok = 1 AND messages > 0 THEN cargo END),
              avg(CASE WHEN ok = 1 AND messages > 0 THEN other END), avg(CASE WHEN ok = 1 AND messages > 0 THEN unknown END)
       FROM measurements
       WHERE ts >= date('now','-3 day') AND ts < date('now')
       GROUP BY substr(ts,1,10), zone, source`),
    env.DB.prepare(`DELETE FROM measurements WHERE ts < date('now','-${RAW_DAYS} day')`),
    env.DB.prepare(`DELETE FROM runs WHERE ts < date('now','-${RAW_DAYS} day')`),
  ]);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/ingest" && request.method === "POST") return await ingest(request, env);
      if (pathname === "/status" && request.method === "GET") return await status(request, env);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
    return new Response("Chokepoint Monitor collector. The public site is not built yet.", { headers: { "content-type": "text/plain" } });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(daily(env));
  },
};
