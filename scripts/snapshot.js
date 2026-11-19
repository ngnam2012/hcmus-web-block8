import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { createReceiverPool, createSenderPool } from '../src/db.js';

export async function captureSnapshot(label, { senderPool, receiverPool }) {
  const [jobs, outbox, deliveryAttempts, replayEvents] = await Promise.all([
    senderPool.query('SELECT * FROM jobs ORDER BY job_id ASC'),
    senderPool.query('SELECT * FROM outbox ORDER BY event_id ASC'),
    senderPool.query('SELECT * FROM delivery_attempts ORDER BY attempt_seq ASC'),
    senderPool.query('SELECT * FROM replay_events ORDER BY replay_id ASC'),
  ]);

  const [inbox, videoSummaries] = await Promise.all([
    receiverPool.query('SELECT * FROM inbox ORDER BY received_at ASC, event_id ASC'),
    receiverPool.query('SELECT * FROM video_summaries ORDER BY video_id ASC'),
  ]);

  return {
    label,
    captured_at: new Date().toISOString(),
    sender_db: {
      jobs: jobs.rows,
      outbox: outbox.rows,
      delivery_attempts: deliveryAttempts.rows,
      replay_events: replayEvents.rows,
    },
    receiver_db: {
      inbox: inbox.rows,
      video_summaries: videoSummaries.rows,
    },
  };
}

export async function saveEvidence(name, data) {
  await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../evidence/${name}.json`, import.meta.url), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function main() {
  const name = process.argv[2] || 'manual-snapshot';
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    throw new Error('Snapshot name must contain only letters, digits, _ or -');
  }
  const senderPool = createSenderPool(config.senderDatabaseUrl);
  const receiverPool = createReceiverPool(config.receiverDatabaseUrl);
  try {
    const snap = await captureSnapshot(name, { senderPool, receiverPool });
    await saveEvidence(name, snap);
    console.log(JSON.stringify(snap, null, 2));
  } finally {
    await senderPool.end();
    await receiverPool.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error('SNAPSHOT_FAILED', error.message);
    process.exit(1);
  });
}
