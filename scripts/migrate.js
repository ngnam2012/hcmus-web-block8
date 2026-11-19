import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { config } from '../src/config.js';
import { createReceiverPool, createSenderPool } from '../src/db.js';

function dbNameFromUrl(connectionString, fallback) {
  try {
    const parsed = new URL(connectionString);
    const name = parsed.pathname.replace(/^\//, '').trim();
    if (/^[a-zA-Z0-9_]+$/.test(name)) return name;
  } catch {
    // fallback
  }
  return fallback;
}

export async function ensureDatabases(cfg = config) {
  const adminPool = new pg.Pool({
    connectionString: cfg.pgAdminDatabaseUrl,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  try {
    const dbNames = [
      dbNameFromUrl(cfg.senderDatabaseUrl, 'sender_db'),
      dbNameFromUrl(cfg.receiverDatabaseUrl, 'receiver_db'),
    ];
    for (const dbName of dbNames) {
      const { rows } = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
      if (rows.length === 0) {
        try {
          await adminPool.query(`CREATE DATABASE "${dbName}"`);
          console.log(`Created database ${dbName}`);
        } catch (error) {
          if (error?.code !== '42P04') throw error;
        }
      }
    }
  } finally {
    await adminPool.end();
  }
}

export async function applyMigrations(cfg = config) {
  await ensureDatabases(cfg);
  const senderSql = await readFile(new URL('../db/sender/001_schema.sql', import.meta.url), 'utf8');
  const receiverSql = await readFile(new URL('../db/receiver/001_schema.sql', import.meta.url), 'utf8');

  const senderPool = createSenderPool(cfg.senderDatabaseUrl);
  const receiverPool = createReceiverPool(cfg.receiverDatabaseUrl);
  try {
    await senderPool.query(senderSql);
    await receiverPool.query(receiverSql);
  } finally {
    await senderPool.end();
    await receiverPool.end();
  }
}

export async function seedFixtures(cfg = config) {
  const fixtureSql = await readFile(new URL('../db/sender/002_fixtures.sql', import.meta.url), 'utf8');
  const senderPool = createSenderPool(cfg.senderDatabaseUrl);
  try {
    await senderPool.query(fixtureSql);
  } finally {
    await senderPool.end();
  }
}

export async function resetFixtures(cfg = config) {
  const fixtureSql = await readFile(new URL('../db/sender/002_fixtures.sql', import.meta.url), 'utf8');
  const senderPool = createSenderPool(cfg.senderDatabaseUrl);
  const receiverPool = createReceiverPool(cfg.receiverDatabaseUrl);
  try {
    await senderPool.query(`
      TRUNCATE replay_events, delivery_attempts, outbox, jobs RESTART IDENTITY CASCADE;
      ALTER SEQUENCE attempt_id_seq RESTART WITH 1;
    `);
    await senderPool.query(fixtureSql);

    await receiverPool.query(`
      TRUNCATE inbox, video_summaries RESTART IDENTITY CASCADE;
    `);
  } finally {
    await senderPool.end();
    await receiverPool.end();
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  await applyMigrations(config);
  if (args.has('--reset')) {
    await resetFixtures(config);
    console.log('Migrations applied and fixtures reset (J42, J43 READY; receiver DB clean).');
  } else if (args.has('--seed')) {
    await seedFixtures(config);
    console.log('Migrations applied and fixtures ensured (J42, J43).');
  } else {
    console.log('Migrations applied for sender_db and receiver_db.');
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error('MIGRATE_FAILED', error.message);
    process.exit(1);
  });
}
