import express from 'express';
import { randomUUID } from 'node:crypto';
import { pool, transaction, withJobLock, ensureSchema } from './db.js';
import { broker } from './broker.js';
import { config, QUEUE, DLQ } from './config.js';
import { validateOptions, validateVideoInput, messageFor, ProcessingError } from './domain.js';
import { fetchTranscriptFromLink } from './transcript.js';
import { startAttempt, finishAttempt, callLlm, commitSummary } from './processing.js';

async function fetchLlmHealth() {
  try {
    const response = await fetch(`${config.mockUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (response.ok) return await response.json();
  } catch {}
  return { status: 'unreachable', provider: config.llmProvider, model: config.geminiModel, gemini_configured: Boolean(config.geminiApiKey) };
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));
app.get('/dashboard', async (_req,res) => {
  const tables={};
  for(const table of ['videos','jobs','summaries','processing_attempts','replay_events','checkpoint_events']) tables[table]=(await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
  const connection=await broker.connect(); const ch=await connection.createChannel();
  const queues=[];
  try { for(const name of ['summaries.main','summaries.dlq','summaries.retry.1000','summaries.retry.3000','summaries.retry.9000']) { const q=await ch.checkQueue(name); queues.push({name,ready:q.messageCount,consumers:q.consumerCount}); } } finally {await ch.close();}
  const calls=(await pool.query('SELECT job_id,COUNT(*)::int AS count FROM mock_calls GROUP BY job_id')).rows;
  let brokerStats=[];
  try { const response=await fetch(`${process.env.RABBIT_MANAGEMENT_URL || 'http://127.0.0.1:15678'}/api/queues/%2F`,{headers:{authorization:'Basic '+Buffer.from(`${process.env.RABBIT_USER || 'lab'}:${process.env.RABBIT_PASSWORD || 'lab'}`).toString('base64')},signal:AbortSignal.timeout(2000)}); if(response.ok) brokerStats=await response.json(); } catch {}
  for(const q of queues) q.unacked=brokerStats.find(x=>x.name===q.name)?.messages_unacknowledged ?? null;
  const llm = await fetchLlmHealth();
  res.json({tables,queues,calls,llm});
});
app.put('/dashboard/faults/:jobId', async(req,res)=>{
  if(!config.labMode) return res.sendStatus(404);
  const response=await fetch(`${config.mockUrl}/faults/${req.params.jobId}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(req.body)});
  res.status(response.status).json(await response.json());
});

app.param('jobId', (req, res, next, id) => /^[0-9a-f-]{36}$/i.test(id) ? next() : res.status(400).json({ error: 'Invalid job_id' }));
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    await broker.connect();
    const llm = await fetchLlmHealth();
    res.json({ status: 'ok', database: true, broker: true, mode: process.env.APP_VERSION || 'V3', llm });
  } catch { res.status(503).json({ status: 'degraded' }); }
});

app.get('/videos', async (_req, res) => {
  const { rows } = await pool.query('SELECT video_id, title, transcript, video_url, has_audio, next_version, current_version, current_summary_id FROM videos ORDER BY video_id');
  res.json(rows);
});

app.post('/videos/transcript-from-link', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const language = typeof req.body?.language === 'string' ? req.body.language.trim() : 'vi';
  if (!url || url.length > 1000) return res.status(400).json({ error: 'Invalid link URL' });
  try {
    const result = await fetchTranscriptFromLink(url, { preferredLang: language || 'vi' });
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Không lấy được transcript từ link' });
  }
});

app.post('/videos', async (req, res) => {
  let payload = req.body && typeof req.body === 'object' ? { ...req.body } : req.body;
  if (payload && typeof payload.video_url === 'string' && payload.video_url.trim() && (!payload.title || (!payload.transcript && payload.auto_fetch === true))) {
    try {
      const fetched = await fetchTranscriptFromLink(payload.video_url.trim(), { preferredLang: payload.language || 'vi' });
      payload = {
        ...payload,
        video_url: fetched.video_url,
        title: payload.title || fetched.title,
        transcript: payload.transcript || fetched.transcript || '',
      };
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }
  let video;
  try { video = validateVideoInput(payload); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  try {
    const { rows: [created] } = await pool.query(
      'INSERT INTO videos(video_id,title,transcript,video_url,has_audio) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [video.video_id, video.title, video.transcript, video.video_url || null, video.has_audio],
    );
    return res.status(201).json(created);
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'Video ID already exists' });
    throw error;
  }
});

