import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { actorOf, requireAdmin } from '../auth.js';
import { audit } from '../audit.js';
import { getPool, withTx } from '../db.js';
import { Errors } from '../errors.js';
import { Account, IdParams, PageQuery, Uuid, Timestamp, errors, ok } from '../schemas.js';
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
        summary: 'Check the books balance',
        description:
          'An on-demand audit of the whole ledger. It confirms that money in and money out match exactly in every ' +
          'currency, that every wallet balance agrees with its full history, and that no transaction is lopsided. ' +
          'It also shows how much is owed to customers, how much is on hold for withdrawals and how much has been ' +
          'earned in fees. If anything is off, ok is false and the problem is listed.',
        security,
        response: {
          200: ok(Type.Object({
            ok: Type.Boolean({ description: 'true when everything balances.' }),
            checked_at: Timestamp,
            currencies: Type.Array(
              Type.Object({
                currency: Type.String(),
                postings_total: Type.Integer({ description: 'Always 0 when the books balance.', examples: [0] }),
                customer_liabilities: Type.Integer({ description: 'Total held in customer wallets.', examples: [500000] }),
                settlement: Type.Integer({ description: 'Mirror of the money at the bank (negative means held for customers).', examples: [-500000] }),
                withdrawals_pending: Type.Integer({ description: 'On hold for withdrawals awaiting review.', examples: [0] }),
                fee_revenue: Type.Integer({ description: 'Fees earned.', examples: [0] }),
              }),
            ),
            mismatched_accounts: Type.Array(
              Type.Object({ account_id: Uuid, cached_balance: Type.Integer(), ledger_balance: Type.Integer() }),
              { description: 'Wallets whose balance disagrees with their history. Empty when all is well.' },
            ),
            unbalanced_entries: Type.Array(Uuid, { description: 'Transactions that do not add up. Empty when all is well.' }),
          }), 'The reconciliation report.'),
          ...errors([401, 403]),
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
        summary: 'Activity log',
        description:
          'Who did what, and when. Every change (new wallets, transfers, withdrawals, deposits, freezes) is recorded ' +
          'at the same moment it happens. Filter by a wallet or transfer id, or by action.',
        security,
        querystring: Type.Object({
          ...PageQuery.properties,
          target_id: Type.Optional(Uuid),
          action: Type.Optional(Type.String({ examples: ['transfer.completed'] })),
        }),
        response: {
          200: ok(Type.Object({
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
          }), 'A page of activity, newest first.'),
          ...errors([400, 401, 403]),
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
          summary: action === 'freeze' ? 'Freeze a wallet' : 'Unfreeze a wallet',
          description:
            action === 'freeze'
              ? 'Puts a compliance hold on a wallet. It can still receive money, but nothing can leave it until it is unfrozen.'
              : 'Lifts the hold so the wallet can send money again.',
          security,
          params: IdParams,
          body: Type.Object(
            { reason: Type.Optional(Type.String({ maxLength: 280, description: 'Why, for the activity log.', examples: ['Suspicious activity review'] })) },
            { additionalProperties: false },
          ),
          response: {
            200: ok(Account, action === 'freeze' ? 'The wallet is now frozen.' : 'The wallet is active again.'),
            ...errors([401, 403, 404]),
          },
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
