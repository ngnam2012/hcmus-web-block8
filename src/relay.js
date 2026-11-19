import http from 'node:http';
import {
  assertValidFixedTargetUrl,
  config,
  MAX_ATTEMPTS_PER_ROUND,
  requireWebhookSecret,
  sleep,
} from './config.js';
import { signWebhook } from './crypto.js';
import { createSenderPool, withTransaction } from './db.js';
import { maybePauseAtMarker } from './marker.js';
import { classifyDeliveryResponse, computeRetryDelayMs } from './protocol.js';

const secret = requireWebhookSecret(config);
const targetUrl = assertValidFixedTargetUrl(config.webhookTargetUrl);
const pool = createSenderPool();
let stopping = false;
let loopDone = Promise.resolve();

/**
 * Rule 2 recovery on relay restart:
 * Any delivery attempt still marked STARTED means the previous relay process died
 * before committing Transaction 2. Close it as UNKNOWN (counting as a used attempt)
 * and schedule next_attempt_at (or DEAD if the round is exhausted).
 */
async function recoverInFlightAttempts() {
  return withTransaction(pool, async client => {
    const { rows: stuckEvents } = await client.query(
      `SELECT DISTINCT event_id FROM delivery_attempts WHERE outcome = 'STARTED' ORDER BY event_id ASC`,
    );

    const recovered = [];
    for (const { event_id: eventId } of stuckEvents) {
      const { rows: [outbox] } = await client.query(
        'SELECT event_id, status, replay_round FROM outbox WHERE event_id = $1 FOR UPDATE',
        [eventId],
      );
      if (!outbox) continue;

      const { rows: closed } = await client.query(
        `UPDATE delivery_attempts
         SET outcome = 'UNKNOWN',
             finished_at = clock_timestamp(),
             error_detail = 'RELAY_RESTART_RECOVERY'
         WHERE event_id = $1 AND outcome = 'STARTED'
         RETURNING attempt_id, round, attempt_in_round, finished_at`,
        [eventId],
      );

      if (outbox.status === 'PENDING' && closed.length > 0) {
        const { rows: [{ cnt }] } = await client.query(
          'SELECT COUNT(*)::int AS cnt FROM delivery_attempts WHERE event_id = $1 AND round = $2',
          [eventId, outbox.replay_round],
        );
        const latestFinished = closed[closed.length - 1].finished_at;
        const delayMs = computeRetryDelayMs({ attemptInRound: cnt });

        if (delayMs === null) {
          await client.query(
            `UPDATE outbox
             SET status = 'DEAD', next_attempt_at = NULL, dead_at = $2, last_error = 'EXHAUSTED_AFTER_UNKNOWN'
             WHERE event_id = $1`,
            [eventId, latestFinished],
          );
        } else {
          await client.query(
            `UPDATE outbox
             SET next_attempt_at = $2::timestamptz + ($3::double precision * interval '1 millisecond'),
                 last_error = 'UNKNOWN_RECOVERY'
             WHERE event_id = $1`,
            [eventId, latestFinished, delayMs],
          );
        }
      }

      recovered.push({ event_id: eventId, attempts: closed.map(r => r.attempt_id) });
    }
    return recovered;
  });
}

/**
 * Three-segment delivery (Rule 2):
 *   Segment 1 (Transaction 1): Commit delivery_attempt STARTED before HTTP.
 *   Segment 2 (No transaction): HTTP POST with fresh timestamp + HMAC on immutable raw_body,
 *                               2s timeout, redirect: 'manual' (no redirect following).
 *   Segment 3 (Transaction 2): Commit attempt outcome + outbox status & durable next_attempt_at.
 */
