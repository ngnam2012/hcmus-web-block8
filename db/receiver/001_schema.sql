-- Receiver DB schema (receiver_db)
-- Accessed ONLY by receiver-api and receiver-worker.

CREATE TABLE IF NOT EXISTS inbox (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  raw_body TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processed_at TIMESTAMPTZ,
  last_delivery_attempt TEXT,
  PRIMARY KEY (source, event_id)
);

CREATE INDEX IF NOT EXISTS idx_inbox_received
  ON inbox (received_at ASC, event_id ASC)
  WHERE status = 'RECEIVED';

CREATE TABLE IF NOT EXISTS video_summaries (
  video_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  summary TEXT NOT NULL,
  applied_count INTEGER NOT NULL DEFAULT 1 CHECK (applied_count >= 1),
  source_event_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
