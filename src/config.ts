const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && value !== undefined && value !== '' ? n : fallback;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ledger',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Shared secret used to verify HMAC signatures on incoming payment provider webhooks. */
  webhookSecret: process.env.WEBHOOK_SECRET ?? 'whsec_dev_only_change_me',
  /** Reject webhooks whose signed timestamp is older than this (replay protection). */
  webhookToleranceSeconds: num(process.env.WEBHOOK_TOLERANCE_SECONDS, 300),
  /** Withdrawal fee in basis points (50 = 0.5%). */
  withdrawalFeeBps: num(process.env.WITHDRAWAL_FEE_BPS, 50),
  rateLimitMax: num(process.env.RATE_LIMIT_MAX, 120),
  rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== 'false',
  /** An idempotency key stuck "in progress" longer than this (crashed worker) may be retried. */
  idempotencyLockSeconds: num(process.env.IDEMPOTENCY_LOCK_SECONDS, 60),
  /** Public base URL of the deployed API, used in the OpenAPI "servers" list. */
  publicUrl: process.env.PUBLIC_API_URL ?? process.env.RENDER_EXTERNAL_URL ?? '',
  /** Comma-separated browser origins allowed to call the API (e.g. the GitHub Pages docs site). */
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /**
   * Sandbox mode exposes /sandbox endpoints so reviewers can self-issue a client key and
   * fund test wallets from Swagger UI. Never enable this in production.
   */
  sandbox: process.env.SANDBOX_MODE === 'true',
  currencies: ['NGN', 'USD', 'GBP', 'EUR', 'KES', 'GHS', 'ZAR'] as const,
};

export type Currency = (typeof config.currencies)[number];
