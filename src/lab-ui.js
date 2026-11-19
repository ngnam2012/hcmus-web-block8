import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config, sleep } from './config.js';
import { createReceiverPool, createSenderPool } from './db.js';
import { applyMigrations, resetFixtures } from '../scripts/migrate.js';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

const UI_PORT = Number(process.env.LAB_UI_PORT || 4200);
const RUN_SECRET = config.webhookSecret || `ui-lab-${randomBytes(24).toString('hex')}`;
const SENDER_BASE = `http://127.0.0.1:${config.senderPort}`;
const RECEIVER_BASE = `http://127.0.0.1:${config.receiverPort}`;

const SERVICE_DEFS = {
  'sender-api': {
    label: '1. Sender API',
    script: 'src/sender-api.js',
    port: config.senderPort,
    healthUrl: `${SENDER_BASE}/health`,
    markers: ['after_job_update_before_outbox', 'after_sender_commit_before_response'],
    env: () => ({
      BIND_HOST: '127.0.0.1',
      SENDER_PORT: String(config.senderPort),
      SENDER_DATABASE_URL: config.senderDatabaseUrl,
      RELAY_HEALTH_URL: `http://127.0.0.1:${config.relayHealthPort}/health`,
      RECEIVER_PUBLIC_URL: RECEIVER_BASE,
      LAB_MODE: 'true',
    }),
  },
  relay: {
    label: '2. Relay (1 process)',
    script: 'src/relay.js',
    port: config.relayHealthPort,
    healthUrl: `http://127.0.0.1:${config.relayHealthPort}/health`,
    markers: ['after_http_2xx_before_delivery_commit'],
    env: () => ({
      BIND_HOST: '127.0.0.1',
      RELAY_HEALTH_PORT: String(config.relayHealthPort),
      SENDER_DATABASE_URL: config.senderDatabaseUrl,
      WEBHOOK_TARGET_URL: `${RECEIVER_BASE}/webhooks/summaries`,
      WEBHOOK_SECRET: RUN_SECRET,
      WEBHOOK_TIMEOUT_MS: String(config.webhookTimeoutMs),
      RELAY_POLL_INTERVAL_MS: '60',
      LAB_MODE: 'true',
    }),
  },
  'receiver-api': {
    label: '3. Receiver API',
    script: 'src/receiver-api.js',
    port: config.receiverPort,
    healthUrl: `${RECEIVER_BASE}/health`,
    markers: ['after_inbox_commit_before_response'],
    env: () => ({
      BIND_HOST: '127.0.0.1',
      RECEIVER_PORT: String(config.receiverPort),
      RECEIVER_DATABASE_URL: config.receiverDatabaseUrl,
      WORKER_HEALTH_URL: `http://127.0.0.1:${config.workerHealthPort}/health`,
      WEBHOOK_SECRET: RUN_SECRET,
      WEBHOOK_SOURCE: config.webhookSource,
      WEBHOOK_TIMESTAMP_WINDOW_SEC: String(config.timestampWindowSec),
      LAB_MODE: 'true',
    }),
  },
  'receiver-worker': {
    label: '4. Receiver Worker',
    script: 'src/receiver-worker.js',
    port: config.workerHealthPort,
    healthUrl: `http://127.0.0.1:${config.workerHealthPort}/health`,
    markers: ['after_projection_write_before_commit'],
    env: () => ({
      BIND_HOST: '127.0.0.1',
      WORKER_HEALTH_PORT: String(config.workerHealthPort),
      RECEIVER_DATABASE_URL: config.receiverDatabaseUrl,
      WORKER_POLL_INTERVAL_MS: '60',
      LAB_MODE: 'true',
    }),
  },
};

const START_ORDER = ['receiver-api', 'receiver-worker', 'sender-api', 'relay'];

const senderPool = createSenderPool(config.senderDatabaseUrl);
const receiverPool = createReceiverPool(config.receiverDatabaseUrl);

const procs = new Map();
const processMeta = Object.fromEntries(
  Object.keys(SERVICE_DEFS).map(name => [
    name,
    {
      name,
      label: SERVICE_DEFS[name].label,
      port: SERVICE_DEFS[name].port,
      available_markers: SERVICE_DEFS[name].markers,
      status: 'STOPPED',
      pid: null,
      marker: null,
      paused_marker_line: null,
      started_at: null,
      last_exit: null,
      logs: [],
    },
  ]),
);

