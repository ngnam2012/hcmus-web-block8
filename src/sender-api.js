import express from 'express';
import { readFile } from 'node:fs/promises';
import { config, EVENT_TYPE_SUMMARY_COMPLETED, requireLoopbackAdmin, SCHEMA_VERSION } from './config.js';
import { createSenderPool, withTransaction } from './db.js';
import { maybePauseAtMarker } from './marker.js';
import { buildSummaryCompletedPayload, deriveEventId } from './protocol.js';

const pool = createSenderPool();
const app = express();
const loopbackAdminOnly = requireLoopbackAdmin(config);
app.use(express.json({ limit: '64kb' }));
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({
    service: 'sender-api',
    endpoints: ['/health', '/jobs', '/jobs/:job_id/complete', '/events/:event_id', '/events/:event_id/replay'],
    ...(config.labMode ? { demo_console: `http://127.0.0.1:${process.env.LAB_UI_PORT || 4200}/` } : {}),
  });
});

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'sender-api', pid: process.pid, database: true });
  } catch (error) {
    res.status(503).json({ status: 'degraded', service: 'sender-api', error: error.message });
  }
});

app.get('/jobs', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT job_id, video_id, version, summary, status, created_at, completed_at FROM jobs ORDER BY job_id ASC',
  );
  res.json(rows);
});

app.get('/jobs/:job_id', async (req, res) => {
  const { rows: [job] } = await pool.query(
    `SELECT j.job_id, j.video_id, j.version, j.summary, j.status, j.created_at, j.completed_at,
            o.event_id, o.status AS outbox_status, o.replay_round
     FROM jobs j
     LEFT JOIN outbox o ON o.job_id = j.job_id
     WHERE j.job_id = $1`,
    [req.params.job_id],
  );
  if (!job) return res.status(404).json({ error: 'JOB_NOT_FOUND', job_id: req.params.job_id });
  return res.json(job);
});

/**
 * Contract API: POST /jobs/:job_id/complete
 * Single local transaction on sender_db:
 *   1. Lock job row (FOR UPDATE)
 *   2. If already DONE, return existing event_id without creating a new event
 *   3. Otherwise UPDATE READY -> DONE and INSERT immutable outbox row in the SAME transaction
 *   4. Return 200 AFTER commit with { job_id, event_id }
 */
app.post('/jobs/:job_id/complete', async (req, res) => {
  const jobId = req.params.job_id;

  const outcome = await withTransaction(pool, async client => {
    const { rows: [job] } = await client.query(
      'SELECT job_id, video_id, version, summary, status, completed_at FROM jobs WHERE job_id = $1 FOR UPDATE',
      [jobId],
    );
    if (!job) {
      return { notFound: true };
    }

    if (job.status === 'DONE') {
      const { rows: [existingOutbox] } = await client.query(
        'SELECT event_id, status, replay_round, next_attempt_at FROM outbox WHERE job_id = $1',
        [jobId],
      );
      return {
        alreadyCompleted: true,
        job,
        outbox: existingOutbox,
      };
    }

    const { rows: [updatedJob] } = await client.query(
      `UPDATE jobs
       SET status = 'DONE', completed_at = clock_timestamp()
       WHERE job_id = $1
       RETURNING job_id, video_id, version, summary, status, completed_at`,
      [jobId],
    );

    // Marker F1: after job UPDATE, before outbox INSERT & COMMIT -> SIGKILL rolls back both.
    await maybePauseAtMarker('after_job_update_before_outbox', { job_id: updatedJob.job_id });

    const eventId = deriveEventId(updatedJob.job_id);
    const payload = buildSummaryCompletedPayload(
      updatedJob,
      eventId,
      new Date(updatedJob.completed_at).toISOString(),
    );
    // Serialize raw_body ONCE and store immutably for all retries and replays.
    const rawBody = JSON.stringify(payload);

    const { rows: [outbox] } = await client.query(
      `INSERT INTO outbox (event_id, job_id, event_type, schema_version, raw_body, status, replay_round, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', 1, clock_timestamp())
       RETURNING event_id, job_id, status, replay_round, next_attempt_at`,
      [eventId, updatedJob.job_id, EVENT_TYPE_SUMMARY_COMPLETED, SCHEMA_VERSION, rawBody],
    );

    return {
      alreadyCompleted: false,
      job: updatedJob,
      outbox,
    };
  });

  if (outcome.notFound) {
    return res.status(404).json({ error: 'JOB_NOT_FOUND', job_id: jobId });
  }

  // Marker F2: AFTER transaction COMMIT, BEFORE HTTP response -> DB has DONE + outbox PENDING.
  if (!outcome.alreadyCompleted) {
    await maybePauseAtMarker('after_sender_commit_before_response', {
      job_id: outcome.job.job_id,
      event_id: outcome.outbox.event_id,
    });
  }

  return res.status(200).json({
    job_id: outcome.job.job_id,
    event_id: outcome.outbox.event_id,
    status: outcome.job.status,
    outbox_status: outcome.outbox.status,
    already_completed: outcome.alreadyCompleted,
  });
});

/**
 * Contract API: GET /events/:event_id
 * Returns outbox status and full delivery attempt + replay history.
 */
