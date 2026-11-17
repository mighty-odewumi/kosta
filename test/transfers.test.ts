import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool } from '../src/db.js';
import { auth, balanceOf, fund, idem, openAccount, setup } from './helpers.js';

let app: FastifyInstance;
let client: string;
let other: string;
let admin: string;

beforeAll(async () => {
  ({ app, client, other, admin } = await setup());
});
afterAll(async () => {
  await app.close();
  await closePool();
});

describe('authentication and access', () => {
  it('rejects requests without a valid API key', async () => {
    const none = await app.inject({ method: 'GET', url: '/v1/accounts' });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('unauthorized');
    const bad = await app.inject({ method: 'GET', url: '/v1/accounts', headers: auth('ks_live_nope') });
    expect(bad.statusCode).toBe(401);
  });

  it('hides other clients\' accounts (404, not 403, so ids cannot be probed)', async () => {
    const mine = await openAccount(app, client);
    const res = await app.inject({ method: 'GET', url: `/v1/accounts/${mine.id}`, headers: auth(other) });
    expect(res.statusCode).toBe(404);
  });

  it('blocks client keys from admin endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/reconciliation', headers: auth(client) });
    expect(res.statusCode).toBe(403);
  });
});

describe('transfers', () => {
  it('moves money atomically and records running balances', async () => {
    const a = await openAccount(app, client);
    const b = await openAccount(app, other);
    await fund(app, a.id, 500_000);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...auth(client), ...idem() },
      payload: { from_account_id: a.id, to_account_id: b.id, amount: 120_000, narration: 'Rent share' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ amount: 120_000, currency: 'NGN', status: 'completed' });
    expect(await balanceOf(app, client, a.id)).toBe(380_000);
    expect(await balanceOf(app, other, b.id)).toBe(120_000);

    const statement = await app.inject({ method: 'GET', url: `/v1/accounts/${a.id}/transactions`, headers: auth(client) });
    const [latest] = statement.json().data;
    expect(latest).toMatchObject({ kind: 'transfer', amount: -120_000, balance_after: 380_000 });
  });

  it('refuses to overdraw and leaves balances untouched', async () => {
    const a = await openAccount(app, client);
    const b = await openAccount(app, client);
    await fund(app, a.id, 10_000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...auth(client), ...idem() },
      payload: { from_account_id: a.id, to_account_id: b.id, amount: 10_001 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'insufficient_funds', details: { available: 10_000, required: 10_001 } });
    expect(await balanceOf(app, client, a.id)).toBe(10_000);
  });

  it('rejects cross-currency transfers', async () => {
    const ngn = await openAccount(app, client, 'NGN');
    const usd = await openAccount(app, client, 'USD');
    await fund(app, ngn.id, 1_000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...auth(client), ...idem() },
      payload: { from_account_id: ngn.id, to_account_id: usd.id, amount: 500 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('currency_mismatch');
  });

  it('cannot spend from an account the caller does not own', async () => {
    const victim = await openAccount(app, other);
    const mine = await openAccount(app, client);
    await fund(app, victim.id, 50_000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...auth(client), ...idem() },
      payload: { from_account_id: victim.id, to_account_id: mine.id, amount: 50_000 },
    });
    expect(res.statusCode).toBe(404);
    expect(await balanceOf(app, other, victim.id)).toBe(50_000);
  });

  it('rejects floats and negative amounts at the edge', async () => {
    const a = await openAccount(app, client);
    const b = await openAccount(app, client);
    for (const amount of [10.5, -100, 0]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/transfers',
        headers: { ...auth(client), ...idem() },
        payload: { from_account_id: a.id, to_account_id: b.id, amount },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('idempotency', () => {
  it('requires an Idempotency-Key on money-moving requests', async () => {
    const a = await openAccount(app, client);
    const b = await openAccount(app, client);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: auth(client),
      payload: { from_account_id: a.id, to_account_id: b.id, amount: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('replays the original response on retry and moves money only once', async () => {
    const a = await openAccount(app, client);
    const b = await openAccount(app, client);
    await fund(app, a.id, 100_000);
    const headers = { ...auth(client), ...idem('retry-test-key-001') };
    const payload = { from_account_id: a.id, to_account_id: b.id, amount: 40_000 };

    const first = await app.inject({ method: 'POST', url: '/v1/transfers', headers, payload });
    const second = await app.inject({ method: 'POST', url: '/v1/transfers', headers, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().id).toBe(first.json().id);
    expect(await balanceOf(app, client, a.id)).toBe(60_000);
  });

  it('rejects reuse of a key with a different request body', async () => {
    const a = await openAccount(app, client);
    const b = await openAccount(app, client);
    await fund(app, a.id, 100_000);
    const headers = { ...auth(client), ...idem('reuse-test-key-001') };
    await app.inject({ method: 'POST', url: '/v1/transfers', headers, payload: { from_account_id: a.id, to_account_id: b.id, amount: 1_000 } });
    const res = await app.inject({ method: 'POST', url: '/v1/transfers', headers, payload: { from_account_id: a.id, to_account_id: b.id, amount: 9_000 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('idempotency_key_reused');
    expect(await balanceOf(app, client, a.id)).toBe(99_000);
  });

  it('handles a burst of identical concurrent requests with one transfer', async () => {
    const a = await openAccount(app, client);
    const b = await openAccount(app, client);
    await fund(app, a.id, 100_000);
    const headers = { ...auth(client), ...idem('burst-test-key-001') };
    const payload = { from_account_id: a.id, to_account_id: b.id, amount: 10_000 };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => app.inject({ method: 'POST', url: '/v1/transfers', headers, payload })),
    );
    const created = results.filter((r) => r.statusCode === 201);
    const ids = new Set(created.map((r) => r.json().id));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
    expect(await balanceOf(app, client, a.id)).toBe(90_000);
  });
});

describe('concurrency', () => {
  it('never double-spends under parallel load', async () => {
    const a = await openAccount(app, client);
    const b = await openAccount(app, client);
    await fund(app, a.id, 1_000);
    // 25 parallel transfers of 100 against a balance of 1,000: exactly 10 can succeed.
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        app.inject({
          method: 'POST',
          url: '/v1/transfers',
          headers: { ...auth(client), ...idem() },
          payload: { from_account_id: a.id, to_account_id: b.id, amount: 100 },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(10);
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(15);
    expect(await balanceOf(app, client, a.id)).toBe(0);
    expect(await balanceOf(app, client, b.id)).toBe(1_000);
  });

  it('does not deadlock when two wallets pay each other at the same time', async () => {
    const a = await openAccount(app, client);
    const b = await openAccount(app, client);
    await fund(app, a.id, 10_000);
    await fund(app, b.id, 10_000);
    const send = (from: string, to: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/transfers',
        headers: { ...auth(client), ...idem() },
        payload: { from_account_id: from, to_account_id: to, amount: 100 },
      });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? send(a.id, b.id) : send(b.id, a.id))),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect((await balanceOf(app, client, a.id)) + (await balanceOf(app, client, b.id))).toBe(20_000);

    const recon = await app.inject({ method: 'GET', url: '/v1/admin/reconciliation', headers: auth(admin) });
    expect(recon.json().ok).toBe(true);
  });
});
