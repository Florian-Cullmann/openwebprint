import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 } },
    },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        baseURL: 'http://127.0.0.1:4174',
      },
    },
  ],
  webServer: [4173, 4174].map((port) => ({
    command: 'node --import tsx e2e/server.ts',
    url: `http://127.0.0.1:${port}/api/health`,
    env: { E2E_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 30_000,
  })),
});
