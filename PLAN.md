# Chokepoint Monitor: running plan

Spec: the build spec James pasted on 2026-11-26 (phases 1 to 4; collector first).

## Sources checked against current docs (2026-11-26)
- aisstream.io: free, WebSocket, back end only, max 3 connections, no uptime guarantee, compression expected. Key needs a GitHub sign-in.
- adsb.lol /v2/mil: works with no key today. 500 requests a day per IP without a key; free keys exist. Licence ODbL 1.0 (credit required).
- NASA FIRMS: free MAP_KEY by email, 5,000 transactions per 10 minutes. NASA asks to be credited.

## Changes to the spec
- Ship listening window must be about 7 minutes or longer: anchored ships only report every 3 minutes and ship type arrives every 6.
- Keep a stored ship-type table so tanker and cargo counts fill in over time.
- Expect the military aircraft layer to be near empty in these zones (0 of 61 in any zone on first check).

## Status
- Done: project folder, zones.json, coverage test script.
- Next: James adds the aisstream key to .dev.vars, then run the one-hour coverage test.
- Open: where the collector runs (decide after the coverage test).

## Update 2026-11-26 (evening)
- Keys in .dev.vars: aisstream and FIRMS (both tested and working).
- Decisions from James: 7-minute ship window plus stored ship-type table; one aircraft network only, layer not built yet; test both hosting options and recommend, free preferred, ask before any cost; Phase 2 is a flat map dashboard with analysis on top, not a globe; ship collector first, nothing else until it is deployed and saving.
- Proposed extra layer: IMF PortWatch daily chokepoint transits (free public data, history from 2019-01-01, latest day 2026-11-22, covers Hormuz, Suez, Bab el-Mandeb, Cape, Panama, Malacca, Bosporus). Waiting on James's yes. Licence points to IMF terms; read them before use.
- ADS-B Exchange: commercial API is price on request; RapidAPI personal plan reported at $10 a month for 10,000 requests, non-commercial, no redistribution. Not confirmed on the listing page itself.
- One-hour coverage test started 22:45 local.

## Decisions 2026-11-26 (late)
- PortWatch is the backbone: daily transit counts drive history, normal ranges, anomalies and rerouting pairs, from 2019. Always show the date the data runs to.
- aisstream is the "right now" layer, only in zones the coverage test shows are reliable. It builds its own history from switch-on.
- Never compare PortWatch (ships passing per day) with aisstream (ships in the zone now). Label each.
- Military aircraft: adsb.lol with credit. ADS-B Exchange dropped.
- Global Fishing Watch to be added: AIS vessel presence for open-water zones, and radar detections with no matching AIS as a carefully labelled count. Needs James's free API token.
- IMF terms read (imf.org copyright-and-terms, statistical data section): publishing and derived work allowed with "Source: International Monetary Fund, PortWatch, link" and a note of any transformation; commercial reuse needs permission; bulk automated download without permission is prohibited, so keep pulls small and email IMF-PortWatch@IMF.ORG.
- GFW terms read: non-commercial only (CC BY-NC 4.0), credit Global Fishing Watch next to the data, no implied endorsement.
- Hormuz check: Lloyd's List figures reported by Gulf Business give 181 vessels for March 1 to 30, 2026 against about 138 a day before; Vortexa reports tanker transits falling from nearly 40 a day to a few. Direction and scale match PortWatch; absolute levels differ by counting method.

## Coverage test result (60 min from 2026-11-26 22:42 UTC, 4,303 messages, 0 reconnects)
Distinct vessels: singapore 571, cape 142, panama-pacific 11, panama-atlantic 4, bosphorus 1; hormuz, suez-north, suez-south, bab-el-mandeb, fujairah, yanbu all 0.
Proposed: live layer on for singapore and cape; panama marked thin; the rest marked "no live coverage" and served by PortWatch (and GFW once the key exists).
Next: hosting test for the collector, then build and deploy it.

## Global Fishing Watch check (2026-11-26)
Key saved in `.dev.vars` as `GFW_API_KEY` (expires 2036). Script: `collector/gfw-test.js`. Result file: `coverage-gfw-2026-11-27.json`.
- AIS presence (`public-global-presence`): data on all 30 of the last 30 days in all 11 zones, including the 7 where aisstream saw nothing. Runs to 2026-11-22 (about 4 days behind). Rows are one vessel per day with hours, name, flag and type, so distinct vessels per day can be counted.
- SAR radar (`public-global-sar-presence`): runs to 2026-11-21/23. Satellite passes are not daily. Days with a pass out of 30: hormuz 19, suez-south 15, fujairah 15, suez-north 14, bosphorus 10, bab-el-mandeb 9, singapore 7, cape 7, yanbu 5, panama 3 each.
- Radar detections not matched to AIS, 30 days (unmatched / all): hormuz 2303/3166, fujairah 1369/2853, suez-south 305/896, suez-north 167/858, cape 134/332, bosphorus 133/449, singapore 119/1718, bab-el-mandeb 40/129, yanbu 37/39, panama-pacific 35/238, panama-atlantic 7/194.
- Decision proposed: GFW AIS presence = the "ships present" layer for every zone (4 days behind, labelled). SAR unmatched shown per pass day, never as a daily series, off for Panama and Yanbu (too few passes). Not yet checked: what share of unmatched detections are small boats.
Next: hosting test, then build and deploy the collector.

