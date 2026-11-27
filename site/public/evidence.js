// "What else changed" panel: for chosen anomalies, other public data drawn on the same dates as the traffic line.
// Reads /api/evidence (built by analysis/evidence.js). Timing only; never a statement of cause.
(function () {
  const $ = id => document.getElementById(id);
  let ev = null, cur = null, CM = null;
  const COLORS = { conflict: "#d95926", talk: "#9085e9", wind: "#199e70", price: "#c98500", monthly: "#d55181", traffic: "var(--series)" };
  const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

  const ready = new Promise(r => window.CM ? r() : document.addEventListener("cm-ready", r, { once: true }));
  Promise.all([fetch("/api/evidence").then(r => r.ok ? r.json() : null).catch(() => null), ready]).then(([e]) => {
    CM = window.CM; ev = e;
    if (!ev || !ev.cases || !ev.cases.length) return;
    $("evidence").hidden = false;
    $("ev-cases").innerHTML = ev.cases.map((c, i) => `<button data-i="${i}"${i ? "" : ' class="on"'}>${CM.esc(c.title.split(":")[0])}</button>`).join("");
    $("ev-cases").addEventListener("click", e => { const b = e.target.closest("button"); if (b) show(+b.dataset.i); });
    show(0);
    let lastW = window.innerWidth;
    window.addEventListener("resize", () => { clearTimeout(show.t); show.t = setTimeout(() => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; show(cur); } }, 160); });
    // A way in from the chart: when the charted chokepoint has a case, offer it.
    document.addEventListener("click", e => { const b = e.target.closest("[data-evcase]"); if (b) { show(+b.dataset.evcase); $("evidence").scrollIntoView({ behavior: "smooth", block: "start" }); } });
    const note = $("chartnote");
    new MutationObserver(link).observe(note, { childList: true });
    link();
  });

  function link() {
    const note = $("chartnote"); if (!note || note.querySelector("[data-evcase]")) return;
    const title = $("charttitle").textContent;
    ev.cases.forEach((c, i) => {
      const z = CM.site.zones.find(z => z.id === c.zone);
      if (z && title.startsWith(z.name)) note.insertAdjacentHTML("beforeend", `<button class="evbtn" data-evcase="${i}">What else changed: ${CM.esc(c.title.split(": ")[1] || c.title)}</button>`);
    });
  }

  function show(i) {
    cur = i; const c = ev.cases[i], z = CM.site.zones.find(z => z.id === c.zone);
    for (const b of $("ev-cases").children) b.classList.toggle("on", +b.dataset.i === i);
    $("ev-summary").innerHTML = `<strong style="color:var(--text)">${CM.esc(c.title)}.</strong> ${CM.esc(c.summary)} Window: ${CM.fmtDay(c.from)} to ${CM.fmtDay(c.to)}.`;
    const days = []; for (let d = c.from; d <= c.to; d = addDays(d, 1)) days.push(d);
    const n = days.length, wrap = $("ev-rows"), tip = $("ev-tip");
    const W = Math.max(300, wrap.clientWidth), narrow = W < 560, m = { l: narrow ? 38 : 46, r: 10 };
    const pw = W - m.l - m.r, X = i => m.l + (n === 1 ? 0 : i / (n - 1) * pw);

    // traffic row from the site data, same dates
    const x = z[c.metric], off = Math.round((Date.parse(c.from) - Date.parse(z.start)) / 86400000);
    const avg = days.map((_, k) => { const j = off + k; if (j < 6 || j >= x.length) return null; let t = 0; for (let q = j - 6; q <= j; q++) t += x[q]; return t / 7; });
    const band = z.band[c.metric], lo = days.map((_, k) => band.lo[off + k - z.band_from] ?? null), hi = days.map((_, k) => band.hi[off + k - z.band_from] ?? null);
    const rows = [{ group: "Traffic", label: `${z.name}: ships passing per day`, unit: "ships a day", kind: "traffic", values: avg, daily: days.map((_, k) => x[off + k] ?? null), lo, hi,
      source: "IMF PortWatch", source_url: "https://portwatch.imf.org/", frequency: "daily, a few days behind", note: "Line: 7-day average. Dots: each day. Shaded: normal range." }].concat(c.rows);

    let html = "", lastGroup = "";
    rows.forEach((r, ri) => {
      if (r.group !== lastGroup) { html += `<div class="evgroup">${CM.esc(r.group)}</div>`; lastGroup = r.group; }
      html += `<div class="evrow"><div class="lab"><b>${CM.esc(r.label)}</b>${r.unit ? `<span>${CM.esc(r.unit)}</span>` : ""}<span>Source: <a href="${r.source_url}">${CM.esc(r.source)}</a>. Updates: ${CM.esc(r.frequency)}.</span></div>${draw(r, ri)}${r.note || r.ref_label ? `<p class="rnote">${r.ref_label ? "Dashed line: " + CM.esc(r.ref_label) + ". " : ""}${CM.esc(r.note || "")}</p>` : ""}${r.kind === "marks" ? marklist(r) : ""}</div>`;
    });
    // date axis
    let ax = `<svg viewBox="0 0 ${W} 22" aria-hidden="true">`;
    const every = n > 120 ? 0 : n > 45 ? 14 : narrow ? 14 : 7;
    days.forEach((d, k) => {
      const [yy, mm, dd] = d.split("-");
      if (every ? k % every === 0 : dd === "01") ax += `<text x="${X(k)}" y="15" text-anchor="${X(k) > W - 40 ? "end" : k === 0 ? "start" : "middle"}" font-size="12" fill="var(--muted)">${+dd} ${CM.MONTHS[mm - 1]}</text>`;
    });
    wrap.innerHTML = html + ax + "</svg>"; wrap.appendChild(tip);

    function draw(r, ri) {
      const H = r.kind === "traffic" ? 130 : r.kind === "marks" ? 30 : 64, t = 6, b = 4, ph = H - t - b;
      let s = `<svg viewBox="0 0 ${W} ${H}" data-ri="${ri}" role="img" aria-label="${CM.esc(r.label)}">`;
      const grid = (lo, hi, fmt) => `<line x1="${m.l}" x2="${W - m.r}" y1="${t + ph}" y2="${t + ph}" stroke="var(--line)"/><text x="${m.l - 6}" y="${t + 9}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(hi)}</text><text x="${m.l - 6}" y="${t + ph}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(lo)}</text>`;
      const f0 = v => Math.round(v).toLocaleString("en-US"), f1 = v => CM.num(v);
      if (r.kind === "marks") {
        s += `<line x1="${m.l}" x2="${W - m.r}" y1="${H - 8}" y2="${H - 8}" stroke="var(--line)"/>`;
        for (const k of r.marks) { const i = days.indexOf(k.day); if (i < 0) continue; s += `<path d="M${X(i)} ${H - 22}l6 12h-12z" fill="${COLORS.talk}" stroke="var(--surface)" stroke-width="1.5"><title>${CM.fmtDay(k.day)}: ${CM.esc(k.text)}</title></path>`; }
        if (!r.marks.length) s += `<text x="${m.l}" y="${H - 14}" font-size="12" fill="var(--muted)">None in this window.</text>`;
      } else if (r.kind === "bars") {
        const max = Math.max(1, ...r.values), Y = v => t + ph - v / max * ph, bw = Math.max(1, pw / n - (n > 90 ? 0.6 : 2));
        s += grid(0, max, f0);
        r.values.forEach((v, i) => { if (v > 0) s += `<rect x="${X(i) - bw / 2}" y="${Y(v)}" width="${bw}" height="${t + ph - Y(v)}" fill="${COLORS[r.color] || COLORS.talk}" rx="${bw > 4 ? 1.5 : 0}"/>`; });
      } else if (r.kind === "monthly") {
        const vs = r.points.map(p => p.value), lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo) * 0.25 || 1, a = lo - pad, z2 = hi + pad, Y = v => t + ph - (v - a) / (z2 - a) * ph;
        s += `<line x1="${m.l}" x2="${W - m.r}" y1="${t + ph}" y2="${t + ph}" stroke="var(--line)"/>`;
        for (const p of r.points) {
          const first = Math.max(0, days.findIndex(d => d.startsWith(p.month))), lastI = days.reduce((q, d, i) => d.startsWith(p.month) ? i : q, -1);
          if (lastI < 0) continue;
          const x1 = X(first), x2 = X(lastI);
          s += `<line x1="${x1}" x2="${x2}" y1="${Y(p.value)}" y2="${Y(p.value)}" stroke="${COLORS.monthly}" stroke-width="2.5" stroke-linecap="round"${p.prelim ? ' stroke-dasharray="5 4"' : ""}/>`;
          if (x2 - x1 > 34) s += `<text x="${(x1 + x2) / 2}" y="${Y(p.value) - 5}" text-anchor="middle" font-size="11" fill="var(--text-2)">${CM.num(p.value)}</text>`;
        }
      } else {
        const vals = (r.kind === "traffic" ? r.values.concat(r.daily, r.hi, r.lo) : r.values.concat(r.ref ?? [])).filter(v => v != null);
        let lo = r.kind === "traffic" ? 0 : Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.1 || 1; if (r.kind !== "traffic") lo -= pad; hi += pad;
        const Y = v => t + ph - (v - lo) / (hi - lo) * ph, col = r.kind === "traffic" ? COLORS.traffic : r.group === "Weather" ? COLORS.wind : COLORS.price;
        s += grid(lo, hi, r.kind === "traffic" ? f0 : f1);
        if (r.kind === "traffic") {
          let up = "", dn = ""; r.lo.forEach((v, i) => { if (v == null) return; up += `${up ? "L" : "M"}${X(i)} ${Y(r.hi[i])}`; dn = `L${X(i)} ${Y(v)}` + dn; });
          if (up) s += `<path d="${up}${dn}Z" fill="var(--band)"/>`;
          r.daily.forEach((v, i) => { if (v != null) s += `<circle cx="${X(i)}" cy="${Y(v)}" r="${n > 90 ? 1.2 : 2}" fill="var(--daily)"/>`; });
        }
        if (r.ref != null) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(r.ref)}" y2="${Y(r.ref)}" stroke="var(--muted)" stroke-dasharray="4 4"/>`;
        let d = ""; r.values.forEach((v, i) => { if (v != null) d += `${d ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; });
        s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
        if (r.ref != null) r.values.forEach((v, i) => { if (v != null && v > r.ref) s += `<circle cx="${X(i)}" cy="${Y(v)}" r="3.5" fill="${col}" stroke="var(--surface)" stroke-width="1.5"/>`; });
      }
      return s + `<line class="evx" y1="0" y2="${H}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/></svg>`;
    }
    function marklist(r) { return r.marks.length ? `<ul class="marklist">${r.marks.map(k => `<li>${CM.fmtDay(k.day)}: <a href="${k.url}">${CM.esc(k.text)}</a></li>`).join("")}</ul>` : ""; }

    const lines = [...wrap.querySelectorAll(".evx")];
    const move = e => {
      const first = wrap.querySelector("svg"), rc = first.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
      const cx = e.touches ? e.touches[0].clientX : e.clientX, cy = e.touches ? e.touches[0].clientY : e.clientY;
      const px = (cx - rc.left) * (W / rc.width), i = Math.max(0, Math.min(n - 1, Math.round((px - m.l) / pw * (n - 1))));
      for (const l of lines) { l.setAttribute("x1", X(i)); l.setAttribute("x2", X(i)); l.setAttribute("visibility", "visible"); }
      let h = `<b>${CM.fmtDay(days[i])}</b>`;
      for (const r of rows) {
        if (r.kind === "traffic") h += `<div><span>Ships that day</span><span>${CM.num(r.daily[i])}</span></div><div><span>7-day average</span><span>${CM.num(r.values[i])}</span></div>`;
        else if (r.kind === "marks") { const k = r.marks.filter(k => k.day === days[i]); if (k.length) h += `<div><span>Treasury action</span><span>${k.length}</span></div>`; }
        else if (r.kind === "monthly") { const p = r.points.find(p => days[i].startsWith(p.month)); h += `<div><span>${CM.esc(r.label.replace(" (monthly)", ""))}</span><span>${p ? CM.num(p.value) : "no value yet"}</span></div>`; }
        else h += `<div><span>${CM.esc(r.label)}</span><span>${r.values[i] == null ? (r.gaps ? "no price" : "") : CM.num(r.values[i])}</span></div>`;
      }
      tip.innerHTML = h; tip.hidden = false; tip.style.minWidth = "250px";
      const left = X(i) * (rc.width / W);
      tip.style.left = Math.min(wr.width - tip.offsetWidth - 4, Math.max(4, left + (left > wr.width * 0.55 ? -tip.offsetWidth - 14 : 14))) + "px";
      tip.style.top = Math.max(0, Math.min(wr.height - tip.offsetHeight, cy - wr.top - tip.offsetHeight / 2)) + "px";
    };
    const out = () => { tip.hidden = true; for (const l of lines) l.setAttribute("visibility", "hidden"); };
    wrap.onmousemove = move; wrap.ontouchstart = move; wrap.ontouchmove = move; wrap.onmouseleave = out; wrap.ontouchend = out;

    $("ev-stories").innerHTML = c.stories.map(s => `<li>${CM.fmtDay(s.day)}: <a href="${s.url}" rel="noopener nofollow">${CM.esc(s.text)}</a> <small>${CM.esc(s.site)}, ${s.kind}</small></li>`).join("") +
      `<li><small>Chosen by how often each was mentioned, from GDELT's automatic reading of the news. Headlines are rebuilt from the links and are not checked by this site. Some are off topic.</small></li>`;
    $("ev-missing").innerHTML = c.missing.map(x => `<li><strong style="color:var(--text)">${CM.esc(x.label)}.</strong> ${CM.esc(x.reason)}</li>`).join("");
  }
})();