let guidedDemo = null;
let lastKillEvent = null;
let verifyState = {
  running: false,
  started_at: null,
  finished_at: null,
  output: [],
  summary: null,
  results: null,
  error: null,
};

function stopConflictingComposeAppServices() {
  try {
    execFileSync(
      'docker',
      ['compose', 'stop', '-t', '1', 'sender-api', 'relay', 'receiver-api', 'receiver-worker'],
      { cwd: rootDir, stdio: 'ignore', timeout: 15000 },
    );
  } catch {
    // Ignore if Compose app services are not running.
  }
}

async function until(fn, description, timeoutMs = 15000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(70);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function httpJson(url, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(url, {
    method,
    headers,
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
  return { status: response.status, ok: response.ok, body: parsed };
}

function appendLog(name, stream, text) {
  const meta = processMeta[name];
  if (!meta) return;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    meta.logs.push({ at: new Date().toISOString(), stream, line });
    if (meta.logs.length > 40) meta.logs.shift();
    if (line.startsWith('MARKER ')) {
      meta.paused_marker_line = line;
      if (meta.marker && line.startsWith(`MARKER ${meta.marker} `)) {
        meta.status = 'PAUSED_AT_MARKER';
      }
    }
  }
}

async function startService(name, { marker = '' } = {}) {
  const def = SERVICE_DEFS[name];
  if (!def) throw new Error(`Unknown service: ${name}`);

  await stopService(name);

  const meta = processMeta[name];
  meta.logs = [];
  meta.paused_marker_line = null;
  meta.marker = marker || null;
  meta.status = 'STARTING';

  const child = spawn(process.execPath, [def.script], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...def.env(),
      MARKER: marker || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const rec = {
    name,
    child,
    pid: child.pid,
    exited: false,
    markerWaiters: [],
    intendedAction: null,
  };

  meta.pid = child.pid;
  meta.started_at = new Date().toISOString();

  child.stdout.on('data', chunk => {
    const text = chunk.toString('utf8');
    appendLog(name, 'stdout', text);
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      for (let i = rec.markerWaiters.length - 1; i >= 0; i -= 1) {
        const w = rec.markerWaiters[i];
        if (line.startsWith(`MARKER ${w.markerName} `)) {
          rec.markerWaiters.splice(i, 1);
          w.resolve(line);
        }
      }
    }
  });

  child.stderr.on('data', chunk => {
    appendLog(name, 'stderr', chunk.toString('utf8'));
  });

  rec.exitPromise = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      rec.exited = true;
      const action = rec.intendedAction || (signal === 'SIGKILL' ? 'SIGKILL' : 'EXIT');
      meta.last_exit = {
        at: new Date().toISOString(),
        action,
        pid: rec.pid,
        code,
        signal: signal || (action === 'SIGKILL' ? 'SIGKILL' : null),
      };
      meta.status = action === 'SIGKILL' ? 'KILLED' : 'STOPPED';
      meta.pid = null;
      meta.paused_marker_line = null;
      if (procs.get(name) === rec) procs.delete(name);
      for (const w of rec.markerWaiters) {
        w.reject(new Error(`${name} exited before marker ${w.markerName}`));
      }
      rec.markerWaiters.length = 0;
      resolve({ code, signal });
    });
  });

  procs.set(name, rec);

  try {
    await until(async () => {
      if (rec.exited) {
        const errTail = meta.logs.slice(-5).map(l => l.line).join(' | ');
        throw new Error(`${name} exited early: ${errTail}`);
      }
      const res = await fetch(def.healthUrl, { signal: AbortSignal.timeout(800) });
      return res.ok;
    }, `${name} /health`, 12000);
  } catch (error) {
    await stopService(name);
    throw error;
  }

  if (meta.status === 'STARTING') {
    meta.status = 'RUNNING';
  }
  return meta;
}