## Phase 1 collector deployed (2026-11-27 01:35 UTC)
- Storage: Cloudflare Worker `chokepoint-monitor` + D1 database `chokepoint-monitor` (free plan). Tables: runs, measurements (raw, 90 days), ship_types, daily (forever), anomalies (every flag with date and time, never deleted; filled in Phase 3).
- Worker: POST /ingest (secret), GET /status?key=... (private status page), daily job 00:20 UTC builds summaries and prunes raw rows.
- Collector: `collector/run.js`, 7-minute listen, all 11 zones recorded each run. A zone with no messages is saved as "nothing heard", never as zero ships.
- First run saved 01:35 UTC from this PC: singapore 197 ships, cape 80, panama 3 and 1, others nothing heard.
- Schedule: GitHub Actions in private repo billnye67/chokepoint-monitor, every 3 hours (private repos get 2,000 free minutes a month; a run uses about 8). Public repos have no minute limit, so 30-minute runs need the repo public.
- Secrets: INGEST_SECRET, STATUS_KEY, INGEST_URL in `.dev.vars`; the first two also in Cloudflare; AISSTREAM key, INGEST_URL, INGEST_SECRET in GitHub Actions secrets.
- Watch out: the workers.dev address contains the name part of James's email. Never write it in committed files or on the public site; the public site needs its own address.
- Hosting test: `hosting-test/` worker tries the same listen on Cloudflare's free plan every 10 minutes and logs to table hosting_test. Remove the worker and table after the test.
- Still to do in Phase 1: PortWatch daily pull and history load (after James emails IMF), GFW daily pull, FIRMS daily, adsb.lol.

## Hosting test result (2026-11-27)
- GitHub Actions (free): run finished in 7 min 16 s and saved. Repo made public 01:56 UTC on James's say; schedule now every 30 minutes (7 and 37 past).
- Cloudflare Worker alone (free plan): one full 7-minute listen completed, 480 messages, but used 49 ms of processing against a stated free allowance of 10 ms. It worked once; it is over the stated limit, so it could be cut off at any time. Paid plan ($5 a month) would remove that risk.
- Decision: GitHub Actions runs the collector, Cloudflare free stores it. No cost. Test worker and its table removed.
- Known weak spots of GitHub's timer: starts can be late or skipped at busy times, and schedules pause after 60 days with no repo activity. The status page shows good runs in the last 24 hours so gaps are visible.

## Done from the Roblox thread by mistake (2026-11-27 ~02:45 UTC), nothing committed
- PortWatch history loaded: D1 table portwatch_daily, 20,181 rows (7 chokepoints x 2,883 days, 2019-01-01 to 2026-11-22). Loader: collector/portwatch.js; port list: worker/src/portwatch-ports.json; portwatch-history.sql gitignored.
- Worker deployed with a daily PortWatch pull (last 30 days, in the 00:20 UTC cron) and POST /pull/portwatch (ingest secret). Tested: 182 rows, run saved with source portwatch. Status page shows PortWatch days and the date the data runs to.
- anomalies table was empty; dropped and recreated with episode columns (started_day, ended_day, level, peak values, found_by). New table site_cache. See worker/schema.sql.
- Not done: /export and /publish endpoints, analysis script, site, method page. GFW daily, FIRMS, adsb.lol not started.
- Timer: no scheduled GitHub run had landed by 02:41 UTC (schedule on since 01:56). Watch stopped here; recheck from the main thread.

## First version of the site live (2026-11-27 ~03:00 UTC)
- Public link: https://chokepoint-monitor-cg3.pages.dev (Cloudflare Pages project chokepoint-monitor; site/ folder; functions /api/site and /api/live read D1).
- analysis/build.js: rules + episodes + rerouting, publishes to D1 (site_cache, anomalies). 292 episodes logged as history backfill, 8 open. Runs after every collector run in collect.yml.
- Rules chosen: 7-day average; normal = middle 95% of own past year ending 30 days earlier; abnormal = gap bigger than the range's own spread (ratio); episode opens after 7 days, closes after 7; abnormal days kept out of baseline for up to a year, then "new normal"; under 180 days = collecting baseline.
- Result on data to 2026-11-22: Hormuz abnormal since 2026-03-03; Suez elevated (above), Cape elevated (below), Bosporus cargo elevated (below); others normal.
- Not built: GFW layer, FIRMS, adsb.lol, live-feed anomaly rules, alerts outside the page (email etc.), Fujairah/Yanbu data for the Hormuz pair.
- Open problem: GitHub's timer had not started a run by itself as of 03:00 UTC (schedule on since 01:56). Runs so far were started by hand.
