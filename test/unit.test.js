import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertValidFixedTargetUrl,
  isLoopbackAddress,
  requireLoopbackAdmin,
  requireWebhookSecret,
} from '../src/config.js';
import { sha256Hex, signWebhook, verifyWebhookSignature } from '../src/crypto.js';
import {
  buildSummaryCompletedPayload,
  classifyDeliveryResponse,
  computeRetryDelayMs,
  deriveEventId,
  parseAndValidateEvent,
  parseRetryAfterMs,
} from '../src/protocol.js';

const TEST_SECRET = 'unit-test-only-ephemeral-secret';

test('HMAC-SHA256 signs exact UTF8(timestamp + ".") || raw_body_bytes and verifies constant-time', () => {
  const rawBody = Buffer.from('{"event_id":"E42","type":"summary.completed","data":{"version":1}}', 'utf8');
  const nowSec = 1794988800;
  const sig = signWebhook({ secret: TEST_SECRET, timestamp: nowSec, rawBody });

  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    verifyWebhookSignature({
      secret: TEST_SECRET,
      timestampHeader: String(nowSec),
      signatureHeader: sig,
      rawBody,
      nowSec,
    }),
    { ok: true, timestamp: nowSec },
  );

  // Re-serializing JSON with extra whitespace changes raw bytes and MUST fail verification.
  const reformattedBody = Buffer.from(
    '{ "event_id": "E42", "type": "summary.completed", "data": { "version": 1 } }',
    'utf8',
  );
  const res = verifyWebhookSignature({
    secret: TEST_SECRET,
    timestampHeader: String(nowSec),
    signatureHeader: sig,
    rawBody: reformattedBody,
    nowSec,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'SIGNATURE_MISMATCH');
});

