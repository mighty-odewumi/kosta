import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { actorOf } from '../auth.js';
import { audit } from '../audit.js';
import { getPool, withTx } from '../db.js';
import { Account, Currency, IdParams, PageQuery, Paginated, Posting, errors, ok } from '../schemas.js';
import { ACCOUNT_COLUMNS, accountView, loadAccount, type AccountRow } from '../views.js';

export default async function accountRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();
  const security = [{ bearerAuth: [] }];

  r.post(
    '/v1/accounts',
    {
      schema: {
        tags: ['Accounts'],
        summary: 'Open a wallet',
        description:
          'Creates a new wallet for one currency. It starts empty and belongs to the API key that created it, ' +
          'so other clients cannot see it or spend from it.',
        security,
        body: Type.Object(
          {
            currency: Currency,
            label: Type.Optional(
              Type.String({ minLength: 1, maxLength: 80, description: 'Optional name to help you recognise it.', examples: ["Ada's wallet"] }),
            ),
          },
          { additionalProperties: false },
        ),
        response: { 201: ok(Account, 'Your new wallet.'), ...errors([400, 401]) },
      },
    },
    async (request, reply) => {
      const account = await withTx(async (tx) => {
        const { rows } = await tx.query<AccountRow>(
          `INSERT INTO accounts (owner_key_id, kind, label, currency)
           VALUES ($1, 'customer', $2, $3)
           RETURNING ${ACCOUNT_COLUMNS}`,
          [request.apiKey!.id, request.body.label ?? null, request.body.currency],
        );
        const created = rows[0]!;
        await audit(tx, actorOf(request), 'account.created', 'account', created.id, {
          currency: created.currency,
        });
        return created;
      });
      return reply.code(201).send(accountView(account));
    },
  );

  r.get(
    '/v1/accounts',
    {
      schema: {
        tags: ['Accounts'],
        summary: 'List your wallets',
        description: 'Every wallet your key has opened, newest first.',
        security,
        querystring: PageQuery,
        response: { 200: ok(Paginated(Type.Ref('Account')), 'A page of your wallets.'), ...errors([400, 401]) },
      },
    },
    async (request) => {
      const limit = request.query.limit ?? 25;
      const offset = Number(request.query.cursor ?? 0);
      const { rows } = await getPool().query<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts
          WHERE kind = 'customer' AND ($1::text = 'admin' OR owner_key_id = $2)
          ORDER BY created_at DESC, id
          LIMIT $3 OFFSET $4`,
        [request.apiKey!.role, request.apiKey!.id, limit + 1, offset],
      );
      const hasMore = rows.length > limit;
      return {
        data: rows.slice(0, limit).map(accountView),
        next_cursor: hasMore ? String(offset + limit) : null,
      };
    },
  );

  r.get(
    '/v1/accounts/:id',
    {
      schema: {
        tags: ['Accounts'],
        summary: 'Check a wallet',
        description: 'Shows the current balance and status of one of your wallets.',
        security,
        params: IdParams,
        response: { 200: ok(Account, 'The wallet and its balance right now.'), ...errors([401, 404]) },
      },
    },
    async (request) => accountView(await loadAccount(getPool(), request.params.id, request.apiKey!)),
  );

  r.get(
    '/v1/accounts/:id/transactions',
    {
      schema: {
        tags: ['Accounts'],
        summary: 'Wallet statement',
        description:
          'Every movement in and out of this wallet, newest first, like a bank statement. Each line shows the ' +
          'balance right after it. Results come in pages so it stays fast even for busy wallets.',
        security,
        params: IdParams,
        querystring: PageQuery,
        response: {
          200: ok(Paginated(Type.Ref('Posting')), 'A page of statement lines, newest first.'),
          ...errors([400, 401, 404]),
        },
      },
    },
    async (request) => {
      await loadAccount(getPool(), request.params.id, request.apiKey!);
      const limit = request.query.limit ?? 25;
      const cursor = request.query.cursor ? Number(request.query.cursor) : null;
      const { rows } = await getPool().query(
        `SELECT p.id, p.entry_id, e.kind, p.amount, p.balance_after, e.description,
                e.reference_type, e.reference_id, p.created_at
           FROM postings p
           JOIN journal_entries e ON e.id = p.entry_id
          WHERE p.account_id = $1 AND ($2::bigint IS NULL OR p.id < $2)
          ORDER BY p.id DESC
          LIMIT $3`,
        [request.params.id, cursor, limit + 1],
      );
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return { data: page, next_cursor: hasMore ? String(page[page.length - 1]!.id) : null };
    },
  );
}