function waitForMarker(name, markerName, timeoutMs = 12000) {
  const rec = procs.get(name);
  if (!rec) throw new Error(`Service ${name} is not running`);
  const existing = processMeta[name].logs.find(l => l.line.startsWith(`MARKER ${markerName} `));
  if (existing) return Promise.resolve(existing.line);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = rec.markerWaiters.indexOf(waiter);
      if (idx >= 0) rec.markerWaiters.splice(idx, 1);
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
    rec.markerWaiters.push(waiter);
  });
}

async function stopService(name) {
  const rec = procs.get(name);
  if (!rec) {
    processMeta[name].status = 'STOPPED';
    processMeta[name].pid = null;
    processMeta[name].paused_marker_line = null;
    return;
  }
  rec.intendedAction = 'SIGTERM';
  if (!rec.exited) {
    rec.child.kill('SIGTERM');
    const done = await Promise.race([rec.exitPromise.then(() => true), sleep(2500).then(() => false)]);
    if (!done && !rec.exited) {
      rec.child.kill('SIGKILL');
      await rec.exitPromise;
    }
  }
}

async function killServiceSigkill(name, reason = 'manual_ui_kill') {
  const rec = procs.get(name);
  if (!rec || rec.exited) {
    throw new Error(`${name} is not running`);
  }
  const pid = rec.pid;
  const markerLine = processMeta[name].paused_marker_line;
  rec.intendedAction = 'SIGKILL';
  const at = new Date().toISOString();
  rec.child.kill('SIGKILL');
  const { code, signal } = await rec.exitPromise;
  // Brief pause so PostgreSQL finishes rolling back any uncommitted transaction from the severed socket.
  await sleep(180);

  lastKillEvent = {
    at,
    service: name,
    pid,
    action: 'kill -9 (SIGKILL)',
    signal: signal || 'SIGKILL',
    code,
    reason,
    marker_line: markerLine,
  };

  if (guidedDemo && guidedDemo.target === name && guidedDemo.phase === 'PAUSED_AT_MARKER') {
    guidedDemo.phase = 'KILLED';
    guidedDemo.kill = lastKillEvent;
  }
  return lastKillEvent;
}

async function startAllNormal() {
  for (const name of START_ORDER) {
    await startService(name, { marker: '' });
  }
}

async function stopAll() {
  for (const name of [...START_ORDER].reverse()) {
    await stopService(name);
  }
}

async function clearReceiverFaultIfUp() {
  if (!procs.has('receiver-api')) return;
  await httpJson(`${RECEIVER_BASE}/_lab/fault`, { method: 'PUT', body: {} }).catch(() => {});
}

// === Express Supervisor App (Loopback only) ===
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(publicDir, { etag: false, maxAge: 0, setHeaders: res => res.set('Cache-Control', 'no-store') }));
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

app.get('/api/state', async (_req, res) => {
  const [jobs, outbox, deliveryAttempts, replayEvents, inbox, videoSummaries, faultResp] = await Promise.all([
    senderPool.query('SELECT * FROM jobs ORDER BY job_id ASC'),
    senderPool.query('SELECT * FROM outbox ORDER BY event_id ASC'),
    senderPool.query('SELECT * FROM delivery_attempts ORDER BY attempt_seq ASC'),
    senderPool.query('SELECT * FROM replay_events ORDER BY replay_id ASC'),
    receiverPool.query('SELECT * FROM inbox ORDER BY received_at ASC, event_id ASC'),
    receiverPool.query('SELECT * FROM video_summaries ORDER BY video_id ASC'),
    procs.has('receiver-api')
      ? httpJson(`${RECEIVER_BASE}/_lab/fault`, { timeoutMs: 1200 }).catch(() => null)
      : Promise.resolve(null),
  ]);

  res.json({
    captured_at: new Date().toISOString(),
    ui_port: UI_PORT,
    processes: Object.values(processMeta).map(m => ({
      ...m,
      logs: m.logs.slice(-12),
    })),
    sender_db: {
      jobs: jobs.rows,
      outbox: outbox.rows,
      delivery_attempts: deliveryAttempts.rows,
      replay_events: replayEvents.rows,
    },
    receiver_db: {
      inbox: inbox.rows,
      video_summaries: videoSummaries.rows,
    },
    receiver_fault: faultResp?.ok ? faultResp.body : null,
    guided_demo: guidedDemo,
    last_kill_event: lastKillEvent,
    verify: verifyState,
  });
});

