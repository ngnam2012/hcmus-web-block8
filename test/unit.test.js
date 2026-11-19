import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus, validateOptions, validateFault, validateVideoInput, messageFor } from '../src/domain.js';
import { buildSummaryPrompt, extractErrorStatus, summarizeWithGemini } from '../src/gemini.js';
import {
  extractYouTubeId,
  canonicalYouTubeUrl,
  cleanSubtitleText,
  parseYouTubeCaptionJson3,
  parseYouTubeCaptionXml,
  pickCaptionTrack,
  assertSafePublicHttpUrl,
} from '../src/transcript.js';

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

test('youtube url extraction, subtitle cleanup and track selection work reliably', () => {
  assert.equal(extractYouTubeId('https://www.youtube.com/watch?v=9hE5-98ZeCg&t=10s'), '9hE5-98ZeCg');
  assert.equal(extractYouTubeId('https://youtu.be/9hE5-98ZeCg?si=abc'), '9hE5-98ZeCg');
  assert.equal(extractYouTubeId('https://youtube.com/shorts/9hE5-98ZeCg'), '9hE5-98ZeCg');
  assert.equal(extractYouTubeId('https://example.com/watch?v=9hE5-98ZeCg'), null);
  assert.equal(canonicalYouTubeUrl('9hE5-98ZeCg'), 'https://www.youtube.com/watch?v=9hE5-98ZeCg');

  const vtt = [
    'WEBVTT',
    'Kind: captions',
    'Language: vi',
    '',
    '00:00:01.000 --> 00:00:03.000',
    '<c>Xin chào &amp; cảm ơn</c>',
    '',
    '00:00:03.000 --> 00:00:05.000',
    'Xin chào &amp; cảm ơn',
    'Dòng thứ hai',
  ].join('\n');
  assert.equal(cleanSubtitleText(vtt), 'Xin chào & cảm ơn\nDòng thứ hai');

  const json3 = parseYouTubeCaptionJson3({
    events: [
      { segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
      { segs: [{ utf8: 'Hello world' }] },
      { segs: [{ utf8: 'Second line' }] },
    ],
  });
  assert.equal(json3, 'Hello world\nSecond line');

  const xml = '<transcript><text start="0" dur="2">Line &amp; 1</text><text start="2" dur="2">Line 2</text></transcript>';
  assert.equal(parseYouTubeCaptionXml(xml), 'Line & 1\nLine 2');

  const tracks = [
    { languageCode: 'en', kind: 'asr', baseUrl: 'https://example.com/en-asr' },
    { languageCode: 'vi', kind: 'asr', baseUrl: 'https://example.com/vi-asr' },
    { languageCode: 'vi', baseUrl: 'https://example.com/vi-manual' },
  ];
  assert.equal(pickCaptionTrack(tracks, 'vi')?.baseUrl, 'https://example.com/vi-manual');
});

test('subtitle url validation blocks private and internal network targets', async () => {
  await assert.rejects(() => assertSafePublicHttpUrl('http://127.0.0.1:3001/health'), /nội bộ/);
  await assert.rejects(() => assertSafePublicHttpUrl('http://postgres:5432/'), /nội bộ/);
  await assert.rejects(() => assertSafePublicHttpUrl('http://169.254.169.254/latest'), /nội bộ/);
  await assert.rejects(
    () => assertSafePublicHttpUrl('https://sub.example.com/test.vtt', async () => [{ address: '10.0.0.5', family: 4 }]),
    /nội bộ/,
  );
  const safe = await assertSafePublicHttpUrl('https://example.com/sub.vtt', async () => [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(safe.href, 'https://example.com/sub.vtt');
});

test('video validation and gemini prompt support youtube links without local transcript', () => {
  const ytVideo = validateVideoInput({
    title: 'YouTube Clip',
    video_url: 'https://youtu.be/9hE5-98ZeCg?t=5',
  });
  assert.equal(ytVideo.video_url, 'https://www.youtube.com/watch?v=9hE5-98ZeCg');
  assert.equal(ytVideo.transcript, '');

  assert.throws(
    () => validateVideoInput({ title: 'Non-YouTube link', video_url: 'https://example.com/sub.vtt' }),
    /Transcript is required/,
  );

  const prompt = buildSummaryPrompt({
    title: 'YouTube Clip',
    videoUrl: 'https://www.youtube.com/watch?v=9hE5-98ZeCg',
    options: { language: 'vi', style: 'short' },
  });
  assert.equal(Array.isArray(prompt.input), true);
  assert.deepEqual(prompt.input[1], { type: 'video', uri: 'https://www.youtube.com/watch?v=9hE5-98ZeCg' });
});
