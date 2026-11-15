import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus, validateOptions, validateFault, messageFor } from '../src/domain.js';

test('retry classification uses status/type, never error text', () => {
  for (const status of [429, 500, 503]) assert.equal(classifyStatus(status).transient, true);
  for (const status of [400, 401, 404]) assert.equal(classifyStatus(status).transient, false);
});
test('lab-only fault injection cannot leak into normal API mode', () => {
  assert.throws(() => validateOptions({ pause_at: 'before_llm_call' }), /Unsupported/);
  assert.throws(() => validateOptions({ mock: { status: 429 } }), /Unsupported/);
  assert.deepEqual(validateOptions({ language: 'vi', style: 'short' }), { language: 'vi', style: 'short' });
  assert.throws(() => validateFault({ delay_ms: -1 }), /Invalid/);
  assert.throws(() => validateFault({ status: 201 }), /Invalid/);
  assert.throws(() => validateOptions({ pause_at: 'wrong' }, true), /Invalid/);
});
test('message envelope keeps identity and metadata without the video payload', () => {
  const job = { job_id: 'j', message_id: 'm', video_id: 'V1', version: 2, correlation_id: 'c', created_at: '2026-11-15T00:00:00Z', options: { language: 'vi' }, transcript: 'must stay out' };
  const message = messageFor(job);
  assert.equal(message.message_id, 'm');
  assert.equal(message.version, 2);
  assert.equal(message.correlation_id, 'c');
  assert.equal(message.created_at, '2026-11-15T00:00:00.000Z');
  assert.equal('transcript' in message, false);
});
