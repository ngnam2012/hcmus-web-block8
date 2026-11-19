import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const HEX_64_RE = /^[0-9a-f]{64}$/i;
const UNSIGNED_INT_RE = /^\d+$/;

export function toBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
  throw new TypeError('rawBody must be a Buffer, Uint8Array, or string');
}

export function sha256Hex(rawBody) {
  return createHash('sha256').update(toBuffer(rawBody)).digest('hex');
}

/**
 * signed_bytes = UTF8(timestamp + ".") || raw_body_bytes
 * signature    = hex(HMAC_SHA256(secret, signed_bytes))
 */
export function signWebhook({ secret, timestamp, rawBody }) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('Webhook secret must be a non-empty string');
  }
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || ts < 0) {
    throw new Error('Webhook timestamp must be a non-negative integer Unix timestamp');
  }
  const bodyBuf = toBuffer(rawBody);
  const prefixBuf = Buffer.from(`${ts}.`, 'utf8');
  const signedBytes = Buffer.concat([prefixBuf, bodyBuf]);
  return createHmac('sha256', secret).update(signedBytes).digest('hex');
}

/**
 * Receiver checks in strict order BEFORE parsing JSON:
 * 1) Timestamp is an integer Unix seconds within abs(now - timestamp) <= windowSec (both past & future)
 * 2) Signature is 64-char hex matching HMAC_SHA256(secret, UTF8(ts + ".") || rawBody) using constant-time compare
 */
export function verifyWebhookSignature({
  secret,
  timestampHeader,
  signatureHeader,
  rawBody,
  nowSec = Math.floor(Date.now() / 1000),
  windowSec = 300,
}) {
  if (typeof timestampHeader !== 'string' || !UNSIGNED_INT_RE.test(timestampHeader.trim())) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' };
  }
  const timestamp = Number(timestampHeader.trim());
  if (!Number.isSafeInteger(timestamp)) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' };
  }
  if (Math.abs(nowSec - timestamp) > windowSec) {
    return { ok: false, reason: 'TIMESTAMP_OUT_OF_WINDOW', timestamp, nowSec };
  }
  if (typeof signatureHeader !== 'string' || !HEX_64_RE.test(signatureHeader.trim())) {
    return { ok: false, reason: 'INVALID_SIGNATURE_FORMAT' };
  }

  const expectedHex = signWebhook({ secret, timestamp, rawBody });
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const providedBuf = Buffer.from(signatureHeader.trim().toLowerCase(), 'hex');
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: 'SIGNATURE_MISMATCH' };
  }
  return { ok: true, timestamp };
}
