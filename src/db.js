import pg from 'pg';
import { config } from './config.js';

export function createPool(connectionString, label = 'db') {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
  });
  pool.on('error', error => console.error(`DB_POOL_ERROR[${label}]`, error.message));
  return pool;
}

export function createSenderPool(connectionString = config.senderDatabaseUrl) {
  return createPool(connectionString, 'sender_db');
}

export function createReceiverPool(connectionString = config.receiverDatabaseUrl) {
  return createPool(connectionString, 'receiver_db');
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection may already be broken; PostgreSQL rolls back automatically.
    }
    throw error;
  } finally {
    client.release();
  }
}
