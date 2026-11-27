# Chokepoint Monitor

Live site: https://chokepoint-monitor-cg3.pages.dev

Daily ship traffic through seven shipping chokepoints (Hormuz, Suez, Bab el-Mandeb, Cape of Good Hope, Panama, Malacca, Bosporus), measured against each one's own normal range. Anything outside the range is logged as an anomaly with the date and time it was raised.

First version. The method, rules and limits are written up on the site: https://chokepoint-monitor-cg3.pages.dev/method

## Data

- **Daily transits, from 2019.** Source: International Monetary Fund, PortWatch (https://portwatch.imf.org/). The 7-day averages, normal ranges and anomaly flags are this project's own calculations.
- **Live ship counts.** aisstream.io, a free live ship feed. Reliable only in the Singapore Strait and off the Cape of Good Hope; other zones are shown as "no live coverage".

The two are different measures and are never compared.

## How it is put together

- `zones.json`: the zones and the rerouting pairs.
- `collector/run.js`: listens to the live ship feed for 7 minutes and saves distinct-ship counts per zone. Runs every 30 minutes on GitHub Actions.
- `collector/portwatch.js`: one-time loader for the PortWatch history.
- `worker/`: Cloudflare Worker and D1 database. Stores runs, pulls the last 30 days of PortWatch once a day, keeps the anomaly log, serves a private status page.
- `analysis/build.js`: the rules. Works out each chokepoint's normal range from its own past year, finds anomaly episodes and rerouting signals, and publishes the result.
- `site/`: the public pages. Plain HTML, CSS and JavaScript, no framework. Two small functions read the published result from the database.

## Rules in one paragraph

Values are 7-day averages. The normal range for a day is the middle 95% of that chokepoint's own values over one year, ending 30 days earlier. Outside the range is elevated. Abnormal means the gap to the range is bigger than the range's own spread. An episode opens after 7 days in a row outside the range and closes after 7 days back inside. With under 180 days of history a series says "collecting baseline". No threshold is set by hand.

## Running it

```
npm install
cp .dev.vars.example .dev.vars      # fill in your own keys
node collector/run.js 7 --dry-run   # listen for 7 minutes and print counts
node analysis/build.js --dry-run    # run the rules and write site-preview.json
```

The worker and the site deploy with `wrangler deploy` (in `worker/`) and `wrangler pages deploy` (in `site/`). Keys live in Cloudflare secrets, GitHub Actions secrets and a local `.dev.vars` that is not committed.

## Limits

The transit data is an estimate and runs several days behind. The rules flag data glitches as well as real events. A flag says traffic is unusual; it does not say why. Not for navigation or trading decisions. Independent personal project, not affiliated with any data provider.
