import { Type, type Static, type TSchema, type TUnknown } from 'typebox';
import { config } from './config.js';

/** Swagger UI's default placeholder id. The docs page swaps it for your real sandbox ids. */
export const PLACEHOLDER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

export const Uuid = Type.String({ format: 'uuid' });
export const Timestamp = Type.String({ format: 'date-time', examples: ['2026-11-17T14:30:00.000Z'] });

export const Currency = Type.Union(
  config.currencies.map((c) => Type.Literal(c)),
  { description: 'Three-letter currency code, like NGN or USD.', examples: ['NGN'] },
);

export const MinorAmount = Type.Integer({
  minimum: 1,
  maximum: 10_000_000_000_000,
  description:
    'Amount in the smallest unit of the currency (kobo for NGN, cents for USD). So 150000 means NGN 1,500.00. Whole numbers only.',
  examples: [150000],
});

export const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String({ description: 'Stable, machine-readable reason. Check this in your app.', examples: ['insufficient_funds'] }),
      message: Type.String({ description: 'A human-readable explanation.' }),
      details: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'Extra context when it helps, for example the available and required amounts.',
        }),
      ),
    }),
  },
  { $id: 'Error', description: 'Something went wrong. Check error.code.' },
);

export const errorRef = Type.Ref('Error');

export const IdempotencyHeaders = Type.Object({
  'idempotency-key': Type.String({
    minLength: 8,
    maxLength: 255,
    description:
      'A unique key you choose for this payment (a UUID works well). If the same request is sent again with the same key, ' +
      'you get the original response back and no money moves twice. On this docs page, leave it as `new-key-per-click` ' +
      'and a fresh key is made each time you press Execute. Type your own key and press Execute twice to see the replay.',
    examples: ['new-key-per-click'],
  }),
});

export const IdParams = Type.Object({
  id: Type.String({
    format: 'uuid',
    description: 'On this docs page, leave the placeholder and your latest sandbox wallet, transfer or withdrawal is used.',
    examples: [PLACEHOLDER_ID],
  }),
});

export const Account = Type.Object(
  {
    id: Uuid,
    label: Type.Union([Type.String(), Type.Null()], { description: 'Your own name for the wallet.', examples: ["Ada's wallet"] }),
    currency: Currency,
    status: Type.Union([Type.Literal('active'), Type.Literal('frozen')], {
      description: 'A frozen wallet can still receive money but cannot send it.',
      examples: ['active'],
    }),
    balance: Type.Integer({ description: 'What the wallet holds right now, in the smallest unit.', examples: [350000] }),
    version: Type.Integer({ description: 'Goes up by one every time the balance changes.', examples: [2] }),
    created_at: Timestamp,
  },
  { $id: 'Account' },
);
export type AccountT = Static<typeof Account>;

export const Posting = Type.Object(
  {
    id: Type.Integer({ examples: [1042] }),
    entry_id: Uuid,
    kind: Type.String({ description: 'deposit, transfer, withdrawal_hold, withdrawal_settle or withdrawal_release.', examples: ['transfer'] }),
    amount: Type.Integer({ description: 'Money in is positive, money out is negative.', examples: [-150000] }),
    balance_after: Type.Integer({ description: 'The wallet balance right after this line.', examples: [350000] }),
    description: Type.Union([Type.String(), Type.Null()], { examples: ['Lunch'] }),
    reference_type: Type.Union([Type.String(), Type.Null()], { examples: ['transfer'] }),
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
    amount: Type.Integer({ examples: [150000] }),
    currency: Currency,
    status: Type.Literal('completed'),
    narration: Type.Union([Type.String(), Type.Null()], { examples: ['Lunch'] }),
    entry_id: Uuid,
    created_at: Timestamp,
  },
  { $id: 'Transfer' },
);

export const Destination = Type.Object(
  {
    bank_code: Type.String({ minLength: 3, maxLength: 11, description: 'The bank sort code.', examples: ['058'] }),
    account_number: Type.String({ pattern: '^[0-9]{6,20}$', examples: ['0123456789'] }),
    account_name: Type.String({ minLength: 2, maxLength: 120, examples: ['Ada Okafor'] }),
  },
  { additionalProperties: false, description: 'The bank account the money is paid out to.' },
);

