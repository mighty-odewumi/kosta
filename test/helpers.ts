import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createApiKey } from '../src/auth.js';
import { getPool } from '../src/db.js';
import { signWebhook } from '../src/routes/webhooks.js';

export async function resetDb() {
  await getPool().query(`
    TRUNCATE audit_log, idempotency_keys, webhook_events, deposits, withdrawals, transfers,
             postings, journal_entries, accounts, api_keys RESTART IDENTITY CASCADE`);
}

export async function setup() {
  await resetDb();
  const app = await buildApp({ logger: false });
  await app.ready();
  const admin = await createApiKey('test-admin', 'admin');
  const client = await createApiKey('test-client', 'client');
  const other = await createApiKey('other-client', 'client');
  return { app, admin: admin.secret, client: client.secret, other: other.secret };
}

export const auth = (key: string) => ({ authorization: `Bearer ${key}` });
export const idem = (key = randomUUID()) => ({ 'idempotency-key': key });

export async function openAccount(app: FastifyInstance, key: string, currency = 'NGN', label?: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/accounts', headers: auth(key), payload: { currency, label } });
  if (res.statusCode !== 201) throw new Error(`open account failed: ${res.body}`);
  return res.json() as { id: string; balance: number; currency: string };
}

export function depositEvent(accountId: string, amount: number, overrides: Partial<{ id: string; reference: string; currency: string; type: string }> = {}) {
  return {
    id: overrides.id ?? `evt_${randomUUID()}`,
    type: overrides.type ?? 'deposit.succeeded',
    provider: 'paystack',
    data: {
      account_id: accountId,
      amount,
      currency: overrides.currency ?? 'NGN',
      reference: overrides.reference ?? `REF_${randomUUID()}`,
    },
  };
}

export async function sendWebhook(app: FastifyInstance, event: unknown, opts: { secret?: string; timestamp?: number } = {}) {
  const raw = JSON.stringify(event);
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/deposits',
    headers: {
      'content-type': 'application/json',
      'x-kosta-signature': signWebhook(raw, opts.secret ?? 'whsec_test_secret', opts.timestamp),
    },
    payload: raw,
  });
}

export async function fund(app: FastifyInstance, accountId: string, amount: number, currency = 'NGN') {
  const res = await sendWebhook(app, depositEvent(accountId, amount, { currency }));
  if (res.json().status !== 'processed') throw new Error(`funding failed: ${res.body}`);
}

export async function balanceOf(app: FastifyInstance, key: string, accountId: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/accounts/${accountId}`, headers: auth(key) });
  return (res.json() as { balance: number }).balance;
}