app.post('/api/reset', async (_req, res) => {
  if (verifyState.running) return res.status(409).json({ error: 'VERIFY_IN_PROGRESS' });
  guidedDemo = null;
  await resetFixtures(config);
  await clearReceiverFaultIfUp();
  return res.json({ ok: true, message: 'Đã reset cả sender_db và receiver_db (J42, J43 READY).' });
});

app.post('/api/processes/start-all', async (_req, res) => {
  if (verifyState.running) return res.status(409).json({ error: 'VERIFY_IN_PROGRESS' });
  guidedDemo = null;
  await startAllNormal();
  return res.json({ ok: true, processes: Object.values(processMeta).map(m => ({ name: m.name, status: m.status, pid: m.pid })) });
});

app.post('/api/processes/:name/start', async (req, res) => {
  if (verifyState.running) return res.status(409).json({ error: 'VERIFY_IN_PROGRESS' });
  const { name } = req.params;
  if (!SERVICE_DEFS[name]) return res.status(404).json({ error: 'UNKNOWN_SERVICE' });
  const marker = typeof req.body?.marker === 'string' ? req.body.marker.trim() : '';
  const meta = await startService(name, { marker });
  return res.json({ ok: true, process: meta });
});

app.post('/api/processes/:name/stop', async (req, res) => {
  if (verifyState.running) return res.status(409).json({ error: 'VERIFY_IN_PROGRESS' });
  const { name } = req.params;
  if (!SERVICE_DEFS[name]) return res.status(404).json({ error: 'UNKNOWN_SERVICE' });
  await stopService(name);
  return res.json({ ok: true, process: processMeta[name] });
});

app.post('/api/processes/:name/kill', async (req, res) => {
  if (verifyState.running) return res.status(409).json({ error: 'VERIFY_IN_PROGRESS' });
  const { name } = req.params;
  if (!SERVICE_DEFS[name]) return res.status(404).json({ error: 'UNKNOWN_SERVICE' });
  try {
    const kill = await killServiceSigkill(name, req.body?.reason || 'ui_sigkill_button');
    return res.json({ ok: true, kill, process: processMeta[name] });
  } catch (error) {
    return res.status(409).json({ error: error.message });
  }
});

// Proxy Sender / Receiver API actions so UI never breaks on CORS or down services.
app.post('/api/jobs/:job_id/complete', async (req, res) => {
  try {
    const out = await httpJson(`${SENDER_BASE}/jobs/${encodeURIComponent(req.params.job_id)}/complete`, {
      method: 'POST',
      timeoutMs: 8000,
    });
    return res.status(out.status).json(out.body);
  } catch (error) {
    return res.status(503).json({ error: 'SENDER_API_UNREACHABLE', detail: error.message });
  }
});

app.post('/api/events/:event_id/replay', async (req, res) => {
  try {
    const out = await httpJson(`${SENDER_BASE}/events/${encodeURIComponent(req.params.event_id)}/replay`, {
      method: 'POST',
      timeoutMs: 8000,
    });
    return res.status(out.status).json(out.body);
  } catch (error) {
    return res.status(503).json({ error: 'SENDER_API_UNREACHABLE', detail: error.message });
  }
});

app.put('/api/receiver/fault', async (req, res) => {
  try {
    const out = await httpJson(`${RECEIVER_BASE}/_lab/fault`, {
      method: 'PUT',
      body: req.body || {},
      timeoutMs: 5000,
    });
    return res.status(out.status).json(out.body);
  } catch (error) {
    return res.status(503).json({ error: 'RECEIVER_API_UNREACHABLE', detail: error.message });
  }
});

app.post('/api/simulate/:scenario', async (req, res) => {
  try {
    const out = await httpJson(`${RECEIVER_BASE}/_lab/simulate/${encodeURIComponent(req.params.scenario)}`, {
      method: 'POST',
      timeoutMs: 10000,
    });
    return res.status(out.status).json(out.body);
  } catch (error) {
    return res.status(503).json({ error: 'RECEIVER_API_UNREACHABLE', detail: error.message });
  }
});

