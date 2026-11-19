export const EVENT_TYPE_SUMMARY_COMPLETED = 'summary.completed';
export const SCHEMA_VERSION = 1;
export const MAX_ATTEMPTS_PER_ROUND = 4;
export const BACKOFF_MS = [1000, 3000, 9000];

function positiveInt(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  return {
    bindHost: env.BIND_HOST || '127.0.0.1',
    senderPort: positiveInt(env.SENDER_PORT, 4000, 'SENDER_PORT'),
    receiverPort: positiveInt(env.RECEIVER_PORT, 4100, 'RECEIVER_PORT'),
    relayHealthPort: positiveInt(env.RELAY_HEALTH_PORT, 4002, 'RELAY_HEALTH_PORT'),
    workerHealthPort: positiveInt(env.WORKER_HEALTH_PORT, 4102, 'WORKER_HEALTH_PORT'),
    relayHealthUrl: (env.RELAY_HEALTH_URL || `http://127.0.0.1:${positiveInt(env.RELAY_HEALTH_PORT, 4002, 'RELAY_HEALTH_PORT')}/health`).trim(),
    workerHealthUrl: (env.WORKER_HEALTH_URL || `http://127.0.0.1:${positiveInt(env.WORKER_HEALTH_PORT, 4102, 'WORKER_HEALTH_PORT')}/health`).trim(),
    receiverPublicUrl: (env.RECEIVER_PUBLIC_URL || `http://127.0.0.1:${positiveInt(env.RECEIVER_PORT, 4100, 'RECEIVER_PORT')}`).trim(),
    pgAdminDatabaseUrl: env.PG_ADMIN_DATABASE_URL || 'postgres://lab:lab@127.0.0.1:5439/postgres',
    senderDatabaseUrl: env.SENDER_DATABASE_URL || 'postgres://lab:lab@127.0.0.1:5439/sender_db',
    receiverDatabaseUrl: env.RECEIVER_DATABASE_URL || 'postgres://lab:lab@127.0.0.1:5439/receiver_db',
    webhookSecret: (env.WEBHOOK_SECRET || '').trim(),
    webhookSource: (env.WEBHOOK_SOURCE || 'sender-lab').trim(),
    webhookTargetUrl: (env.WEBHOOK_TARGET_URL || 'http://127.0.0.1:4100/webhooks/summaries').trim(),
    webhookTimeoutMs: positiveInt(env.WEBHOOK_TIMEOUT_MS, 2000, 'WEBHOOK_TIMEOUT_MS'),
    timestampWindowSec: positiveInt(env.WEBHOOK_TIMESTAMP_WINDOW_SEC, 300, 'WEBHOOK_TIMESTAMP_WINDOW_SEC'),
    relayPollIntervalMs: positiveInt(env.RELAY_POLL_INTERVAL_MS, 100, 'RELAY_POLL_INTERVAL_MS'),
    workerPollIntervalMs: positiveInt(env.WORKER_POLL_INTERVAL_MS, 100, 'WORKER_POLL_INTERVAL_MS'),
    labMode: env.LAB_MODE === 'true',
    allowDockerBridgeAdmin: env.ALLOW_DOCKER_BRIDGE_ADMIN === 'true',
    marker: (env.MARKER || '').trim(),
  };
}

export const config = loadConfig();

export function requireWebhookSecret(cfg = config) {
  if (!cfg.webhookSecret) {
    throw new Error('WEBHOOK_SECRET is required (copy .env.example to .env and set a local secret)');
  }
  return cfg.webhookSecret;
}

const ALLOWED_TARGET_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', 'receiver-api']);

export function assertValidFixedTargetUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid WEBHOOK_TARGET_URL: ${urlString}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported WEBHOOK_TARGET_URL protocol: ${parsed.protocol}`);
  }
  if (!ALLOWED_TARGET_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`WEBHOOK_TARGET_URL host must be loopback or receiver-api, got: ${parsed.hostname}`);
  }
  return parsed.toString();
}

function normalizeIpv4(remoteAddress) {
  if (typeof remoteAddress !== 'string') return null;
  const addr = remoteAddress.trim().toLowerCase();
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export function isLoopbackAddress(remoteAddress) {
  if (typeof remoteAddress !== 'string') return false;
  const addr = remoteAddress.trim().toLowerCase();
  if (addr === '::1') return true;
  const ipv4 = normalizeIpv4(addr);
  if (!ipv4) return false;
  const m = ipv4.match(/^127\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  return m.slice(1).every(part => Number(part) <= 255);
}

function isPrivateContainerBridgeAddress(remoteAddress) {
  const ipv4 = normalizeIpv4(remoteAddress);
  if (!ipv4) return false;
  const m = ipv4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some(n => n > 255)) return false;
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Application-layer loopback guard for admin routes (e.g., POST /events/:event_id/replay, /_lab/*).
 * Inspects req.socket.remoteAddress directly (never trusts spoofable X-Forwarded-For headers).
 * When running inside Docker Compose with host ports pinned to 127.0.0.1, ALLOW_DOCKER_BRIDGE_ADMIN=true
 * permits requests arriving from the container bridge gateway.
 */
export function requireLoopbackAdmin(cfg = config) {
  return (req, res, next) => {
    const remoteAddress = req.socket?.remoteAddress || '';
    if (isLoopbackAddress(remoteAddress)) {
      return next();
    }
    if (cfg.allowDockerBridgeAdmin && isPrivateContainerBridgeAddress(remoteAddress)) {
      return next();
    }
    return res.status(403).json({
      error: 'LOOPBACK_ONLY',
      detail: 'Admin routes are restricted to loopback addresses',
    });
  };
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
