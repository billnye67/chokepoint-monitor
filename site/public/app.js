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
  const COLOR = { normal: "var(--good)", elevated: "var(--warning)", abnormal: "var(--critical)", baseline: "var(--idle)", "no-data": "var(--idle)" };
  const METRIC = { total: "All ships", tanker: "Tankers", cargo: "Cargo ships", rerouting: "Rerouting" };
  const UNIT = { total: "ships", tanker: "tankers", cargo: "cargo ships" };
  const badge = state => `<span class="badge"><i class="mark ${state}"></i>${STATE[state] || state}</span>`;
  const SHORT = n => n.replace(" Strait", "").replace("Strait of ", "");
  // Label position per marker: [dx, dy, anchor] in map units, chosen so the crowded Middle East labels do not overlap.
  const LABEL_AT = { hormuz: [1, -1, "start"], suez: [-1, 0, "end"], "bab-el-mandeb": [-1, 1, "end"], cape: [1, 0, "start"], panama: [1, 0, "start"], malacca: [-1, 0, "end"], bosporus: [-1, -1, "end"] };
  const LIVE_NOTE = { "panama-atlantic": "partial coverage", "panama-pacific": "partial coverage" };

  let site = null, live = null, sel = { zone: null, metric: "total", range: "90" };

  Promise.all([
    fetch("/api/site").then(r => { if (!r.ok) throw new Error("site data " + r.status); return r.json(); }),
    fetch("/api/live").then(r => r.ok ? r.json() : null).catch(() => null),
  ]).then(([s, l]) => { site = s; live = l; start(); })
    .catch(e => { $("headline").textContent = "Data could not be loaded"; $("dataline").innerHTML = `<span class="warn">${esc(e.message)}. Nothing is shown rather than showing old numbers.</span>`; });

  function start() {
    sel.zone = (site.zones.find(z => z.state === "abnormal") || site.zones.find(z => z.state === "elevated") || site.zones[0]).id;
    renderStatus(); renderMap(); renderCards(); renderChart(); renderOpen(); renderPairs(); renderLog();
    for (const id of ["f-level", "f-zone", "f-metric"]) $(id).addEventListener("change", renderLog);
    seg("seg-metric", v => { sel.metric = v; renderChart(); });
    seg("seg-range", v => { sel.range = v; renderChart(); });
    $("tablewrap").addEventListener("toggle", renderTable);
    let lastW = window.innerWidth;
    window.addEventListener("resize", () => { clearTimeout(start.t); start.t = setTimeout(() => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; renderMap(); renderChart(); } }, 150); });
  }
  function seg(id, fn) {
    $(id).addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      for (const x of $(id).children) x.classList.toggle("on", x === b);
      fn(b.dataset.v);
    });
  }
  function setSeg(id, v) { for (const x of $(id).children) x.classList.toggle("on", x.dataset.v === v); }
  function pick(zone, metric, scroll) {
    sel.zone = zone;
    if (metric && UNIT[metric]) { sel.metric = metric; setSeg("seg-metric", metric); }
    renderMap(); renderCards(); renderChart();
    if (scroll !== false) $("chartcard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  const zoneName = id => (site.zones.find(z => z.id === id) || {}).name || id;
  const pairName = id => { const p = site.pairs.find(p => p.id === id); return p ? `${p.falls_names.map(SHORT).join(" and ")} to ${p.rises_names.map(SHORT).join(" and ")}` : id; };
  // Which measure decides the chokepoint's state (all ships first, then tankers, then cargo).
  const stateMetric = z => ["total", "tanker", "cargo"].find(m => z.status[m].state === z.state) || "total";

  function renderStatus() {
    const age = daysBetween(site.data_to, new Date().toISOString().slice(0, 10)), c = site.counts;
    $("headline").textContent = site.status_line;
    $("chips").innerHTML = ["abnormal", "elevated", "normal"].concat(c.baseline ? ["baseline"] : [])
      .map(k => `<span class="chip"><i class="mark ${k}"></i><b>${c[k]}</b>${STATE[k]}</span>`).join("");
    $("dataline").innerHTML = `Ships passing per day, 7-day average. Data to ${fmtDay(site.data_to)} (IMF PortWatch publishes a few days behind).` +
      (age > 12 ? ` <span class="warn">No new data since ${fmtDay(site.data_to)}, ${age} days ago.</span>` : "");
    $("built").textContent = `Analysis last run ${fmtTime(site.built)}.`;
  }

  // ---- map ----
  function renderMap() {
    const M = window.MAP, phone = window.innerWidth < 700;
    const xy = (lat, lon) => [(lon + 180) * M.k, (M.top - lat) * M.k];
    // Desktop shows the Americas to East Asia. Phones show Europe, Africa and Asia, with Panama pinned to the left edge.
    const view = phone ? { x: (-24 + 180) * M.k, y: (M.top - 57) * M.k, w: 152 * M.k, h: 106 * M.k } : { x: (-128 + 180) * M.k, y: (M.top - 68) * M.k, w: 282 * M.k, h: 122 * M.k };
    const u = phone ? 1.25 : 1;            // size multiplier for marks and text
    let h = `<defs><filter id="glow" x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation="${5 * u}"/></filter></defs>`;
    for (let lon = -180; lon <= 180; lon += 30) h += `<line x1="${(lon + 180) * M.k}" x2="${(lon + 180) * M.k}" y1="0" y2="${M.h}" stroke="rgba(255,255,255,.035)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    for (let lat = -30; lat <= 60; lat += 30) h += `<line x1="0" x2="${M.w}" y1="${(M.top - lat) * M.k}" y2="${(M.top - lat) * M.k}" stroke="rgba(255,255,255,${lat === 0 ? ".07" : ".035"})" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    h += `<path d="${window.LAND_PATH}" fill="var(--land)" stroke="#223040" stroke-width=".4"/>`;
    for (const b of site.bypass) { const [x, y] = xy(b.lat, b.lon); h += `<circle cx="${x}" cy="${y}" r="${2.2 * u}" fill="var(--sea)" stroke="var(--idle)" stroke-width="${1 * u}"><title>${esc(b.name)}: bypass port, no daily transit data in this version</title></circle>`; }
    for (const z of site.zones) {
      let [x, y] = xy(z.lat, z.lon); const on = z.id === sel.zone, c = COLOR[z.state];
      let [sx, sy, anchor] = LABEL_AT[z.id] || [1, 0, "start"];
      const edge = phone && x < view.x + 8;                 // off the phone map: pin to the left edge
      if (edge) { x = view.x + 12 * u; y = (M.top + 22) * M.k; sx = 1; sy = 0; anchor = "start"; }   // parked in open Atlantic, clear of other labels
      const r = 5 * u, lx = x + sx * (r + 9 * u), ly = y + (sy < 0 ? -9 * u : sy > 0 ? 10 * u : -1 * u);
      const mark = z.state === "abnormal" ? `<rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" transform="rotate(45 ${x} ${y})" fill="${c}" stroke="#05070a" stroke-width="${1.2 * u}"/>`
        : z.state === "elevated" ? `<path d="M${x} ${y - r * 1.35}L${x + r * 1.25} ${y + r * .9}L${x - r * 1.25} ${y + r * .9}Z" fill="${c}" stroke="#05070a" stroke-width="${1.2 * u}" stroke-linejoin="round"/>`
        : `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" stroke="#05070a" stroke-width="${1.2 * u}"/>`;
      h += `<g class="mk" data-z="${z.id}" tabindex="0" role="button" aria-label="${esc(z.name)}: ${STATE[z.state]}, ${num(z.status.total.value)} ships a day">
        <circle cx="${x}" cy="${y}" r="${r * 2.4}" fill="${c}" opacity=".5" filter="url(#glow)"/>
        ${z.state !== "normal" ? `<circle class="halo" cx="${x}" cy="${y}" r="${r * 1.9}" fill="none" stroke="${c}" stroke-width="${1.2 * u}"/>` : ""}
        ${on ? `<circle class="ring" cx="${x}" cy="${y}" r="${r * 2.5}" fill="none" stroke="var(--text)" stroke-width="${1 * u}"/>` : ""}
        ${mark}
        <text x="${lx}" y="${ly}" text-anchor="${anchor}" font-size="${9.5 * u}" font-weight="600" fill="var(--text)" paint-order="stroke" stroke="#05070a" stroke-width="${3 * u}" stroke-linejoin="round">${edge ? "&#9664; " : ""}${esc(SHORT(z.name))}</text>
        <text x="${lx}" y="${ly + 10.5 * u}" text-anchor="${anchor}" font-size="${9 * u}" fill="var(--text-2)" paint-order="stroke" stroke="#05070a" stroke-width="${3 * u}" stroke-linejoin="round"><tspan fill="var(--text)" font-weight="700">${num(z.status.total.value)}</tspan> ships/day</text>
        <circle cx="${x}" cy="${y}" r="${r * 3.2}" fill="transparent"><title>${esc(z.name)}: ${STATE[z.state]}</title></circle></g>`;
    }
    const svg = $("map"); svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`); svg.innerHTML = h;
    svg.onclick = e => { const g = e.target.closest(".mk"); if (g) pick(g.dataset.z); };
    svg.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { const g = e.target.closest(".mk"); if (g) { e.preventDefault(); pick(g.dataset.z); } } };
    $("maplegend").innerHTML = ["normal", "elevated", "abnormal"].map(s => `<span><i class="mark ${s}"></i>${STATE[s]}</span>`).join("") + `<span><i class="mark baseline"></i>Bypass port, no data yet</span>`;
  }

  // ---- cards ----
  function avg7(x) { return x.map((_, i) => { if (i < 6) return null; let t = 0; for (let j = i - 6; j <= i; j++) t += x[j]; return t / 7; }); }
  function spark(z, color) {
    const x = z.total, n = x.length, a = avg7(x), N = 90, from = n - N, W = 140, H = 34, band = z.band.total;
    let max = 0, min = Infinity;
    for (let i = from; i < n; i++) { const lo = band.lo[i - z.band_from], hi = band.hi[i - z.band_from]; max = Math.max(max, a[i], hi ?? 0); min = Math.min(min, a[i], lo ?? Infinity); }
    const pad = (max - min) * .12 || 1; min = Math.max(0, min - pad); max += pad;
    const X = i => (i - from) / (N - 1) * W, Y = v => H - 1.5 - (v - min) / (max - min) * (H - 3);
    let up = "", down = "", line = "";
    for (let i = from; i < n; i++) {
      const lo = band.lo[i - z.band_from], hi = band.hi[i - z.band_from];
      if (lo != null) { up += `${up ? "L" : "M"}${X(i).toFixed(1)} ${Y(hi).toFixed(1)}`; down = `L${X(i).toFixed(1)} ${Y(lo).toFixed(1)}` + down; }
      line += `${line ? "L" : "M"}${X(i).toFixed(1)} ${Y(a[i]).toFixed(1)}`;
    }
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${up ? `<path d="${up}${down}Z" fill="var(--band)"/>` : ""}<path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
  }
  function renderCards() {
    $("cards").innerHTML = site.zones.map(z => {
      const st = z.status.total, m = stateMetric(z), c = COLOR[z.state];
      const from = z.state !== "normal" && m !== "total" ? ` <small>from ${METRIC[m].toLowerCase()}</small>` : "";
      return `<button class="zcard${z.id === sel.zone ? " sel" : ""}" data-z="${z.id}" style="--c:${c}" aria-pressed="${z.id === sel.zone}">
        <div class="nm">${esc(z.name)}</div>
        <div class="val">${num(st.value)}</div><div class="unit">ships a day</div>
        <div class="rng">${st.lo == null ? "Collecting baseline" : `Normal ${num(st.lo)} to ${num(st.hi)}`}</div>
        ${spark(z, z.state === "normal" ? "var(--series)" : c)}
        <div class="st"><i class="mark ${z.state}"></i>${STATE[z.state]}${from}</div></button>`;
    }).join("");
    $("cards").onclick = e => { const b = e.target.closest(".zcard"); if (b) pick(b.dataset.z); };
  }

  // ---- anomalies, pairs, log ----
  function renderOpen() {
    const rank = { abnormal: 0, elevated: 1 };
    const open = site.episodes.filter(e => !e.ended_day).sort((a, b) => rank[a.level] - rank[b.level] || (a.started_day < b.started_day ? -1 : 1));
    $("opencount").textContent = open.length;
    $("open").innerHTML = open.length ? open.map((e, i) => {
      if (e.metric === "rerouting") return `<div class="ep" data-i="${i}">${badge(e.level)}<div class="what">Rerouting: ${esc(pairName(e.zone))}</div><div class="now">since ${fmtDay(e.started_day)}</div><div class="more">${esc(e.detail)}</div></div>`;
      const z = site.zones.find(z => z.id === e.zone), st = z.status[e.metric], days = daysBetween(e.started_day, site.data_to) + 1;
      const closing = e.inside_days > 0 ? ` Back inside the range for ${e.inside_days} of the 7 days needed to close.` : "";
      return `<div class="ep" data-i="${i}">${badge(e.level)}
        <div class="what">${esc(SHORT(z.name))}: ${METRIC[e.metric].toLowerCase()} ${e.direction} normal</div>
        <div class="now">${num(st.value)} <span style="color:var(--muted)">vs ${num(st.lo)} to ${num(st.hi)}</span></div>
        <div class="more">${days} days, since ${fmtDay(e.started_day)}.${closing} Furthest: ${num(e.peak_value)} on ${fmtDay(e.peak_day)}. Logged ${fmtTime(e.flagged_at)} (${esc(e.found_by)}).</div></div>`;
    }).join("") : `<p class="none">None. Every chokepoint is inside its normal range as of ${fmtDay(site.data_to)}.</p>`;
    $("open").onclick = ev => { const el = ev.target.closest(".ep"); if (!el) return; const e = open[+el.dataset.i]; if (e.metric === "rerouting") pick(site.pairs.find(p => p.id === e.zone).falls[0], "total"); else pick(e.zone, e.metric); };
  }
  function renderPairs() {
    $("pairs").innerHTML = site.pairs.map(p => {
      const title = `${esc(p.falls_names.map(SHORT).join(" and "))} &rarr; ${esc(p.rises_names.map(SHORT).join(" and "))}`;
      const body = p.state === "no-data" ? `No daily series for ${esc(p.rises_names.join(" or "))} yet.`
        : p.state === "normal" ? `No signal as of ${fmtDay(site.data_to)}. ${p.episodes} past in the log.`
        : `Active since ${fmtDay(p.since)}.`;
      return `<div class="pair"><h3>${title}</h3>${badge(p.state)}<p>${body}</p></div>`;
    }).join("");
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

  // ---- chart ----
  function series() {
    const z = site.zones.find(z => z.id === sel.zone), x = z[sel.metric], n = x.length, avg = avg7(x);
    const count = sel.range === "all" ? n : Math.min(n, +sel.range), from = n - count;
    const band = z.band[sel.metric], hasBand = sel.range !== "all" && from >= z.band_from;
    const lo = i => hasBand ? band.lo[i - z.band_from] : null, hi = i => hasBand ? band.hi[i - z.band_from] : null;
    return { z, x, avg, n, from, count, lo, hi, hasBand };
  }
  function renderChart() {
    const S = series(), { z, x, avg, n, from, count } = S, all = sel.range === "all";
    const st = z.status[sel.metric];
    $("charttitle").textContent = `${z.name}: ${METRIC[sel.metric].toLowerCase()} per day`;
    $("chartnote").innerHTML = `${badge(st.state)}<span>Now <b style="color:var(--text)">${num(st.value)}</b></span>` +
      (st.lo == null ? "" : `<span>Normal ${num(st.lo)} to ${num(st.hi)}</span>`) + (st.year_ago == null ? "" : `<span>A year ago ${num(st.year_ago)}</span>`) +
      `<span>Data to ${fmtDay(z.end)}, IMF PortWatch</span>`;
    const svg = $("chart"), W = Math.max(300, svg.parentNode.clientWidth), H = W < 560 ? 250 : 360, m = { l: W < 560 ? 36 : 44, r: 12, t: 16, b: 28 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    let ymax = 0;
    for (let i = from; i < n; i++) ymax = Math.max(ymax, all ? (avg[i] || 0) : x[i], avg[i] || 0, S.hi(i) || 0);
    const step = niceStep(ymax / 4); ymax = Math.max(step, Math.ceil(ymax * 1.04 / step) * step);
    const X = i => m.l + (count === 1 ? 0 : (i - from) / (count - 1) * pw), Y = v => m.t + ph - v / ymax * ph;
    let h = "";
    for (let v = 0; v <= ymax + 1e-9; v += step) h += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="12" fill="var(--muted)">${v.toLocaleString("en-US")}</text>`;
    const ticks = [], narrow = W < 560;
    for (let i = from; i < n; i++) {
      const d = dayAt(z.start, i), [yy, mm, dd] = d.split("-");
      const hit = all ? (mm === "01" && dd === "01" && (!narrow || +yy % 2 === 1)) : sel.range === "365" ? (dd === "01" && (+mm % (narrow ? 3 : 2) === 1)) : sel.range === "90" ? (dd === "01" || (!narrow && dd === "15")) : ((n - 1 - i) % (narrow ? 14 : 7) === 0);
      if (hit) ticks.push([i, all ? yy : sel.range === "365" ? `${MONTHS[mm - 1]} ${yy.slice(2)}` : fmtShort(d)]);
    }
    for (const [i, label] of ticks) h += `<text x="${X(i)}" y="${H - 8}" text-anchor="${X(i) > W - 40 ? "end" : "middle"}" font-size="12" fill="var(--muted)">${label}</text>`;
    if (S.hasBand) {
      let up = "", down = "";
      for (let i = from; i < n; i++) { if (S.lo(i) == null) continue; up += `${up ? "L" : "M"}${X(i).toFixed(1)} ${Y(S.hi(i)).toFixed(1)}`; down = `L${X(i).toFixed(1)} ${Y(S.lo(i)).toFixed(1)}` + down; }
      if (up) h += `<path d="${up}${down}Z" fill="var(--band)"/>`;
    }
    const eps = site.episodes.filter(e => e.zone === z.id && e.metric === sel.metric);
    let shown = 0;
    for (const e of eps) {
      const a = Math.max(from, daysBetween(z.start, e.started_day)), b = Math.min(n - 1, daysBetween(z.start, e.ended_day || z.end));
      if (b < from || a > n - 1) continue; shown++;
      h += `<rect x="${X(a)}" y="${m.t - 9}" width="${Math.max(2, X(b) - X(a))}" height="4" rx="2" fill="${e.level === "abnormal" ? "var(--critical)" : "var(--warning)"}"><title>${STATE[e.level]}: ${e.direction} normal, ${fmtDay(e.started_day)} to ${e.ended_day ? fmtDay(e.ended_day) : "now"}</title></rect>`;
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
      tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, left + (left > r.width * 0.6 ? -tip.offsetWidth - 12 : 12))) + "px"; tip.style.top = "22px";
    };
    const out = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
    svg.onmousemove = move; svg.ontouchstart = move; svg.ontouchmove = move; svg.onmouseleave = out; svg.ontouchend = out;

    $("chartlegend").innerHTML = `<span><i class="lg-line"></i>7-day average</span>` + (all ? "" : `<span><i class="lg-dot"></i>Each day</span>`) +
      (S.hasBand ? `<span><i class="lg-band"></i>Normal range</span>` : "") +
      (shown ? `<span><i class="lg-ep" style="background:var(--warning)"></i>Elevated episode</span><span><i class="lg-ep" style="background:var(--critical)"></i>Abnormal episode</span>` : "") +
      (all ? `<span>Normal range shows at 1y or less.</span>` : "");
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
    const mine = live && live.zones ? live.zones.filter(l => z.live_zones.includes(l.zone)) : [];
    let h = "";
    if (!live) h = `<div class="lv"><span class="tag">Live feed</span><span>Status could not be loaded.</span></div>`;
    else if (!mine.length) h = `<div class="lv"><span class="tag">Live feed</span><span>No live coverage here. The free feed has sent no ship messages from this area.</span></div>`;
    else {
      for (const l of mine) {
        const stale = Date.now() - Date.parse(l.ts) > 3 * 3600000, name = esc(names[l.zone] || l.zone) + (LIVE_NOTE[l.zone] ? ` (${LIVE_NOTE[l.zone]})` : "");
        h += stale ? `<div class="lv"><span class="tag">Live feed</span><span>${name}: no live data since ${fmtTime(l.ts)}.</span></div>`
          : `<div class="lv"><span class="tag">Live feed</span><span>${name}</span><span><b>${l.vessels}</b> ships in the zone</span><span>${l.moving} moving, ${l.stopped} stopped</span><span>${l.tanker} tankers, ${l.cargo} cargo, ${l.other} other, ${l.unknown} type not known yet</span><span>${fmtTime(l.ts)}</span></div>`;
      }
      h += `<p>Ships present during a 7-minute listen (aisstream.io). A different measure from the daily transits above; do not compare them. Collecting baseline since ${fmtDay(live.first_run.slice(0, 10))}.</p>`;
    }
    box.innerHTML = h;
  }
})();
