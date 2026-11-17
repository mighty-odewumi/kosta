import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { config } from '../config.js';
import { getPool, withTx } from '../db.js';
import { AppError } from '../errors.js';
import { creditDeposit } from '../ledger/deposits.js';
import { Currency, MinorAmount, Uuid, errors, ok } from '../schemas.js';

export const SIGNATURE_HEADER = 'x-kosta-signature';

/** Signs a payload the way a payment provider would: HMAC-SHA256 over "timestamp.rawBody". */
export function signWebhook(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export function verifySignature(request: FastifyRequest): void {
  const header = request.headers[SIGNATURE_HEADER];
  const raw = request.rawBody;
  if (typeof header !== 'string' || raw === undefined) {
    throw new AppError(401, 'invalid_signature', 'Missing webhook signature.');
  }
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) {
    throw new AppError(401, 'invalid_signature', 'Malformed webhook signature header.');
  }
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > config.webhookToleranceSeconds) {
    throw new AppError(401, 'signature_expired', 'Webhook timestamp is outside the allowed tolerance (possible replay).');
  }
  const expected = createHmac('sha256', config.webhookSecret).update(`${timestamp}.${raw}`).digest();
  const given = Buffer.from(parts.v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AppError(401, 'invalid_signature', 'Webhook signature does not match.');
  }
}

const WebhookBody = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128, description: "The provider's id for this notification.", examples: ['evt_8f2a1c'] }),
  type: Type.String({ description: 'Only deposit.succeeded moves money. Other types are acknowledged and ignored.', examples: ['deposit.succeeded'] }),
  provider: Type.String({ minLength: 2, maxLength: 40, examples: ['paystack'] }),
  data: Type.Object({
    account_id: Uuid,
    amount: MinorAmount,
    currency: Currency,
    reference: Type.String({ minLength: 1, maxLength: 128, description: "The provider's payment reference.", examples: ['PSK_REF_0001'] }),
  }),
});

const WebhookResult = Type.Object({
  status: Type.Union(
    [Type.Literal('processed'), Type.Literal('duplicate'), Type.Literal('ignored'), Type.Literal('failed')],
    {
      description:
        'processed: wallet credited. duplicate: already credited before, nothing changed. ignored: not a deposit. failed: could not be applied (see reason).',
      examples: ['processed'],
    },
  ),
  deposit_id: Type.Optional(Uuid),
  reason: Type.Optional(Type.String()),
});

export default async function webhookRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<TypeBoxTypeProvider>();

  r.post(
    '/v1/webhooks/deposits',
    {
      // Verify the signature before anything else, including body validation.
      preValidation: async (request) => verifySignature(request),
      schema: {
        tags: ['Webhooks'],
        summary: 'Payment received (called by your payment provider)',
        description:
          'Your payment provider (Paystack, Flutterwave and so on) calls this when a customer pays in, and Kosta ' +
          'credits their wallet. You do not call it yourself; on this docs page, use the Sandbox deposit instead.\n\n' +
          'How it stays safe:\n\n' +
          '- Every call must be signed with a secret only you and the provider know, sent in `X-Kosta-Signature`.\n' +
          '- Calls older than 5 minutes are refused, so a captured request cannot be replayed later.\n' +
          '- Providers often send the same notification more than once. Each payment is credited exactly once.\n' +
          '- Kosta answers 200 to every properly signed call so the provider stops retrying, and records any that ' +
          'could not be applied for the team to review.',
        security: [{ webhookSignature: [] }],
        body: WebhookBody,
        response: {
          200: ok(WebhookResult, 'Received. The status says what happened.'),
          ...errors([400, 401], {
            401: { description: 'The signature is missing, wrong or too old.', codes: ['invalid_signature', 'signature_expired'] },
          }),
        },
      },
    },
    async (request) => {
      const event = request.body;
      const actor = { keyId: null, label: `webhook:${event.provider}` };

      if (event.type !== 'deposit.succeeded') {
        const ins = await getPool().query(
          `INSERT INTO webhook_events (provider, event_id, event_type, payload, status)
           VALUES ($1, $2, $3, $4, 'ignored') ON CONFLICT DO NOTHING`,
          [event.provider, event.id, event.type, JSON.stringify(event)],
        );
        return { status: ins.rowCount === 0 ? 'duplicate' : 'ignored' } as const;
      }

      try {
        return await withTx(async (tx) => {
          const ins = await tx.query(
            `INSERT INTO webhook_events (provider, event_id, event_type, payload, status)
             VALUES ($1, $2, $3, $4, 'processed') ON CONFLICT DO NOTHING RETURNING id`,
            [event.provider, event.id, event.type, JSON.stringify(event)],
          );
          if (ins.rowCount === 0) return { status: 'duplicate' } as const;

          const result = await creditDeposit(
            tx,
            {
              accountId: event.data.account_id,
              amount: event.data.amount,
              currency: event.data.currency,
              provider: event.provider,
              reference: event.data.reference,
            },
            actor,
          );
          return { status: result.status, deposit_id: result.depositId } as const;
        });
      } catch (err) {
        if (!(err instanceof AppError) || err.statusCode >= 500) throw err; // 5xx: let the provider retry
        await getPool().query(
          `INSERT INTO webhook_events (provider, event_id, event_type, payload, status, error)
           VALUES ($1, $2, $3, $4, 'failed', $5) ON CONFLICT DO NOTHING`,
          [event.provider, event.id, event.type, JSON.stringify(event), err.code],
        );
        request.log.warn({ eventId: event.id, code: err.code }, 'deposit webhook could not be applied');
        return { status: 'failed', reason: err.code } as const;
      }
    },
  );
}
