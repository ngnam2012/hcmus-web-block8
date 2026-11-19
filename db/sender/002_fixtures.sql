-- Fixtures for Block 9 practical: J42 (V7, version 1) and J43 (V7, version 2).
-- Fixed deterministic summary text; lab does not call any LLM.

INSERT INTO jobs (job_id, video_id, version, summary, status)
VALUES
  ('J42', 'V7', 1, 'Nội dung tóm tắt giả định của video V7 (version 1, job J42).', 'READY'),
  ('J43', 'V7', 2, 'Nội dung tóm tắt giả định của video V7 (version 2, job J43).', 'READY')
ON CONFLICT (job_id) DO NOTHING;
