// Hosting test only: can a free-plan Cloudflare Worker do the 7-minute ship listen by itself?
// Writes a "start" row, listens, then writes an "end" row. If the end row never appears, the platform cut the job off.
const BOXES = [[[1.0, 103.4], [1.5, 104.4]], [[-35.2, 17.6], [-33.6, 20.5]]];   // Singapore and the Cape
async function listen(env, seconds) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO hosting_test (id, stage, ts, seconds) VALUES (?, 'start', datetime('now'), ?)").bind(id, seconds).run();
  let messages = 0, ships = new Set(), error = "";
  await new Promise(resolve => {
    const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
    ws.addEventListener("open", () => ws.send(JSON.stringify({ APIKey: env.AISSTREAM_API_KEY, BoundingBoxes: BOXES,
      FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"] })));
    ws.addEventListener("message", async ev => {
      try {
        const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data instanceof Blob ? await ev.data.arrayBuffer() : ev.data);
        const m = JSON.parse(text); messages++; if (m.MetaData) ships.add(m.MetaData.MMSI);
      } catch (e) { error = String(e.message); }
    });
    ws.addEventListener("error", () => { error = "socket error"; });
    ws.addEventListener("close", () => resolve());
    setTimeout(() => { try { ws.close(); } catch {} resolve(); }, seconds * 1000);
  });
  await env.DB.prepare("INSERT INTO hosting_test (id, stage, ts, seconds, messages, ships, error) VALUES (?, 'end', datetime('now'), ?, ?, ?, ?)")
    .bind(id, seconds, messages, ships.size, error).run();
}
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(listen(env, 420)); },
  async fetch() { return new Response("hosting test"); },
};
