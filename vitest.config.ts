import { userInfo } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    // Tests share one database, so run files one at a time.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? `postgresql://${userInfo().username}@localhost:5432/loyalty_test`,
      JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
      ODOO_BASE_URL: 'http://odoo.invalid/go/api',
      CORS_ORIGINS: 'http://localhost:5173',
      PUBLIC_JOIN_BASE_URL: 'https://join.test',
    },
  },
});