// === Guided Interactive Demos (100% browser-driven, real SIGKILL & real process stop!) ===
const KILL_DEMO_CONFIG = {
  F1: {
    id: 'F1',
    title: 'F1 — Kill thật Sender API trước INSERT outbox (Rollback nguyên tử)',
    target: 'sender-api',
    marker: 'after_job_update_before_outbox',
    startRelay: true,
    beforeKillHint: 'Sender API đã chạy UPDATE J42=DONE nhưng CHƯA INSERT outbox và CHƯA COMMIT. Bấm Kill -9 để kiểm chứng PostgreSQL tự rollback!',
    afterKillHint: 'Kiểm tra DB 1 bên trái: J42 đã rollback về READY, 0 outbox, 0 inbox! Bấm "Bước 3: Khởi động lại & Phục hồi" để restart Sender API và gọi complete lại.',
  },
  F2: {
    id: 'F2',
    title: 'F2 — Kill thật Sender API sau COMMIT, trước HTTP response (Relay đang tắt)',
    target: 'sender-api',
    marker: 'after_sender_commit_before_response',
    startRelay: false,
    beforeKillHint: 'Sender API ĐÃ COMMIT J42=DONE + outbox E42=PENDING nhưng chưa trả 200 cho client (Relay đang tắt). Bấm Kill -9 ngay!',
    afterKillHint: 'Kiểm tra DB 1 bên trái: J42 đã DONE và outbox E42 PENDING dù client mất kết nối! Bấm "Bước 3" để restart Sender API, gọi lại complete (nhận cùng E42) và bật Relay.',
  },
  F3: {
    id: 'F3',
    title: 'F3 — Kill thật Relay sau 202, trước khi ghi DELIVERED',
    target: 'relay',
    marker: 'after_http_2xx_before_delivery_commit',
    startRelay: true,
    beforeKillHint: 'Relay đã gửi A1 và nhận 202 từ Receiver (DB 2 bên phải ĐÃ có inbox E42!), nhưng CHƯA ghi DELIVERED ở DB 1. Bấm Kill -9 Relay ngay!',
    afterKillHint: 'Quan sát 2 DB: DB 2 đã có inbox E42, DB 1 vẫn outbox PENDING & A1 STARTED. Bấm "Bước 3" để restart Relay -> A1 thành UNKNOWN, gửi A2 -> 202, vẫn 1 inbox & applied_count=1!',
  },
  F7: {
    id: 'F7',
    title: 'F7 — Kill thật Receiver Worker sau UPSERT, trước COMMIT PROCESSED',
    target: 'receiver-worker',
    marker: 'after_projection_write_before_commit',
    startRelay: true,
    beforeKillHint: 'Worker đã chạy UPSERT video_summaries nhưng CHƯA ghi PROCESSED và CHƯA COMMIT. Bấm Kill -9 Worker để kiểm chứng rollback!',
    afterKillHint: 'Quan sát DB 2: inbox E42 vẫn RECEIVED, V7 vẫn 404 (chưa có cập nhật đã commit)! Bấm "Bước 3" để restart Worker -> xử lý lại, PROCESSED & applied_count=1!',
  },
};

app.post('/api/demo/arm-kill/:caseId', async (req, res) => {
  if (verifyState.running) return res.status(409).json({ error: 'VERIFY_IN_PROGRESS' });
  const cfg = KILL_DEMO_CONFIG[String(req.params.caseId || '').toUpperCase()];
  if (!cfg) return res.status(400).json({ error: 'UNSUPPORTED_KILL_DEMO', supported: Object.keys(KILL_DEMO_CONFIG) });

  await stopAll();
  await resetFixtures(config);

  await startService('receiver-api');
  await startService('receiver-worker', { marker: cfg.target === 'receiver-worker' ? cfg.marker : '' });
  await startService('sender-api', { marker: cfg.target === 'sender-api' ? cfg.marker : '' });
  if (cfg.startRelay) {
    await startService('relay', { marker: cfg.target === 'relay' ? cfg.marker : '' });
  }

  const markerPromise = waitForMarker(cfg.target, cfg.marker, 12000);
  // Fire POST /jobs/J42/complete asynchronously (for F1/F2 it intentionally hangs until SIGKILL).
  const triggerReq = httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST', timeoutMs: 25000 }).catch(err => ({
    status: 0,
    error: err.message,
  }));

  const markerLine = await markerPromise;
  // For F3/F7 the complete call finishes immediately; for F1/F2 it stays open until killed.
  if (cfg.target !== 'sender-api') {
    await triggerReq;
  }

  guidedDemo = {
    id: cfg.id,
    title: cfg.title,
    target: cfg.target,
    marker: cfg.marker,
    pid: processMeta[cfg.target].pid,
    marker_line: markerLine,
    phase: 'PAUSED_AT_MARKER',
    before_kill_hint: cfg.beforeKillHint,
    after_kill_hint: cfg.afterKillHint,
    kill: null,
  };

  return res.json({ ok: true, guided_demo: guidedDemo });
});

