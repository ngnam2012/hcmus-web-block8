import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { ProcessingError, classifyStatus } from './domain.js';

export async function checkpoint(client, job, marker, workerId) {
  if (!config.labMode || config.appVersion !== 'V3' || job.options.pause_at !== marker) return;
  const { rowCount } = await client.query(`INSERT INTO checkpoint_events(job_id,worker_id,marker,process_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(job_id,marker) DO NOTHING`, [job.job_id, workerId, marker, process.pid]);
  if (rowCount) {
    console.log(JSON.stringify({ event: 'CHECKPOINT_PAUSED', marker, worker_id: workerId, job_id: job.job_id, pid: process.pid, at: new Date().toISOString() }));
    await new Promise(() => {}); // Intentionally waits for an external, real SIGKILL.
  }
}

export async function startAttempt(client, job, workerId, redelivered) {
  // An unfinished attempt belongs to a process that lost this job's session lock.
  await client.query(`UPDATE processing_attempts SET outcome='CRASHED', error_type='PROCESS_LOST',
    finished_at=clock_timestamp() WHERE message_id=$1 AND outcome IS NULL`, [job.message_id]);
  const { rows: [attempt] } = await client.query(`INSERT INTO processing_attempts
    (job_id,message_id,attempt_no,replay_generation,worker_id,redelivered)
    SELECT $1,$2,COALESCE(MAX(attempt_no),0)+1,$3,$4,$5 FROM processing_attempts WHERE message_id=$2 RETURNING *`,
  [job.job_id, job.message_id, job.replay_count, workerId, redelivered]);
  return attempt;
}

export async function finishAttempt(client, attempt, outcome, errorType = null) {
  await client.query(`UPDATE processing_attempts SET outcome=$2,error_type=$3,finished_at=clock_timestamp() WHERE attempt_id=$1`,
    [attempt.attempt_id, outcome, errorType]);
}

export async function callLlm(client, job) {
  const { rows: [video] } = await client.query('SELECT * FROM videos WHERE video_id=$1', [job.video_id]);
  if (!video.has_audio) throw new ProcessingError('NO_AUDIO', false);
  const directVideoMode = !video.transcript?.trim() && Boolean(video.video_url);
  const timeoutMs = job.options?.mock?.timeout
    ? config.llmTimeoutMs
    : Math.max(config.llmTimeoutMs, directVideoMode ? 60000 : 30000);
  let response;
  try {
    response = await fetch(`${config.mockUrl}/summarize`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_id: job.job_id,
        title: video.title,
        transcript: video.transcript,
        video_url: video.video_url || '',
        options: job.options,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ProcessingError(error.name === 'TimeoutError' ? 'LLM_TIMEOUT' : 'LLM_UNAVAILABLE', true);
  }
  if (!response.ok) throw classifyStatus(response.status);
  return (await response.json()).summary;
}

export async function commitSummary(client, job, attempt, content) {
  await client.query('BEGIN');
  try {
    const summaryId = randomUUID();
    await client.query(`INSERT INTO summaries(summary_id,job_id,video_id,version,content) VALUES($1,$2,$3,$4,$5)`,
      [summaryId, job.job_id, job.video_id, job.version, content]);
    // Atomic compare-and-set: V1 finishing after V2 cannot overwrite V2.
    await client.query(`UPDATE videos SET current_version=$2,current_summary_id=$3 WHERE video_id=$1 AND current_version<$2`,
      [job.video_id, job.version, summaryId]);
    await client.query(`UPDATE jobs SET status='DONE', completed_at=clock_timestamp(),last_error_type=NULL WHERE job_id=$1`, [job.job_id]);
    await finishAttempt(client, attempt, 'SUCCEEDED');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
