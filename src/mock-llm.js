import express from 'express';
import { pool, transaction } from './db.js';
import { validateFault } from './domain.js';
import { config, sleep } from './config.js';

const app = express();
app.use(express.json({ limit: '64kb' }));
app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', provider: 'mock-only' }); }
  catch { res.status(503).json({ status: 'degraded' }); }
});
app.post('/summarize', async (req, res) => {
  const { job_id: jobId, transcript, options = {} } = req.body;
  if (!/^[0-9a-f-]{36}$/i.test(jobId || '') || typeof transcript !== 'string') return res.status(400).json({ error: 'Invalid request' });
  const call = await transaction(async client => {
    // The counter is durable, independent of worker retries/restarts.
    await client.query('SELECT job_id FROM jobs WHERE job_id=$1 FOR UPDATE', [jobId]);
    const { rows: [rule] } = await client.query('SELECT config FROM mock_faults WHERE job_id=$1', [jobId]);
    const fault = rule?.config || {};
    const { rows: [count] } = await client.query('SELECT COUNT(*)::int AS n FROM mock_calls WHERE job_id=$1', [jobId]);
    const callNo = count.n + 1;
    const failing = fault.fail_first === undefined || callNo <= fault.fail_first;
    const status = failing ? (fault.timeout ? 408 : fault.status || 200) : 200;
    const { rows: [created] } = await client.query('INSERT INTO mock_calls(job_id,call_no,response_status) VALUES($1,$2,$3) RETURNING *', [jobId, callNo, status]);
    return { ...created, fault, failing };
  });
  await sleep(call.fault.timeout && call.failing ? 2500 : call.fault.delay_ms ?? 400);
  await pool.query('UPDATE mock_calls SET finished_at=clock_timestamp() WHERE call_id=$1', [call.call_id]);
  if (call.response_status !== 200) return res.status(call.response_status).json({ error: `MOCK_${call.response_status}` });
  res.json({ summary: `[MOCK; ${options.language || 'vi'}; ${options.style || 'short'}] ${transcript.slice(0, 240)}` });
});
app.get('/calls/:jobId', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.jobId)) return res.status(400).json({ error: 'Invalid job_id' });
  const { rows } = await pool.query('SELECT * FROM mock_calls WHERE job_id=$1 ORDER BY call_no', [req.params.jobId]);
  res.json({ job_id: req.params.jobId, count: rows.length, calls: rows });
});
app.put('/faults/:jobId', async (req, res) => {
  if (!config.labMode) return res.sendStatus(404);
  if (!/^[0-9a-f-]{36}$/i.test(req.params.jobId)) return res.status(400).json({ error: 'Invalid job_id' });
  try { validateFault(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  await pool.query(`INSERT INTO mock_faults(job_id,config) VALUES($1,$2) ON CONFLICT(job_id) DO UPDATE SET config=EXCLUDED.config`, [req.params.jobId, req.body]);
  res.json({ job_id: req.params.jobId, config: req.body });
});
app.use((error, _req, res, _next) => { console.error('MOCK_ERROR', error.message); res.status(error.status || 500).json({ error: 'MOCK_INTERNAL_ERROR' }); });
app.listen(3001, '0.0.0.0', () => console.log('Mock LLM listening on 3001 (no external LLM calls)'));