app.post('/api/demo/recover-kill', async (_req, res) => {
  if (verifyState.running) return res.status(409).json({ error: 'VERIFY_IN_PROGRESS' });
  if (!guidedDemo) return res.status(400).json({ error: 'NO_ACTIVE_KILL_DEMO' });

  const demo = guidedDemo;
  const actions = [];

  if (demo.id === 'F1') {
    await startService('sender-api');
    actions.push('Restarted sender-api (không marker)');
    const retry = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
    actions.push(`POST /jobs/J42/complete -> HTTP ${retry.status} (${retry.body?.event_id})`);
  } else if (demo.id === 'F2') {
    await startService('sender-api');
    actions.push('Restarted sender-api (không marker)');
    const retry = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
    actions.push(`Gọi lại POST /jobs/J42/complete -> HTTP ${retry.status} (event_id=${retry.body?.event_id}, already_completed=${retry.body?.already_completed})`);
    await startService('relay');
    actions.push('Started relay để gửi outbox E42');
  } else if (demo.id === 'F3') {
    await startService('relay');
    actions.push('Restarted relay (không marker) -> A1 thành UNKNOWN, gửi A2 sau 1s');
  } else if (demo.id === 'F7') {
    await startService('receiver-worker');
    actions.push('Restarted receiver-worker (không marker) -> đọc lại inbox RECEIVED và commit');
  }

  demo.phase = 'RECOVERED';
  demo.recovery_actions = actions;
  return res.json({ ok: true, guided_demo: demo, actions });
});

app.post('/api/demo/f9', async (_req, res) => {
  if (verifyState.running) return res.status(409).json({ error: 'VERIFY_IN_PROGRESS' });
  guidedDemo = null;
  await startAllNormal();
  await resetFixtures(config);

  const c43 = await httpJson(`${SENDER_BASE}/jobs/J43/complete`, { method: 'POST' });
  await until(async () => {
    const r = await httpJson(`${RECEIVER_BASE}/inbox/E43`);
    return r.ok && r.body?.status === 'PROCESSED';
  }, 'E43 PROCESSED');

  const c42 = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
  await until(async () => {
    const r = await httpJson(`${RECEIVER_BASE}/inbox/E42`);
    return r.ok && r.body?.status === 'PROCESSED';
  }, 'E42 PROCESSED');

  const summary = await httpJson(`${RECEIVER_BASE}/videos/V7/summary`);
  return res.json({ ok: true, c43, c42, summary: summary.body });
});

app.post('/api/demo/f10-prepare', async (_req, res) => {
  if (verifyState.running) return res.status(409).json({ error: 'VERIFY_IN_PROGRESS' });
  await stopAll();
  await resetFixtures(config);
  await startService('receiver-api');
  await startService('sender-api');
  await startService('relay');
  // receiver-worker intentionally stays STOPPED!

  const complete = await httpJson(`${SENDER_BASE}/jobs/J42/complete`, { method: 'POST' });
  await until(async () => {
    const r = await httpJson(`${SENDER_BASE}/events/E42`);
    return r.ok && r.body?.status === 'DELIVERED';
  }, 'E42 DELIVERED');

  guidedDemo = {
    id: 'F10',
    title: 'F10 — Worker đang tắt: DELIVERED ≠ PROCESSED',
    target: 'receiver-worker',
    phase: 'WORKER_STOPPED',
    after_kill_hint: 'Sender đã DELIVERED, Receiver inbox mới RECEIVED và GET /videos/V7/summary trả 404! Bấm nút "Start" ở thẻ 4. Receiver Worker (hoặc nút bên dưới) để hoàn tất xử lý.',
  };
  return res.json({ ok: true, complete, guided_demo: guidedDemo });
});

