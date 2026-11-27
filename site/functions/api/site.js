// The built analysis (chokepoints, normal ranges, episodes). Written by analysis/build.js, read here as stored.
export async function onRequestGet({ env }) {
  const row = await env.DB.prepare("SELECT body FROM site_cache WHERE key = 'site'").first();
  if (!row) return new Response('{"error":"not built yet"}', { status: 503, headers: { "content-type": "application/json" } });
  return new Response(row.body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
}