export const Withdrawal = Type.Object(
  {
    id: Uuid,
    account_id: Uuid,
    amount: Type.Integer({ description: 'What lands in the bank account.', examples: [200000] }),
    fee: Type.Integer({ description: 'Platform fee, charged on top of the amount.', examples: [1000] }),
    currency: Currency,
    status: Type.Union([Type.Literal('pending'), Type.Literal('completed'), Type.Literal('rejected')], {
      description: 'pending until an admin approves (completed) or rejects it.',
      examples: ['pending'],
    }),
    destination: Destination,
    review_note: Type.Union([Type.String(), Type.Null()], { examples: [null] }),
    reviewed_at: Type.Union([Timestamp, Type.Null()], { examples: [null] }),
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
      description: 'Send this back as ?cursor= to get the next page. It is null on the last page.',
      examples: [null],
    }),
  });

export const PageQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25, description: 'How many results per page.' })),
  cursor: Type.Optional(Type.String({ pattern: '^[0-9]+$', description: 'The next_cursor from the previous page.' })),
});

const withoutId = <T extends TSchema>(schema: T): T => {
  const { $id: _ignored, ...rest } = schema as T & { $id?: string };
  return rest as T;
};

/**
 * A success response with its own human description (shown in Swagger instead of "Default Response").
 * Typed loosely, like a $ref, because handlers return database rows (Date objects) that the
 * serializer formats as ISO strings.
 */
export const ok = (schema: TSchema, description: string): TUnknown =>
  ({ ...withoutId(schema), description }) as unknown as TUnknown;

type ErrorExample = { description: string; code: string; message: string; details?: Record<string, unknown> };

const ERROR_EXAMPLES: Record<number, ErrorExample> = {
  400: {
    description: 'Something in the request is missing or not valid.',
    code: 'validation_error',
    message: 'body/amount must be integer',
    details: { issues: [{ instancePath: '/amount', message: 'must be integer' }] },
  },
  401: { description: 'No API key was sent, or the key is not valid.', code: 'unauthorized', message: 'Missing or invalid API key.' },
  403: {
    description: 'Your key is valid but cannot do this. Admin actions need an admin key.',
    code: 'forbidden',
    message: 'This API key is not allowed to perform this action.',
  },
  404: {
    description: "It doesn't exist, or it belongs to someone else.",
    code: 'not_found',
    message: 'Account not found.',
  },
  409: {
    description: 'The same Idempotency-Key is still being processed. Wait a moment and retry.',
    code: 'request_in_progress',
    message: 'A request with this Idempotency-Key is still being processed.',
  },
  422: {
    description: 'The request was understood but breaks a money rule, such as not enough balance or mixed currencies.',
    code: 'insufficient_funds',
    message: 'The account does not have enough available balance.',
    details: { account_id: PLACEHOLDER_ID, available: 100000, required: 150000 },
  },
  423: {
    description: 'The wallet is frozen, so money cannot leave it.',
    code: 'account_frozen',
    message: 'The account is frozen and cannot be debited.',
    details: { account_id: PLACEHOLDER_ID },
  },
  429: {
    description: 'Too many requests in a short time. Wait and try again.',
    code: 'rate_limited',
    message: 'Too many requests. Retry after 42s.',
  },
};

/**
 * Error responses for a route, each with a plain-English description and a realistic example,
 * so Swagger shows real errors instead of generated filler.
 */
export function errors(statuses: number[], overrides: Record<number, Partial<ErrorExample>> = {}) {
  const out: Record<number, TSchema> = {};
  for (const status of statuses) {
    const e = { ...ERROR_EXAMPLES[status]!, ...overrides[status] };
    out[status] = {
      ...withoutId(ErrorResponse),
      description: e.description,
      examples: [{ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }],
    } as TSchema;
  }
  return out;
}
