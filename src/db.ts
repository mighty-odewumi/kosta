import pg from 'pg';
import { config } from './config.js';

// bigint (int8) columns hold minor-unit amounts. They are bounded by API validation
// (max 10^13), well inside Number.MAX_SAFE_INTEGER, so parsing to number is safe.
pg.types.setTypeParser(20, (v) => Number(v));

export type Tx = pg.PoolClient;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Runs fn inside a single READ COMMITTED transaction. Money-moving code relies on
 * explicit row locks (SELECT ... FOR UPDATE) rather than SERIALIZABLE retries.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
