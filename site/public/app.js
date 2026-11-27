// Chokepoint Monitor front end. Plain JavaScript, no framework.
// Everything shown comes from /api/site (analysis of IMF PortWatch data) and /api/live (aisstream collector).
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDay = d => { if (!d) return ""; const [y, m, dd] = d.split("-"); return `${+dd} ${MONTHS[m - 1]} ${y}`; };
  const fmtShort = d => { const [, m, dd] = d.split("-"); return `${+dd} ${MONTHS[m - 1]}`; };
  const fmtTime = ts => { const d = new Date(ts); return `${fmtDay(ts.slice(0, 10))}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`; };
  const dayAt = (start, i) => new Date(Date.parse(start + "T00:00:00Z") + i * 86400000).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const num = v => v == null ? "" : (Math.round(v * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
  const STATE = { normal: "Normal", elevated: "Elevated", abnormal: "Abnormal", baseline: "Collecting baseline", "no-data": "No data yet" };
  const METRIC = { total: "All ships", tanker: "Tankers", cargo: "Cargo ships", rerouting: "Rerouting" };
  const UNIT = { total: "ships", tanker: "tankers", cargo: "cargo ships" };
  const badge = state => `<span class="badge"><i class="mark ${state}"></i>${STATE[state] || state}</span>`;
  const LABEL_AT = { hormuz: [16, -6, "start"], suez: [-16, 7, "end"], "bab-el-mandeb": [-16, 16, "end"], cape: [16, 7, "start"], panama: [16, 7, "start"], malacca: [-16, 7, "end"], bosporus: [-14, -10, "end"] };
  const LIVE_NOTE = { "panama-atlantic": "partial coverage", "panama-pacific": "partial coverage" };

  let site = null, live = null, sel = { zone: null, metric: "total", range: "30" };

  Promise.all([
    fetch("/api/site").then(r => { if (!r.ok) throw new Error("site data " + r.status); return r.json(); }),
    fetch("/api/live").then(r => r.ok ? r.json() : null).catch(() => null),
  ]).then(([s, l]) => { site = s; live = l; start(); })
    .catch(e => { $("dataline").innerHTML = `<span class="warn">The data could not be loaded (${esc(e.message)}). Nothing is shown rather than showing old numbers.</span>`; });

  function start() {
    sel.zone = (site.zones.find(z => z.state === "abnormal") || site.zones.find(z => z.state === "elevated") || site.zones[0]).id;
    renderStatus(); renderOpen(); renderLog(); renderPairs(); renderMap(); renderZones(); renderChart();
    for (const id of ["f-level", "f-zone", "f-metric"]) $(id).addEventListener("change", renderLog);
    seg("seg-metric", v => { sel.metric = v; renderChart(); });
    seg("seg-range", v => { sel.range = v; renderChart(); });
    $("tablewrap").addEventListener("toggle", renderTable);
    window.addEventListener("resize", () => { clearTimeout(start.t); start.t = setTimeout(renderChart, 150); });
  }
  function seg(id, fn) {
    $(id).addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      for (const x of $(id).children) x.classList.toggle("on", x === b);
      fn(b.dataset.v);
    });
  }
  function setSeg(id, v) { for (const x of $(id).children) x.classList.toggle("on", x.dataset.v === v); }
  function pick(zone, metric) {
    sel.zone = zone; if (metric && METRIC[metric] && metric !== "rerouting") { sel.metric = metric; setSeg("seg-metric", metric); }
    renderMap(); renderZones(); renderChart();
    $("chartcard").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const zoneName = id => (site.zones.find(z => z.id === id) || {}).name || id;
  const pairName = id => { const p = site.pairs.find(p => p.id === id); return p ? `${p.falls_names.join(" and ")} to ${p.rises_names.join(" and ")}` : id; };

  function renderStatus() {
    const age = daysBetween(site.data_to, new Date().toISOString().slice(0, 10));
    let line = `Daily transit data runs to <strong>${fmtDay(site.data_to)}</strong> (IMF PortWatch publishes a few days behind). Status below is as of that date.`;
    if (age > 12) line += ` <span class="warn">No new PortWatch data since ${fmtDay(site.data_to)}, ${age} days ago.</span>`;
    $("dataline").innerHTML = line;
    $("headline").textContent = site.status_line;
    $("details").innerHTML = site.status_details.map(d => `<li>${esc(d)}</li>`).join("");
    const c = site.counts;
    $("tiles").innerHTML = ["abnormal", "elevated", "normal"].concat(c.baseline ? ["baseline"] : [])
      .map(k => `<div class="tile"><b>${c[k]}</b><span><i class="mark ${k}"></i>${STATE[k]}</span></div>`).join("");
    $("built").textContent = `Analysis last run ${fmtTime(site.built)}.`;
  }

  function epText(e) {
    if (e.metric === "rerouting") return { what: `Rerouting: ${pairName(e.zone)}`, more: e.detail };
    const z = site.zones.find(z => z.id === e.zone), st = z && z.status[e.metric];
    const days = daysBetween(e.started_day, e.ended_day || site.data_to) + 1;
    const what = `${zoneName(e.zone)}: ${METRIC[e.metric].toLowerCase()} ${e.direction} normal`;
    let more = `Since ${fmtDay(e.started_day)} (${days} days).`;
    if (!e.ended_day && st) more += ` Now averaging ${num(st.value)} ${UNIT[e.metric]} a day against a normal range of ${num(st.lo)} to ${num(st.hi)}.`;
    more += ` Furthest point: ${num(e.peak_value)} on ${fmtDay(e.peak_day)}, when normal was ${num(e.normal_low)} to ${num(e.normal_high)}.`;
    return { what, more };
  }
  function renderOpen() {
    const rank = { abnormal: 0, elevated: 1 };
    const open = site.episodes.filter(e => !e.ended_day).sort((a, b) => rank[a.level] - rank[b.level] || (a.started_day < b.started_day ? -1 : 1));
    $("open").innerHTML = open.length ? open.map((e, i) => {
      const t = epText(e);
      return `<div class="ep" data-i="${i}">${badge(e.level)}<div class="what">${esc(t.what)}</div>
        <div class="more">${esc(t.more)}</div>
        <div class="logged">First logged by this system ${fmtTime(e.flagged_at)} (${esc(e.found_by)}).</div></div>`;
    }).join("") : `<p class="none">No open anomalies. Every chokepoint is inside its normal range as of ${fmtDay(site.data_to)}.</p>`;
    $("open").onclick = ev => { const el = ev.target.closest(".ep"); if (!el) return; const e = open[+el.dataset.i]; if (e.metric === "rerouting") { const p = site.pairs.find(p => p.id === e.zone); pick(p.falls[0], "total"); } else pick(e.zone, e.metric); };
  }

  function renderLog() {
    const fz = $("f-zone");
    if (fz.options.length === 1) {
      for (const z of site.zones) fz.add(new Option(z.name, z.id));
      for (const p of site.pairs) if (p.state !== "no-data") fz.add(new Option("Pair: " + pairName(p.id), p.id));
    }
    const L = $("f-level").value, Z = fz.value, M = $("f-metric").value;
    const rows = site.episodes.filter(e => (!L || e.level === L) && (!Z || e.zone === Z) && (!M || e.metric === M));
    $("logcount").textContent = site.episodes.length;
    $("log").innerHTML = `<tr><th>Started</th><th>Ended</th><th>Chokepoint</th><th>Measure</th><th>Direction</th><th>Level</th><th class="num">Furthest value</th><th class="num">Normal range then</th><th>First logged (UTC)</th></tr>` +
      (rows.map(e => `<tr><td>${fmtDay(e.started_day)}</td><td>${e.ended_day ? fmtDay(e.ended_day) : "Still open"}${e.detail && e.metric !== "rerouting" ? `<small>${esc(e.detail)}</small>` : ""}</td>
        <td>${esc(e.metric === "rerouting" ? pairName(e.zone) : zoneName(e.zone))}</td><td>${METRIC[e.metric]}</td><td>${esc(e.direction)}</td><td>${badge(e.level)}</td>
        <td class="num">${num(e.peak_value)}</td><td class="num">${e.normal_low == null ? "" : num(e.normal_low) + " to " + num(e.normal_high)}</td>
        <td>${fmtTime(e.flagged_at)}<small>${esc(e.found_by)}</small></td></tr>`).join("") || `<tr><td colspan="9">No episodes match.</td></tr>`);
  }

  function renderPairs() {
    $("pairs").innerHTML = site.pairs.map(p => {
      let body;
      if (p.state === "no-data") body = `<p>${badge("no-data")}</p><p>PortWatch has no daily series for ${esc(p.rises_names.join(" or "))}, so this pair cannot be checked yet.</p>`;
      else if (p.state === "normal") body = `<p>${badge("normal")}</p><p>No rerouting signal as of ${fmtDay(site.data_to)}. ${p.episodes} past ${p.episodes === 1 ? "episode" : "episodes"} in the log.</p>`;
      else body = `<p>${badge(p.state)}</p><p>${esc(p.falls_names.join(" and "))} below normal while ${esc(p.rises_names.join(" and "))} above normal, since ${fmtDay(p.since)}.</p>`;
      return `<div class="pair"><h3>${esc(p.falls_names.join(" and "))} &rarr; ${esc(p.rises_names.join(" and "))}</h3>${body}</div>`;
    }).join("");
  }

  function renderMap() {
    const M = window.MAP, xy = (lat, lon) => [(lon + 180) * M.k, (M.top - lat) * M.k];
    const col = { normal: "var(--good)", elevated: "var(--warning)", abnormal: "var(--critical)", baseline: "var(--idle)" };
    let h = `<path d="${window.LAND_PATH}" fill="var(--land)"/>`;
    for (const b of site.bypass) { const [x, y] = xy(b.lat, b.lon); h += `<circle cx="${x}" cy="${y}" r="4.5" fill="none" stroke="var(--idle)" stroke-width="1.6"><title>${esc(b.name)}: bypass port, no daily transit data in this version</title></circle>`; }
    for (const z of site.zones) {
      const [x, y] = xy(z.lat, z.lon), on = z.id === sel.zone, [dx, dy, anchor] = LABEL_AT[z.id] || [10, 4, "start"];
      h += `<g class="mk" data-z="${z.id}" style="cursor:pointer" tabindex="0" role="button" aria-label="${esc(z.name)}: ${STATE[z.state]}">
        ${on ? `<circle cx="${x}" cy="${y}" r="17" fill="none" stroke="var(--text)" stroke-width="1.6"/>` : ""}
        ${z.state === "abnormal" ? `<rect x="${x - 8}" y="${y - 8}" width="16" height="16" transform="rotate(45 ${x} ${y})" fill="${col[z.state]}" stroke="var(--bg)" stroke-width="2"/>`
        : z.state === "elevated" ? `<path d="M${x} ${y - 11}L${x + 10} ${y + 7}L${x - 10} ${y + 7}Z" fill="${col[z.state]}" stroke="var(--bg)" stroke-width="2"/>`
        : `<circle cx="${x}" cy="${y}" r="8" fill="${col[z.state]}" stroke="var(--bg)" stroke-width="2.5"/>`}
        <text x="${x + dx}" y="${y + dy}" text-anchor="${anchor}" font-size="19" fill="var(--text)" paint-order="stroke" stroke="var(--bg)" stroke-width="5">${esc(z.name.replace(" Strait", "").replace("Strait of ", ""))}</text>
        <circle cx="${x}" cy="${y}" r="22" fill="transparent"><title>${esc(z.name)}: ${STATE[z.state]}</title></circle></g>`;
    }
    const svg = $("map"); svg.setAttribute("viewBox", "150 50 770 300"); svg.innerHTML = h;
    svg.onclick = e => { const g = e.target.closest(".mk"); if (g) pick(g.dataset.z); };
    svg.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { const g = e.target.closest(".mk"); if (g) { e.preventDefault(); pick(g.dataset.z); } } };
    $("maplegend").innerHTML = ["normal", "elevated", "abnormal"].map(s => `<span>${badge(s)}</span>`).join("") + `<span><i class="mark baseline"></i> Bypass port, no transit data yet</span>`;
  }

  function liveFor(z) { return live && live.zones ? live.zones.filter(l => z.live_zones.includes(l.zone)) : []; }
  function renderZones() {
    $("zones").innerHTML = `<tr><th>Chokepoint</th><th>State</th><th class="num">Ships a day<small>7-day average</small></th><th class="num">Normal range</th><th class="num">A year ago</th></tr>` +
      site.zones.map(z => { const st = z.status.total; return `<tr class="row${z.id === sel.zone ? " sel" : ""}" data-z="${z.id}" tabindex="0">
        <td>${esc(z.name)}</td><td>${badge(z.state)}${z.state !== st.state ? `<small>from ${Object.keys(z.status).filter(m => z.status[m].state === z.state).map(m => METRIC[m].toLowerCase()).join(", ")}</small>` : ""}</td><td class="num">${num(st.value)}</td>
        <td class="num">${st.lo == null ? "" : num(st.lo) + " to " + num(st.hi)}</td><td class="num">${num(st.year_ago)}</td></tr>`; }).join("");
    $("zones").onclick = e => { const r = e.target.closest("tr.row"); if (r) pick(r.dataset.z); };
    $("zones").onkeydown = e => { if (e.key === "Enter") { const r = e.target.closest("tr.row"); if (r) pick(r.dataset.z); } };
  }

  // ---- chart ----
  function series() {
    const z = site.zones.find(z => z.id === sel.zone), x = z[sel.metric], n = x.length;
    const avg = x.map((_, i) => { if (i < 6) return null; let t = 0; for (let j = i - 6; j <= i; j++) t += x[j]; return t / 7; });
    const count = sel.range === "all" ? n : Math.min(n, +sel.range), from = n - count;
    const band = z.band[sel.metric], hasBand = sel.range !== "all" && from >= z.band_from;
    const lo = i => hasBand ? band.lo[i - z.band_from] : null, hi = i => hasBand ? band.hi[i - z.band_from] : null;
    return { z, x, avg, n, from, count, lo, hi, hasBand };
  }
  function renderChart() {
    const S = series(), { z, x, avg, n, from, count } = S, all = sel.range === "all";
    const st = z.status[sel.metric];
    $("charttitle").textContent = `${z.name}: ${METRIC[sel.metric].toLowerCase()} passing per day`;
    $("chartnote").innerHTML = `${badge(st.state)} &nbsp; Latest 7-day average ${num(st.value)} ${UNIT[sel.metric]} a day` +
      (st.lo == null ? "." : `, normal range ${num(st.lo)} to ${num(st.hi)}.`) + ` Data to ${fmtDay(z.end)}. Source: IMF PortWatch.` +
      (z.id === "malacca" ? " PortWatch counts the Malacca Strait as a whole." : "");
    const svg = $("chart"), W = Math.max(320, svg.parentNode.clientWidth), H = W < 560 ? 260 : 340, m = { l: 44, r: 14, t: 14, b: 28 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    let ymax = 0;
    for (let i = from; i < n; i++) ymax = Math.max(ymax, all ? (avg[i] || 0) : x[i], avg[i] || 0, S.hi(i) || 0);
    const step = niceStep(ymax / 4); ymax = Math.max(step, Math.ceil(ymax * 1.04 / step) * step);
    const X = i => m.l + (count === 1 ? 0 : (i - from) / (count - 1) * pw), Y = v => m.t + ph - v / ymax * ph;
    let h = "";
    for (let v = 0; v <= ymax + 1e-9; v += step) h += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="12" fill="var(--muted)">${v.toLocaleString("en-US")}</text>`;
    // x ticks
    const ticks = [];
    for (let i = from; i < n; i++) {
      const d = dayAt(z.start, i), [yy, mm, dd] = d.split("-");
      if (all ? (mm === "01" && dd === "01") : sel.range === "365" ? (dd === "01" && (+mm % 2 === 1)) : sel.range === "90" ? (dd === "01" || dd === "15") : ((n - 1 - i) % 7 === 0)) ticks.push([i, all ? yy : sel.range === "365" ? `${MONTHS[mm - 1]} ${yy.slice(2)}` : fmtShort(d)]);
    }
    for (const [i, label] of ticks) h += `<text x="${X(i)}" y="${H - 8}" text-anchor="${i === n - 1 ? "end" : "middle"}" font-size="12" fill="var(--muted)">${label}</text>`;
    // normal range band
    if (S.hasBand) {
      let up = "", down = "";
      for (let i = from; i < n; i++) { if (S.lo(i) == null) continue; up += `${up ? "L" : "M"}${X(i).toFixed(1)} ${Y(S.hi(i)).toFixed(1)}`; down = `L${X(i).toFixed(1)} ${Y(S.lo(i)).toFixed(1)}` + down; }
      if (up) h += `<path d="${up}${down}Z" fill="var(--band)"/>`;
    }
    // episodes of this zone and measure, as a strip along the top
    const eps = site.episodes.filter(e => e.zone === z.id && e.metric === sel.metric);
    for (const e of eps) {
      const a = Math.max(from, daysBetween(z.start, e.started_day)), b = Math.min(n - 1, daysBetween(z.start, e.ended_day || z.end));
      if (b < from || a > n - 1) continue;
      h += `<rect x="${X(a)}" y="${m.t - 8}" width="${Math.max(2, X(b) - X(a))}" height="4" rx="2" fill="${e.level === "abnormal" ? "var(--critical)" : "var(--warning)"}"><title>${STATE[e.level]}: ${e.direction} normal, ${fmtDay(e.started_day)} to ${e.ended_day ? fmtDay(e.ended_day) : "now"}</title></rect>`;
    }
    if (!all) for (let i = from; i < n; i++) h += `<circle cx="${X(i).toFixed(1)}" cy="${Y(x[i]).toFixed(1)}" r="${count > 120 ? 1.3 : 2.2}" fill="var(--daily)"/>`;
    let line = "";
    for (let i = from; i < n; i++) if (avg[i] != null) line += `${line ? "L" : "M"}${X(i).toFixed(1)} ${Y(avg[i]).toFixed(1)}`;
    h += `<path d="${line}" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round"/>`;
    h += `<line id="cross" y1="${m.t}" y2="${m.t + ph}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/><circle id="crossdot" r="4.5" fill="var(--series)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`;
    h += `<rect id="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent"/>`;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("aria-label", $("charttitle").textContent); svg.innerHTML = h;

    const tip = $("tip"), cross = svg.querySelector("#cross"), dot = svg.querySelector("#crossdot");
    const move = ev => {
      const r = svg.getBoundingClientRect(), px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) * (W / r.width);
      const i = Math.max(from, Math.min(n - 1, Math.round(from + (px - m.l) / pw * (count - 1))));
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
      if (avg[i] != null) { dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Y(avg[i])); dot.setAttribute("visibility", "visible"); }
      tip.innerHTML = `<b>${fmtDay(dayAt(z.start, i))}</b><div><span>That day</span><span>${num(x[i])}</span></div><div><span>7-day average</span><span>${num(avg[i])}</span></div>` +
        (S.lo(i) != null ? `<div><span>Normal range</span><span>${num(S.lo(i))} to ${num(S.hi(i))}</span></div>` : "");
      tip.hidden = false;
      const left = X(i) * (r.width / W);
      tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, left + (left > r.width * 0.6 ? -tip.offsetWidth - 12 : 12))) + "px"; tip.style.top = "18px";
    };
    const out = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
    svg.onmousemove = move; svg.ontouchstart = move; svg.ontouchmove = move; svg.onmouseleave = out; svg.ontouchend = out;

    $("chartlegend").innerHTML = `<span><i class="lg-line"></i>7-day average</span>` + (all ? "" : `<span><i class="lg-dot"></i>Each day's count</span>`) +
      (S.hasBand ? `<span><i class="lg-band"></i>Normal range (middle 95% of the zone's own past year)</span>` : "") +
      (eps.length ? `<span><i class="lg-ep" style="background:var(--warning)"></i>Elevated episode</span><span><i class="lg-ep" style="background:var(--critical)"></i>Abnormal episode</span>` : "") +
      (all ? `<span>Pick 1 year or less to see the normal range.</span>` : "");
    renderTable(); renderLive();
  }
  function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))), f = (raw || 1) / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }

  function renderTable() {
    if (!$("tablewrap").open) return;
    const S = series(), rows = [];
    for (let i = S.n - 1; i >= S.from; i--) rows.push(`<tr><td>${fmtDay(dayAt(S.z.start, i))}</td><td class="num">${num(S.x[i])}</td><td class="num">${num(S.avg[i])}</td><td class="num">${S.lo(i) == null ? "" : num(S.lo(i)) + " to " + num(S.hi(i))}</td></tr>`);
    $("datatable").innerHTML = `<tr><th>Day</th><th class="num">That day</th><th class="num">7-day average</th><th class="num">Normal range</th></tr>` + rows.join("");
  }

  function renderLive() {
    const z = site.zones.find(z => z.id === sel.zone), box = $("live"), names = Object.fromEntries(site.live_zones.map(l => [l.id, l.name]));
    const mine = liveFor(z);
    let h = `<h3>Live feed (aisstream.io)</h3>`;
    if (!live) h += `<p>The live feed status could not be loaded.</p>`;
    else if (!mine.length) h += `<p>No live coverage here. The free live feed has not sent any ship messages from this area, so this site shows no live count for it.</p>`;
    else {
      for (const l of mine) {
        const mins = Math.round((Date.now() - Date.parse(l.ts)) / 60000), stale = mins > 180;
        h += stale ? `<p><strong>${esc(names[l.zone] || l.zone)}:</strong> no live data since ${fmtTime(l.ts)}.</p>`
          : `<p><strong>${esc(names[l.zone] || l.zone)}${LIVE_NOTE[l.zone] ? " (" + LIVE_NOTE[l.zone] + ")" : ""}:</strong> ${l.vessels} ships heard in the zone during a 7-minute listen ending ${fmtTime(l.ts)}. ${l.moving} moving, ${l.stopped} stopped or at anchor. By type: ${l.tanker} tankers, ${l.cargo} cargo, ${l.other} other, ${l.unknown} not known yet.</p>`;
      }
      h += `<p>This counts ships present in a box right now. It is a different measure from the daily transits charted above, and the two should not be compared. Normal range for the live feed: collecting baseline since ${fmtDay(live.first_run.slice(0, 10))} (${live.days} ${live.days === 1 ? "day" : "days"} so far).</p>`;
    }
    box.innerHTML = h;
  }
})();
