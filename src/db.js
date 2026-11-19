import pg from 'pg';
import { config } from './config.js';
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 12, connectionTimeoutMillis: 3000 });
pool.on('error', error => console.error('DB_POOL_ERROR', error.message));

export async function ensureSchema() {
  await pool.query('ALTER TABLE videos ADD COLUMN IF NOT EXISTS video_url text');
}

export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

// A session lock covers the external call too. On SIGKILL PostgreSQL releases it.
// All deliveries/replays of one job serialize; different videos/jobs run in parallel.
export async function withJobLock(jobId, fn) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [jobId]);
    return await fn(client);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [jobId]); }
    finally { client.release(); }
  }
}
