// Evidence panels ("what else changed") for chosen anomalies. Written by analysis/evidence.js, read here as stored.
export async function onRequestGet({ env }) {
  const row = await env.DB.prepare("SELECT body FROM site_cache WHERE key = 'evidence'").first();
  return new Response(row ? row.body : '{"cases":[]}', { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
}
