import { randomUUID } from 'node:crypto';
import {
  BACKOFF_MS,
  EVENT_TYPE_SUMMARY_COMPLETED,
  MAX_ATTEMPTS_PER_ROUND,
  SCHEMA_VERSION,
} from './config.js';

export function deriveEventId(jobId) {
  if (typeof jobId === 'string' && /^J[A-Za-z0-9._-]+$/.test(jobId)) {
    return `E${jobId.slice(1)}`;
  }
  return `E-${randomUUID()}`;
}

export function buildSummaryCompletedPayload(job, eventId, occurredAt = new Date().toISOString()) {
  return {
    event_id: eventId,
    type: EVENT_TYPE_SUMMARY_COMPLETED,
    schema_version: SCHEMA_VERSION,
    occurred_at: occurredAt,
    data: {
      job_id: job.job_id,
      video_id: job.video_id,
      version: job.version,
      summary: job.summary,
    },
  };
}

function isNonEmptyString(value, maxLen = 128) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLen;
}

export function parseAndValidateEvent(rawBodyBuffer) {
  let payload;
  try {
    const text = Buffer.isBuffer(rawBodyBuffer) ? rawBodyBuffer.toString('utf8') : String(rawBodyBuffer);
    payload = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'Body is not valid JSON' };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, detail: 'Payload must be a JSON object' };
  }
  if (!isNonEmptyString(payload.event_id, 128)) {
    return { ok: false, detail: 'event_id must be a non-empty string' };
  }
  if (payload.type !== EVENT_TYPE_SUMMARY_COMPLETED) {
    return { ok: false, detail: `type must be "${EVENT_TYPE_SUMMARY_COMPLETED}"` };
  }
  if (payload.schema_version !== SCHEMA_VERSION) {
    return { ok: false, detail: `schema_version must be ${SCHEMA_VERSION}` };
  }
  if (typeof payload.occurred_at !== 'string' || Number.isNaN(Date.parse(payload.occurred_at))) {
    return { ok: false, detail: 'occurred_at must be a valid ISO-8601 timestamp string' };
  }

  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, detail: 'data must be an object' };
  }
  if (!isNonEmptyString(data.job_id, 128)) {
    return { ok: false, detail: 'data.job_id must be a non-empty string' };
  }
  if (!isNonEmptyString(data.video_id, 128)) {
    return { ok: false, detail: 'data.video_id must be a non-empty string' };
  }
  if (!Number.isInteger(data.version) || data.version <= 0) {
    return { ok: false, detail: 'data.version must be a positive integer' };
  }
  if (!isNonEmptyString(data.summary, 50000)) {
    return { ok: false, detail: 'data.summary must be a non-empty string' };
  }

  return { ok: true, payload };
}

export function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }

  // Only treat values containing alphabetic characters (e.g., RFC 9110 HTTP-date) as dates,
  // preventing V8 Date.parse from accepting negative numbers like "-5".
  if (!/[a-zA-Z]/.test(trimmed)) {
    return null;
  }

  const parsedMs = Date.parse(trimmed);
  if (!Number.isNaN(parsedMs)) {
    return Math.max(0, parsedMs - nowMs);
  }
  return null;
}

/**
 * Relay HTTP response classification (Block 9 Contract API):
 * - 2xx: ACKNOWLEDGED -> outbox DELIVERED
 * - 429, 5xx: RETRYABLE (with Retry-After respected on 429)
 * - 3xx, other 4xx (400, 401, 404, 409, ...): REJECTED -> outbox DEAD immediately
 */
export function classifyDeliveryResponse({ status, retryAfterHeader = null, nowMs = Date.now() }) {
  if (status >= 200 && status <= 299) {
    return { outcome: 'ACKNOWLEDGED', nextOutboxStatus: 'DELIVERED', retryAfterMs: null };
  }
  if (status === 429) {
    return {
      outcome: 'RETRYABLE',
      nextOutboxStatus: 'PENDING',
      retryAfterMs: parseRetryAfterMs(retryAfterHeader, nowMs),
    };
  }
  if (status >= 500 && status <= 599) {
    return { outcome: 'RETRYABLE', nextOutboxStatus: 'PENDING', retryAfterMs: null };
  }
  return { outcome: 'REJECTED', nextOutboxStatus: 'DEAD', retryAfterMs: null };
}

/**
 * Returns delay in ms before the next attempt, or null if round attempts are exhausted (DEAD).
 */
export function computeRetryDelayMs({
  attemptInRound,
  retryAfterMs = null,
  maxAttempts = MAX_ATTEMPTS_PER_ROUND,
  backoffMs = BACKOFF_MS,
}) {
  if (attemptInRound >= maxAttempts) {
    return null;
  }
  const idx = Math.max(0, Math.min(attemptInRound - 1, backoffMs.length - 1));
  const baseMs = backoffMs[idx];
  return Math.max(baseMs, retryAfterMs ?? 0);
}