// Run unit tests (node --test test/unit.test.js) directly from the UI!
app.post('/api/unit-test/run', async (_req, res) => {
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, ['--test', 'test/unit.test.js'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', c => { out += c.toString('utf8'); });
  child.stderr.on('data', c => { out += c.toString('utf8'); });
  const exitCode = await new Promise(resolve => child.once('exit', code => resolve(code)));
  const testsMatch = out.match(/# tests (\d+)/);
  const passMatch = out.match(/# pass (\d+)/);
  const failMatch = out.match(/# fail (\d+)/);
  return res.status(exitCode === 0 ? 200 : 500).json({
    ok: exitCode === 0,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    total: testsMatch ? Number(testsMatch[1]) : null,
    passed: passMatch ? Number(passMatch[1]) : null,
    failed: failMatch ? Number(failMatch[1]) : null,
    output: out,
  });
});

// Run full official harness (H0, F1..F10) directly from the UI!
app.post('/api/verify/run', async (_req, res) => {
  if (verifyState.running) return res.status(409).json({ error: 'VERIFY_ALREADY_RUNNING' });

  guidedDemo = null;
  verifyState = {
    running: true,
    started_at: new Date().toISOString(),
    finished_at: null,
    output: ['Đang dừng tạm 4 tiến trình demo để chạy harness sạch (H0 & F1–F10)...'],
    summary: null,
    results: null,
    error: null,
  };

  // Run asynchronously so UI polls live progress.
  (async () => {
    try {
      await stopAll();
      const child = spawn(process.execPath, ['scripts/harness.js', 'all'], {
        cwd: rootDir,
        env: { ...process.env, WEBHOOK_SECRET: RUN_SECRET },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const onData = chunk => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) {
          if (line.trim()) verifyState.output.push(line);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      const exitCode = await new Promise(resolve => child.once('exit', code => resolve(code)));
      if (exitCode === 0) {
        const raw = await readFile(new URL('../evidence/verification.json', import.meta.url), 'utf8');
        const parsed = JSON.parse(raw);
        verifyState.summary = parsed.summary;
        verifyState.results = parsed.results.map(r => ({
          id: r.id,
          kind: r.kind,
          title: r.title,
          status: r.status,
          duration_ms: r.duration_ms,
          kill_pid: r.observed?.kill?.pid ?? null,
          gaps: r.observed?.measured_gaps_ms ?? null,
        }));
        // Also refresh docs/REPORT.md
        execFileSync(process.execPath, ['scripts/report.js'], { cwd: rootDir, stdio: 'ignore' });
        verifyState.output.push('Đã cập nhật evidence/verification.json và docs/REPORT.md.');
      } else {
        verifyState.error = `Harness exited with code ${exitCode}`;
      }
    } catch (error) {
      verifyState.error = error.message;
    } finally {
      verifyState.finished_at = new Date().toISOString();
      verifyState.running = false;
      // Restore clean demo stack automatically after verification!
      await resetFixtures(config).catch(() => {});
      await startAllNormal().catch(() => {});
    }
  })();

  return res.status(202).json({ ok: true, started_at: verifyState.started_at });
});

app.use((error, _req, res, _next) => {
  console.error('LAB_UI_ERROR', error.message);
  res.status(500).json({ error: error.message || 'INTERNAL_ERROR' });
});

async function main() {
  stopConflictingComposeAppServices();
  await applyMigrations(config);
  await resetFixtures(config);
  await startAllNormal();

  const server = app.listen(UI_PORT, '127.0.0.1', () => {
    console.log(`LAB_UI_READY http://127.0.0.1:${UI_PORT} pid=${process.pid}`);
  });

  async function shutdown() {
    server.close();
    await stopAll();
    await senderPool.end().catch(() => {});
    await receiverPool.end().catch(() => {});
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(async error => {
  console.error('LAB_UI_FATAL', error.stack || error.message);
  await stopAll().catch(() => {});
  await senderPool.end().catch(() => {});
  await receiverPool.end().catch(() => {});
  process.exit(1);
});
