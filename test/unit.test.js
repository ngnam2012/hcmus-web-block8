import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus, validateOptions, validateFault, validateVideoInput, messageFor } from '../src/domain.js';
import { buildSummaryPrompt, extractErrorStatus, summarizeWithGemini } from '../src/gemini.js';

test('retry classification uses status/type, never error text', () => {
  for (const status of [408, 429, 500, 503, 504]) assert.equal(classifyStatus(status).transient, true);
  for (const status of [400, 401, 403, 404]) assert.equal(classifyStatus(status).transient, false);
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

test('video input validation supports dynamic transcripts and no-audio videos', () => {
  const valid = validateVideoInput({ video_id: 'V-DEMO', title: 'Demo Video', transcript: 'Xin chao cac ban' });
  assert.deepEqual(valid, { video_id: 'V-DEMO', title: 'Demo Video', transcript: 'Xin chao cac ban', has_audio: true });

  const autoId = validateVideoInput({ title: 'No Audio Video', has_audio: false });
  assert.match(autoId.video_id, /^V-[0-9a-f]{8}$/);
  assert.equal(autoId.has_audio, false);

  assert.throws(() => validateVideoInput({ title: 'Missing transcript' }), /Transcript is required/);
  assert.throws(() => validateVideoInput({ video_id: 'bad id!', title: 'X', transcript: 'abc' }), /Invalid video_id/);
});

test('gemini prompt builder includes language, style, title and transcript', () => {
  const { systemInstruction, input } = buildSummaryPrompt({
    title: 'Docker Intro',
    transcript: 'Containers package code and dependencies.',
    options: { language: 'en', style: 'detailed' },
  });
  assert.match(systemInstruction, /summarizer/i);
  assert.match(input, /Output language: English/);
  assert.match(input, /Summary style: detailed/);
  assert.match(input, /Video title: Docker Intro/);
  assert.match(input, /Containers package code and dependencies\./);
});

test('gemini error mapping extracts HTTP status codes and timeouts accurately', async () => {
  assert.equal(extractErrorStatus({ status: 429 }), 429);
  assert.equal(extractErrorStatus({ statusCode: 400 }), 400);
  assert.equal(extractErrorStatus({ name: 'RequestTimeoutError' }), 504);
  assert.equal(extractErrorStatus(new Error('network down')), 503);

  await assert.rejects(
    () => summarizeWithGemini({ transcript: 'hello', apiKey: '', model: 'gemini-3.5-flash-lite' }),
    err => err.status === 401 && /GEMINI_API_KEY/.test(err.message),
  );
});
