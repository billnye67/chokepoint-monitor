// Ship collector: listen to aisstream for a few minutes, count distinct ships per zone, send the run to storage.
// Usage: node collector/run.js [minutes]        (default 7)
// Reads AISSTREAM_API_KEY, INGEST_URL and INGEST_SECRET from the environment, or from .dev.vars when run locally.
// Why 7 minutes: ships at anchor only report every 3 minutes, and ship type is sent about every 6.
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const root = path.join(__dirname, "..");
const vars = {};
try {
  for (const l of fs.readFileSync(path.join(root, ".dev.vars"), "utf8").split(/\r?\n/)) {
    if (l.includes("=") && !l.trim().startsWith("#")) vars[l.slice(0, l.indexOf("=")).trim()] = l.slice(l.indexOf("=") + 1).trim();
  }
} catch {}
const env = k => process.env[k] || vars[k] || "";
const KEY = env("AISSTREAM_API_KEY"), INGEST_URL = env("INGEST_URL"), INGEST_SECRET = env("INGEST_SECRET");
const minutes = Number(process.argv[2] || env("LISTEN_MINUTES") || 7);
const dryRun = process.argv.includes("--dry-run");
if (!KEY) { console.error("AISSTREAM_API_KEY is not set"); process.exit(1); }
if (!dryRun && (!INGEST_URL || !INGEST_SECRET)) { console.error("INGEST_URL or INGEST_SECRET is not set"); process.exit(1); }

const zones = JSON.parse(fs.readFileSync(path.join(root, "zones.json"), "utf8")).zones;
const seen = Object.fromEntries(zones.map(z => [z.id, { ships: new Map(), messages: 0 }]));
const types = new Map();              // MMSI -> AIS ship type number heard in this run
let total = 0, reconnects = 0, opened = 0, lastError = "", done = false;
const started = Date.now(), deadline = started + minutes * 60000;

const inBox = (z, lat, lon) => {
  const [[a, b], [c, d]] = z.box;
  return lat >= Math.min(a, c) && lat <= Math.max(a, c) && lon >= Math.min(b, d) && lon <= Math.max(b, d);
};

function connect(attempt = 0) {
  if (done) return;
  const ws = new WebSocket("wss://stream.aisstream.io/v0/stream", { perMessageDeflate: true, handshakeTimeout: 20000 });
  ws.on("open", () => {
    opened++; attempt = 0;
    ws.send(JSON.stringify({
      APIKey: KEY,
      BoundingBoxes: zones.map(z => z.box),
      FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"],
    }));
  });
  ws.on("message", data => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.error) { lastError = String(m.error).slice(0, 200); return; }
    const meta = m.MetaData; if (!meta || !m.Message) return;
    total++;
    const mmsi = meta.MMSI;
    if (m.MessageType === "ShipStaticData") {
      const t = m.Message.ShipStaticData && m.Message.ShipStaticData.Type;
      if (Number.isInteger(t) && t > 0) types.set(mmsi, t);
      return;
    }
    const body = m.Message.PositionReport || m.Message.StandardClassBPositionReport; if (!body) return;
    const lat = meta.latitude ?? meta.Latitude, lon = meta.longitude ?? meta.Longitude;
    if (typeof lat !== "number" || typeof lon !== "number") return;
    for (const z of zones) {
      if (!inBox(z, lat, lon)) continue;
      const s = seen[z.id];
      s.messages++;
      // Stopped: under 0.5 knots, or navigation status says at anchor (1) or moored (5). The latest report wins.
      const stopped = body.Sog < 0.5 || body.NavigationalStatus === 1 || body.NavigationalStatus === 5;
      s.ships.set(mmsi, stopped ? 1 : 0);
    }
  });
  ws.on("error", e => { lastError = String(e.message).slice(0, 200); });
  ws.on("close", () => {
    if (done) return;
    reconnects++;
    const wait = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
    if (Date.now() + wait < deadline) setTimeout(() => connect(attempt + 1), wait);
  });
  setTimeout(() => { try { ws.close(); } catch {} }, Math.max(0, deadline - Date.now()));
}

async function send(payload) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + INGEST_SECRET },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      if (r.ok) { console.log("saved:", text); return true; }
      console.error(`storage answered ${r.status}: ${text.slice(0, 300)}`);
      if (r.status >= 400 && r.status < 500) return false;
    } catch (e) { console.error("storage not reachable:", e.message); }
    await new Promise(r => setTimeout(r, 5000 * (i + 1)));
  }
  return false;
}

async function finish() {
  done = true;
  const ok = opened > 0 && total > 0;
  const payload = {
    source: "aisstream",
    ts: new Date().toISOString(),
    ok,
    listen_seconds: Math.round((Date.now() - started) / 1000),
    messages: total,
    reconnects,
    runner: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
    note: ok ? (lastError ? "last error: " + lastError : "") : (opened ? "connected but no messages" : "could not connect") + (lastError ? ": " + lastError : ""),
    zones: zones.map(z => ({ zone: z.id, messages: seen[z.id].messages, ships: [...seen[z.id].ships.entries()] })),
    types: [...types.entries()],
  };
  console.log(`listened ${payload.listen_seconds}s, ${total} messages, ${reconnects} reconnects, ${types.size} ship types heard, ok=${ok}`);
  console.table(payload.zones.map(z => ({ zone: z.zone, messages: z.messages, ships: z.ships.length, stopped: z.ships.filter(s => s[1]).length })));
  if (dryRun) process.exit(0);
  const saved = await send(payload);
  process.exit(saved ? 0 : 1);
}

console.log(`Listening for ${minutes} minutes across ${zones.length} zones...`);
connect();
setTimeout(finish, minutes * 60000 + 1500);
