import { Type, type Static, type TSchema } from 'typebox';
import { config } from './config.js';

export const Uuid = Type.String({ format: 'uuid' });
export const Timestamp = Type.String({ format: 'date-time' });

export const Currency = Type.Union(
  config.currencies.map((c) => Type.Literal(c)),
  { description: 'ISO 4217 currency code.' },
);

export const MinorAmount = Type.Integer({
  minimum: 1,
  maximum: 10_000_000_000_000,
  description: 'Amount in minor units (kobo, cents, pence). 150000 NGN = NGN 1,500.00. Never a float.',
  examples: [150000],
});

export const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String({ examples: ['insufficient_funds'] }),
      message: Type.String(),
      details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
  },
  { $id: 'Error', description: 'Every error uses this shape. Branch on error.code, not the message.' },
);

export const errorRef = Type.Ref('Error');

export const IdempotencyHeaders = Type.Object({
  'idempotency-key': Type.String({
    minLength: 8,
    maxLength: 255,
    description:
      'Unique key per logical operation (a UUID works). Retrying with the same key and body returns the original response instead of moving money twice.',
  }),
});

export const IdParams = Type.Object({ id: Uuid });

export const Account = Type.Object(
  {
    id: Uuid,
    label: Type.Union([Type.String(), Type.Null()]),
    currency: Currency,
    status: Type.Union([Type.Literal('active'), Type.Literal('frozen')]),
    balance: Type.Integer({ description: 'Current balance in minor units.' }),
    version: Type.Integer({ description: 'Increments on every balance change. Useful for optimistic UI.' }),
    created_at: Timestamp,
  },
  { $id: 'Account' },
);
export type AccountT = Static<typeof Account>;

export const Posting = Type.Object(
  {
    id: Type.Integer(),
    entry_id: Uuid,
    kind: Type.String({ examples: ['transfer'] }),
    amount: Type.Integer({ description: 'Signed. Positive is a credit, negative is a debit.' }),
    balance_after: Type.Integer(),
    description: Type.Union([Type.String(), Type.Null()]),
    reference_type: Type.Union([Type.String(), Type.Null()]),
    reference_id: Type.Union([Uuid, Type.Null()]),
    created_at: Timestamp,
  },
  { $id: 'Posting' },
);

export const Transfer = Type.Object(
  {
    id: Uuid,
    from_account_id: Uuid,
    to_account_id: Uuid,
    amount: Type.Integer(),
    currency: Currency,
    status: Type.Literal('completed'),
    narration: Type.Union([Type.String(), Type.Null()]),
    entry_id: Uuid,
    created_at: Timestamp,
  },
  { $id: 'Transfer' },
);

export const Destination = Type.Object(
  {
    bank_code: Type.String({ minLength: 3, maxLength: 11, examples: ['058'] }),
    account_number: Type.String({ pattern: '^[0-9]{6,20}$', examples: ['0123456789'] }),
    account_name: Type.String({ minLength: 2, maxLength: 120, examples: ['Ada Okafor'] }),
  },
  { additionalProperties: false },
);

export const Withdrawal = Type.Object(
  {
    id: Uuid,
    account_id: Uuid,
    amount: Type.Integer({ description: 'Amount paid out to the destination.' }),
    fee: Type.Integer({ description: 'Platform fee, charged on top of amount.' }),
    currency: Currency,
    status: Type.Union([Type.Literal('pending'), Type.Literal('completed'), Type.Literal('rejected')]),
    destination: Destination,
    review_note: Type.Union([Type.String(), Type.Null()]),
    reviewed_at: Type.Union([Timestamp, Type.Null()]),
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { $id: 'Withdrawal' },
);

export const sharedSchemas = [ErrorResponse, Account, Posting, Transfer, Withdrawal];

export const Paginated = <T extends TSchema>(item: T) =>
  Type.Object({
    data: Type.Array(item),
    next_cursor: Type.Union([Type.String(), Type.Null()], {
      description: 'Pass as ?cursor= to fetch the next page. null when there are no more results.',
    }),
  });

export const PageQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
  cursor: Type.Optional(Type.String({ pattern: '^[0-9]+$' })),
});

const err = (description: string) => Type.Ref('Error', { description });

export const standardErrors = {
  400: err('Validation failed or a required header (such as Idempotency-Key) is missing.'),
  401: err('Missing or invalid API key.'),
  403: err('The API key does not have permission for this action.'),
  404: err('The resource does not exist or belongs to another client.'),
  409: err('Conflict: the resource is in the wrong state, or the same Idempotency-Key is still in flight.'),
  422: err('Business rule rejected the request: insufficient_funds, currency_mismatch, idempotency_key_reused and similar.'),
  423: err('The account is frozen and cannot be debited.'),
};
