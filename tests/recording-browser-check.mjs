import { chromium } from '@playwright/test';
import { runBrowserHarness } from './e2e/harness-runner.js';

// Standalone equivalent of the CI test. Start Vite separately, then run:
// npx playwright install --with-deps chromium
// node tests/recording-browser-check.mjs
// CHROMIUM_PATH optionally selects an already installed browser. CI uses the
// Playwright-managed revision rather than assuming /usr/bin/chromium exists.
const baseUrl = process.env.WEBMIC_TEST_URL ?? 'http://127.0.0.1:5173/webmicrophone/';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
try {
  const page = await browser.newPage();
  const reports = await runBrowserHarness(page, baseUrl);
  console.log(JSON.stringify({ browser: browser.version(), ...reports }, null, 2));
} finally { await browser.close(); }