app.post('/summaries', async (req, res) => {
  let options;
  try { options = validateOptions(req.body?.options, config.labMode); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const videoId = req.body?.video_id;
  if (typeof videoId !== 'string' || videoId.length > 100) return res.status(400).json({ error: 'Invalid video_id' });
  const correlationId = req.get('x-correlation-id') || randomUUID();
  if (correlationId.length > 200) return res.status(400).json({ error: 'Invalid correlation_id' });
  const job = await transaction(async client => {
    const { rows: [video] } = await client.query('UPDATE videos SET next_version=next_version+1 WHERE video_id=$1 RETURNING next_version', [videoId]);
    if (!video) return null;
    const { rows: [created] } = await client.query(`INSERT INTO jobs(job_id,message_id,video_id,version,correlation_id,options)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), randomUUID(), videoId, video.next_version, correlationId, options]);
    if (options.mock) await client.query('INSERT INTO mock_faults(job_id,config) VALUES($1,$2)', [created.job_id, options.mock]);
    return created;
  });
  if (!job) return res.status(404).json({ error: 'Video not found' });
  const result = { job_id: job.job_id, message_id: job.message_id, status_url: `/summaries/${job.job_id}` };
  if (process.env.APP_VERSION === 'V0') {
    try {
      await withJobLock(job.job_id, async client => {
        const attempt = await startAttempt(client, job, 'api-sync', false);
        try { await commitSummary(client, job, attempt, await callLlm(client, job)); }
        catch (error) { await finishAttempt(client, attempt, error.transient ? 'TRANSIENT_ERROR' : 'PERMANENT_ERROR', error.type || 'INTERNAL'); throw error; }
      });
      return res.status(200).json({ ...result, status: 'DONE' });
    } catch (error) { return res.status(error instanceof ProcessingError ? 502 : 500).json({ ...result, error: error.type || error.message }); }
  }
  try {
    await broker.publish(QUEUE, messageFor(job));
    return res.status(202).location(result.status_url).json(result);
  } catch (error) {
    // Intentionally preserve gap 1 for F6. No RAM retry or outbox in block 8.
    return res.status(503).json({ ...result, error: 'BROKER_NOT_CONFIRMED', detail: error.message });
  }
});

app.get('/summaries/:jobId/attempts', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM processing_attempts WHERE job_id=$1 ORDER BY attempt_no', [req.params.jobId]);
  res.json(rows);
});
app.get('/summaries/:jobId', async (req, res) => {
  const { rows: [job] } = await pool.query(`SELECT j.*,s.content AS summary FROM jobs j LEFT JOIN summaries s USING(job_id) WHERE job_id=$1`, [req.params.jobId]);
  res.status(job ? 200 : 404).json(job || { error: 'Job not found' });
});
app.get('/videos/:videoId/summary', async (req, res) => {
  const { rows: [summary] } = await pool.query(`SELECT s.* FROM videos v JOIN summaries s ON s.summary_id=v.current_summary_id WHERE v.video_id=$1`, [req.params.videoId]);
  res.status(summary ? 200 : 404).json(summary || { error: 'Summary not found' });
});

// RabbitMQ cannot remove by message_id; scan with manual ack, hold unrelated
// deliveries unacked, then requeue them. A DB lock serializes all replay scans.
app.post('/dlq/:messageId/replay', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.messageId)) return res.status(400).json({ error: 'Invalid message_id' });
  const lock = await pool.connect();
  let channel;
  try {
    await lock.query("SELECT pg_advisory_lock(hashtextextended('dlq-replay-scan',0))");
    channel = await (await broker.connect()).createChannel();
    channel.on('error', () => {});
    const { messageCount } = await channel.checkQueue(DLQ);
    let matched;
    for (let i = 0; i < messageCount; i++) {
      const delivery = await channel.get(DLQ, { noAck: false });
      if (!delivery) break;
      if (delivery.properties.messageId === req.params.messageId) { matched = delivery; break; }
    }
    if (!matched) return res.status(404).json({ error: 'Message not found in DLQ' });
    const message = JSON.parse(matched.content.toString());
    const replay = await withJobLock(message.job_id, async client => {
      await client.query('BEGIN');
      try {
        const { rows: [job] } = await client.query(`UPDATE jobs SET status='QUEUED', replay_count=replay_count+1,last_error_type=NULL
          WHERE job_id=$1 AND status='DEAD_LETTERED' RETURNING *`, [message.job_id]);
        if (!job) { await client.query('ROLLBACK'); return null; }
        await client.query('INSERT INTO replay_events(message_id,generation) VALUES($1,$2)', [job.message_id, job.replay_count]);
        await broker.publish(QUEUE, messageFor(job));
        await client.query('COMMIT');
        channel.ack(matched);
        return job;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    });
    res.status(replay ? 202 : 409).json(replay ? { message_id: replay.message_id, job_id: replay.job_id, replay_generation: replay.replay_count } : { error: 'Job is not DEAD_LETTERED' });
  } finally {
    // Closing the scan channel requeues every unmatched delivery.
    await channel?.close().catch(() => {});
    try { await lock.query("SELECT pg_advisory_unlock(hashtextextended('dlq-replay-scan',0))"); }
    finally { lock.release(); }
  }
});
app.use((error, _req, res, _next) => {
  console.error('API_ERROR', error.message);
  res.status(error.status || 500).json({ error: error.status === 400 ? 'Invalid JSON' : 'INTERNAL_ERROR' });
});
await ensureSchema();
app.listen(config.apiPort, '0.0.0.0', () => console.log(`API listening on ${config.apiPort}`));
