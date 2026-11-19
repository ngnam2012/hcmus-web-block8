import express from 'express';
import { config, requireLoopbackAdmin, requireWebhookSecret, sleep } from './config.js';
import { sha256Hex, signWebhook, verifyWebhookSignature } from './crypto.js';
import { createReceiverPool, withTransaction } from './db.js';
import { emitMarkerLine, maybePauseAtMarker } from './marker.js';
import { parseAndValidateEvent } from './protocol.js';

const secret = requireWebhookSecret(config);
const source = config.webhookSource;
const pool = createReceiverPool();
const app = express();
const loopbackAdminOnly = requireLoopbackAdmin(config);

// Allow loopback dashboard (e.g., http://127.0.0.1:4000) to inspect receiver state directly in LAB_MODE.
const LOOPBACK_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;
app.use((req, res, next) => {
  if (config.labMode) {
    const origin = req.get('origin');
    if (origin && LOOPBACK_ORIGIN_RE.test(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
  }
  return next();
});

// In-memory lab fault config (enabled ONLY when LAB_MODE=true on loopback).
const labFault = {
  fail_status: null,
  fail_remaining: null,
  retry_after: null,
  redirect_to: null,
  delay_after_commit_ms: 0,
  delay_after_commit_once: false,
  drop_after_commit_once: false,
};

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'receiver-api', pid: process.pid, database: true });
  } catch (error) {
    res.status(503).json({ status: 'degraded', service: 'receiver-api', error: error.message });
  }
});

/**
 * Contract API: POST /webhooks/summaries
 * Strict order (Rules 4 & 5):
 *   1. Capture raw body bytes BEFORE any JSON parsing
 *   2. Verify timestamp window (±300s, both past & future) and HMAC-SHA256 constant-time -> 401 on fail
 *   3. Parse JSON and validate schema -> 400 on fail
 *   4. (Lab fault for F8: return 503 BEFORE inserting inbox)
 *   5. INSERT inbox with UNIQUE(source, event_id), COMMIT BEFORE returning 202
 *      - Identical duplicate raw_body -> 202 (no new row)
 *      - Same (source, event_id) with different raw_body -> 409 (no overwrite)
 */
app.post('/webhooks/summaries', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
  const rawBodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // Step 1 & 2: Timestamp window and HMAC signature on exact raw body bytes.
  const sigCheck = verifyWebhookSignature({
    secret,
    timestampHeader: req.get('x-webhook-timestamp'),
    signatureHeader: req.get('x-webhook-signature'),
    rawBody: rawBodyBuf,
    windowSec: config.timestampWindowSec,
  });
  if (!sigCheck.ok) {
    return res.status(401).json({ error: sigCheck.reason });
  }

  // Step 3: Parse JSON and validate event schema.
  const parsed = parseAndValidateEvent(rawBodyBuf);
  if (!parsed.ok) {
    return res.status(400).json({ error: 'INVALID_SCHEMA', detail: parsed.detail });
  }
  const event = parsed.payload;

  // Step 4: Lab fault injection before inbox write (used by F8 for 503, 429, 301).
  if (config.labMode && labFault.fail_status !== null) {
    const status = labFault.fail_status;
    if (labFault.retry_after !== null) {
      res.set('Retry-After', String(labFault.retry_after));
    }
    if (labFault.redirect_to !== null) {
      res.set('Location', String(labFault.redirect_to));
    }
    if (labFault.fail_remaining !== null) {
      labFault.fail_remaining -= 1;
      if (labFault.fail_remaining <= 0) {
        labFault.fail_status = null;
        labFault.fail_remaining = null;
        labFault.retry_after = null;
        labFault.redirect_to = null;
      }
    }
    return res.status(status).json({ error: 'INJECTED_FAULT', status });
  }

  // Step 5: Durable inbox commit BEFORE returning 202.
  const rawBodyText = rawBodyBuf.toString('utf8');
  const payloadHash = sha256Hex(rawBodyBuf);
  const deliveryAttempt = req.get('x-delivery-attempt') || null;

  const inboxResult = await withTransaction(pool, async client => {
    const { rows: [inserted] } = await client.query(
      `INSERT INTO inbox (source, event_id, event_type, schema_version, raw_body, payload_hash, payload, status, last_delivery_attempt)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'RECEIVED', $8)
       ON CONFLICT (source, event_id) DO NOTHING
       RETURNING event_id, status, received_at`,
      [source, event.event_id, event.type, event.schema_version, rawBodyText, payloadHash, rawBodyText, deliveryAttempt],
    );

    if (inserted) {
      return { kind: 'inserted', status: inserted.status, received_at: inserted.received_at };
    }

    // Conflict on UNIQUE(source, event_id): compare exact raw body bytes.
    const { rows: [existing] } = await client.query(
      'SELECT raw_body, payload_hash, status, received_at FROM inbox WHERE source = $1 AND event_id = $2',
      [source, event.event_id],
    );
    if (existing && existing.payload_hash === payloadHash && existing.raw_body === rawBodyText) {
      return { kind: 'duplicate', status: existing.status, received_at: existing.received_at };
    }
    return { kind: 'conflict' };
  });

  if (inboxResult.kind === 'conflict') {
    return res.status(409).json({ error: 'PAYLOAD_CONFLICT', event_id: event.event_id });
  }

  // Marker F4 / slow response AFTER inbox COMMIT, BEFORE HTTP 202 response.
  if (config.labMode) {
    if (labFault.drop_after_commit_once) {
      labFault.drop_after_commit_once = false;
      emitMarkerLine('after_inbox_commit_before_response', {
        event_id: event.event_id,
        mode: 'close_socket_once',
      });
      req.socket.destroy();
      return;
    }
    if (labFault.delay_after_commit_ms > 0) {
      const waitMs = labFault.delay_after_commit_ms;
      if (labFault.delay_after_commit_once) {
        labFault.delay_after_commit_ms = 0;
        labFault.delay_after_commit_once = false;
      }
      await sleep(waitMs);
    }
    await maybePauseAtMarker('after_inbox_commit_before_response', {
      event_id: event.event_id,
    });
  }

  return res.status(202).json({
    status: 'ACCEPTED',
    event_id: event.event_id,
    inbox_status: inboxResult.status,
    duplicate: inboxResult.kind === 'duplicate',
  });
});

