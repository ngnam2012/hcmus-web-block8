import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BACKOFF_MS, config, sleep } from '../src/config.js';
import { signWebhook } from '../src/crypto.js';
import { createReceiverPool, createSenderPool } from '../src/db.js';
import { applyMigrations, resetFixtures } from './migrate.js';
import { captureSnapshot, saveEvidence } from './snapshot.js';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const RUN_SECRET = config.webhookSecret || randomBytes(32).toString('hex');
const SENDER_PORT = config.senderPort;
const RECEIVER_PORT = config.receiverPort;
const RELAY_HEALTH_PORT = config.relayHealthPort;
const WORKER_HEALTH_PORT = config.workerHealthPort;

const SENDER_BASE = `http://127.0.0.1:${SENDER_PORT}`;
const RECEIVER_BASE = `http://127.0.0.1:${RECEIVER_PORT}`;

const SERVICE_DEFS = {
  'sender-api': {
    script: 'src/sender-api.js',
    healthUrl: `${SENDER_BASE}/health`,
    env: () => ({
      BIND_HOST: '127.0.0.1',
      SENDER_PORT: String(SENDER_PORT),
      SENDER_DATABASE_URL: config.senderDatabaseUrl,
      LAB_MODE: 'true',
    }),
  },
  relay: {
    script: 'src/relay.js',
    healthUrl: `http://127.0.0.1:${RELAY_HEALTH_PORT}/health`,
    env: () => ({
      BIND_HOST: '127.0.0.1',
      RELAY_HEALTH_PORT: String(RELAY_HEALTH_PORT),
      SENDER_DATABASE_URL: config.senderDatabaseUrl,
      WEBHOOK_TARGET_URL: `${RECEIVER_BASE}/webhooks/summaries`,
      WEBHOOK_SECRET: RUN_SECRET,
      WEBHOOK_TIMEOUT_MS: String(config.webhookTimeoutMs),
      RELAY_POLL_INTERVAL_MS: '50',
      LAB_MODE: 'true',
    }),
  },
  'receiver-api': {
    script: 'src/receiver-api.js',
    healthUrl: `${RECEIVER_BASE}/health`,
    env: () => ({
      BIND_HOST: '127.0.0.1',
      RECEIVER_PORT: String(RECEIVER_PORT),
      RECEIVER_DATABASE_URL: config.receiverDatabaseUrl,
      WEBHOOK_SECRET: RUN_SECRET,
      WEBHOOK_SOURCE: config.webhookSource,
      WEBHOOK_TIMESTAMP_WINDOW_SEC: String(config.timestampWindowSec),
      LAB_MODE: 'true',
    }),
  },
  'receiver-worker': {
    script: 'src/receiver-worker.js',
    healthUrl: `http://127.0.0.1:${WORKER_HEALTH_PORT}/health`,
    env: () => ({
      BIND_HOST: '127.0.0.1',
      WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
      RECEIVER_DATABASE_URL: config.receiverDatabaseUrl,
      WORKER_POLL_INTERVAL_MS: '50',
      LAB_MODE: 'true',
    }),
  },
};

function stopConflictingComposeAppServices() {
  try {
    execFileSync(
      'docker',
      ['compose', 'stop', '-t', '1', 'sender-api', 'relay', 'receiver-api', 'receiver-worker'],
      { cwd: rootDir, stdio: 'ignore', timeout: 15000 },
    );
  } catch {
    // Compose may not be running app services; postgres-only mode is fine.
  }
}

