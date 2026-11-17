import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { actorOf } from '../auth.js';
import { audit } from '../audit.js';
import { getPool } from '../db.js';
import { AppError, Errors } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { postEntry } from '../ledger/ledger.js';
import { IdParams, IdempotencyHeaders, MinorAmount, Transfer, errors, ok } from '../schemas.js';
import { TRANSFER_COLUMNS, loadAccount, transferView } from '../views.js';

export default async function transferRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const security = [{ bearerAuth: [] }];

  r.post(
    '/v1/transfers',
    {
      schema: {
        tags: ['Transfers'],
        summary: 'Send money to another wallet',
        description:
          'Moves money from one of your wallets to any other wallet in the same currency. Both sides change ' +
          'together or not at all, so money is never lost halfway. If the sender does not have enough, nothing ' +
          'moves and you get insufficient_funds. Send an Idempotency-Key so a retried request never pays twice.',
        security,
        headers: IdempotencyHeaders,
        body: Type.Object(
          {
            from_account_id: Type.String({ format: 'uuid', description: 'Your wallet the money comes from.' }),
            to_account_id: Type.String({ format: 'uuid', description: 'The wallet receiving the money.' }),
            amount: MinorAmount,
            narration: Type.Optional(Type.String({ maxLength: 140, description: 'A short note, like a bank transfer narration.', examples: ['Lunch'] })),
          },
          { additionalProperties: false },
        ),
        response: {
          201: ok(Transfer, 'Done. The money has moved.'),
          ...errors([400, 401, 404, 409, 422, 423]),
        },
      },
    },
    async (request, reply) =>
      idempotent(request, reply, async (tx) => {
        const { from_account_id, to_account_id, amount, narration } = request.body;
        if (from_account_id === to_account_id) {
          throw new AppError(422, 'same_account', 'Source and destination accounts must be different.');
        }
        const from = await loadAccount(tx, from_account_id, request.apiKey!);
        const to = await loadAccount(tx, to_account_id, request.apiKey!, { anyOwner: true });
        if (from.currency !== to.currency) throw Errors.currencyMismatch();

        const transferId = randomUUID();
        const entry = await postEntry(tx, {
          kind: 'transfer',
          currency: from.currency,
          referenceType: 'transfer',
          referenceId: transferId,
          description: narration ?? 'Wallet transfer',
          legs: [
            { accountId: from.id, amount: -amount },
            { accountId: to.id, amount },
          ],
        });
        const { rows } = await tx.query(
          `INSERT INTO transfers (id, from_account_id, to_account_id, amount, currency, status, narration, entry_id, created_by)
           VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8)
           RETURNING ${TRANSFER_COLUMNS}`,
          [transferId, from.id, to.id, amount, from.currency, narration ?? null, entry.id, request.apiKey!.id],
        );
        await audit(tx, actorOf(request), 'transfer.completed', 'transfer', transferId, {
          from: from.id,
          to: to.id,
          amount,
          currency: from.currency,
        });
        return { status: 201, body: transferView(rows[0]!) };
      }),
  );

  r.get(
    '/v1/transfers/:id',
    {
      schema: {
        tags: ['Transfers'],
        summary: 'Look up a transfer',
        description: 'Shows a transfer you sent or received.',
        security,
        params: IdParams,
        response: { 200: ok(Transfer, 'The transfer.'), ...errors([401, 404], { 404: { message: 'Transfer not found.' } }) },
      },
    },
    async (request) => {
      const caller = request.apiKey!;
      const { rows } = await getPool().query(
        `SELECT ${TRANSFER_COLUMNS.split(',').map((c) => `t.${c.trim()}`).join(', ')}
           FROM transfers t
           JOIN accounts f ON f.id = t.from_account_id
           JOIN accounts d ON d.id = t.to_account_id
          WHERE t.id = $1 AND ($2::text = 'admin' OR f.owner_key_id = $3 OR d.owner_key_id = $3)`,
        [request.params.id, caller.role, caller.id],
      );
      if (!rows[0]) throw Errors.notFound('Transfer');
      return transferView(rows[0]);
    },
  );
}
