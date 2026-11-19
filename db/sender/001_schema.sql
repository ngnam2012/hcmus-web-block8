-- Sender DB schema (sender_db)
-- Accessed ONLY by sender-api and relay.

CREATE SEQUENCE IF NOT EXISTS attempt_id_seq START 1 INCREMENT 1;

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('READY', 'DONE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  UNIQUE (video_id, version)
);

CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
  event_type TEXT NOT NULL DEFAULT 'summary.completed',
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  raw_body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'DEAD')),
  replay_round INTEGER NOT NULL DEFAULT 1 CHECK (replay_round >= 1),
  next_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  delivered_at TIMESTAMPTZ,
  dead_at TIMESTAMPTZ,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON outbox (next_attempt_at ASC, created_at ASC)
  WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS delivery_attempts (
  attempt_seq BIGSERIAL UNIQUE NOT NULL,
  attempt_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES outbox(event_id),
  round INTEGER NOT NULL CHECK (round >= 1),
  attempt_in_round INTEGER NOT NULL CHECK (attempt_in_round >= 1),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finished_at TIMESTAMPTZ,
  http_status INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('STARTED', 'ACKNOWLEDGED', 'RETRYABLE', 'REJECTED', 'UNKNOWN')),
  error_detail TEXT,
  UNIQUE (event_id, round, attempt_in_round)
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_event
  ON delivery_attempts (event_id, attempt_seq ASC);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_started
  ON delivery_attempts (event_id)
  WHERE outcome = 'STARTED';

CREATE TABLE IF NOT EXISTS replay_events (
  replay_id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES outbox(event_id),
  round INTEGER NOT NULL CHECK (round >= 2),
  replayed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, round)
);
