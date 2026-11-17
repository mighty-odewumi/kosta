import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool } from '../src/db.js';
import { auth, balanceOf, idem, openAccount, setup } from './helpers.js';

let app: FastifyInstance;
let other: string;

beforeAll(async () => {
  ({ app, other } = await setup());
});
afterAll(async () => {
  await app.close();
  await closePool();
});

describe('public sandbox', () => {
  it('lets a reviewer self-issue a key, fund a wallet and transfer', async () => {
    const keyRes = await app.inject({ method: 'POST', url: '/sandbox/api-keys', payload: { name: 'reviewer', role: 'client' } });
    expect(keyRes.statusCode).toBe(201);
    const key = keyRes.json().api_key as string;
    expect(key).toMatch(/^ks_live_/);

    const wallet = await openAccount(app, key);
    const dep = await app.inject({
      method: 'POST',
      url: '/sandbox/deposits',
      headers: auth(key),
      payload: { account_id: wallet.id, amount: 500_000 },
    });
    expect(dep.statusCode).toBe(201);
    expect(dep.json().balance).toBe(500_000);

    const friend = await openAccount(app, other);
    const t = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...auth(key), ...idem() },
      payload: { from_account_id: wallet.id, to_account_id: friend.id, amount: 200_000 },
    });
    expect(t.statusCode).toBe(201);
    expect(await balanceOf(app, key, wallet.id)).toBe(300_000);
  });

  it('issues an admin key by default so the docs can show every endpoint', async () => {
    const res = await app.inject({ method: 'POST', url: '/sandbox/api-keys', payload: {} });
    expect(res.json()).toMatchObject({ role: 'admin' });
    expect(res.json().api_key).toMatch(/^ks_admin_/);
  });

  it('cannot fund someone else\'s wallet or fund without a key', async () => {
    const theirs = await openAccount(app, other);
    const key = (await app.inject({ method: 'POST', url: '/sandbox/api-keys', payload: { role: 'client' } })).json().api_key;
    const res = await app.inject({ method: 'POST', url: '/sandbox/deposits', headers: auth(key), payload: { account_id: theirs.id, amount: 1 } });
    expect(res.statusCode).toBe(404);
    const anon = await app.inject({ method: 'POST', url: '/sandbox/deposits', payload: { account_id: theirs.id, amount: 1 } });
    expect(anon.statusCode).toBe(401);
  });

  it('answers CORS preflight for the docs site with the idempotency header allowed', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/transfers',
      headers: {
        origin: 'https://docs.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,idempotency-key,content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://docs.example.com');
    expect(String(res.headers['access-control-allow-headers'])).toContain('idempotency-key');
  });
});
