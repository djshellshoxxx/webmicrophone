import { defineConfig } from '@playwright/test';

const builtApp = process.env.WEBMIC_TEST_BUILD === '1';
const baseURL = process.env.WEBMIC_TEST_URL ?? `http://127.0.0.1:${builtApp ? 4173 : 5173}/webmicrophone/`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 120000,
  globalTimeout: 5 * 60 * 1000,
  expect: { timeout: 15000 },
  outputDir: builtApp ? 'test-results/pages' : 'test-results/source',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: builtApp ? 'playwright-report/pages' : 'playwright-report/source' }],
    ['json', { outputFile: builtApp ? 'test-results/pages-browser-results.json' : 'test-results/browser-results.json' }],
  ],
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: builtApp ? 'npx vite preview --host 127.0.0.1 --port 4173 --strictPort' : 'npx vite --host 127.0.0.1 --port 5173 --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
