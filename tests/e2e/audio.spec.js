import { test, expect } from '@playwright/test';
import { runBrowserHarness } from './harness-runner.js';

test('real browser audio capture, persistence, processing and export', async ({ page, baseURL }, testInfo) => {
  await runBrowserHarness(page, baseURL, async (name, report) => {
    await testInfo.attach(name, { body: Buffer.from(JSON.stringify(report, null, 2)), contentType: 'application/json' });
  });
});

test('workbench starts muted and scene changes keep monitoring off', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await expect(page.locator('h1')).toContainText('WebMicrophone');
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#scene').selectOption('street-voice');
  await expect(page.locator('[data-setting="speech"]')).toBeChecked();
  await page.locator('#scene').selectOption('birds-wind');
  await expect(page.locator('[data-setting="speech"]')).not.toBeChecked();
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#source-details')).toContainText('not connected');
  expect(errors).toEqual([]);
});
