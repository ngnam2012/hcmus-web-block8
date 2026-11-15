CREATE TABLE videos (
  video_id text PRIMARY KEY,
  title text NOT NULL,
  transcript text NOT NULL,
  has_audio boolean NOT NULL DEFAULT true,
  next_version integer NOT NULL DEFAULT 0,
  current_version integer NOT NULL DEFAULT 0,
  current_summary_id uuid
);
CREATE TABLE jobs (
  job_id uuid PRIMARY KEY,
  message_id uuid NOT NULL UNIQUE,
  video_id text NOT NULL REFERENCES videos,
  version integer NOT NULL,
  correlation_id text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','DONE','DEAD_LETTERED')),
  replay_count integer NOT NULL DEFAULT 0,
  last_error_type text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE(video_id, version)
);
CREATE TABLE summaries (
  summary_id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES jobs,
  video_id text NOT NULL REFERENCES videos,
  version integer NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE videos ADD FOREIGN KEY (current_summary_id) REFERENCES summaries(summary_id);
CREATE TABLE processing_attempts (
  attempt_id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs,
  message_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  replay_generation integer NOT NULL DEFAULT 0,
  worker_id text NOT NULL,
  redelivered boolean NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('SUCCEEDED','TRANSIENT_ERROR','PERMANENT_ERROR','DUPLICATE','CRASHED')),
  error_type text,
  UNIQUE(message_id, attempt_no)
);
CREATE TABLE replay_events (
  replay_id bigserial PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES jobs(message_id),
  generation integer NOT NULL,
  replayed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(message_id, generation)
);
-- Markers persist across a real SIGKILL; a restarted process will not pause twice.
CREATE TABLE checkpoint_events (
  checkpoint_id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs,
  worker_id text NOT NULL,
  marker text NOT NULL,
  process_id integer NOT NULL,
  reached_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(job_id, marker)
);
CREATE TABLE mock_faults (
  job_id uuid PRIMARY KEY REFERENCES jobs,
  config jsonb NOT NULL
);
CREATE TABLE mock_calls (
  call_id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs,
  call_no integer NOT NULL,
  response_status integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE(job_id, call_no)
);
INSERT INTO videos(video_id,title,transcript,has_audio) VALUES
('V1','Message Broker','Message broker tách API khỏi tác vụ tốn thời gian. Publisher confirm xác nhận broker đã nhận; consumer ack được gửi sau commit.',true),
('V7','Ordering và version','Hai worker có thể hoàn tất khác thứ tự nhận. Chỉ cập nhật bản hiện tại khi version mới lớn hơn current_version.',true),
('V9','Video không có âm thanh','',false);
