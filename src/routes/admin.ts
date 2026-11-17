import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { actorOf, requireAdmin } from '../auth.js';
import { audit } from '../audit.js';
import { getPool, withTx } from '../db.js';
import { Errors } from '../errors.js';
import { IdParams, PageQuery, Uuid, Timestamp, standardErrors } from '../schemas.js';
import { ACCOUNT_COLUMNS, accountView, type AccountRow } from '../views.js';

export default async function adminRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const security = [{ bearerAuth: [] }];

  r.get(
    '/v1/admin/reconciliation',
    {
      preHandler: requireAdmin,
      schema: {
        tags: ['Admin'],
        summary: 'Run a ledger reconciliation',
        description:
          'Proves the books are correct. Checks that (1) postings in every currency sum to exactly zero, ' +
          '(2) every cached account balance equals the sum of its postings, and (3) no journal entry is unbalanced. ' +
          'Also returns system account positions: settlement (money that should be at the bank), funds held for ' +
          'pending payouts, and fee revenue. Safe to run on a schedule and alert on ok = false.',
        security,
        response: {
          200: Type.Object({
            ok: Type.Boolean(),
            checked_at: Timestamp,
            currencies: Type.Array(
              Type.Object({
                currency: Type.String(),
                postings_total: Type.Integer({ description: 'Must be 0.' }),
                customer_liabilities: Type.Integer({ description: 'Total owed to customers.' }),
                settlement: Type.Integer(),
                withdrawals_pending: Type.Integer(),
                fee_revenue: Type.Integer(),
              }),
            ),
            mismatched_accounts: Type.Array(
              Type.Object({ account_id: Uuid, cached_balance: Type.Integer(), ledger_balance: Type.Integer() }),
            ),
            unbalanced_entries: Type.Array(Uuid),
          }),
          ...standardErrors,
        },
      },
    },
    async () => {
      const pool = getPool();
      const [totals, positions, mismatched, unbalanced] = await Promise.all([
        pool.query<{ currency: string; total: number }>(
          `SELECT a.currency, COALESCE(SUM(p.amount), 0)::bigint AS total
             FROM accounts a LEFT JOIN postings p ON p.account_id = a.id
            GROUP BY a.currency ORDER BY a.currency`,
        ),
        pool.query<{ currency: string; bucket: string; total: number }>(
          `SELECT currency, COALESCE(system_code, 'customer') AS bucket, SUM(balance)::bigint AS total
             FROM accounts GROUP BY currency, COALESCE(system_code, 'customer')`,
        ),
        pool.query<{ account_id: string; cached_balance: number; ledger_balance: number }>(
          `SELECT a.id AS account_id, a.balance AS cached_balance, COALESCE(SUM(p.amount), 0)::bigint AS ledger_balance
             FROM accounts a LEFT JOIN postings p ON p.account_id = a.id
            GROUP BY a.id HAVING a.balance <> COALESCE(SUM(p.amount), 0)`,
        ),
        pool.query<{ entry_id: string }>(
          `SELECT entry_id FROM postings GROUP BY entry_id HAVING SUM(amount) <> 0`,
        ),
      ]);

      const pos = (currency: string, bucket: string) =>
        positions.rows.find((p) => p.currency === currency && p.bucket === bucket)?.total ?? 0;

      const currencies = totals.rows.map((t) => ({
        currency: t.currency,
        postings_total: t.total,
        customer_liabilities: pos(t.currency, 'customer'),
        settlement: pos(t.currency, 'settlement'),
        withdrawals_pending: pos(t.currency, 'withdrawals_pending'),
        fee_revenue: pos(t.currency, 'fee_revenue'),
      }));

      return {
        ok:
          currencies.every((c) => c.postings_total === 0) &&
          mismatched.rows.length === 0 &&
          unbalanced.rows.length === 0,
        checked_at: new Date(),
        currencies,
        mismatched_accounts: mismatched.rows,
        unbalanced_entries: unbalanced.rows.map((u) => u.entry_id),
      };
    },
  );

  r.get(
    '/v1/admin/audit-log',
    {
      preHandler: requireAdmin,
      schema: {
        tags: ['Admin'],
        summary: 'Audit trail',
        description: 'Who did what, when. Every state change (accounts, transfers, payouts, deposits, freezes) writes here in the same transaction as the change.',
        security,
        querystring: Type.Object({
          ...PageQuery.properties,
          target_id: Type.Optional(Uuid),
          action: Type.Optional(Type.String({ examples: ['transfer.completed'] })),
        }),
        response: {
          200: Type.Object({
            data: Type.Array(
              Type.Object({
                id: Type.Integer(),
                actor: Type.String(),
                action: Type.String(),
                target_type: Type.String(),
                target_id: Type.Union([Uuid, Type.Null()]),
                data: Type.Record(Type.String(), Type.Unknown()),
                created_at: Timestamp,
              }),
            ),
            next_cursor: Type.Union([Type.String(), Type.Null()]),
          }),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const limit = request.query.limit ?? 25;
      const cursor = request.query.cursor ? Number(request.query.cursor) : null;
      const { rows } = await getPool().query(
        `SELECT id, actor, action, target_type, target_id, data, created_at
           FROM audit_log
          WHERE ($1::bigint IS NULL OR id < $1)
            AND ($2::uuid IS NULL OR target_id = $2)
            AND ($3::text IS NULL OR action = $3)
          ORDER BY id DESC LIMIT $4`,
        [cursor, request.query.target_id ?? null, request.query.action ?? null, limit + 1],
      );
      const page = rows.slice(0, limit);
      return { data: page, next_cursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
    },
  );

  const setStatus = (action: 'freeze' | 'unfreeze') =>
    r.post(
      `/v1/admin/accounts/:id/${action}`,
      {
        preHandler: requireAdmin,
        schema: {
          tags: ['Admin'],
          summary: action === 'freeze' ? 'Freeze an account (compliance hold)' : 'Unfreeze an account',
          description:
            action === 'freeze'
              ? 'A frozen account can still receive money but cannot send transfers or request payouts.'
              : 'Restores normal debits on a frozen account.',
          security,
          params: IdParams,
          body: Type.Object(
            { reason: Type.Optional(Type.String({ maxLength: 280, examples: ['Suspicious activity review'] })) },
            { additionalProperties: false },
          ),
          response: { 200: Type.Ref('Account'), ...standardErrors },
        },
      },
      async (request) => {
        const account = await withTx(async (tx) => {
          const { rows } = await tx.query<AccountRow>(
            `UPDATE accounts SET status = $2 WHERE id = $1 AND kind = 'customer' RETURNING ${ACCOUNT_COLUMNS}`,
            [request.params.id, action === 'freeze' ? 'frozen' : 'active'],
          );
          if (!rows[0]) throw Errors.notFound('Account');
          await audit(tx, actorOf(request), `account.${action === 'freeze' ? 'frozen' : 'unfrozen'}`, 'account', rows[0].id, {
            reason: request.body?.reason ?? null,
          });
          return rows[0];
        });
        return accountView(account);
      },
    );

  setStatus('freeze');
  setStatus('unfreeze');
}