test('timestamp window rejects both too-old and too-far-future timestamps (> 300s)', () => {
  const rawBody = Buffer.from('{"a":1}', 'utf8');
  const nowSec = 1794988800;

  for (const delta of [-300, 0, 300]) {
    const ts = nowSec + delta;
    const sig = signWebhook({ secret: TEST_SECRET, timestamp: ts, rawBody });
    assert.equal(
      verifyWebhookSignature({
        secret: TEST_SECRET,
        timestampHeader: String(ts),
        signatureHeader: sig,
        rawBody,
        nowSec,
        windowSec: 300,
      }).ok,
      true,
    );
  }

  for (const delta of [-301, 301, -999, 999]) {
    const ts = nowSec + delta;
    const sig = signWebhook({ secret: TEST_SECRET, timestamp: ts, rawBody });
    const result = verifyWebhookSignature({
      secret: TEST_SECRET,
      timestampHeader: String(ts),
      signatureHeader: sig,
      rawBody,
      nowSec,
      windowSec: 300,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'TIMESTAMP_OUT_OF_WINDOW');
  }

  for (const badTs of [undefined, '', '-10', '1794988800.5', 'not-a-number']) {
    const result = verifyWebhookSignature({
      secret: TEST_SECRET,
      timestampHeader: badTs,
      signatureHeader: 'a'.repeat(64),
      rawBody,
      nowSec,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'INVALID_TIMESTAMP');
  }
});

test('signature format and wrong secret are rejected before JSON parse', () => {
  const notEvenJson = Buffer.from('<<<not-json>>>', 'utf8');
  const nowSec = 1794988800;
  const sigWithOtherSecret = signWebhook({ secret: 'different-secret', timestamp: nowSec, rawBody: notEvenJson });

  assert.equal(
    verifyWebhookSignature({
      secret: TEST_SECRET,
      timestampHeader: String(nowSec),
      signatureHeader: sigWithOtherSecret,
      rawBody: notEvenJson,
      nowSec,
    }).reason,
    'SIGNATURE_MISMATCH',
  );

  assert.equal(
    verifyWebhookSignature({
      secret: TEST_SECRET,
      timestampHeader: String(nowSec),
      signatureHeader: 'short',
      rawBody: notEvenJson,
      nowSec,
    }).reason,
    'INVALID_SIGNATURE_FORMAT',
  );
});

test('event payload builder and strict schema validator enforce required fields and positive integer version', () => {
  const eventId = deriveEventId('J42');
  assert.equal(eventId, 'E42');
  assert.equal(deriveEventId('J43'), 'E43');

  const payload = buildSummaryCompletedPayload(
    { job_id: 'J42', video_id: 'V7', version: 1, summary: 'Fixture summary' },
    eventId,
    '2026-11-18T08:00:00.000Z',
  );
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  assert.equal(sha256Hex(raw).length, 64);

  const ok = parseAndValidateEvent(raw);
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.event_id, 'E42');
  assert.equal(ok.payload.data.version, 1);

  assert.equal(parseAndValidateEvent(Buffer.from('not json')).ok, false);
  assert.equal(parseAndValidateEvent(Buffer.from(JSON.stringify({ ...payload, type: 'other' }))).ok, false);
  assert.equal(parseAndValidateEvent(Buffer.from(JSON.stringify({ ...payload, schema_version: 2 }))).ok, false);
  assert.equal(parseAndValidateEvent(Buffer.from(JSON.stringify({ ...payload, occurred_at: 'bad-date' }))).ok, false);
  assert.equal(
    parseAndValidateEvent(Buffer.from(JSON.stringify({ ...payload, data: { ...payload.data, version: 0 } }))).ok,
    false,
  );
  assert.equal(
    parseAndValidateEvent(Buffer.from(JSON.stringify({ ...payload, data: { ...payload.data, version: 1.5 } }))).ok,
    false,
  );
  assert.equal(
    parseAndValidateEvent(Buffer.from(JSON.stringify({ ...payload, data: { ...payload.data, summary: '' } }))).ok,
    false,
  );
});

test('relay response classifier maps 2xx, 429/5xx, and 3xx/other-4xx strictly per Block 9 contract', () => {
  for (const status of [200, 201, 202, 204]) {
    const res = classifyDeliveryResponse({ status });
    assert.equal(res.outcome, 'ACKNOWLEDGED');
    assert.equal(res.nextOutboxStatus, 'DELIVERED');
  }

  for (const status of [500, 502, 503, 504]) {
    const res = classifyDeliveryResponse({ status });
    assert.equal(res.outcome, 'RETRYABLE');
    assert.equal(res.nextOutboxStatus, 'PENDING');
  }

  const rateLimited = classifyDeliveryResponse({ status: 429, retryAfterHeader: '20' });
  assert.equal(rateLimited.outcome, 'RETRYABLE');
  assert.equal(rateLimited.retryAfterMs, 20000);

  for (const status of [301, 302, 307, 400, 401, 403, 404, 409, 422]) {
    const res = classifyDeliveryResponse({ status });
    assert.equal(res.outcome, 'REJECTED');
    assert.equal(res.nextOutboxStatus, 'DEAD');
  }
});

test('Retry-After parser and backoff policy respect 1/3/9s schedule, 4-attempt cap, and Retry-After floor', () => {
  const nowMs = Date.parse('2026-11-19T00:00:00.000Z');
  assert.equal(parseRetryAfterMs('20', nowMs), 20000);
  assert.equal(parseRetryAfterMs('Thu, 19 Nov 2026 00:00:15 GMT', nowMs), 15000);
  assert.equal(parseRetryAfterMs('invalid', nowMs), null);
  assert.equal(parseRetryAfterMs('-5', nowMs), null);

  assert.equal(computeRetryDelayMs({ attemptInRound: 1 }), 1000);
  assert.equal(computeRetryDelayMs({ attemptInRound: 2 }), 3000);
  assert.equal(computeRetryDelayMs({ attemptInRound: 3 }), 9000);
  assert.equal(computeRetryDelayMs({ attemptInRound: 4 }), null);

  // 429 with Retry-After: 20s must wait at least 20s (greater than 1s backoff).
  assert.equal(computeRetryDelayMs({ attemptInRound: 1, retryAfterMs: 20000 }), 20000);
  // 429 with Retry-After: 2s on attempt 3 must still wait at least 9s lab backoff.
  assert.equal(computeRetryDelayMs({ attemptInRound: 3, retryAfterMs: 2000 }), 9000);
});

test('fixed target URL validation restricts endpoint to loopback / receiver-api and requires webhook secret', () => {
  assert.equal(
    assertValidFixedTargetUrl('http://127.0.0.1:4100/webhooks/summaries'),
    'http://127.0.0.1:4100/webhooks/summaries',
  );
  assert.equal(
    assertValidFixedTargetUrl('http://localhost:4100/webhooks/summaries'),
    'http://localhost:4100/webhooks/summaries',
  );
  assert.equal(
    assertValidFixedTargetUrl('http://receiver-api:4100/webhooks/summaries'),
    'http://receiver-api:4100/webhooks/summaries',
  );

  assert.throws(() => assertValidFixedTargetUrl('http://169.254.169.254/latest'), /loopback/);
  assert.throws(() => assertValidFixedTargetUrl('https://evil.example.com/hook'), /loopback/);
  assert.throws(() => assertValidFixedTargetUrl('ftp://127.0.0.1/hook'), /protocol/);
  assert.throws(() => assertValidFixedTargetUrl('not-a-url'), /Invalid/);
  assert.throws(() => requireWebhookSecret({ webhookSecret: '' }), /WEBHOOK_SECRET is required/);
});

test('HMAC-SHA256 handles multi-byte UTF-8 Vietnamese payloads byte-accurately', () => {
  const payload = JSON.stringify({
    event_id: 'E42',
    type: 'summary.completed',
    schema_version: 1,
    occurred_at: '2026-11-19T03:00:00.000Z',
    data: {
      job_id: 'J42',
      video_id: 'V7',
      version: 1,
      summary: 'Nội dung tóm tắt giả định tiếng Việt có dấu đầy đủ ă â đ ê ô ơ ư.',
    },
  });
  const rawBuf = Buffer.from(payload, 'utf8');
  assert.ok(rawBuf.length > payload.length, 'UTF-8 byte length should exceed JS string length');
  const nowSec = 1794988800;
  const sig = signWebhook({ secret: TEST_SECRET, timestamp: nowSec, rawBody: rawBuf });
  assert.equal(
    verifyWebhookSignature({
      secret: TEST_SECRET,
      timestampHeader: String(nowSec),
      signatureHeader: sig,
      rawBody: rawBuf,
      nowSec,
    }).ok,
    true,
  );
});

test('requireLoopbackAdmin enforces loopback remoteAddress and ignores spoofed X-Forwarded-For', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.10'), false);
  assert.equal(isLoopbackAddress('::ffff:172.18.0.1'), false);
  assert.equal(isLoopbackAddress('203.0.113.9'), false);
  assert.equal(isLoopbackAddress(''), false);

  const runGuard = (remoteAddress, cfg = { allowDockerBridgeAdmin: false }) => {
    const mw = requireLoopbackAdmin(cfg);
    let nextCalled = false;
    let statusCode = null;
    let jsonBody = null;
    const req = {
      socket: { remoteAddress },
      headers: { 'x-forwarded-for': '127.0.0.1' },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        jsonBody = body;
        return this;
      },
    };
    mw(req, res, () => {
      nextCalled = true;
    });
    return { nextCalled, statusCode, jsonBody };
  };

  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.deepEqual(runGuard(addr), { nextCalled: true, statusCode: null, jsonBody: null });
  }

  for (const addr of ['192.168.1.10', '::ffff:172.18.0.1', '10.0.0.5', '203.0.113.9', '']) {
    const out = runGuard(addr);
    assert.equal(out.nextCalled, false);
    assert.equal(out.statusCode, 403);
    assert.equal(out.jsonBody?.error, 'LOOPBACK_ONLY');
  }

  // Only when explicitly enabled in compose.yaml (where host port is pinned to 127.0.0.1)
  assert.equal(runGuard('::ffff:172.18.0.1', { allowDockerBridgeAdmin: true }).nextCalled, true);
  assert.equal(runGuard('203.0.113.9', { allowDockerBridgeAdmin: true }).statusCode, 403);
});
