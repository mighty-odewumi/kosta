import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { actorOf, requireAdmin } from '../auth.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { getPool, withTx } from '../db.js';
import { Errors } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { getSystemAccountId, postEntry } from '../ledger/ledger.js';
import { Destination, IdParams, IdempotencyHeaders, MinorAmount, Withdrawal, errors, ok } from '../schemas.js';
import { WITHDRAWAL_COLUMNS, loadAccount, withdrawalView } from '../views.js';

/** Fee in minor units, rounded up so the platform never under-charges by a fraction. */
export const withdrawalFee = (amount: number) => Math.ceil((amount * config.withdrawalFeeBps) / 10_000);

export default async function withdrawalRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const security = [{ bearerAuth: [] }];

  r.post(
    '/v1/withdrawals',
    {
      schema: {
        tags: ['Withdrawals'],
        summary: 'Withdraw to a bank account',
        description:
          'Asks to pay money out of a wallet to a bank account. The amount plus a 0.5% fee is set aside straight ' +
          'away, so it cannot be spent again while the request waits for review. An admin then approves it (the ' +
          'money leaves) or rejects it (the money goes back to the wallet). Send an Idempotency-Key so a retry never ' +
          'creates a second withdrawal.',
        security,
        headers: IdempotencyHeaders,
        body: Type.Object(
          {
            account_id: Type.String({ format: 'uuid', description: 'Your wallet to withdraw from.' }),
            amount: MinorAmount,
            destination: Destination,
          },
          { additionalProperties: false },
        ),
        response: {
          201: ok(Withdrawal, 'Request received. The money is on hold until an admin reviews it.'),
          ...errors([400, 401, 404, 409, 422, 423], {
            400: { codes: ['validation_error', 'idempotency_key_required', 'invalid_json'] },
            422: { codes: ['insufficient_funds', 'idempotency_key_reused', 'constraint_violation'] },
          }),
        },
      },
    },
    async (request, reply) =>
      idempotent(request, reply, async (tx) => {
        const { account_id, amount, destination } = request.body;
        const account = await loadAccount(tx, account_id, request.apiKey!);
        const fee = withdrawalFee(amount);
        const pending = await getSystemAccountId(tx, 'withdrawals_pending', account.currency);
        const withdrawalId = randomUUID();

        const hold = await postEntry(tx, {
          kind: 'withdrawal_hold',
          currency: account.currency,
          referenceType: 'withdrawal',
          referenceId: withdrawalId,
          description: `Payout hold to ${destination.account_name}`,
          legs: [
            { accountId: account.id, amount: -(amount + fee) },
            { accountId: pending, amount: amount + fee },
          ],
        });

        const { rows } = await tx.query(
          `INSERT INTO withdrawals (id, account_id, amount, fee, currency, status, destination, hold_entry_id, created_by)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
           RETURNING ${WITHDRAWAL_COLUMNS}`,
          [withdrawalId, account.id, amount, fee, account.currency, JSON.stringify(destination), hold.id, request.apiKey!.id],
        );
        await audit(tx, actorOf(request), 'withdrawal.requested', 'withdrawal', withdrawalId, {
          account_id: account.id,
          amount,
          fee,
        });
        return { status: 201, body: withdrawalView(rows[0]!) };
      }),
  );

  r.get(
    '/v1/withdrawals/:id',
    {
      schema: {
        tags: ['Withdrawals'],
        summary: 'Check a withdrawal',
        description: 'Shows whether a withdrawal is still pending, completed or rejected.',
        security,
        params: IdParams,
        response: { 200: ok(Withdrawal, 'The withdrawal.'), ...errors([401, 404], { 404: { message: 'Withdrawal not found.' } }) },
      },
    },
    async (request) => {
      const { rows } = await getPool().query(`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals WHERE id = $1`, [
        request.params.id,
      ]);
      const w = rows[0];
      if (!w) throw Errors.notFound('Withdrawal');
      await loadAccount(getPool(), w.account_id, request.apiKey!); // ownership check
      return withdrawalView(w);
    },
  );

  // ---------- Admin review ----------

  r.get(
    '/v1/admin/withdrawals',
    {
      preHandler: requireAdmin,
      schema: {
        tags: ['Admin'],
        summary: 'Withdrawals waiting for review',
        description: 'The admin review queue. Oldest first, so requests are handled in the order they came in.',
        security,
        querystring: Type.Object({
          status: Type.Optional(
            Type.Union([Type.Literal('pending'), Type.Literal('completed'), Type.Literal('rejected')], {
              default: 'pending',
            }),
          ),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
        }),
        response: {
          200: ok(Type.Object({ data: Type.Array(Type.Ref('Withdrawal')) }), 'Withdrawals with the requested status.'),
          ...errors([400, 401, 403]),
        },
      },
    },
    async (request) => {
      const { rows } = await getPool().query(
        `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals WHERE status = $1 ORDER BY created_at, id LIMIT $2`,
        [request.query.status ?? 'pending', request.query.limit ?? 50],
      );
      return { data: rows.map(withdrawalView) };
    },
  );

  const ReviewBody = Type.Object(
    { note: Type.Optional(Type.String({ maxLength: 280, description: 'Optional note for the record.', examples: ['Checked against KYC'] })) },
    { additionalProperties: false },
  );

  const review = (decision: 'approve' | 'reject') =>
    r.post(
      `/v1/admin/withdrawals/:id/${decision}`,
      {
        preHandler: requireAdmin,
        schema: {
          tags: ['Admin'],
          summary: decision === 'approve' ? 'Approve a withdrawal' : 'Reject a withdrawal',
          description:
            decision === 'approve'
              ? 'Pays out a pending withdrawal: the money leaves the platform and the fee is kept as revenue. ' +
                'A withdrawal can only be approved once, even if two admins press approve at the same moment.'
              : 'Turns down a pending withdrawal and puts the full amount, fee included, back in the wallet.',
          security,
          params: IdParams,
          body: ReviewBody,
          response: {
            200: ok(Withdrawal, decision === 'approve' ? 'Approved and paid out.' : 'Rejected. The money is back in the wallet.'),
            ...errors([401, 403, 404, 409], {
              404: { message: 'Withdrawal not found.' },
              409: { description: 'This withdrawal was already approved or rejected.', codes: ['invalid_state'] },
            }),
          },
        },
      },
      async (request) => {
        const result = await withTx(async (tx) => {
          const { rows } = await tx.query(
            `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals WHERE id = $1 FOR UPDATE`,
            [request.params.id],
          );
          const w = rows[0];
          if (!w) throw Errors.notFound('Withdrawal');
          if (w.status !== 'pending') {
            throw Errors.invalidState(`Withdrawal is already ${w.status}.`);
          }
          const pending = await getSystemAccountId(tx, 'withdrawals_pending', w.currency);
          const total = w.amount + w.fee;

          let legs;
          if (decision === 'approve') {
            const settlement = await getSystemAccountId(tx, 'settlement', w.currency);
            const fees = await getSystemAccountId(tx, 'fee_revenue', w.currency);
            legs = [
              { accountId: pending, amount: -total },
              { accountId: settlement, amount: w.amount },
              { accountId: fees, amount: w.fee },
            ];
          } else {
            legs = [
              { accountId: pending, amount: -total },
              { accountId: w.account_id, amount: total },
            ];
          }

          const entry = await postEntry(tx, {
            kind: decision === 'approve' ? 'withdrawal_settle' : 'withdrawal_release',
            currency: w.currency,
            referenceType: 'withdrawal',
            referenceId: w.id,
            description: decision === 'approve' ? 'Payout settled' : 'Payout rejected, hold released',
            legs,
          });

          const updated = await tx.query(
            `UPDATE withdrawals
                SET status = $2, settle_entry_id = $3, review_note = $4, reviewed_by = $5,
                    reviewed_at = now(), updated_at = now()
              WHERE id = $1
              RETURNING ${WITHDRAWAL_COLUMNS}`,
            [
              w.id,
              decision === 'approve' ? 'completed' : 'rejected',
              entry.id,
              request.body?.note ?? null,
              request.apiKey!.id,
            ],
          );
          await audit(tx, actorOf(request), `withdrawal.${decision === 'approve' ? 'approved' : 'rejected'}`, 'withdrawal', w.id, {
            note: request.body?.note ?? null,
          });
          return updated.rows[0]!;
        });
        return withdrawalView(result);
      },
    );

  review('approve');
  review('reject');
}
