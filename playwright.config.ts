import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    ignoreHTTPSErrors: true,
    baseURL: 'https://localhost:3000',
  },
  webServer: {
    command: 'npm run dev',
    url: 'https://localhost:3000',
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
