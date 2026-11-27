// Coverage test: listen to aisstream for a set time and count what is actually seen in each zone.
// Usage: node collector/coverage-test.js [minutes]      (default 60)
// Needs AISSTREAM_API_KEY in .dev.vars at the project root.
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const root = path.join(__dirname, "..");
const minutes = Number(process.argv[2] || 60);
const vars = Object.fromEntries(
  fs.readFileSync(path.join(root, ".dev.vars"), "utf8").split(/\r?\n/)
    .filter(l => l.includes("=") && !l.trim().startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const KEY = vars.AISSTREAM_API_KEY;
if (!KEY) { console.error("AISSTREAM_API_KEY is empty in .dev.vars"); process.exit(1); }

const zones = JSON.parse(fs.readFileSync(path.join(root, "zones.json"), "utf8")).zones;
const stats = Object.fromEntries(zones.map(z => [z.id, { ships: new Map(), messages: 0, firstMsg: null, lastMsg: null }]));
const shipType = new Map();           // MMSI -> AIS ship type number, from static data messages
let total = 0, reconnects = 0, started = Date.now(), done = false;

const inBox = (z, lat, lon) => {
  const [[a, b], [c, d]] = z.box;
  return lat >= Math.min(a, c) && lat <= Math.max(a, c) && lon >= Math.min(b, d) && lon <= Math.max(b, d);
};
const typeName = t => t >= 80 && t <= 89 ? "tanker" : t >= 70 && t <= 79 ? "cargo" : t ? "other" : "unknown";

function connect(attempt = 0) {
  const ws = new WebSocket("wss://stream.aisstream.io/v0/stream", { perMessageDeflate: true });
  ws.on("open", () => ws.send(JSON.stringify({
    APIKey: KEY,
    BoundingBoxes: zones.map(z => z.box),
    FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"],
  })));
  ws.on("message", data => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.error) { console.error("stream error:", m.error); return; }
    const meta = m.MetaData; if (!meta) return;
    total++;
    const mmsi = meta.MMSI;
    if (m.MessageType === "ShipStaticData") { shipType.set(mmsi, m.Message.ShipStaticData.Type); return; }
    const body = m.Message.PositionReport || m.Message.StandardClassBPositionReport; if (!body) return;
    const lat = meta.latitude ?? meta.Latitude, lon = meta.longitude ?? meta.Longitude;
    for (const z of zones) {
      if (!inBox(z, lat, lon)) continue;
      const s = stats[z.id];
      s.messages++; s.firstMsg ??= Date.now(); s.lastMsg = Date.now();
      // stopped: under 0.5 knots, or navigation status says at anchor (1) or moored (5)
      const stopped = body.Sog < 0.5 || body.NavigationalStatus === 1 || body.NavigationalStatus === 5;
      s.ships.set(mmsi, { stopped });
    }
  });
  ws.on("close", () => {
    if (done) return;
    reconnects++;
    setTimeout(() => connect(attempt + 1), Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500);
  });
  ws.on("error", e => console.error("socket error:", e.message));
  setTimeout(() => { done = true; ws.close(); report(); }, Math.max(0, started + minutes * 60000 - Date.now()));
}

function report() {
  if (report.ran) return; report.ran = true;
  const rows = zones.map(z => {
    const s = stats[z.id], ships = [...s.ships.entries()];
    const by = { tanker: 0, cargo: 0, other: 0, unknown: 0 };
    for (const [mmsi] of ships) by[typeName(shipType.get(mmsi))]++;
    return { zone: z.id, vessels: ships.length, stopped: ships.filter(([, v]) => v.stopped).length,
             moving: ships.filter(([, v]) => !v.stopped).length, ...by, messages: s.messages };
  });
  console.log(`\nListened ${minutes} min, ${total} messages, ${reconnects} reconnects\n`);
  console.table(rows);
  const out = path.join(root, `coverage-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify({ minutes, total, reconnects, started: new Date(started).toISOString(), rows }, null, 2));
  console.log("saved", out);
  process.exit(0);
}

console.log(`Listening for ${minutes} minutes across ${zones.length} zones...`);
connect();
