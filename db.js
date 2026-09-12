import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  // A background/idle client emitted an error — log it, don't crash the process.
  console.error('[db] unexpected error on idle client', err);
});

/**
 * Thin wrapper around pool.query with lightweight timing logs in dev.
 */
export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  if (process.env.NODE_ENV !== 'production') {
    console.log('[db] query', { text, ms: Date.now() - start, rows: res.rowCount });
  }
  return res;
}

/**
 * Polls the database until it accepts connections, or throws after `retries`.
 * Docker Compose's healthcheck+depends_on already waits for Postgres to be
 * ready before this container starts, but this guards against the DB
 * still finishing its own startup work (e.g. right after init scripts run).
 */
export async function waitForDb(retries = 20, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      console.log('[db] connected');
      return true;
    } catch (err) {
      console.warn(`[db] not ready yet (attempt ${attempt}/${retries}): ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('[db] could not establish a connection after multiple retries');
}
