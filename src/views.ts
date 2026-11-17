import type { Tx } from './db.js';
import { getPool } from './db.js';
import type { ApiKeyContext } from './auth.js';
import { Errors } from './errors.js';

type Queryable = Tx | ReturnType<typeof getPool>;

export const ACCOUNT_COLUMNS = `id, label, currency, status, balance, version, created_at, owner_key_id, kind`;
export const WITHDRAWAL_COLUMNS = `id, account_id, amount, fee, currency, status, destination, review_note,
  reviewed_at, created_at, updated_at, created_by`;
export const TRANSFER_COLUMNS = `id, from_account_id, to_account_id, amount, currency, status, narration,
  entry_id, created_at, created_by`;

export interface AccountRow {
  id: string;
  label: string | null;
  currency: string;
  status: 'active' | 'frozen';
  balance: number;
  version: number;
  created_at: Date;
  owner_key_id: string | null;
  kind: 'customer' | 'system';
}

export const accountView = (a: AccountRow) => ({
  id: a.id,
  label: a.label,
  currency: a.currency,
  status: a.status,
  balance: a.balance,
  version: a.version,
  created_at: a.created_at,
});

export const withdrawalView = (w: Record<string, unknown>) => ({
  id: w.id,
  account_id: w.account_id,
  amount: w.amount,
  fee: w.fee,
  currency: w.currency,
  status: w.status,
  destination: w.destination,
  review_note: w.review_note ?? null,
  reviewed_at: w.reviewed_at ?? null,
  created_at: w.created_at,
  updated_at: w.updated_at,
});

export const transferView = (t: Record<string, unknown>) => ({
  id: t.id,
  from_account_id: t.from_account_id,
  to_account_id: t.to_account_id,
  amount: t.amount,
  currency: t.currency,
  status: t.status,
  narration: t.narration ?? null,
  entry_id: t.entry_id,
  created_at: t.created_at,
});

/**
 * Loads a customer account the caller is allowed to see. Clients only see accounts
 * created with their own key; admins see all. Unknown and foreign accounts both
 * return 404 so ids cannot be probed.
 */
export async function loadAccount(
  db: Queryable,
  id: string,
  caller: ApiKeyContext,
  opts: { forUpdate?: boolean; anyOwner?: boolean } = {},
): Promise<AccountRow> {
  const { rows } = await db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1 AND kind = 'customer'${opts.forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const account = rows[0];
  if (!account) throw Errors.notFound('Account');
  if (!opts.anyOwner && caller.role !== 'admin' && account.owner_key_id !== caller.id) {
    throw Errors.notFound('Account');
  }
  return account;
}