async function deliverNextDueEvent() {
  // === SEGMENT 1: Transaction 1 (commit STARTED) ===
  const claim = await withTransaction(pool, async client => {
    const { rows: [outbox] } = await client.query(
      `SELECT event_id, raw_body, replay_round, next_attempt_at
       FROM outbox
       WHERE status = 'PENDING' AND next_attempt_at <= clock_timestamp()
       ORDER BY next_attempt_at ASC, created_at ASC
       FOR UPDATE
       LIMIT 1`,
    );
    if (!outbox) return null;

    const { rows: [{ cnt }] } = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM delivery_attempts WHERE event_id = $1 AND round = $2',
      [outbox.event_id, outbox.replay_round],
    );
    if (cnt >= MAX_ATTEMPTS_PER_ROUND) {
      await client.query(
        `UPDATE outbox
         SET status = 'DEAD', next_attempt_at = NULL, dead_at = clock_timestamp(), last_error = 'MAX_ATTEMPTS_REACHED'
         WHERE event_id = $1`,
        [outbox.event_id],
      );
      return null;
    }

    const attemptInRound = cnt + 1;
    const { rows: [{ seq }] } = await client.query(`SELECT nextval('attempt_id_seq') AS seq`);
    const attemptId = `A${seq}`;

    const { rows: [attempt] } = await client.query(
      `INSERT INTO delivery_attempts (attempt_id, event_id, round, attempt_in_round, started_at, outcome)
       VALUES ($1, $2, $3, $4, clock_timestamp(), 'STARTED')
       RETURNING attempt_id, event_id, round, attempt_in_round, started_at`,
      [attemptId, outbox.event_id, outbox.replay_round, attemptInRound],
    );

    return { outbox, attempt };
  });

  if (!claim) return false;

  const { outbox, attempt } = claim;

  // === SEGMENT 2: HTTP POST outside any DB transaction ===
  const rawBodyBuf = Buffer.from(outbox.raw_body, 'utf8');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhook({ secret, timestamp, rawBody: rawBodyBuf });

  let httpStatus = null;
  let outcome = 'RETRYABLE';
  let retryAfterMs = null;
  let errorDetail = null;

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(config.webhookTimeoutMs),
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': String(timestamp),
        'x-webhook-signature': signature,
        'x-delivery-attempt': attempt.attempt_id,
      },
      body: rawBodyBuf,
    });
    // Drain body so connection can be cleanly released.
    await response.text().catch(() => {});

    httpStatus = response.status;
    const classified = classifyDeliveryResponse({
      status: response.status,
      retryAfterHeader: response.headers.get('retry-after'),
    });
    outcome = classified.outcome;
    retryAfterMs = classified.retryAfterMs;
    if (outcome !== 'ACKNOWLEDGED') {
      errorDetail = `HTTP_${response.status}`;
    }

    // Marker F3: after receiving 2xx, BEFORE committing DELIVERED in Transaction 2.
    if (outcome === 'ACKNOWLEDGED') {
      await maybePauseAtMarker('after_http_2xx_before_delivery_commit', {
        event_id: outbox.event_id,
        attempt_id: attempt.attempt_id,
        http_status: response.status,
      });
    }
  } catch (error) {
    outcome = 'RETRYABLE';
    httpStatus = null;
    if (error?.name === 'TimeoutError') {
      errorDetail = 'TIMEOUT';
    } else {
      errorDetail = error?.cause?.code || error?.code || error?.message || 'CONNECTION_ERROR';
    }
  }

  // === SEGMENT 3: Transaction 2 (commit attempt outcome + outbox status atomically) ===
  await withTransaction(pool, async client => {
    const { rows: [{ finished_at: finishedAt }] } = await client.query(
      `UPDATE delivery_attempts
       SET finished_at = clock_timestamp(),
           http_status = $2,
           outcome = $3,
           error_detail = $4
       WHERE attempt_id = $1
       RETURNING finished_at`,
      [attempt.attempt_id, httpStatus, outcome, errorDetail],
    );

    if (outcome === 'ACKNOWLEDGED') {
      await client.query(
        `UPDATE outbox
         SET status = 'DELIVERED', next_attempt_at = NULL, delivered_at = $2, last_error = NULL
         WHERE event_id = $1`,
        [outbox.event_id, finishedAt],
      );
      return;
    }

    if (outcome === 'REJECTED') {
      await client.query(
        `UPDATE outbox
         SET status = 'DEAD', next_attempt_at = NULL, dead_at = $2, last_error = $3
         WHERE event_id = $1`,
        [outbox.event_id, finishedAt, errorDetail],
      );
      return;
    }

    // RETRYABLE: compute durable next_attempt_at or mark DEAD if round attempts exhausted.
    const delayMs = computeRetryDelayMs({
      attemptInRound: attempt.attempt_in_round,
      retryAfterMs,
    });
    if (delayMs === null) {
      await client.query(
        `UPDATE outbox
         SET status = 'DEAD', next_attempt_at = NULL, dead_at = $2, last_error = $3
         WHERE event_id = $1`,
        [outbox.event_id, finishedAt, errorDetail || 'EXHAUSTED'],
      );
    } else {
      await client.query(
        `UPDATE outbox
         SET status = 'PENDING',
             next_attempt_at = $2::timestamptz + ($3::double precision * interval '1 millisecond'),
             last_error = $4
         WHERE event_id = $1`,
        [outbox.event_id, finishedAt, delayMs, errorDetail],
      );
    }
  });

  console.log(
    `RELAY_ATTEMPT event=${outbox.event_id} attempt=${attempt.attempt_id} round=${attempt.round} n=${attempt.attempt_in_round} status=${httpStatus ?? 'ERR'} outcome=${outcome}`,
  );
  return true;
}

const healthServer = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    try {
      await pool.query('SELECT 1');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'relay', pid: process.pid, database: true }));
    } catch (error) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'degraded', service: 'relay', error: error.message }));
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

async function main() {
  const recovered = await recoverInFlightAttempts();
  if (recovered.length > 0) {
    console.log(`RELAY_RECOVERED ${JSON.stringify(recovered)}`);
  }

  await new Promise(resolve => {
    healthServer.listen(config.relayHealthPort, config.bindHost, resolve);
  });
  console.log(
    `RELAY_STARTED target=${targetUrl} health=http://${config.bindHost}:${config.relayHealthPort}/health pid=${process.pid}`,
  );

  loopDone = (async () => {
    while (!stopping) {
      try {
        const processed = await deliverNextDueEvent();
        if (!processed) {
          await sleep(config.relayPollIntervalMs);
        }
      } catch (error) {
        if (stopping) break;
        console.error('RELAY_LOOP_ERROR', error.message);
        await sleep(Math.max(250, config.relayPollIntervalMs));
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
  console.error('RELAY_FATAL', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
