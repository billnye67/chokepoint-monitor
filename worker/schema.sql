-- One row per collector run, per source.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                 -- when the run finished, UTC ISO
  source TEXT NOT NULL,             -- aisstream, portwatch, gfw, ...
  ok INTEGER NOT NULL,              -- 1 if the source responded properly
  listen_seconds INTEGER,
  messages INTEGER,
  reconnects INTEGER,
  runner TEXT,                      -- where the job ran
  note TEXT
);
CREATE INDEX IF NOT EXISTS runs_source_ts ON runs (source, ts);

-- One row per run, per zone. Raw records, kept 90 days.
CREATE TABLE IF NOT EXISTS measurements (
  run_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  zone TEXT NOT NULL,
  source TEXT NOT NULL,
  ok INTEGER NOT NULL,
  messages INTEGER NOT NULL,        -- 0 means nothing was heard from this zone, not that it was empty
  vessels INTEGER NOT NULL,
  moving INTEGER NOT NULL,
  stopped INTEGER NOT NULL,
  tanker INTEGER NOT NULL,
  cargo INTEGER NOT NULL,
  other INTEGER NOT NULL,
  unknown INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS measurements_zone_ts ON measurements (zone, source, ts);
CREATE INDEX IF NOT EXISTS measurements_ts ON measurements (ts);

-- Ship type by MMSI, learned from static data messages. Fills in over time.
CREATE TABLE IF NOT EXISTS ship_types (
  mmsi INTEGER PRIMARY KEY,
  type INTEGER NOT NULL,
  updated TEXT NOT NULL
);

-- Daily summaries, kept forever.
CREATE TABLE IF NOT EXISTS daily (
  day TEXT NOT NULL,
  zone TEXT NOT NULL,
  source TEXT NOT NULL,
  runs INTEGER NOT NULL,            -- runs that day
  runs_heard INTEGER NOT NULL,      -- runs where the source was ok and the zone had at least one message
  vessels_avg REAL, vessels_min INTEGER, vessels_max INTEGER,
  moving_avg REAL, stopped_avg REAL,
  tanker_avg REAL, cargo_avg REAL, other_avg REAL, unknown_avg REAL,
  PRIMARY KEY (day, zone, source)
);

-- Anomaly log: one row per episode (a run of flagged days), with when it started and ended in the data,
-- and when this system first raised it. Rows are never deleted.
CREATE TABLE IF NOT EXISTS anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flagged_at TEXT NOT NULL,         -- UTC date and time this system first raised the flag
  found_by TEXT NOT NULL,           -- 'daily check' or 'history backfill'
  zone TEXT NOT NULL,               -- chokepoint id, or a pair id for rerouting
  source TEXT NOT NULL,             -- portwatch, aisstream, ...
  metric TEXT NOT NULL,             -- total, tanker, cargo, rerouting
  direction TEXT NOT NULL,          -- below or above (rerouting: shift)
  started_day TEXT NOT NULL,        -- first flagged day of data
  ended_day TEXT,                   -- last flagged day; NULL while still going
  last_checked_day TEXT NOT NULL,   -- latest data day when this row was last updated
  level TEXT NOT NULL,              -- highest level reached: elevated or abnormal
  peak_value REAL, peak_day TEXT, normal_low REAL, normal_high REAL, peak_score REAL,
  latest_value REAL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS anomalies_zone_time ON anomalies (zone, started_day);

-- IMF PortWatch daily chokepoint transits (ships passing per day, from 2019-01-01).
-- Source: International Monetary Fund, PortWatch. Stored as published; the latest days can be revised, so the daily pull re-reads the last 30 days.
CREATE TABLE IF NOT EXISTS portwatch_daily (
  day TEXT NOT NULL,
  portid TEXT NOT NULL,             -- PortWatch id, e.g. chokepoint6
  portname TEXT NOT NULL,
  n_total INTEGER, n_tanker INTEGER, n_cargo INTEGER,
  n_container INTEGER, n_dry_bulk INTEGER, n_general_cargo INTEGER, n_roro INTEGER,
  capacity INTEGER, capacity_tanker INTEGER, capacity_cargo INTEGER,
  fetched TEXT NOT NULL,
  PRIMARY KEY (portid, day)
);
CREATE INDEX IF NOT EXISTS portwatch_day ON portwatch_daily (day);

-- Built output for the public site (one JSON text per key).
CREATE TABLE IF NOT EXISTS site_cache (
  key TEXT PRIMARY KEY,
  built TEXT NOT NULL,
  body TEXT NOT NULL
);
