import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  // Start the server before running tests.
  webServer: {
    command: `DATABASE_URL=/tmp/beam-e2e-${Date.now()}.db pnpm --filter @routr/server start`,
    url: 'http://localhost:3000/api/v1/health',
    reuseExistingServer: false,
    timeout: 15_000,
  },
  use: {
    baseURL: 'http://localhost:3000',
  },
  projects: [
    {
      name: 'api',
      testMatch: '**/api.test.ts',
    },
  ],
});
