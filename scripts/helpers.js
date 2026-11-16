import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { broker } from '../src/broker.js';
import { QUEUE, DLQ, RETRY_QUEUES, sleep } from '../src/config.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const apiUrl = process.env.API_URL || `http://127.0.0.1:${process.env.API_PORT || 3000}`;
export const mockUrl = process.env.MOCK_URL || `http://127.0.0.1:${process.env.MOCK_PORT || 3001}`;
export const commands = [];
export function compose(...args) {
  const command = ['compose', ...args];
  const at = new Date().toISOString();
  const output = execFileSync('docker', command, { cwd: root, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  commands.push({ at, command: `docker ${command.join(' ')}`, output: output.trim() });
  return output;
}
export async function request(path, { method = 'GET', body, base = apiUrl, timeoutMs = 25000 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: await response.json() };
}
export async function until(fn, description, timeout = 45000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; }
    catch (error) { last = error; }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${description}${last ? `: ${last.message}` : ''}`);
}
export async function status(jobId, expected = 'DONE') {
  return until(async () => {
    const result = await request(`/summaries/${jobId}`);
    return result.body.status === expected ? result.body : false;
  }, `${jobId} => ${expected}`);
}
export async function submit(videoId = 'V1', options = {}) {
  const start = Date.now();
  const response = await request('/summaries', { method: 'POST', body: { video_id: videoId, options } });
  return { ...response, elapsed_ms: Date.now() - start };
}
export async function workerReady() {
  const url = process.env.RABBIT_MANAGEMENT_URL || `http://127.0.0.1:${process.env.RABBIT_ADMIN_PORT || 15678}`;
  await until(async () => {
    const response = await fetch(`${url}/api/queues/%2F/${QUEUE}`, { headers: {
      authorization: `Basic ${Buffer.from(`${process.env.RABBIT_USER || 'lab'}:${process.env.RABBIT_PASSWORD || 'lab'}`).toString('base64')}`,
    }, signal: AbortSignal.timeout(3000) });
    return response.ok && (await response.json()).consumers >= 2;
  }, 'two consumers', 60000);
}
export async function reset() {
  compose('stop', '-t', '1', 'worker-1', 'worker-2');
  await broker.close();
  const channel = await (await broker.connect()).createChannel();
  try { for (const queue of [QUEUE, DLQ, ...RETRY_QUEUES]) await channel.purgeQueue(queue); }
  finally { await channel.close(); }
  await pool.query(`TRUNCATE checkpoint_events,replay_events,mock_calls,mock_faults,processing_attempts,summaries,jobs,videos RESTART IDENTITY CASCADE;
    INSERT INTO videos(video_id,title,transcript,has_audio) VALUES
    ('V1','Message Broker','Broker nhận công việc qua publisher confirm, worker ack sau commit.',true),
    ('V7','Ordering','Version lớn nhất đã DONE là bản tóm tắt hiện tại.',true),
    ('V9','No audio','',false)`);
  compose('up', '-d', 'worker-1', 'worker-2');
  await workerReady();
}
export async function brokerCounts() {
  const raw = compose('exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q', 'list_queues', 'name', 'messages_ready', 'messages_unacknowledged', '--formatter', 'json');
  return JSON.parse(raw).filter(q => [QUEUE, DLQ, ...RETRY_QUEUES].includes(q.name));
}
export async function snapshot(label) {
  const data = { label, captured_at: new Date().toISOString(), tables: {} };
  for (const table of ['videos', 'jobs', 'summaries', 'processing_attempts', 'replay_events', 'checkpoint_events', 'mock_calls', 'mock_faults']) {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY 1`); // table comes only from the fixed list above
    data.tables[table] = rows;
  }
  data.queues = await brokerCounts();
  const channel = await (await broker.connect()).createChannel();
  data.dlq_messages = [];
  try {
    const { messageCount } = await channel.checkQueue(DLQ);
    for (let i = 0; i < messageCount; i++) {
      const delivery = await channel.get(DLQ, { noAck: false });
      if (!delivery) break;
      data.dlq_messages.push({ properties: delivery.properties, message: JSON.parse(delivery.content.toString()) });
    }
  } finally { await channel.close(); } // requeues inspected messages
  return data;
}
export async function save(name, data) {
  await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../evidence/${name}.json`, import.meta.url), JSON.stringify(data, null, 2) + '\n');
}
export async function close() { await broker.close(); await pool.end(); }
