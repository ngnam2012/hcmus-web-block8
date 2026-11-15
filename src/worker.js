import express from 'express';
import { pool, withJobLock } from './db.js';
import { broker } from './broker.js';
import { config, QUEUE, DLQ, RETRY_QUEUES, sleep } from './config.js';
import { messageFor, ProcessingError } from './domain.js';
import { checkpoint, startAttempt, finishAttempt, callLlm, commitSummary } from './processing.js';

let connected = false;
let stopping = false;
const health = express();
health.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(connected ? 200 : 503).json({ worker_id: config.workerId, broker: connected, prefetch: 1 });
  } catch { res.status(503).json({ worker_id: config.workerId, database: false }); }
});
health.listen(3002, '0.0.0.0');

async function handle(channel, delivery) {
  const message = JSON.parse(delivery.content.toString());
  await withJobLock(message.job_id, async client => {
    const { rows: [job] } = await client.query('SELECT * FROM jobs WHERE job_id=$1 AND message_id=$2', [message.job_id, message.message_id]);
    if (!job) throw new Error('UNKNOWN_JOB');
    // DB is the source of truth, never the broker's redelivered hint.
    if (job.status === 'DONE') {
      const attempt = await startAttempt(client, job, config.workerId, delivery.fields.redelivered);
      await finishAttempt(client, attempt, 'DUPLICATE');
      channel.ack(delivery);
      return;
    }
    if (job.status === 'DEAD_LETTERED') {
      // Recovery for DB committed but DLQ publish/ack was interrupted (gap 2).
      const { rows: [last] } = await client.query('SELECT * FROM processing_attempts WHERE message_id=$1 ORDER BY attempt_no DESC LIMIT 1', [job.message_id]);
      await broker.publish(DLQ, messageFor(job), { error_type: job.last_error_type, attempt_count: last?.attempt_no || 0 });
      channel.ack(delivery);
      return;
    }
    const attempt = await startAttempt(client, job, config.workerId, delivery.fields.redelivered);
    const { rows: [count] } = await client.query(`SELECT COUNT(*)::int AS n FROM processing_attempts WHERE message_id=$1 AND replay_generation=$2`,
      [job.message_id, job.replay_count]);
    try {
      await checkpoint(client, job, 'before_llm_call', config.workerId);
      const content = await callLlm(client, job);
      await checkpoint(client, job, 'after_llm_before_commit', config.workerId);
      await commitSummary(client, job, attempt, content);
    } catch (error) {
      if (!(error instanceof ProcessingError)) throw error;
      const outcome = error.transient ? 'TRANSIENT_ERROR' : 'PERMANENT_ERROR';
      await finishAttempt(client, attempt, outcome, error.type);
      if (config.appVersion !== 'V1' && error.transient && count.n < 4) {
        // Publish to a durable TTL queue, wait for confirm, then ack the source.
        await broker.publish(RETRY_QUEUES[count.n - 1], messageFor(job), {
          error_type: error.type, attempt_count: attempt.attempt_no,
        });
        channel.ack(delivery);
        return;
      }
      await client.query(`UPDATE jobs SET status='DEAD_LETTERED', last_error_type=$2 WHERE job_id=$1`, [job.job_id, error.type]);
      await broker.publish(DLQ, messageFor(job), {
        error_type: error.type, attempt_count: attempt.attempt_no,
        correlation_id: job.correlation_id,
      });
      channel.ack(delivery);
      return;
    }
    await checkpoint(client, job, 'after_commit_before_ack', config.workerId);
    channel.ack(delivery); // Business transaction is already committed.
  });
}

async function run() {
  while (!stopping) {
    let channel;
    try {
      const connection = await broker.connect();
      channel = await connection.createChannel();
      channel.on('error', error => console.error('CONSUMER_ERROR', error.message));
      await channel.prefetch(1);
      const closed = new Promise(resolve => channel.once('close', resolve));
      await channel.consume(QUEUE, delivery => {
        if (!delivery) { channel.close().catch(() => {}); return; }
        handle(channel, delivery).catch(async error => {
          console.error('PROCESSING_INFRA_ERROR', error.message);
          // Loss of the channel requeues unacked delivery. Back off before reconnect.
          await channel.close().catch(() => {});
        });
      }, { noAck: false });
      connected = true;
      console.log(JSON.stringify({ event: 'WORKER_READY', worker_id: config.workerId, prefetch: 1 }));
      await closed;
    } catch (error) { console.error('WORKER_RECONNECT', error.message); }
    finally { connected = false; await channel?.close().catch(() => {}); }
    await broker.close();
    if (!stopping) await sleep(1000);
  }
}
process.on('SIGTERM', () => { stopping = true; process.exit(0); });
process.on('SIGINT', () => { stopping = true; process.exit(0); });
await run();
