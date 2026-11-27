// IMF PortWatch daily chokepoint transits.
// node collector/portwatch.js history   -> writes portwatch-history.sql (all days from 2019) for wrangler d1 execute
// The daily pull runs inside the worker (worker/src/index.js); this script is only the one-off history load.
// Pulls are kept small: only our 7 chokepoints, one request per 10,000 rows, a pause between requests.
const fs = require("fs");
const BASE = "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query";
const PORTS = require("../worker/src/portwatch-ports.json");
const FIELDS = "date,portid,portname,n_total,n_tanker,n_cargo,n_container,n_dry_bulk,n_general_cargo,n_roro,capacity,capacity_tanker,capacity_cargo";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = v => v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";

async function pull(portid) {
  const rows = [];
  for (let offset = 0; ; offset += 10000) {
    const u = `${BASE}?where=${encodeURIComponent(`portid='${portid}'`)}&outFields=${FIELDS}&orderByFields=date&resultOffset=${offset}&resultRecordCount=10000&f=json`;
    const j = await (await fetch(u)).json();
    if (j.error) throw new Error(portid + ": " + JSON.stringify(j.error));
    rows.push(...j.features.map(f => f.attributes));
    if (!j.exceededTransferLimit) break;
    await sleep(1500);
  }
  return rows;
}

(async () => {
  const fetched = new Date().toISOString();
  const out = [];
  for (const p of PORTS) {
    const rows = await pull(p.portid);
    console.log(p.portid, p.name, rows.length, "days,", rows[0]?.date, "to", rows.at(-1)?.date);
    for (let i = 0; i < rows.length; i += 200) {
      out.push("INSERT OR REPLACE INTO portwatch_daily (day,portid,portname,n_total,n_tanker,n_cargo,n_container,n_dry_bulk,n_general_cargo,n_roro,capacity,capacity_tanker,capacity_cargo,fetched) VALUES\n" +
        rows.slice(i, i + 200).map(r => "(" + [r.date, r.portid, r.portname, r.n_total, r.n_tanker, r.n_cargo, r.n_container, r.n_dry_bulk, r.n_general_cargo, r.n_roro, r.capacity, r.capacity_tanker, r.capacity_cargo, fetched].map(q).join(",") + ")").join(",\n") + ";");
    }
    await sleep(1500);
  }
  fs.writeFileSync("portwatch-history.sql", out.join("\n") + "\n");
  console.log("wrote portwatch-history.sql");
})().catch(e => { console.error(e); process.exit(1); });
