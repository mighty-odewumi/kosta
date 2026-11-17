import pg from 'pg';

/** Recreates the test schema from scratch and applies migrations once per test run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ledger_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();

  process.env.DATABASE_URL = url;
  const { migrate } = await import('../scripts/migrate.js');
  const { closePool } = await import('../src/db.js');
  await migrate(false);
  await closePool();
}