async function until(fn, description, timeoutMs = 30000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function httpJson(url, { method = 'GET', body, headers = {}, timeoutMs = 15000 } = {}) {
  const reqHeaders = { ...headers };
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      payload = body;
      if (!reqHeaders['content-type']) reqHeaders['content-type'] = 'application/json';
    } else {
      payload = JSON.stringify(body);
      if (!reqHeaders['content-type']) reqHeaders['content-type'] = 'application/json';
    }
  }
  const response = await fetch(url, {
    method,
    headers: reqHeaders,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

class ProcessManager {
  constructor() {
    this.procs = new Map();
    this.log = [];
  }

  async start(name, { marker = null } = {}) {
    if (this.procs.has(name)) {
      await this.stop(name);
    }
    const def = SERVICE_DEFS[name];
    const env = {
      ...process.env,
      ...def.env(),
      MARKER: marker || '',
    };
    const child = spawn(process.execPath, [def.script], {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const record = {
      name,
      child,
      pid: child.pid,
      marker,
      lines: [],
      stderr: [],
      exited: false,
      exitCode: null,
      exitSignal: null,
      markerWaiters: [],
    };

    const handleStdoutChunk = chunk => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        record.lines.push(line);
        for (let i = record.markerWaiters.length - 1; i >= 0; i -= 1) {
          const waiter = record.markerWaiters[i];
          if (line.startsWith(`MARKER ${waiter.markerName} `)) {
            record.markerWaiters.splice(i, 1);
            waiter.resolve(line);
          }
        }
      }
    };

    child.stdout.on('data', handleStdoutChunk);
    child.stderr.on('data', chunk => {
      record.stderr.push(chunk.toString('utf8'));
    });

    record.exitPromise = new Promise(resolve => {
      child.once('exit', (code, signal) => {
        record.exited = true;
        record.exitCode = code;
        record.exitSignal = signal;
        for (const waiter of record.markerWaiters) {
          waiter.reject(new Error(`${name} exited before marker ${waiter.markerName} (code=${code}, signal=${signal})`));
        }
        record.markerWaiters.length = 0;
        resolve({ code, signal });
      });
    });

    this.procs.set(name, record);

    try {
      await until(async () => {
        if (record.exited) {
          throw new Error(
            `${name} exited early (code=${record.exitCode}, signal=${record.exitSignal}): ${record.stderr.join('')}`,
          );
        }
        const res = await fetch(def.healthUrl, { signal: AbortSignal.timeout(800) });
        return res.ok;
      }, `${name} /health`, 15000);
    } catch (error) {
      await this.stop(name);
      throw error;
    }

    this.log.push({
      at: new Date().toISOString(),
      action: 'start',
      service: name,
      pid: record.pid,
      marker: marker || null,
    });
    return record;
  }

  waitForMarker(name, markerName, timeoutMs = 15000) {
    const record = this.procs.get(name);
    if (!record) throw new Error(`Service ${name} is not running`);
    const existing = record.lines.find(line => line.startsWith(`MARKER ${markerName} `));
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = record.markerWaiters.indexOf(waiter);
        if (idx >= 0) record.markerWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for MARKER ${markerName} on ${name}`));
      }, timeoutMs);

      const waiter = {
        markerName,
        resolve: line => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      };
      record.markerWaiters.push(waiter);
    });
  }

  async killSigkill(name, reason) {
    const record = this.procs.get(name);
    if (!record) throw new Error(`Service ${name} is not running`);
    const killedAt = new Date().toISOString();
    record.child.kill('SIGKILL');
    const { code, signal } = await record.exitPromise;
    this.procs.delete(name);
    const entry = {
      at: killedAt,
      action: 'kill -9 (SIGKILL)',
      service: name,
      pid: record.pid,
      reason,
      exit_code: code,
      exit_signal: signal || 'SIGKILL',
    };
    this.log.push(entry);
    return entry;
  }

  async stop(name) {
    const record = this.procs.get(name);
    if (!record) return;
    if (!record.exited) {
      record.child.kill('SIGTERM');
      const done = await Promise.race([
        record.exitPromise.then(() => true),
        sleep(2500).then(() => false),
      ]);
      if (!done && !record.exited) {
        record.child.kill('SIGKILL');
        await record.exitPromise;
      }
    }
    this.procs.delete(name);
    this.log.push({
      at: new Date().toISOString(),
      action: 'stop',
      service: name,
      pid: record.pid,
    });
  }

  async stopAll() {
    for (const name of [...this.procs.keys()]) {
      await this.stop(name);
    }
  }
}

async function waitForEventStatus(eventId, expectedStatus, timeoutMs = 25000) {
  return until(async () => {
    const res = await httpJson(`${SENDER_BASE}/events/${eventId}`);
    return res.status === 200 && res.body.status === expectedStatus ? res.body : false;
  }, `event ${eventId} => ${expectedStatus}`, timeoutMs);
}

async function waitForInboxStatus(eventId, expectedStatus, timeoutMs = 20000) {
  return until(async () => {
    const res = await httpJson(`${RECEIVER_BASE}/inbox/${eventId}`);
    return res.status === 200 && res.body.status === expectedStatus ? res.body : false;
  }, `inbox ${eventId} => ${expectedStatus}`, timeoutMs);
}

function buildSignedWebhookRequest(payloadObj, { secret = RUN_SECRET, timestamp = Math.floor(Date.now() / 1000), attemptId = 'MANUAL-1', rawOverride = null, sigOverride = null } = {}) {
  const rawBody = rawOverride ?? JSON.stringify(payloadObj);
  const signature = sigOverride ?? signWebhook({ secret, timestamp, rawBody });
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': String(timestamp),
      'x-webhook-signature': signature,
      'x-delivery-attempt': attemptId,
    },
  };
}

const SCENARIOS = [
  {
    id: 'H0',
    kind: 'Tự động',
    title: 'Hoàn tất J42, không fault',
    expected: 'J42 DONE, 1 outbox E42 DELIVERED, 1 attempt ACKNOWLEDGED (202), 1 inbox E42 PROCESSED, V7 version 1, applied_count = 1.',
    async run(ctx) {
      await ctx.pm.start('receiver-api');
      await ctx.pm.start('receiver-worker');
      await ctx.pm.start('sender-api');
      await ctx.pm.start('relay');

      const complete = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
      assert.equal(complete.status, 200);
      assert.equal(complete.body.job_id, 'J42');
      assert.equal(complete.body.event_id, 'E42');
      assert.equal(complete.body.status, 'DONE');

      const event = await waitForEventStatus('E42', 'DELIVERED');
      const inbox = await waitForInboxStatus('E42', 'PROCESSED');
      const summary = await httpJson(`${RECEIVER_BASE}/videos/V7/summary`);
      assert.equal(summary.status, 200);
      assert.equal(summary.body.version, 1);
      assert.equal(summary.body.applied_count, 1);

      const snap = await ctx.snap('H0');
      assert.equal(snap.sender_db.jobs.find(j => j.job_id === 'J42').status, 'DONE');
      assert.equal(snap.sender_db.outbox.length, 1);
      assert.equal(snap.sender_db.outbox[0].status, 'DELIVERED');
      assert.equal(snap.sender_db.delivery_attempts.length, 1);
      assert.equal(snap.sender_db.delivery_attempts[0].outcome, 'ACKNOWLEDGED');
      assert.equal(snap.sender_db.delivery_attempts[0].http_status, 202);
      assert.equal(snap.receiver_db.inbox.length, 1);
      assert.equal(snap.receiver_db.inbox[0].status, 'PROCESSED');
      assert.equal(snap.receiver_db.video_summaries.length, 1);
      assert.equal(snap.receiver_db.video_summaries[0].applied_count, 1);

      return {
        client_complete: complete,
        event_status: event.status,
        inbox_status: inbox.status,
        summary: summary.body,
        snapshots: ['H0.json'],
      };
    },
  },
  {
    id: 'F1',
    kind: 'Kill thật',
    title: 'Kill sender trước khi INSERT outbox',
    expected: 'Kill sender tại after_job_update_before_outbox => rollback: J42 vẫn READY, 0 outbox. Restart và gọi complete lại => đạt H0.',
    async run(ctx) {
      await ctx.pm.start('receiver-api');
      await ctx.pm.start('receiver-worker');
      await ctx.pm.start('relay');
      await ctx.pm.start('sender-api', { marker: 'after_job_update_before_outbox' });

      const markerPromise = ctx.pm.waitForMarker('sender-api', 'after_job_update_before_outbox');
      const firstReqPromise = httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST', timeoutMs: 8000 })
        .then(res => ({ ok: true, res }))
        .catch(err => ({ ok: false, error: err.message }));

      const markerLine = await markerPromise;
      const killInfo = await ctx.pm.killSigkill('sender-api', 'after_job_update_before_outbox');
      const firstReq = await firstReqPromise;
      assert.equal(firstReq.ok, false, 'Client should not receive response after SIGKILL');

      // Wait for PostgreSQL to complete rollback of uncommitted transaction.
      await until(async () => {
        const { rows: [job] } = await ctx.senderPool.query("SELECT status FROM jobs WHERE job_id = 'J42'");
        return job?.status === 'READY';
      }, 'PostgreSQL rollback J42 => READY');

      const afterKill = await ctx.snap('F1-after-kill');
      assert.equal(afterKill.sender_db.jobs.find(j => j.job_id === 'J42').status, 'READY');
      assert.equal(afterKill.sender_db.outbox.length, 0);
      assert.equal(afterKill.sender_db.delivery_attempts.length, 0);
      assert.equal(afterKill.receiver_db.inbox.length, 0);
      assert.equal(afterKill.receiver_db.video_summaries.length, 0);

      await ctx.pm.start('sender-api');
      const retryComplete = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
      assert.equal(retryComplete.status, 200);
      assert.equal(retryComplete.body.event_id, 'E42');
      assert.equal(retryComplete.body.already_completed, false);

      await waitForEventStatus('E42', 'DELIVERED');
      await waitForInboxStatus('E42', 'PROCESSED');
      const finalSnap = await ctx.snap('F1');
      assert.equal(finalSnap.sender_db.outbox.length, 1);
      assert.equal(finalSnap.sender_db.outbox[0].status, 'DELIVERED');
      assert.equal(finalSnap.receiver_db.inbox.length, 1);
      assert.equal(finalSnap.receiver_db.inbox[0].status, 'PROCESSED');
      assert.equal(finalSnap.receiver_db.video_summaries[0].version, 1);
      assert.equal(finalSnap.receiver_db.video_summaries[0].applied_count, 1);

      return {
        marker: markerLine,
        kill: killInfo,
        client_first_attempt: firstReq,
        client_retry_complete: retryComplete,
        snapshots: ['F1-after-kill.json', 'F1.json'],
      };
    },
  },
  {
    id: 'F2',
    kind: 'Kill thật',
    title: 'Kill sender sau commit, trước response',
    expected: 'Tắt relay, kill sender tại after_sender_commit_before_response => DB đã có J42 DONE & outbox E42 PENDING dù client không nhận response. Gọi complete lại trả cùng E42; bật relay => đạt H0.',
    async run(ctx) {
      await ctx.pm.start('receiver-api');
      await ctx.pm.start('receiver-worker');
      // Relay intentionally STOPPED during kill.
      await ctx.pm.start('sender-api', { marker: 'after_sender_commit_before_response' });

      const markerPromise = ctx.pm.waitForMarker('sender-api', 'after_sender_commit_before_response');
      const firstReqPromise = httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST', timeoutMs: 8000 })
        .then(res => ({ ok: true, res }))
        .catch(err => ({ ok: false, error: err.message }));

      const markerLine = await markerPromise;
      const killInfo = await ctx.pm.killSigkill('sender-api', 'after_sender_commit_before_response');
      const firstReq = await firstReqPromise;
      assert.equal(firstReq.ok, false, 'Client should not receive response after SIGKILL');

      const afterKill = await ctx.snap('F2-after-kill');
      assert.equal(afterKill.sender_db.jobs.find(j => j.job_id === 'J42').status, 'DONE');
      assert.equal(afterKill.sender_db.outbox.length, 1);
      assert.equal(afterKill.sender_db.outbox[0].event_id, 'E42');
      assert.equal(afterKill.sender_db.outbox[0].status, 'PENDING');
      assert.equal(afterKill.sender_db.delivery_attempts.length, 0);
      assert.equal(afterKill.receiver_db.inbox.length, 0);

      await ctx.pm.start('sender-api');
      const secondComplete = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
      assert.equal(secondComplete.status, 200);
      assert.equal(secondComplete.body.event_id, 'E42');
      assert.equal(secondComplete.body.already_completed, true);

      // Start relay now and verify end-to-end delivery.
      await ctx.pm.start('relay');
      await waitForEventStatus('E42', 'DELIVERED');
      await waitForInboxStatus('E42', 'PROCESSED');

      const finalSnap = await ctx.snap('F2');
      assert.equal(finalSnap.sender_db.outbox.length, 1);
      assert.equal(finalSnap.sender_db.outbox[0].status, 'DELIVERED');
      assert.equal(finalSnap.receiver_db.inbox.length, 1);
      assert.equal(finalSnap.receiver_db.inbox[0].status, 'PROCESSED');
      assert.equal(finalSnap.receiver_db.video_summaries[0].version, 1);
      assert.equal(finalSnap.receiver_db.video_summaries[0].applied_count, 1);

      return {
        marker: markerLine,
        kill: killInfo,
        client_first_attempt: firstReq,
        client_idempotent_retry: secondComplete,
        snapshots: ['F2-after-kill.json', 'F2.json'],
      };
    },
  },
  {
    id: 'F3',
    kind: 'Kill thật',
    title: 'Kill relay sau 2xx, trước DELIVERED',
    expected: 'Kill relay tại after_http_2xx_before_delivery_commit => receiver đã có inbox E42, sender còn PENDING & A1 STARTED. Restart relay: A1 -> UNKNOWN, gửi A2 cùng E42 -> 202, 1 inbox, applied_count = 1.',
    async run(ctx) {
      await ctx.pm.start('receiver-api');
      await ctx.pm.start('receiver-worker');
      await ctx.pm.start('sender-api');
      await ctx.pm.start('relay', { marker: 'after_http_2xx_before_delivery_commit' });

      const markerPromise = ctx.pm.waitForMarker('relay', 'after_http_2xx_before_delivery_commit');
      const complete = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
      assert.equal(complete.status, 200);

      const markerLine = await markerPromise;
      const killInfo = await ctx.pm.killSigkill('relay', 'after_http_2xx_before_delivery_commit');

      const afterKill = await ctx.snap('F3-after-kill');
      assert.equal(afterKill.sender_db.outbox[0].status, 'PENDING');
      assert.equal(afterKill.sender_db.delivery_attempts.length, 1);
      assert.equal(afterKill.sender_db.delivery_attempts[0].attempt_id, 'A1');
      assert.equal(afterKill.sender_db.delivery_attempts[0].outcome, 'STARTED');
      assert.equal(afterKill.receiver_db.inbox.length, 1);
      assert.equal(afterKill.receiver_db.inbox[0].event_id, 'E42');

      // Restart relay without marker: A1 becomes UNKNOWN, A2 is sent with same E42 -> 202.
      await ctx.pm.start('relay');
      await waitForEventStatus('E42', 'DELIVERED');
      await waitForInboxStatus('E42', 'PROCESSED');

      const finalSnap = await ctx.snap('F3');
      assert.equal(finalSnap.sender_db.outbox[0].status, 'DELIVERED');
      assert.equal(finalSnap.sender_db.delivery_attempts.length, 2);
      const [a1, a2] = finalSnap.sender_db.delivery_attempts;
      assert.equal(a1.attempt_id, 'A1');
      assert.equal(a1.outcome, 'UNKNOWN');
      assert.equal(a2.attempt_id, 'A2');
      assert.notEqual(a1.attempt_id, a2.attempt_id);
      assert.equal(a2.event_id, a1.event_id);
      assert.equal(a2.outcome, 'ACKNOWLEDGED');
      assert.equal(a2.http_status, 202);
      assert.equal(finalSnap.receiver_db.inbox.length, 1);
      assert.equal(finalSnap.receiver_db.inbox[0].status, 'PROCESSED');
      assert.equal(finalSnap.receiver_db.video_summaries[0].version, 1);
      assert.equal(finalSnap.receiver_db.video_summaries[0].applied_count, 1);

      return {
        marker: markerLine,
        kill: killInfo,
        attempts: finalSnap.sender_db.delivery_attempts.map(a => ({
          attempt_id: a.attempt_id,
          event_id: a.event_id,
          round: a.round,
          attempt_in_round: a.attempt_in_round,
          outcome: a.outcome,
          http_status: a.http_status,
        })),
        snapshots: ['F3-after-kill.json', 'F3.json'],
      };
    },
  },
  {
    id: 'F4',
    kind: 'Tự động',
    title: 'Receiver đóng kết nối sau commit inbox',
    expected: 'Marker after_inbox_commit_before_response (bật 1 lần) => sender ghi A1 RETRYABLE, inbox đã có E42; retry A2 thành 202/DELIVERED; 1 inbox; sau khi worker chạy, applied_count = 1.',
    async run(ctx) {
      await ctx.pm.start('receiver-api');
      await ctx.pm.start('sender-api');
      await ctx.pm.start('relay');
      // Worker starts AFTER attempt 2 so F4-after-attempt-1 clearly shows RECEIVED before worker runs.

      const armFault = await httpJson(`${RECEIVER_BASE}/_lab/fault`, {
        method: 'PUT',
        body: { drop_after_commit_once: true },
      });
      assert.equal(armFault.status, 200);

      const markerPromise = ctx.pm.waitForMarker('receiver-api', 'after_inbox_commit_before_response');
      const complete = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
      assert.equal(complete.status, 200);

      const markerLine = await markerPromise;

      // Wait until sender records attempt 1 as RETRYABLE.
      await until(async () => {
        const res = await httpJson(`${SENDER_BASE}/events/E42`);
        return res.status === 200 && res.body.attempts.length >= 1 && res.body.attempts[0].outcome === 'RETRYABLE';
      }, 'attempt 1 => RETRYABLE');

      const afterAttempt1 = await ctx.snap('F4-after-attempt-1');
      assert.equal(afterAttempt1.sender_db.delivery_attempts[0].outcome, 'RETRYABLE');
      assert.equal(afterAttempt1.sender_db.outbox[0].status, 'PENDING');
      assert.equal(afterAttempt1.receiver_db.inbox.length, 1);
      assert.equal(afterAttempt1.receiver_db.inbox[0].event_id, 'E42');
      assert.equal(afterAttempt1.receiver_db.inbox[0].status, 'RECEIVED');

      // Relay automatically retries A2 after 1s -> receiver returns 202 duplicate -> DELIVERED.
      await waitForEventStatus('E42', 'DELIVERED');
      await ctx.pm.start('receiver-worker');
      await waitForInboxStatus('E42', 'PROCESSED');

      const finalSnap = await ctx.snap('F4');
      assert.equal(finalSnap.sender_db.delivery_attempts.length, 2);
      assert.equal(finalSnap.sender_db.delivery_attempts[0].outcome, 'RETRYABLE');
      assert.equal(finalSnap.sender_db.delivery_attempts[1].outcome, 'ACKNOWLEDGED');
      assert.equal(finalSnap.sender_db.delivery_attempts[1].http_status, 202);
      assert.equal(finalSnap.receiver_db.inbox.length, 1);
      assert.equal(finalSnap.receiver_db.inbox[0].status, 'PROCESSED');
      assert.equal(finalSnap.receiver_db.video_summaries[0].version, 1);
      assert.equal(finalSnap.receiver_db.video_summaries[0].applied_count, 1);

      return {
        marker: markerLine,
        attempts: finalSnap.sender_db.delivery_attempts.map(a => ({
          attempt_id: a.attempt_id,
          outcome: a.outcome,
          http_status: a.http_status,
          error_detail: a.error_detail,
        })),
        snapshots: ['F4-after-attempt-1.json', 'F4.json'],
      };
    },
  },
  {
    id: 'F5',
    kind: 'Tự động',
    title: 'Payload sửa, chữ ký sai, timestamp lệch',
    expected: 'Payload bị sửa, chữ ký sai, timestamp quá cũ (>300s), timestamp quá xa tương lai (>300s) đều trả 401; sai schema trả 400; inbox rỗng, không đổi video_summaries.',
    async run(ctx) {
      await ctx.pm.start('receiver-api');
      await ctx.pm.start('receiver-worker');

      const nowSec = Math.floor(Date.now() / 1000);
      const validPayload = {
        event_id: 'E42',
        type: 'summary.completed',
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        data: { job_id: 'J42', video_id: 'V7', version: 1, summary: 'Original fixture summary.' },
      };

      // 1) Tampered payload after signing
      const originalRaw = JSON.stringify(validPayload);
      const tamperedRaw = originalRaw.replace('Original', 'Tampered');
      const sigForOriginal = signWebhook({ secret: RUN_SECRET, timestamp: nowSec, rawBody: originalRaw });
      const tamperedRes = await httpJson(`${RECEIVER_BASE}/webhooks/summaries`, {
        method: 'POST',
        body: tamperedRaw,
        headers: {
          'content-type': 'application/json',
          'x-webhook-timestamp': String(nowSec),
          'x-webhook-signature': sigForOriginal,
          'x-delivery-attempt': 'F5-tampered',
        },
      });
      assert.equal(tamperedRes.status, 401);

      // 2) Wrong signature
      const wrongSigReq = buildSignedWebhookRequest(validPayload, {
        timestamp: nowSec,
        sigOverride: '0'.repeat(64),
        attemptId: 'F5-wrong-sig',
      });
      const wrongSigRes = await httpJson(`${RECEIVER_BASE}/webhooks/summaries`, {
        method: 'POST',
        body: wrongSigReq.rawBody,
        headers: wrongSigReq.headers,
      });
      assert.equal(wrongSigRes.status, 401);

      // 3) Timestamp too old (> 300s in past)
      const oldReq = buildSignedWebhookRequest(validPayload, {
        timestamp: nowSec - 301,
        attemptId: 'F5-old-ts',
      });
      const oldRes = await httpJson(`${RECEIVER_BASE}/webhooks/summaries`, {
        method: 'POST',
        body: oldReq.rawBody,
        headers: oldReq.headers,
      });
      assert.equal(oldRes.status, 401);

      // 4) Timestamp too far in future (> 300s ahead)
      const futureReq = buildSignedWebhookRequest(validPayload, {
        timestamp: nowSec + 301,
        attemptId: 'F5-future-ts',
      });
      const futureRes = await httpJson(`${RECEIVER_BASE}/webhooks/summaries`, {
        method: 'POST',
        body: futureReq.rawBody,
        headers: futureReq.headers,
      });
      assert.equal(futureRes.status, 401);

      // 5) Valid HMAC & timestamp but invalid schema (version = 0) -> 400
      const badSchemaPayload = {
        ...validPayload,
        data: { ...validPayload.data, version: 0 },
      };
      const badSchemaReq = buildSignedWebhookRequest(badSchemaPayload, {
        timestamp: nowSec,
        attemptId: 'F5-bad-schema',
      });
      const badSchemaRes = await httpJson(`${RECEIVER_BASE}/webhooks/summaries`, {
        method: 'POST',
        body: badSchemaReq.rawBody,
        headers: badSchemaReq.headers,
      });
      assert.equal(badSchemaRes.status, 400);

      const summaryRes = await httpJson(`${RECEIVER_BASE}/videos/V7/summary`);
      assert.equal(summaryRes.status, 404);

      const snap = await ctx.snap('F5');
      assert.equal(snap.receiver_db.inbox.length, 0);
      assert.equal(snap.receiver_db.video_summaries.length, 0);

      return {
        responses: {
          tampered_body: tamperedRes,
          wrong_signature: wrongSigRes,
          timestamp_too_old: oldRes,
          timestamp_too_future: futureRes,
          invalid_schema: badSchemaRes,
        },
        snapshots: ['F5.json'],
      };
    },
  },
  {
    id: 'F6',
    kind: 'Tự động',
    title: '5 bản sao đồng thời; cùng ID khác body',
    expected: '5 bản sao đồng thời cùng E42 cùng payload đều trả 202, chỉ 1 inbox, applied_count = 1. Cùng event_id nhưng khác body (chữ ký hợp lệ) => 409, dữ liệu cũ không đổi.',
    async run(ctx) {
      await ctx.pm.start('receiver-api');
      await ctx.pm.start('receiver-worker');

      const basePayload = {
        event_id: 'E42',
        type: 'summary.completed',
        schema_version: 1,
        occurred_at: '2026-11-19T03:00:00.000Z',
        data: { job_id: 'J42', video_id: 'V7', version: 1, summary: 'Bản gốc cố định cho E42.' },
      };
      const rawOriginal = JSON.stringify(basePayload);

      // Send 5 concurrent identical copies with distinct attempt headers.
      const concurrentResponses = await Promise.all(
        [1, 2, 3, 4, 5].map(idx => {
          const req = buildSignedWebhookRequest(basePayload, {
            rawOverride: rawOriginal,
            attemptId: `F6-dup-${idx}`,
          });
          return httpJson(`${RECEIVER_BASE}/webhooks/summaries`, {
            method: 'POST',
            body: req.rawBody,
            headers: req.headers,
          });
        }),
      );
      const statuses = concurrentResponses.map(r => r.status);
      assert.deepEqual(statuses, [202, 202, 202, 202, 202]);

      await waitForInboxStatus('E42', 'PROCESSED');

      // Send same event_id with a DIFFERENT body (validly signed) -> must return 409.
      const conflictingPayload = {
        ...basePayload,
        data: { ...basePayload.data, summary: 'Nội dung khác cố ghi đè E42.' },
      };
      const conflictReq = buildSignedWebhookRequest(conflictingPayload, { attemptId: 'F6-conflict' });
      const conflictRes = await httpJson(`${RECEIVER_BASE}/webhooks/summaries`, {
        method: 'POST',
        body: conflictReq.rawBody,
        headers: conflictReq.headers,
      });
      assert.equal(conflictRes.status, 409);

      const snap = await ctx.snap('F6');
      assert.equal(snap.receiver_db.inbox.length, 1);
      assert.equal(snap.receiver_db.inbox[0].raw_body, rawOriginal);
      assert.equal(snap.receiver_db.inbox[0].status, 'PROCESSED');
      assert.equal(snap.receiver_db.video_summaries.length, 1);
      assert.equal(snap.receiver_db.video_summaries[0].summary, 'Bản gốc cố định cho E42.');
      assert.equal(snap.receiver_db.video_summaries[0].applied_count, 1);

      return {
        concurrent_statuses: statuses,
        conflict_response: conflictRes,
        snapshots: ['F6.json'],
      };
    },
  },
  {
    id: 'F7',
    kind: 'Kill thật',
    title: 'Kill worker trước commit',
    expected: 'Kill receiver worker tại after_projection_write_before_commit => rollback: inbox vẫn RECEIVED, video_summaries rỗng (404). Restart worker => PROCESSED, applied_count = 1.',
    async run(ctx) {
      await ctx.pm.start('receiver-api');
      await ctx.pm.start('receiver-worker', { marker: 'after_projection_write_before_commit' });
      await ctx.pm.start('sender-api');
      await ctx.pm.start('relay');

      const markerPromise = ctx.pm.waitForMarker('receiver-worker', 'after_projection_write_before_commit');
      const complete = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
      assert.equal(complete.status, 200);

      const markerLine = await markerPromise;
      const killInfo = await ctx.pm.killSigkill('receiver-worker', 'after_projection_write_before_commit');

      // Ensure PostgreSQL has rolled back uncommitted projection write & inbox row lock.
      await waitForEventStatus('E42', 'DELIVERED');
      await until(async () => {
        const res = await httpJson(`${RECEIVER_BASE}/videos/V7/summary`);
        return res.status === 404;
      }, 'video_summaries rollback => 404');

      const summaryAfterKill = await httpJson(`${RECEIVER_BASE}/videos/V7/summary`);
      assert.equal(summaryAfterKill.status, 404);

      const afterKill = await ctx.snap('F7-after-kill');
      assert.equal(afterKill.sender_db.outbox[0].status, 'DELIVERED');
      assert.equal(afterKill.receiver_db.inbox.length, 1);
      assert.equal(afterKill.receiver_db.inbox[0].status, 'RECEIVED');
      assert.equal(afterKill.receiver_db.inbox[0].processed_at, null);
      assert.equal(afterKill.receiver_db.video_summaries.length, 0);

      // Restart worker without marker -> processes E42 cleanly.
      await ctx.pm.start('receiver-worker');
      await waitForInboxStatus('E42', 'PROCESSED');

      const finalSummary = await httpJson(`${RECEIVER_BASE}/videos/V7/summary`);
      assert.equal(finalSummary.status, 200);
      assert.equal(finalSummary.body.version, 1);
      assert.equal(finalSummary.body.applied_count, 1);

      const finalSnap = await ctx.snap('F7');
      assert.equal(finalSnap.receiver_db.inbox[0].status, 'PROCESSED');
      assert.equal(finalSnap.receiver_db.video_summaries.length, 1);
      assert.equal(finalSnap.receiver_db.video_summaries[0].applied_count, 1);

      return {
        marker: markerLine,
        kill: killInfo,
        summary_after_kill_status: summaryAfterKill.status,
        snapshots: ['F7-after-kill.json', 'F7.json'],
      };
    },
  },
  {
    id: 'F8',
    kind: 'Tự động',
    title: '503 cả 4 lần, rồi replay',
    expected: '4 attempt 503 (chờ 1, 3, 9s) => E42 DEAD, inbox rỗng. Gỡ fault, replay giữ event_id & raw_body, mở vòng 2 => DELIVERED, PROCESSED, applied_count = 1; replay khi DELIVERED trả 409.',
    async run(ctx) {
      await ctx.pm.start('receiver-api');
      await ctx.pm.start('receiver-worker');
      await ctx.pm.start('sender-api');
      await ctx.pm.start('relay');

      // Force 503 BEFORE inbox save.
      const armFault = await httpJson(`${RECEIVER_BASE}/_lab/fault`, {
        method: 'PUT',
        body: { fail_status: 503 },
      });
      assert.equal(armFault.status, 200);

      const complete = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
      assert.equal(complete.status, 200);

      // Wait for all 4 attempts (0s + 1s + 3s + 9s = ~13s) -> DEAD.
      const deadEvent = await waitForEventStatus('E42', 'DEAD', 30000);
      assert.equal(deadEvent.attempts.length, 4);

      const beforeReplay = await ctx.snap('F8-before-replay');
      assert.equal(beforeReplay.sender_db.outbox[0].status, 'DEAD');
      assert.equal(beforeReplay.sender_db.delivery_attempts.length, 4);
      for (const [idx, att] of beforeReplay.sender_db.delivery_attempts.entries()) {
        assert.equal(att.round, 1);
        assert.equal(att.attempt_in_round, idx + 1);
        assert.equal(att.http_status, 503);
        assert.equal(att.outcome, 'RETRYABLE');
      }
      assert.equal(beforeReplay.receiver_db.inbox.length, 0);
      assert.equal(beforeReplay.receiver_db.video_summaries.length, 0);

      // Verify backoff wait gaps via attempt timestamps (published tolerance: [-50ms, +1000ms]).
      const attemptsR1 = beforeReplay.sender_db.delivery_attempts;
      const measuredGapsMs = attemptsR1.slice(1).map((att, idx) =>
        new Date(att.started_at).getTime() - new Date(attemptsR1[idx].finished_at).getTime(),
      );
      const tolerance = { min_delta: -50, max_delta: 1000 };
      for (let i = 0; i < BACKOFF_MS.length; i += 1) {
        const expectedGap = BACKOFF_MS[i];
        const actualGap = measuredGapsMs[i];
        assert.ok(
          actualGap >= expectedGap + tolerance.min_delta && actualGap <= expectedGap + tolerance.max_delta,
          `Backoff gap ${i + 1} out of tolerance: expected ${expectedGap}ms [${tolerance.min_delta}, +${tolerance.max_delta}], got ${actualGap}ms`,
        );
      }

      const rawBodyBeforeReplay = beforeReplay.sender_db.outbox[0].raw_body;

      // Clear 503 fault and replay E42.
      await httpJson(`${RECEIVER_BASE}/_lab/fault`, { method: 'PUT', body: {} });
      const replayRes = await httpJson(`${SENDER_BASE}/events/E42/replay`, { method: 'POST' });
      assert.equal(replayRes.status, 200);
      assert.equal(replayRes.body.event_id, 'E42');
      assert.equal(replayRes.body.replay_round, 2);
      assert.equal(replayRes.body.status, 'PENDING');

      await waitForEventStatus('E42', 'DELIVERED');
      await waitForInboxStatus('E42', 'PROCESSED');

      // Replaying an event that is not DEAD must return 409.
      const replayDeliveredRes = await httpJson(`${SENDER_BASE}/events/E42/replay`, { method: 'POST' });
      assert.equal(replayDeliveredRes.status, 409);

      const finalSnap = await ctx.snap('F8');
      assert.equal(finalSnap.sender_db.outbox[0].event_id, 'E42');
      assert.equal(finalSnap.sender_db.outbox[0].raw_body, rawBodyBeforeReplay);
      assert.equal(finalSnap.sender_db.outbox[0].status, 'DELIVERED');
      assert.equal(finalSnap.sender_db.outbox[0].replay_round, 2);
      assert.equal(finalSnap.sender_db.replay_events.length, 1);
      assert.equal(finalSnap.sender_db.replay_events[0].round, 2);
      assert.equal(finalSnap.sender_db.delivery_attempts.length, 5);
      assert.equal(finalSnap.sender_db.delivery_attempts[4].round, 2);
      assert.equal(finalSnap.sender_db.delivery_attempts[4].attempt_in_round, 1);
      assert.equal(finalSnap.sender_db.delivery_attempts[4].outcome, 'ACKNOWLEDGED');
      assert.equal(finalSnap.sender_db.delivery_attempts[4].http_status, 202);
      assert.equal(finalSnap.receiver_db.inbox.length, 1);
      assert.equal(finalSnap.receiver_db.inbox[0].status, 'PROCESSED');
      assert.equal(finalSnap.receiver_db.video_summaries[0].version, 1);
      assert.equal(finalSnap.receiver_db.video_summaries[0].applied_count, 1);

      return {
        backoff_policy_ms: BACKOFF_MS,
        measured_gaps_ms: measuredGapsMs,
        tolerance_ms: tolerance,
        replay_response: replayRes,
        replay_when_delivered_status: replayDeliveredRes.status,
        raw_body_preserved: finalSnap.sender_db.outbox[0].raw_body === rawBodyBeforeReplay,
        snapshots: ['F8-before-replay.json', 'F8.json'],
      };
    },
  },
  {
    id: 'F9',
    kind: 'Tự động',
    title: 'E43 (version 2) trước E42 (version 1)',
    expected: 'Chờ worker xử lý từng event. Cả hai inbox PROCESSED; bản hiện tại vẫn version 2, applied_count = 1.',
    async run(ctx) {
      await ctx.pm.start('receiver-api');
      await ctx.pm.start('receiver-worker');
      await ctx.pm.start('sender-api');
      await ctx.pm.start('relay');

      // Step 1: Complete J43 (version 2) first and wait until PROCESSED.
      const c43 = await httpJson(`${SENDER_BASE}/jobs/J43/complete`, { method: 'POST' });
      assert.equal(c43.status, 200);
      assert.equal(c43.body.event_id, 'E43');
      await waitForEventStatus('E43', 'DELIVERED');
      await waitForInboxStatus('E43', 'PROCESSED');

      const midSummary = await httpJson(`${RECEIVER_BASE}/videos/V7/summary`);
      assert.equal(midSummary.status, 200);
      assert.equal(midSummary.body.version, 2);
      assert.equal(midSummary.body.applied_count, 1);

      // Step 2: Complete J42 (older version 1) and wait until PROCESSED.
      const c42 = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
      assert.equal(c42.status, 200);
      assert.equal(c42.body.event_id, 'E42');
      await waitForEventStatus('E42', 'DELIVERED');
      await waitForInboxStatus('E42', 'PROCESSED');

      const finalSummary = await httpJson(`${RECEIVER_BASE}/videos/V7/summary`);
      assert.equal(finalSummary.status, 200);
      assert.equal(finalSummary.body.version, 2);
      assert.equal(finalSummary.body.applied_count, 1);
      assert.equal(finalSummary.body.source_event_id, 'E43');

      const snap = await ctx.snap('F9');
      assert.equal(snap.sender_db.outbox.length, 2);
      assert.equal(snap.receiver_db.inbox.length, 2);
      assert.ok(snap.receiver_db.inbox.every(row => row.status === 'PROCESSED'));
      assert.equal(snap.receiver_db.video_summaries.length, 1);
      assert.equal(snap.receiver_db.video_summaries[0].version, 2);
      assert.equal(snap.receiver_db.video_summaries[0].applied_count, 1);

      return {
        after_E43: midSummary.body,
        after_E42: finalSummary.body,
        snapshots: ['F9.json'],
      };
    },
  },
  {
    id: 'F10',
    kind: 'Tự động',
    title: 'Worker tắt, hoàn tất J42',
    expected: 'Khi worker tắt: sender DELIVERED, inbox RECEIVED, GET /videos/V7/summary trả 404. Bật worker: inbox PROCESSED, bản tóm tắt xuất hiện (version 1, applied_count = 1).',
    async run(ctx) {
      await ctx.pm.start('receiver-api');
      await ctx.pm.start('sender-api');
      await ctx.pm.start('relay');
      // receiver-worker intentionally STOPPED.

      const complete = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
      assert.equal(complete.status, 200);

      const deliveredEvent = await waitForEventStatus('E42', 'DELIVERED');
      const inboxWhileStopped = await httpJson(`${RECEIVER_BASE}/inbox/E42`);
      const summaryWhileStopped = await httpJson(`${RECEIVER_BASE}/videos/V7/summary`);

      assert.equal(deliveredEvent.status, 'DELIVERED');
      assert.equal(inboxWhileStopped.status, 200);
      assert.equal(inboxWhileStopped.body.status, 'RECEIVED');
      assert.equal(inboxWhileStopped.body.processed_at, null);
      assert.equal(summaryWhileStopped.status, 404);

      const stoppedSnap = await ctx.snap('F10-worker-stopped');
      assert.equal(stoppedSnap.sender_db.outbox[0].status, 'DELIVERED');
      assert.equal(stoppedSnap.receiver_db.inbox[0].status, 'RECEIVED');
      assert.equal(stoppedSnap.receiver_db.video_summaries.length, 0);

      // Start worker -> inbox becomes PROCESSED and summary appears.
      await ctx.pm.start('receiver-worker');
      await waitForInboxStatus('E42', 'PROCESSED');

      const summaryAfterStart = await httpJson(`${RECEIVER_BASE}/videos/V7/summary`);
      assert.equal(summaryAfterStart.status, 200);
      assert.equal(summaryAfterStart.body.version, 1);
      assert.equal(summaryAfterStart.body.applied_count, 1);

      const finalSnap = await ctx.snap('F10');
      assert.equal(finalSnap.receiver_db.inbox[0].status, 'PROCESSED');
      assert.equal(finalSnap.receiver_db.video_summaries[0].version, 1);
      assert.equal(finalSnap.receiver_db.video_summaries[0].applied_count, 1);

      return {
        while_worker_stopped: {
          sender_event_status: deliveredEvent.status,
          receiver_inbox_status: inboxWhileStopped.body.status,
          receiver_summary_http_status: summaryWhileStopped.status,
        },
        after_worker_started: summaryAfterStart.body,
        snapshots: ['F10-worker-stopped.json', 'F10.json'],
      };
    },
  },
];

function selectScenarios(selector) {
  if (!selector || selector === 'all') return SCENARIOS;
  if (selector === 'automated') return SCENARIOS.filter(s => s.kind === 'Tự động');
  if (selector === 'kills') return SCENARIOS.filter(s => s.kind === 'Kill thật');
  const ids = selector.split(',').map(s => s.trim().toUpperCase());
  const selected = SCENARIOS.filter(s => ids.includes(s.id));
  if (selected.length === 0) {
    throw new Error(`Unknown scenario selector "${selector}". Valid: all, automated, kills, H0, F1..F10`);
  }
  return selected;
}

async function main() {
  const selector = process.argv[2] || 'all';
  const selected = selectScenarios(selector);

  stopConflictingComposeAppServices();
  await applyMigrations(config);

  const senderPool = createSenderPool(config.senderDatabaseUrl);
  const receiverPool = createReceiverPool(config.receiverDatabaseUrl);

  const startedAt = new Date().toISOString();
  const results = [];

  try {
    for (const scenario of selected) {
      await resetFixtures(config);
      const pm = new ProcessManager();
      const caseStart = Date.now();
      let status = 'PASS';
      let observed = null;
      let errorMsg = null;

      console.log(`\n=== Running ${scenario.id} (${scenario.kind}): ${scenario.title} ===`);
      try {
        observed = await scenario.run({
          pm,
          senderPool,
          receiverPool,
          snap: async label => {
            const s = await captureSnapshot(label, { senderPool, receiverPool });
            await saveEvidence(label, s);
            return s;
          },
        });
        console.log(`PASS ${scenario.id} (${Date.now() - caseStart} ms)`);
      } catch (error) {
        status = 'FAIL';
        errorMsg = error.stack || error.message;
        console.error(`FAIL ${scenario.id}: ${error.message}`);
      } finally {
        await pm.stopAll();
      }

      results.push({
        id: scenario.id,
        kind: scenario.kind,
        title: scenario.title,
        status,
        duration_ms: Date.now() - caseStart,
        expected: scenario.expected,
        observed,
        error: errorMsg,
        process_log: pm.log,
      });
    }
  } finally {
    await senderPool.end();
    await receiverPool.end();
  }

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.length - passed;
  const verification = {
    block: 9,
    selector,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    node_version: process.version,
    platform: process.platform,
    summary: {
      total: results.length,
      passed,
      failed,
    },
    results,
  };

  const outName = selector === 'all' ? 'verification' : `verification-${selector.replace(/[^a-z0-9_-]/gi, '_')}`;
  await saveEvidence(outName, verification);
  console.log(`\nSummary: ${passed}/${results.length} PASS (saved evidence/${outName}.json)`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('HARNESS_FATAL', error.stack || error.message);
  process.exit(1);
});
