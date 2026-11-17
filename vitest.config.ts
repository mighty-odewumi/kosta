import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ledger_test',
      WEBHOOK_SECRET: 'whsec_test_secret',
      WITHDRAWAL_FEE_BPS: '50',
      RATE_LIMIT_ENABLED: 'false',
      LOG_LEVEL: 'silent',
      SANDBOX_MODE: 'true',
      CORS_ORIGINS: 'https://docs.example.com',
    },
  },
});
