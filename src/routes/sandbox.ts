import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { actorOf, authenticate, createApiKey } from '../auth.js';
import { withTx } from '../db.js';
import { creditDeposit } from '../ledger/deposits.js';
import { Uuid, errorRef, standardErrors } from '../schemas.js';
import { loadAccount } from '../views.js';

/**
 * Sandbox-only helpers so anyone reviewing the API can try every endpoint from Swagger UI
 * without a payment provider. Registered only when SANDBOX_MODE=true.
 */
export default async function sandboxRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();

  r.post(
    '/sandbox/api-keys',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        tags: ['Sandbox'],
        summary: 'Get a sandbox API key',
        description:
          'Issues a fresh API key for the public sandbox. Start here: copy `api_key`, click **Authorize** at the ' +
          'top of the page and paste it. Use role `admin` to try payout approval, freezes, the audit log and ' +
          'reconciliation. Sandbox data is fake and may be reset at any time.',
        body: Type.Object(
          {
            role: Type.Optional(Type.Union([Type.Literal('client'), Type.Literal('admin')], { default: 'client' })),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 60, examples: ['reviewer'] })),
          },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({
            api_key: Type.String({ examples: ['ks_live_Qm9vZ3dhcnRzLWlzLXJlYWw'] }),
            role: Type.String(),
            note: Type.String(),
          }),
          400: errorRef,
          429: errorRef,
        },
      },
    },
    async (request, reply) => {
      const role = request.body.role ?? 'client';
      const key = await createApiKey(`sandbox:${request.body.name ?? 'reviewer'}`, role);
      return reply.code(201).send({
        api_key: key.secret,
        role,
        note: 'Shown once. Only a SHA-256 hash of this key is stored.',
      });
    },
  );

  r.post(
    '/sandbox/deposits',
    {
      preValidation: async (request) => authenticate(request),
      schema: {
        tags: ['Sandbox'],
        summary: 'Fund a wallet with test money',
        description:
          'Simulates a payment provider confirming a deposit, using exactly the same ledger code path as the ' +
          'signed webhook. Use it to put money in a wallet before trying transfers and withdrawals.',
        security: [{ bearerAuth: [] }],
        body: Type.Object(
          {
            account_id: Uuid,
            amount: Type.Integer({
              minimum: 1,
              maximum: 100_000_000,
              description: 'Minor units, up to 1,000,000.00 per call.',
              examples: [500000],
            }),
          },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({ deposit_id: Uuid, account_id: Uuid, amount: Type.Integer(), balance: Type.Integer() }),
          ...standardErrors,
        },
      },
    },
    async (request, reply) => {
      const result = await withTx(async (tx) => {
        const account = await loadAccount(tx, request.body.account_id, request.apiKey!);
        const dep = await creditDeposit(
          tx,
          {
            accountId: account.id,
            amount: request.body.amount,
            currency: account.currency,
            provider: 'sandbox',
            reference: `SBX_${randomUUID()}`,
          },
          actorOf(request),
        );
        const { rows } = await tx.query<{ balance: number }>(`SELECT balance FROM accounts WHERE id = $1`, [account.id]);
        return { deposit_id: dep.depositId, account_id: account.id, amount: request.body.amount, balance: rows[0]!.balance };
      });
      return reply.code(201).send(result);
    },
  );
}
