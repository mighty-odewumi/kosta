import type { Tx } from '../db.js';
import { AppError, Errors } from '../errors.js';

export type SystemAccountCode = 'settlement' | 'withdrawals_pending' | 'fee_revenue';

export interface Leg {
  accountId: string;
  /** Signed amount in minor units. Positive credits the account, negative debits it. */
  amount: number;
}

export interface EntryInput {
  kind: 'deposit' | 'transfer' | 'withdrawal_hold' | 'withdrawal_settle' | 'withdrawal_release';
  currency: string;
  legs: Leg[];
  referenceType?: string;
  referenceId?: string;
  description?: string;
}

export interface PostedEntry {
  id: string;
  postings: { accountId: string; amount: number; balanceAfter: number }[];
}

interface LockedAccount {
  id: string;
  kind: 'customer' | 'system';
  currency: string;
  status: 'active' | 'frozen';
  balance: number;
}

/**
 * Returns the system account for a currency, creating it on first use.
 *
 * settlement           mirrors money held at the bank / payment provider (contra account)
 * withdrawals_pending  funds reserved for payouts awaiting approval
 * fee_revenue          fees earned by the platform
 */
export async function getSystemAccountId(tx: Tx, code: SystemAccountCode, currency: string): Promise<string> {
  await tx.query(
    `INSERT INTO accounts (kind, system_code, label, currency)
     VALUES ('system', $1, $2, $3)
     ON CONFLICT (system_code, currency) DO NOTHING`,
    [code, `${code} ${currency}`, currency],
  );
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM accounts WHERE system_code = $1 AND currency = $2`,
    [code, currency],
  );
  return rows[0]!.id;
}

/**
 * Posts a balanced journal entry. This is the only function in the codebase that
 * changes a balance.
 *
 * Guarantees:
 *  - legs must sum to zero (checked here and again by a deferred DB trigger)
 *  - all accounts share the entry currency
 *  - accounts are locked in a deterministic order (by id) so concurrent entries
 *    touching the same accounts cannot deadlock
 *  - customer accounts can never go negative (checked here and by a DB CHECK)
 *  - frozen customer accounts cannot be debited
 */
export async function postEntry(tx: Tx, input: EntryInput): Promise<PostedEntry> {
  const legs = input.legs.filter((l) => l.amount !== 0);
  if (legs.length < 2) {
    throw new AppError(500, 'ledger_invalid_entry', 'A journal entry needs at least two non-zero legs.');
  }
  for (const leg of legs) {
    if (!Number.isSafeInteger(leg.amount)) {
      throw new AppError(500, 'ledger_invalid_amount', 'Ledger amounts must be integers in minor units.');
    }
  }
  const sum = legs.reduce((acc, l) => acc + l.amount, 0);
  if (sum !== 0) {
    throw new AppError(500, 'ledger_unbalanced', `Journal entry does not balance (sum = ${sum}).`);
  }

  const ids = [...new Set(legs.map((l) => l.accountId))];
  const { rows } = await tx.query<LockedAccount>(
    `SELECT id, kind, currency, status, balance
       FROM accounts
      WHERE id = ANY($1::uuid[])
      ORDER BY id
        FOR UPDATE`,
    [ids],
  );
  if (rows.length !== ids.length) throw Errors.notFound('Account');

  const accounts = new Map(rows.map((a) => [a.id, a]));
  const running = new Map(rows.map((a) => [a.id, a.balance]));

  for (const leg of legs) {
    const account = accounts.get(leg.accountId)!;
    if (account.currency !== input.currency) throw Errors.currencyMismatch();
    if (account.kind === 'customer' && leg.amount < 0 && account.status === 'frozen') {
      throw Errors.accountFrozen(account.id);
    }
  }

  // Validate every customer account ends non-negative before writing anything.
  const net = new Map<string, number>();
  for (const leg of legs) net.set(leg.accountId, (net.get(leg.accountId) ?? 0) + leg.amount);
  for (const [accountId, delta] of net) {
    const account = accounts.get(accountId)!;
    if (account.kind === 'customer' && account.balance + delta < 0) {
      throw Errors.insufficientFunds(accountId, account.balance, -delta);
    }
  }

  const entry = await tx.query<{ id: string }>(
    `INSERT INTO journal_entries (kind, currency, reference_type, reference_id, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.kind, input.currency, input.referenceType ?? null, input.referenceId ?? null, input.description ?? null],
  );
  const entryId = entry.rows[0]!.id;

  const postings: PostedEntry['postings'] = [];
  for (const leg of legs) {
    const balanceAfter = running.get(leg.accountId)! + leg.amount;
    running.set(leg.accountId, balanceAfter);
    await tx.query(
      `INSERT INTO postings (entry_id, account_id, amount, balance_after) VALUES ($1, $2, $3, $4)`,
      [entryId, leg.accountId, leg.amount, balanceAfter],
    );
    postings.push({ accountId: leg.accountId, amount: leg.amount, balanceAfter });
  }

  for (const [accountId, delta] of net) {
    await tx.query(`UPDATE accounts SET balance = balance + $2, version = version + 1 WHERE id = $1`, [
      accountId,
      delta,
    ]);
  }

  return { id: entryId, postings };
}
