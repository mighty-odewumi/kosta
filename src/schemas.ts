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
      code: Type.String({
        description: 'Stable, machine-readable reason. Check this in your app. Each response lists the codes it can return.',
        examples: ['not_found'],
      }),
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

/** Every error code the API can return, with the message it sends and when it happens. */
const ERROR_CODES: Record<string, { message: string; when: string; details?: Record<string, unknown> }> = {
  validation_error: {
    message: 'body/amount must be integer',
    when: 'a field is missing, has the wrong type or is out of range',
    details: { issues: [{ instancePath: '/amount', message: 'must be integer' }] },
  },
  invalid_json: { message: 'Request body is not valid JSON.', when: 'the body could not be read as JSON' },
  idempotency_key_required: {
    message: 'Send a unique Idempotency-Key header (8 to 255 characters) with every money-moving request.',
    when: 'the Idempotency-Key header is missing or too short',
  },
  unauthorized: { message: 'Missing or invalid API key.', when: 'no API key was sent, or it is wrong or revoked' },
  invalid_signature: { message: 'Webhook signature does not match.', when: 'the signature is missing or does not match the body' },
  signature_expired: {
    message: 'Webhook timestamp is outside the allowed tolerance (possible replay).',
    when: 'the signed timestamp is more than 5 minutes old',
  },
  forbidden: { message: 'This API key is not allowed to perform this action.', when: 'a client key tries an admin action' },
  not_found: { message: 'Account not found.', when: "it does not exist, or it belongs to another client" },
  request_in_progress: {
    message: 'A request with this Idempotency-Key is still being processed.',
    when: 'the same Idempotency-Key arrives again while the first request is still running',
  },
  invalid_state: { message: 'Withdrawal is already completed.', when: 'the withdrawal was already approved or rejected' },
  insufficient_funds: {
    message: 'The account does not have enough available balance.',
    when: 'the wallet cannot cover the amount (plus the fee, for withdrawals)',
    details: { account_id: PLACEHOLDER_ID, available: 100000, required: 150000 },
  },
  currency_mismatch: {
    message: 'All accounts in a transaction must use the same currency.',
    when: 'the two wallets hold different currencies',
  },
  same_account: { message: 'Source and destination accounts must be different.', when: 'you try to send money to the same wallet' },
  idempotency_key_reused: {
    message: 'This Idempotency-Key was already used with a different request.',
    when: 'a key you already used is sent again with a different body',
  },
  constraint_violation: {
    message: 'The operation violates a ledger rule.',
    when: 'a database safety check stopped the change (a last line of defence that should never trigger)',
  },
  account_frozen: {
    message: 'The account is frozen and cannot be debited.',
    when: 'money would leave a frozen wallet',
    details: { account_id: PLACEHOLDER_ID },
  },
  rate_limited: { message: 'Too many requests. Retry after 42s.', when: 'too many requests were sent in a short time' },
};

type StatusInfo = { description: string; codes: string[] };

const STATUS_DEFAULTS: Record<number, StatusInfo> = {
  400: { description: 'Something in the request is missing or not valid.', codes: ['validation_error', 'invalid_json'] },
  401: { description: 'No API key was sent, or the key is not valid.', codes: ['unauthorized'] },
  403: { description: 'Your key is valid but cannot do this. Admin actions need an admin key.', codes: ['forbidden'] },
  404: { description: "It doesn't exist, or it belongs to someone else.", codes: ['not_found'] },
  409: { description: 'The same Idempotency-Key is still being processed. Wait a moment and retry.', codes: ['request_in_progress'] },
  422: {
    description: 'The request was understood but breaks a money rule.',
    codes: ['insufficient_funds', 'currency_mismatch'],
  },
  423: { description: 'The wallet is frozen, so money cannot leave it.', codes: ['account_frozen'] },
  429: { description: 'Too many requests in a short time. Wait and try again.', codes: ['rate_limited'] },
};

type ErrorOverride = { description?: string; codes?: string[]; message?: string };

/**
 * Error responses for a route. Each status gets a plain-English description, the exact list of
 * codes it can carry (with when each happens) and a realistic example, so the Schema and Example
 * tabs in Swagger always match the status they sit under.
 */
export function errors(statuses: number[], overrides: Record<number, ErrorOverride> = {}) {
  const out: Record<number, TSchema> = {};
  for (const status of statuses) {
    const info = { ...STATUS_DEFAULTS[status]!, ...overrides[status] };
    const first = ERROR_CODES[info.codes[0]!]!;
    const message = overrides[status]?.message ?? first.message;
    const detailsNote = info.codes.includes('insufficient_funds')
      ? 'Extra context. For insufficient_funds: account_id, available and required.'
      : info.codes.includes('account_frozen')
        ? 'Extra context: the account_id of the frozen wallet.'
        : info.codes.includes('validation_error')
          ? 'Extra context: issues lists each field that failed and why.'
          : undefined;
    const codeList = info.codes.map((c) => `\`${c}\`: ${ERROR_CODES[c]!.when}.`).join('\n- ');
    out[status] = {
      type: 'object',
      description: info.description,
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: {
              type: 'string',
              enum: info.codes,
              description: (info.codes.length > 1 ? 'One of:\n- ' : 'Always:\n- ') + codeList,
            },
            message: { type: 'string', description: 'A human-readable explanation.', examples: [message] },
            ...(detailsNote
              ? { details: { type: 'object', additionalProperties: true, description: detailsNote } }
              : {}),
          },
        },
      },
      examples: [{ error: { code: info.codes[0], message, ...(first.details ? { details: first.details } : {}) } }],
    } as unknown as TSchema;
  }
  return out;
}
