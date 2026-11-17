import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Type } from 'typebox';
import { authenticate } from './auth.js';
import { config } from './config.js';
import { getPool } from './db.js';
import { AppError } from './errors.js';
import { sharedSchemas } from './schemas.js';
import accountRoutes from './routes/accounts.js';
import transferRoutes from './routes/transfers.js';
import withdrawalRoutes from './routes/withdrawals.js';
import webhookRoutes from './routes/webhooks.js';
import adminRoutes from './routes/admin.js';
import sandboxRoutes from './routes/sandbox.js';

const API_DESCRIPTION = `
Kosta is a double-entry ledger and payments API for wallet-based fintech products.

**Core guarantees**

- **Double-entry accounting.** Every movement of money is a journal entry whose postings sum to zero. A deferred Postgres trigger rejects any unbalanced entry at commit time.
- **No overdrafts.** Accounts are row-locked in a fixed order during each entry, and a database CHECK constraint stops customer balances going below zero even if application code is wrong.
- **Exactly-once money movement.** Transfers and withdrawals require an \`Idempotency-Key\`. Retries replay the original response.
- **Append-only ledger.** Postings and journal entries cannot be updated or deleted; corrections are new entries.
- **Integer money.** All amounts are integers in minor units (kobo, cents). No floating point anywhere.
- **Signed, replay-safe webhooks** for deposits, de-duplicated by event id and provider reference.
- **Full audit trail** written in the same transaction as each change, plus an on-demand reconciliation report.

**Authentication**

Send \`Authorization: Bearer <api key>\`. Client keys see only the wallets they created. Admin keys can review payouts, freeze accounts, read the audit log and run reconciliation.

**Errors**

Every error has the shape \`{ "error": { "code": "...", "message": "...", "details": {} } }\`. Branch on \`code\`.
`.trim();

export async function buildApp(opts: FastifyServerOptions = {}) {
  const app = Fastify({
    logger: { level: config.logLevel, redact: ['req.headers.authorization'] },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true } },
    genReqId: () => crypto.randomUUID(),
    ...opts,
  });

  // Keep the raw body so webhook signatures can be verified byte-for-byte.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = body as string;
    request.rawBody = raw;
    if (raw === '') return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(new AppError(400, 'invalid_json', 'Request body is not valid JSON.'), undefined);
    }
  });

  for (const schema of sharedSchemas) app.addSchema(schema);

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });

  if (config.corsOrigins.length) {
    await app.register(cors, {
      origin: config.corsOrigins,
      allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
      exposedHeaders: ['idempotent-replayed', 'x-ratelimit-remaining', 'retry-after'],
      methods: ['GET', 'POST'],
    });
  }

  if (config.rateLimitEnabled) {
    await app.register(rateLimit, {
      max: config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.headers.authorization ?? req.ip,
      errorResponseBuilder: (_req, ctx) =>
        new AppError(429, 'rate_limited', `Too many requests. Retry after ${Math.ceil(ctx.ttl / 1000)}s.`),
    });
  }

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Kosta API', version: '1.0.0', description: API_DESCRIPTION },
      servers: [
        ...(config.publicUrl ? [{ url: config.publicUrl, description: config.sandbox ? 'Public sandbox' : 'Production' }] : []),
        { url: `http://localhost:${config.port}`, description: 'Local' },
      ],
      tags: [
        ...(config.sandbox
          ? [{ name: 'Sandbox', description: 'Start here on the public sandbox: get a key, then fund a wallet' }]
          : []),
        { name: 'Accounts', description: 'Single-currency wallets and statements' },
        { name: 'Transfers', description: 'Wallet-to-wallet transfers' },
        { name: 'Withdrawals', description: 'Payouts to bank accounts with a hold, then review' },
        { name: 'Webhooks', description: 'Inbound payment provider events' },
        { name: 'Admin', description: 'Operations, compliance and finance tooling' },
        { name: 'System', description: 'Health' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key, e.g. ks_live_xxx or ks_admin_xxx' },
          webhookSignature: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Kosta-Signature',
            description: 't=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">',
          },
        },
      },
    },
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) => (json.$id as string) ?? `def-${i}`,
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list', deepLinking: true } });

  // Every /v1 route except inbound webhooks needs an API key.
  app.addHook('onRequest', async (request) => {
    const url = request.url;
    if (url.startsWith('/v1/') && !url.startsWith('/v1/webhooks/')) await authenticate(request);
  });

  // Action endpoints (approve, reject, freeze) take an optional body; treat "no body" as {}.
  app.addHook('preValidation', async (request) => {
    if (request.method === 'POST' && request.body === undefined) request.body = {};
  });

  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
    if ((err as FastifyError).validation) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: err.message,
          details: { issues: (err as FastifyError).validation },
        },
      });
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23514') {
      // A database CHECK caught something application code missed (e.g. overdraft). Fail safe.
      request.log.error({ err }, 'database constraint rejected a write');
      return reply.code(422).send({ error: { code: 'constraint_violation', message: 'The operation violates a ledger rule.' } });
    }
    if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) {
      return reply
        .code((err as FastifyError).statusCode!)
        .send({ error: { code: (err as FastifyError).code ?? 'bad_request', message: err.message } });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong. It has been logged.' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'route_not_found', message: 'No such endpoint.' } }),
  );

  app.get(
    '/health',
    {
      schema: {
        tags: ['System'],
        summary: 'Liveness and database check',
        response: { 200: Type.Object({ status: Type.Literal('ok'), database: Type.Literal('ok') }) },
      },
    },
    async () => {
      await getPool().query('SELECT 1');
      return { status: 'ok', database: 'ok' } as const;
    },
  );

  await app.register(accountRoutes);
  await app.register(transferRoutes);
  await app.register(withdrawalRoutes);
  await app.register(webhookRoutes);
  await app.register(adminRoutes);
  if (config.sandbox) await app.register(sandboxRoutes);

  return app;
}
