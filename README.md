# Chokepoint Monitor

Work in progress. A site that watches the world's shipping chokepoints with free public data, keeps its own history and flags what is abnormal.

Built so far: the ship collector. Every run it listens to the aisstream.io live ship feed for 7 minutes, counts distinct ships in each zone, and saves the run to a Cloudflare D1 database.

- `zones.json`: the zones.
- `collector/run.js`: the scheduled ship collector.
- `collector/coverage-test.js`, `collector/gfw-test.js`: coverage checks for the data sources.
- `worker/`: Cloudflare Worker that stores runs, builds daily summaries and serves a private status page.
- `hosting-test/`: a one-off test of running the listener on Cloudflare itself.

A full README with sources, limits and run instructions comes with the public site.
