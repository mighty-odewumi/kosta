import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { closePool } from '../src/db.js';
import { balanceOf, depositEvent, openAccount, sendWebhook, setup } from './helpers.js';

let app: FastifyInstance;
let client: string;

beforeAll(async () => {
  ({ app, client } = await setup());
});
afterAll(async () => {
  await app.close();
  await closePool();
});

describe('deposit webhooks', () => {
  it('credits the wallet for a correctly signed event', async () => {
    const acct = await openAccount(app, client);
    const res = await sendWebhook(app, depositEvent(acct.id, 250_000));
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('processed');
    expect(await balanceOf(app, client, acct.id)).toBe(250_000);
  });

  it('ignores provider retries of the same event', async () => {
    const acct = await openAccount(app, client);
    const event = depositEvent(acct.id, 5_000);
    await sendWebhook(app, event);
    const retry = await sendWebhook(app, event);
    expect(retry.json().status).toBe('duplicate');
    expect(await balanceOf(app, client, acct.id)).toBe(5_000);
  });

  it('never credits the same provider reference twice, even under a new event id', async () => {
    const acct = await openAccount(app, client);
    const reference = `REF_${randomUUID()}`;
    await sendWebhook(app, depositEvent(acct.id, 7_000, { reference }));
    const again = await sendWebhook(app, depositEvent(acct.id, 7_000, { reference }));
    expect(again.json().status).toBe('duplicate');
    expect(await balanceOf(app, client, acct.id)).toBe(7_000);
  });

  it('rejects a forged signature', async () => {
    const acct = await openAccount(app, client);
    const res = await sendWebhook(app, depositEvent(acct.id, 1_000_000), { secret: 'attacker_guess' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_signature');
    expect(await balanceOf(app, client, acct.id)).toBe(0);
  });

  it('rejects a replayed request with an old timestamp', async () => {
    const acct = await openAccount(app, client);
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const res = await sendWebhook(app, depositEvent(acct.id, 1_000), { timestamp: tenMinutesAgo });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('signature_expired');
  });

  it('records but does not apply a deposit for an unknown account', async () => {
    const res = await sendWebhook(app, depositEvent(randomUUID(), 1_000));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'failed', reason: 'account_not_found' });
  });

  it('records but does not apply a deposit in the wrong currency', async () => {
    const acct = await openAccount(app, client, 'USD');
    const res = await sendWebhook(app, depositEvent(acct.id, 1_000, { currency: 'NGN' }));
    expect(res.json()).toMatchObject({ status: 'failed', reason: 'currency_mismatch' });
    expect(await balanceOf(app, client, acct.id)).toBe(0);
  });

  it('acknowledges unrelated event types without acting on them', async () => {
    const acct = await openAccount(app, client);
    const res = await sendWebhook(app, depositEvent(acct.id, 1_000, { type: 'transfer.reversed' }));
    expect(res.json().status).toBe('ignored');
  });
});