/**
 * Contract API: GET /inbox/:event_id
 */
app.get('/inbox/:event_id', async (req, res) => {
  const { rows: [row] } = await pool.query(
    `SELECT source, event_id, event_type, schema_version, status, received_at, processed_at,
            last_delivery_attempt, payload
     FROM inbox
     WHERE source = $1 AND event_id = $2`,
    [source, req.params.event_id],
  );
  if (!row) {
    return res.status(404).json({ error: 'INBOX_EVENT_NOT_FOUND', event_id: req.params.event_id });
  }
  return res.json(row);
});

/**
 * Contract API: GET /videos/:video_id/summary
 * Returns 404 when no summary has been processed yet.
 */
app.get('/videos/:video_id/summary', async (req, res) => {
  const { rows: [summary] } = await pool.query(
    `SELECT video_id, version, summary, applied_count, source_event_id, updated_at
     FROM video_summaries
     WHERE video_id = $1`,
    [req.params.video_id],
  );
  if (!summary) {
    return res.status(404).json({ error: 'SUMMARY_NOT_FOUND', video_id: req.params.video_id });
  }
  return res.json(summary);
});

// Lab-only fault control routes (loopback only, disabled outside LAB_MODE=true).
app.use('/_lab', loopbackAdminOnly);

app.get('/_lab/fault', (_req, res) => {
  if (!config.labMode) return res.sendStatus(404);
  return res.json(labFault);
});

app.put('/_lab/fault', express.json({ limit: '16kb' }), (req, res) => {
  if (!config.labMode) return res.sendStatus(404);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  labFault.fail_status = Number.isInteger(body.fail_status) ? body.fail_status : null;
  labFault.fail_remaining = Number.isInteger(body.fail_remaining) && body.fail_remaining > 0 ? body.fail_remaining : null;
  labFault.retry_after = body.retry_after !== undefined && body.retry_after !== null ? String(body.retry_after) : null;
  labFault.redirect_to = typeof body.redirect_to === 'string' && body.redirect_to.trim() ? body.redirect_to.trim() : null;
  labFault.delay_after_commit_ms =
    Number.isInteger(body.delay_after_commit_ms) && body.delay_after_commit_ms > 0 ? body.delay_after_commit_ms : 0;
  labFault.delay_after_commit_once = body.delay_after_commit_once === true;
  labFault.drop_after_commit_once = body.drop_after_commit_once === true;
  return res.json({ ok: true, fault: labFault });
});

app.get('/_lab/state', async (_req, res) => {
  if (!config.labMode) return res.sendStatus(404);
  const [inbox, videoSummaries, workerHealth] = await Promise.all([
    pool.query('SELECT * FROM inbox ORDER BY received_at ASC, event_id ASC'),
    pool.query('SELECT * FROM video_summaries ORDER BY video_id ASC'),
    fetch(config.workerHealthUrl, { signal: AbortSignal.timeout(800) })
      .then(async r => (r.ok ? await r.json() : { status: 'degraded' }))
      .catch(() => ({ status: 'down' })),
  ]);
  return res.json({
    service: 'receiver-api',
    pid: process.pid,
    captured_at: new Date().toISOString(),
    source,
    worker: workerHealth,
    fault: labFault,
    receiver_db: {
      inbox: inbox.rows,
      video_summaries: videoSummaries.rows,
    },
  });
});

