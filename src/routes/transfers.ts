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
import { IdParams, IdempotencyHeaders, MinorAmount, Uuid, standardErrors } from '../schemas.js';
import { TRANSFER_COLUMNS, loadAccount, transferView } from '../views.js';

export default async function transferRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const security = [{ bearerAuth: [] }];

  r.post(
    '/v1/transfers',
    {
      schema: {
        tags: ['Transfers'],
        summary: 'Move money between two wallets',
        description:
          'Atomically debits the source wallet and credits the destination wallet in one balanced journal entry. ' +
          'The source must belong to the caller; the destination can be any customer wallet in the same currency. ' +
          'Requires an Idempotency-Key header: retries return the original result and never move money twice.',
        security,
        headers: IdempotencyHeaders,
        body: Type.Object(
          {
            from_account_id: Uuid,
            to_account_id: Uuid,
            amount: MinorAmount,
            narration: Type.Optional(Type.String({ maxLength: 140, examples: ['Rent share for March'] })),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Ref('Transfer'), ...standardErrors },
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
        summary: 'Get a transfer',
        security,
        params: IdParams,
        response: { 200: Type.Ref('Transfer'), ...standardErrors },
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
