import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool } from '../src/db.js';
import { auth, balanceOf, fund, idem, openAccount, setup } from './helpers.js';

let app: FastifyInstance;
let client: string;
let admin: string;

const destination = { bank_code: '058', account_number: '0123456789', account_name: 'Ada Okafor' };

beforeAll(async () => {
  ({ app, client, admin } = await setup());
});
afterAll(async () => {
  await app.close();
  await closePool();
});

async function requestWithdrawal(accountId: string, amount: number) {
  return app.inject({
    method: 'POST',
    url: '/v1/withdrawals',
    headers: { ...auth(client), ...idem() },
    payload: { account_id: accountId, amount, destination },
  });
}

async function recon() {
  return (await app.inject({ method: 'GET', url: '/v1/admin/reconciliation', headers: auth(admin) })).json();
}

describe('withdrawals', () => {
  it('holds amount plus fee, then settles on approval', async () => {
    const acct = await openAccount(app, client);
    await fund(app, acct.id, 1_000_000);

    const res = await requestWithdrawal(acct.id, 200_000);
    expect(res.statusCode).toBe(201);
    const w = res.json();
    expect(w).toMatchObject({ status: 'pending', amount: 200_000, fee: 1_000 }); // 0.5%
    expect(await balanceOf(app, client, acct.id)).toBe(799_000);

    const approved = await app.inject({
      method: 'POST',
      url: `/v1/admin/withdrawals/${w.id}/approve`,
      headers: { ...auth(admin), 'content-type': 'application/json' },
      payload: { note: 'KYC verified' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'completed', review_note: 'KYC verified' });

    const r = await recon();
    const ngn = r.currencies.find((c: { currency: string }) => c.currency === 'NGN');
    expect(ngn).toMatchObject({ postings_total: 0, withdrawals_pending: 0, fee_revenue: 1_000 });
    expect(r.ok).toBe(true);
  });

  it('cannot be approved twice (no double payout)', async () => {
    const acct = await openAccount(app, client);
    await fund(app, acct.id, 50_000);
    const w = (await requestWithdrawal(acct.id, 10_000)).json();
    const approve = () =>
      app.inject({ method: 'POST', url: `/v1/admin/withdrawals/${w.id}/approve`, headers: auth(admin) });
    const results = await Promise.all([approve(), approve(), approve()]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2);
  });

  it('releases the hold back to the wallet on rejection', async () => {
    const acct = await openAccount(app, client);
    await fund(app, acct.id, 100_000);
    const w = (await requestWithdrawal(acct.id, 50_000)).json();
    expect(await balanceOf(app, client, acct.id)).toBe(49_750);
    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/admin/withdrawals/${w.id}/reject`,
      headers: auth(admin),
    });
    expect(rejected.json().status).toBe('rejected');
    expect(await balanceOf(app, client, acct.id)).toBe(100_000);
  });

  it('counts the fee when checking available balance', async () => {
    const acct = await openAccount(app, client);
    await fund(app, acct.id, 100_000);
    const res = await requestWithdrawal(acct.id, 100_000); // needs 100,500
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('insufficient_funds');
  });

  it('shows pending payouts in the admin queue', async () => {
    const acct = await openAccount(app, client);
    await fund(app, acct.id, 20_000);
    const w = (await requestWithdrawal(acct.id, 5_000)).json();
    const queue = await app.inject({ method: 'GET', url: '/v1/admin/withdrawals?status=pending', headers: auth(admin) });
    expect(queue.json().data.map((x: { id: string }) => x.id)).toContain(w.id);
  });
});

describe('compliance freeze', () => {
  it('blocks debits on a frozen account but still allows incoming money', async () => {
    const frozen = await openAccount(app, client);
    const other = await openAccount(app, client);
    await fund(app, frozen.id, 10_000);
    await app.inject({ method: 'POST', url: `/v1/admin/accounts/${frozen.id}/freeze`, headers: auth(admin) });

    const out = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...auth(client), ...idem() },
      payload: { from_account_id: frozen.id, to_account_id: other.id, amount: 1_000 },
    });
    expect(out.statusCode).toBe(423);
    expect((await requestWithdrawal(frozen.id, 1_000)).statusCode).toBe(423);

    await fund(app, frozen.id, 5_000);
    expect(await balanceOf(app, client, frozen.id)).toBe(15_000);

    const log = await app.inject({ method: 'GET', url: `/v1/admin/audit-log?target_id=${frozen.id}`, headers: auth(admin) });
    expect(log.json().data.map((e: { action: string }) => e.action)).toContain('account.frozen');
  });
});

describe('database-level ledger guarantees', () => {
  it('rejects an unbalanced journal entry even when written with raw SQL', async () => {
    const acct = await openAccount(app, client);
    const client_ = await getPool().connect();
    try {
      await client_.query('BEGIN');
      const { rows } = await client_.query(`INSERT INTO journal_entries (kind, currency) VALUES ('transfer', 'NGN') RETURNING id`);
      await client_.query(`INSERT INTO postings (entry_id, account_id, amount, balance_after) VALUES ($1, $2, 999, 999)`, [rows[0].id, acct.id]);
      await expect(client_.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await client_.query('ROLLBACK').catch(() => undefined);
      client_.release();
    }
  });

  it('makes postings append-only', async () => {
    const acct = await openAccount(app, client);
    await fund(app, acct.id, 1_000);
    await expect(getPool().query(`UPDATE postings SET amount = amount * 100`)).rejects.toThrow(/append-only/);
    await expect(getPool().query(`DELETE FROM postings`)).rejects.toThrow(/append-only/);
  });

  it('blocks a negative customer balance at the database level', async () => {
    const acct = await openAccount(app, client);
    await expect(getPool().query(`UPDATE accounts SET balance = -1 WHERE id = $1`, [acct.id])).rejects.toThrow(
      /customer_balance_non_negative/,
    );
  });

  it('reconciliation detects a tampered cached balance', async () => {
    const acct = await openAccount(app, client);
    await fund(app, acct.id, 3_000);
    await getPool().query(`UPDATE accounts SET balance = balance + 1 WHERE id = $1`, [acct.id]);
    const r = await recon();
    expect(r.ok).toBe(false);
    expect(r.mismatched_accounts).toEqual([{ account_id: acct.id, cached_balance: 3_001, ledger_balance: 3_000 }]);
    await getPool().query(`UPDATE accounts SET balance = balance - 1 WHERE id = $1`, [acct.id]);
    expect((await recon()).ok).toBe(true);
  });
});

describe('statements', () => {
  it('paginates with a stable cursor', async () => {
    const acct = await openAccount(app, client);
    for (let i = 0; i < 5; i++) await fund(app, acct.id, 100);
    const page1 = (await app.inject({ method: 'GET', url: `/v1/accounts/${acct.id}/transactions?limit=3`, headers: auth(client) })).json();
    expect(page1.data).toHaveLength(3);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = (
      await app.inject({ method: 'GET', url: `/v1/accounts/${acct.id}/transactions?limit=3&cursor=${page1.next_cursor}`, headers: auth(client) })
    ).json();
    expect(page2.data).toHaveLength(2);
    expect(page2.next_cursor).toBeNull();
    expect(page2.data[1].balance_after).toBe(100);
  });
});

describe('API documentation', () => {
  it('serves the Swagger page and a valid OpenAPI 3.1 document covering every endpoint', async () => {
    const page = await app.inject({ method: 'GET', url: '/docs/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('swagger-ui');
    const res = await app.inject({ method: 'GET', url: '/docs/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/v1/transfers', '/v1/withdrawals', '/v1/webhooks/deposits', '/v1/admin/reconciliation']),
    );
    // Every response has a human description and errors carry real examples, not generated filler.
    const transfer = spec.paths['/v1/transfers'].post.responses;
    expect(transfer['201'].description).toBe('Done. The money has moved.');
    expect(transfer['422'].content['application/json'].example.error.code).toBe('insufficient_funds');
    expect(JSON.stringify(spec)).not.toContain('Default Response');
  });
});
