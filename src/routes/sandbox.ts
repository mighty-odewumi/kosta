import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { actorOf, authenticate, createApiKey } from '../auth.js';
import { withTx } from '../db.js';
import { creditDeposit } from '../ledger/deposits.js';
import { Uuid, errors, ok } from '../schemas.js';
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
        summary: 'Get a test API key',
        description:
          'Gives you a free key for this test sandbox. On the docs page you do not need to copy it: it is applied ' +
          'automatically, so every other request is signed in. Choose role `admin` to also try withdrawal approval, ' +
          'freezing wallets, the activity log and the books check. Everything here is test money.',
        body: Type.Object(
          {
            role: Type.Optional(
              Type.Union([Type.Literal('client'), Type.Literal('admin')], {
                default: 'admin',
                description: 'client sees only its own wallets. admin can also review withdrawals and see everything.',
                examples: ['admin'],
              }),
            ),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: 'Any name, for the activity log.', examples: ['reviewer'] })),
          },
          { additionalProperties: false },
        ),
        response: {
          201: ok(
            Type.Object({
              api_key: Type.String({ description: 'Your key. It is only shown once.', examples: ['ks_admin_Qm9vZ3dhcnRzLWlzLXJlYWw'] }),
              role: Type.String({ examples: ['admin'] }),
              note: Type.String({ examples: ['Shown once. Only a SHA-256 hash of this key is stored.'] }),
            }),
            'Your test key.',
          ),
          ...errors([400, 429]),
        },
      },
    },
    async (request, reply) => {
      const role = request.body.role ?? 'admin';
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
        summary: 'Add test money to a wallet',
        description:
          'Pretends a customer paid in through a payment provider, so you have money to play with. It goes through ' +
          'exactly the same ledger code as a real, signed deposit.',
        security: [{ bearerAuth: [] }],
        body: Type.Object(
          {
            account_id: Type.String({ format: 'uuid', description: 'One of your wallets.' }),
            amount: Type.Integer({
              minimum: 1,
              maximum: 100_000_000,
              description: 'In the smallest unit, up to 100,000,000 (1,000,000.00) per call. 500000 is NGN 5,000.00.',
              examples: [500000],
            }),
          },
          { additionalProperties: false },
        ),
        response: {
          201: ok(
            Type.Object({
              deposit_id: Uuid,
              account_id: Uuid,
              amount: Type.Integer({ examples: [500000] }),
              balance: Type.Integer({ description: 'The wallet balance after the deposit.', examples: [500000] }),
            }),
            'Money added.',
          ),
          ...errors([400, 401, 404]),
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
