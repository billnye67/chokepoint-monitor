// Latest live ship counts per zone from the aisstream collector. The database builds the JSON.
// A zone only appears if the feed actually sent messages from it; each entry carries the time it was heard.
export async function onRequestGet({ env }) {
  const row = await env.DB.prepare(
    `SELECT json_object(
       'first_run', (SELECT min(ts) FROM runs WHERE source = 'aisstream'),
       'last_run', (SELECT max(ts) FROM runs WHERE source = 'aisstream'),
       'last_ok_run', (SELECT max(ts) FROM runs WHERE source = 'aisstream' AND ok = 1),
       'runs_24h', (SELECT count(*) FROM runs WHERE source = 'aisstream' AND ts > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')),
       'ok_24h', (SELECT count(*) FROM runs WHERE source = 'aisstream' AND ok = 1 AND ts > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')),
       'days', (SELECT count(DISTINCT substr(ts,1,10)) FROM runs WHERE source = 'aisstream' AND ok = 1),
       'zones', json((SELECT json_group_array(json_object('zone', zone, 'ts', ts, 'vessels', vessels, 'moving', moving, 'stopped', stopped,
                        'tanker', tanker, 'cargo', cargo, 'other', other, 'unknown', unknown,
                        'heard_24h', (SELECT count(*) FROM measurements x WHERE x.zone = m.zone AND x.source = 'aisstream' AND x.ok = 1 AND x.messages > 0 AND x.ts > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'))))
                      FROM measurements m
                      WHERE m.source = 'aisstream' AND m.ok = 1 AND m.messages > 0
                        AND m.ts = (SELECT max(ts) FROM measurements x WHERE x.zone = m.zone AND x.source = 'aisstream' AND x.ok = 1 AND x.messages > 0)))
     ) AS j`).first();
  return new Response(row.j, { headers: { "content-type": "application/json", "cache-control": "public, max-age=120" } });
}