app.get('/events/:event_id', async (req, res) => {
  const eventId = req.params.event_id;
  const { rows: [event] } = await pool.query(
    `SELECT event_id, job_id, event_type, schema_version, raw_body, status,
            replay_round, next_attempt_at, created_at, delivered_at, dead_at, last_error
     FROM outbox
     WHERE event_id = $1`,
    [eventId],
  );
  if (!event) {
    return res.status(404).json({ error: 'EVENT_NOT_FOUND', event_id: eventId });
  }

  const { rows: attempts } = await pool.query(
    `SELECT attempt_id, event_id, round, attempt_in_round, started_at, finished_at,
            http_status, outcome, error_detail
     FROM delivery_attempts
     WHERE event_id = $1
     ORDER BY attempt_seq ASC`,
    [eventId],
  );

  const { rows: replays } = await pool.query(
    `SELECT replay_id, event_id, round, replayed_at
     FROM replay_events
     WHERE event_id = $1
     ORDER BY replay_id ASC`,
    [eventId],
  );

  return res.json({ ...event, attempts, replays });
});

/**
 * Contract API: POST /events/:event_id/replay
 * Loopback admin route: accepts ONLY DEAD events; keeps event_id and raw_body immutable;
 * opens a new replay round (up to 4 attempts) and logs the operation in replay_events.
 * Non-DEAD events return 409.
 */
app.post('/events/:event_id/replay', loopbackAdminOnly, async (req, res) => {
  const eventId = req.params.event_id;

  const outcome = await withTransaction(pool, async client => {
    const { rows: [event] } = await client.query(
      'SELECT event_id, status, replay_round FROM outbox WHERE event_id = $1 FOR UPDATE',
      [eventId],
    );
    if (!event) {
      return { notFound: true };
    }
    if (event.status !== 'DEAD') {
      return { conflict: true, status: event.status };
    }

    const nextRound = event.replay_round + 1;
    const { rows: [updated] } = await client.query(
      `UPDATE outbox
       SET status = 'PENDING',
           replay_round = $2,
           next_attempt_at = clock_timestamp(),
           dead_at = NULL,
           last_error = NULL
       WHERE event_id = $1
       RETURNING event_id, status, replay_round, next_attempt_at`,
      [eventId, nextRound],
    );

    await client.query(
      'INSERT INTO replay_events (event_id, round) VALUES ($1, $2)',
      [eventId, nextRound],
    );

    return { ok: true, outbox: updated };
  });

  if (outcome.notFound) {
    return res.status(404).json({ error: 'EVENT_NOT_FOUND', event_id: eventId });
  }
  if (outcome.conflict) {
    return res.status(409).json({
      error: 'EVENT_NOT_DEAD',
      event_id: eventId,
      status: outcome.status,
    });
  }

  return res.status(200).json(outcome.outbox);
});

// Lab-only dashboard inspection & sender fixture reset (disabled outside LAB_MODE=true).
app.get('/_lab/state', loopbackAdminOnly, async (_req, res) => {
  if (!config.labMode) return res.sendStatus(404);
  const [jobs, outbox, deliveryAttempts, replayEvents, relayHealth] = await Promise.all([
    pool.query('SELECT * FROM jobs ORDER BY job_id ASC'),
    pool.query('SELECT * FROM outbox ORDER BY event_id ASC'),
    pool.query('SELECT * FROM delivery_attempts ORDER BY attempt_seq ASC'),
    pool.query('SELECT * FROM replay_events ORDER BY replay_id ASC'),
    fetch(config.relayHealthUrl, { signal: AbortSignal.timeout(800) })
      .then(async r => (r.ok ? await r.json() : { status: 'degraded' }))
      .catch(() => ({ status: 'down' })),
  ]);
  return res.json({
    service: 'sender-api',
    pid: process.pid,
    captured_at: new Date().toISOString(),
    receiver_public_url: config.receiverPublicUrl,
    relay: relayHealth,
    sender_db: {
      jobs: jobs.rows,
      outbox: outbox.rows,
      delivery_attempts: deliveryAttempts.rows,
      replay_events: replayEvents.rows,
    },
  });
});

app.post('/_lab/reset', loopbackAdminOnly, async (_req, res) => {
  if (!config.labMode) return res.sendStatus(404);
  const fixtureSql = await readFile(new URL('../db/sender/002_fixtures.sql', import.meta.url), 'utf8');
  await pool.query(`
    TRUNCATE replay_events, delivery_attempts, outbox, jobs RESTART IDENTITY CASCADE;
    ALTER SEQUENCE attempt_id_seq RESTART WITH 1;
  `);
  await pool.query(fixtureSql);
  return res.json({ ok: true, database: 'sender_db', fixtures: ['J42', 'J43'] });
});

app.use((error, _req, res, _next) => {
  console.error('SENDER_API_ERROR', error.message);
  res.status(error.status || 500).json({
    error: error.status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR',
  });
});

const server = app.listen(config.senderPort, config.bindHost, () => {
  console.log(`SENDER_API_LISTENING http://${config.bindHost}:${config.senderPort} pid=${process.pid}`);
});

async function shutdown() {
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
