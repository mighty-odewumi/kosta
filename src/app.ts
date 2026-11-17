import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
Kosta is a payments backend for wallet apps. It keeps a proper ledger of every naira, cent or penny that moves, so balances are always right, money can never be spent twice, and every change can be traced.

**What it guarantees**

- **Every movement balances.** Money is never created or lost: each transaction takes from one place and puts the same amount somewhere else. The database itself refuses anything that does not add up.
- **No overdrafts, even under heavy load.** When many requests try to spend the same balance at once, only the ones the balance can cover go through.
- **Safe retries.** Send an \`Idempotency-Key\` with transfers and withdrawals. If the same request arrives twice, say a phone retries after a timeout, the second one gets the original answer and no money moves again.
- **History cannot be rewritten.** Ledger records cannot be edited or deleted. Mistakes are fixed with new, visible correcting entries.
- **Whole numbers only.** Amounts are in the smallest unit (kobo, cents), so there are no rounding errors.
- **Trusted deposits.** Notifications from payment providers must be signed, and the same payment can never be credited twice.
- **A full paper trail.** Every action is logged, and a books check proves everything balances.

**Signing in**

Send your API key as \`Authorization: Bearer <key>\`. Client keys only see the wallets they opened. Admin keys can also review withdrawals, freeze wallets, read the activity log and run the books check.

**When something goes wrong**

Errors always look like \`{ "error": { "code": "...", "message": "..." } }\`, sometimes with extra \`details\`. Check \`code\` in your app; the message is written for people.
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
          ? [{ name: 'Sandbox', description: 'Test helpers: get a key and add test money' }]
          : []),
        { name: 'Accounts', description: 'Open wallets, check balances and read statements' },
        { name: 'Transfers', description: 'Send money between wallets' },
        { name: 'Withdrawals', description: 'Pay out to bank accounts, with review' },
        { name: 'Webhooks', description: 'Payment notifications from your provider' },
        { name: 'Admin', description: 'Review withdrawals, freeze wallets, see activity and check the books' },
        { name: 'System', description: 'Is it up?' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'Your API key. On the docs page this is filled in for you when you start a sandbox session.',
          },
          webhookSignature: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Kosta-Signature',
            description: 'Format: `t=<unix seconds>,v1=<hex>` where hex is the HMAC-SHA256 of `<t>.<raw body>` using the shared webhook secret.',
          },
        },
      },
    },
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) => (json.$id as string) ?? `def-${i}`,
    },
  });
  // The same Swagger UI page published to GitHub Pages, served by the API itself at /docs.
  const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
  app.get('/docs', { schema: { hide: true } }, (_req, reply) => reply.redirect('/docs/'));
  app.get('/docs/', { schema: { hide: true } }, async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(await readFile(join(docsDir, 'index.html'), 'utf8')),
  );
  app.get('/docs/openapi.json', { schema: { hide: true } }, async () => app.swagger());

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
        summary: 'Health check',
        description: 'Answers ok when the API is running and can reach its database.',
        response: {
          200: Type.Object(
            { status: Type.Literal('ok'), database: Type.Literal('ok') },
            { description: 'All good.' },
          ),
        },
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
