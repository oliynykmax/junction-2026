-- Operational ledger for the dashboard. Written by Review objects at a few
-- boundaries; never holds prompts, tool arguments, failure text or secrets.

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT INTO meta (k, v) VALUES
  ('collection_started_at', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));

-- One row per Review object (one PR head commit).
CREATE TABLE runs (
  object_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL,
  decision TEXT,
  findings INTEGER,
  failure TEXT,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX runs_started ON runs (started_at);
CREATE INDEX runs_status_started ON runs (status, started_at);
CREATE INDEX runs_repo_started ON runs (owner, repo, started_at);

-- Usage snapshot per run and model, replaced on every settle.
CREATE TABLE run_models (
  object_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  PRIMARY KEY (object_id, model)
);

-- Calls and lifecycle events; pruned after 30 days by the daily cron.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  object_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  ok INTEGER NOT NULL,
  ms INTEGER,
  detail TEXT
);
CREATE INDEX events_at ON events (at);
CREATE INDEX events_kind_at ON events (kind, at);

-- One row per boot that found tasks a dead process left running.
CREATE TABLE recoveries (
  boot_id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  tasks INTEGER NOT NULL,
  scan_complete INTEGER NOT NULL,
  ended_ok INTEGER NOT NULL DEFAULT 0,
  ended_bad INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX recoveries_detected ON recoveries (detected_at);
CREATE INDEX recoveries_object ON recoveries (object_id, detected_at);
