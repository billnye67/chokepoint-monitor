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

-- Anomaly log: every flag is saved with the date and time it was raised, for every chokepoint. Rows are never deleted.
CREATE TABLE IF NOT EXISTS anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flagged_at TEXT NOT NULL,         -- UTC date and time the flag was raised
  zone TEXT NOT NULL,
  source TEXT NOT NULL,
  metric TEXT NOT NULL,
  data_day TEXT,                    -- the day of data the flag is about
  value REAL,
  normal_low REAL,
  normal_high REAL,
  baseline_days INTEGER,
  level TEXT NOT NULL,              -- elevated or abnormal
  detail TEXT
);
CREATE INDEX IF NOT EXISTS anomalies_zone_time ON anomalies (zone, flagged_at);