app.post('/_lab/reset', async (_req, res) => {
  if (!config.labMode) return res.sendStatus(404);
  labFault.fail_status = null;
  labFault.fail_remaining = null;
  labFault.retry_after = null;
  labFault.redirect_to = null;
  labFault.delay_after_commit_ms = 0;
  labFault.delay_after_commit_once = false;
  labFault.drop_after_commit_once = false;
  await pool.query('TRUNCATE inbox, video_summaries RESTART IDENTITY CASCADE');
  return res.json({ ok: true, database: 'receiver_db' });
});

// Lab-only simulator for F5 (auth/schema) and F6 (5 concurrent duplicates + 409 conflict)
// Sends real HTTP requests over loopback to /webhooks/summaries without exposing WEBHOOK_SECRET to browser JS.
app.post('/_lab/simulate/:scenario', async (req, res) => {
  if (!config.labMode) return res.sendStatus(404);
  const scenario = String(req.params.scenario || '').toUpperCase();
  const selfUrl = `http://127.0.0.1:${config.receiverPort}/webhooks/summaries`;
  const nowSec = Math.floor(Date.now() / 1000);

  async function postWebhook(rawBody, { ts = nowSec, sig = null, attempt = 'UI-SIM' } = {}) {
    const signature = sig ?? signWebhook({ secret, timestamp: ts, rawBody });
    const response = await fetch(selfUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': String(ts),
        'x-webhook-signature': signature,
        'x-delivery-attempt': attempt,
      },
      body: rawBody,
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  const basePayload = {
    event_id: 'E42',
    type: 'summary.completed',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    data: {
      job_id: 'J42',
      video_id: 'V7',
      version: 1,
      summary: 'Nội dung tóm tắt giả định của video V7 (version 1, job J42).',
    },
  };

  if (scenario === 'F5') {
    const originalRaw = JSON.stringify(basePayload);
    const tamperedRaw = originalRaw.replace('version 1', 'TAMPERED!');
    const originalSig = signWebhook({ secret, timestamp: nowSec, rawBody: originalRaw });
    const badSchemaRaw = JSON.stringify({ ...basePayload, data: { ...basePayload.data, version: 0 } });

    const results = {
      tampered_body: await postWebhook(tamperedRaw, { ts: nowSec, sig: originalSig, attempt: 'F5-tampered' }),
      wrong_signature: await postWebhook(originalRaw, { ts: nowSec, sig: '0'.repeat(64), attempt: 'F5-wrong-sig' }),
      timestamp_too_old: await postWebhook(originalRaw, { ts: nowSec - 301, attempt: 'F5-old-ts' }),
      timestamp_too_future: await postWebhook(originalRaw, { ts: nowSec + 301, attempt: 'F5-future-ts' }),
      invalid_schema: await postWebhook(badSchemaRaw, { ts: nowSec, attempt: 'F5-bad-schema' }),
    };
    return res.json({ scenario: 'F5', results });
  }

  if (scenario === 'F6') {
    const rawOriginal = JSON.stringify(basePayload);
    const concurrent = await Promise.all(
      [1, 2, 3, 4, 5].map(i => postWebhook(rawOriginal, { ts: nowSec, attempt: `F6-dup-${i}` })),
    );
    const conflictRaw = JSON.stringify({
      ...basePayload,
      data: { ...basePayload.data, summary: 'Payload khác cùng event_id E42 -> phải bị chặn 409!' },
    });
    const conflict = await postWebhook(conflictRaw, { ts: nowSec, attempt: 'F6-conflict' });
    return res.json({
      scenario: 'F6',
      concurrent_statuses: concurrent.map(r => r.status),
      concurrent,
      conflict,
    });
  }

  return res.status(400).json({ error: 'UNSUPPORTED_SCENARIO', supported: ['F5', 'F6'] });
});

app.use((error, _req, res, _next) => {
  console.error('RECEIVER_API_ERROR', error.message);
  res.status(error.status || 500).json({
    error: error.status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
  });
});

const server = app.listen(config.receiverPort, config.bindHost, () => {
  console.log(`RECEIVER_API_LISTENING http://${config.bindHost}:${config.receiverPort} pid=${process.pid}`);
});

async function shutdown() {
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
