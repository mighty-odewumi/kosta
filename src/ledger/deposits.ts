import type { Tx } from '../db.js';
import { audit, type Actor } from '../audit.js';
import { AppError } from '../errors.js';
import { getSystemAccountId, postEntry } from './ledger.js';

export interface DepositInput {
  accountId: string;
  amount: number;
  currency: string;
  provider: string;
  reference: string;
}

export type DepositResult = { status: 'processed' | 'duplicate'; depositId: string };

/**
 * Credits a customer wallet for money received at the provider.
 * settlement -amount, customer +amount. A provider reference can only ever credit once.
 */
export async function creditDeposit(tx: Tx, input: DepositInput, actor: Actor): Promise<DepositResult> {
  const dup = await tx.query<{ id: string }>(
    `SELECT id FROM deposits WHERE provider = $1 AND provider_reference = $2`,
    [input.provider, input.reference],
  );
  if (dup.rows[0]) return { status: 'duplicate', depositId: dup.rows[0].id };

  const { rows } = await tx.query<{ id: string; currency: string }>(
    `SELECT id, currency FROM accounts WHERE id = $1 AND kind = 'customer'`,
    [input.accountId],
  );
  const account = rows[0];
  if (!account) throw new AppError(422, 'account_not_found', 'Deposit references an unknown account.');
  if (account.currency !== input.currency) {
    throw new AppError(422, 'currency_mismatch', 'Deposit currency does not match the account currency.');
  }

  const settlement = await getSystemAccountId(tx, 'settlement', account.currency);
  const depositId = (await tx.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
  const entry = await postEntry(tx, {
    kind: 'deposit',
    currency: account.currency,
    referenceType: 'deposit',
    referenceId: depositId,
    description: `Deposit via ${input.provider} (${input.reference})`,
    legs: [
      { accountId: settlement, amount: -input.amount },
      { accountId: account.id, amount: input.amount },
    ],
  });
  await tx.query(
    `INSERT INTO deposits (id, account_id, amount, currency, provider, provider_reference, entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [depositId, account.id, input.amount, account.currency, input.provider, input.reference, entry.id],
  );
  await audit(tx, actor, 'deposit.credited', 'deposit', depositId, {
    account_id: account.id,
    amount: input.amount,
    provider: input.provider,
    reference: input.reference,
  });
  return { status: 'processed', depositId };
}
