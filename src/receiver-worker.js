import http from 'node:http';
import { config, sleep } from './config.js';
import { createReceiverPool, withTransaction } from './db.js';
import { maybePauseAtMarker } from './marker.js';

const pool = createReceiverPool();
let stopping = false;
let loopDone = Promise.resolve();

/**
 * Rule 6 local transaction on receiver_db:
 *   1. Lock one RECEIVED inbox row (FOR UPDATE SKIP LOCKED)
 *   2. Conditionally UPSERT video_summaries ONLY when EXCLUDED.version > video_summaries.version
 *      (applied_count increments ONLY when the current summary is actually inserted or replaced)
 *   3. Mark inbox row PROCESSED in the SAME transaction
 *   4. COMMIT atomically — no external HTTP calls inside this transaction
 */
async function processNextInboxEvent() {
  return withTransaction(pool, async client => {
    const { rows: [inboxRow] } = await client.query(
      `SELECT source, event_id, payload
       FROM inbox
       WHERE status = 'RECEIVED'
       ORDER BY received_at ASC, event_id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (!inboxRow) return false;

    const { video_id: videoId, version, summary } = inboxRow.payload.data;

    const upsertResult = await client.query(
      `INSERT INTO video_summaries (video_id, version, summary, applied_count, source_event_id, updated_at)
       VALUES ($1, $2, $3, 1, $4, clock_timestamp())
       ON CONFLICT (video_id) DO UPDATE
         SET version = EXCLUDED.version,
             summary = EXCLUDED.summary,
             applied_count = video_summaries.applied_count + 1,
             source_event_id = EXCLUDED.source_event_id,
             updated_at = clock_timestamp()
         WHERE EXCLUDED.version > video_summaries.version
       RETURNING video_id, version, applied_count`,
      [videoId, version, summary, inboxRow.event_id],
    );

    const applied = upsertResult.rows.length > 0;

    // Marker F7: after writing video_summaries, BEFORE marking PROCESSED & COMMIT.
    // SIGKILL here causes PostgreSQL to roll back both; inbox stays RECEIVED.
    await maybePauseAtMarker('after_projection_write_before_commit', {
      event_id: inboxRow.event_id,
      video_id: videoId,
      version,
      applied,
    });

    await client.query(
      `UPDATE inbox
       SET status = 'PROCESSED', processed_at = clock_timestamp()
       WHERE source = $1 AND event_id = $2`,
      [inboxRow.source, inboxRow.event_id],
    );

    console.log(
      `WORKER_PROCESSED event=${inboxRow.event_id} video=${videoId} version=${version} applied=${applied}`,
    );
    return true;
  });
}

const healthServer = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    try {
      await pool.query('SELECT 1');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'receiver-worker', pid: process.pid, database: true }));
    } catch (error) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'degraded', service: 'receiver-worker', error: error.message }));
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

async function main() {
  await new Promise(resolve => {
    healthServer.listen(config.workerHealthPort, config.bindHost, resolve);
  });
  console.log(
    `RECEIVER_WORKER_STARTED health=http://${config.bindHost}:${config.workerHealthPort}/health pid=${process.pid}`,
  );

  loopDone = (async () => {
    while (!stopping) {
      try {
        const worked = await processNextInboxEvent();
        if (!worked) {
          await sleep(config.workerPollIntervalMs);
        }
      } catch (error) {
        if (stopping) break;
        console.error('WORKER_LOOP_ERROR', error.message);
        await sleep(Math.max(250, config.workerPollIntervalMs));
      }
    }
  })();
  await loopDone;
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  healthServer.close();
  await Promise.race([loopDone.catch(() => {}), sleep(3000)]);
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch(async error => {
  console.error('WORKER_FATAL', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
