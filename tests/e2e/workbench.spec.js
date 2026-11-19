import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('record a generated source, save EQ settings, and export a trimmed filtered take', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.locator('#demo').click();
  await expect.poll(async () => page.locator('#input-peak').innerText()).toMatch(/\d/);
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false');

  await page.locator('#duration').selectOption('10');
  await page.locator('#record').click();
  await expect(page.locator('#record-time')).toHaveText('00:01', { timeout: 15000 });
  await page.locator('#pause').click();
  await expect(page.locator('#pause')).toContainText('Resume');
  await page.locator('#pause').click();
  await expect(page.locator('#pause')).toContainText('Pause');
  await page.locator('#stop').click();
  await expect(page.locator('#takes-list .take-row')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('#export-audio')).toBeEnabled();

  await page.locator('[data-control="band"]').selectOption('5');
  await page.locator('[data-control="frequency"]').fill('440');
  await page.locator('[data-control="gain"]').fill('-12');
  await page.locator('[data-control="gain"]').press('Tab');

  // A nonzero start catches accidentally trimming the already-trimmed render twice.
  await page.locator('#trim-start').fill('0.025');
  await page.locator('#trim-end').fill('0.275');
  await page.locator('#export-format').selectOption('wav24');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-audio').click();
  const download = await downloadPromise;
  const wavPath = testInfo.outputPath('filtered-selection.wav');
  await download.saveAs(wavPath);
  const wav = await readFile(wavPath);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt16LE(20)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(48000);
  expect(wav.readUInt16LE(34)).toBe(24);
  let dataBytes = null, dataOffset = null;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') { dataBytes = size; dataOffset = offset + 8; break; }
    offset += 8 + size + size % 2;
  }
  expect(dataBytes).toBe(12000 * wav.readUInt16LE(22) * 3);
  let power = 0;
  for (let offset = dataOffset; offset < dataOffset + dataBytes; offset += 3) power += (wav.readIntLE(offset, 3) / 8388608) ** 2;
  expect(Math.sqrt(power / (dataBytes / 3))).toBeLessThan(0.11);

  await page.locator('#scene').selectOption('birds-wind');
  await page.locator('#preset-name').fill('Verification bird settings');
  await page.locator('#save-preset').click();
  await page.locator('#reset-settings').click();
  await page.locator('#saved-preset').selectOption('0');
  await expect(page.locator('#scene')).toHaveValue('birds-wind');
  await expect(page.locator('[data-setting="speech"]')).not.toBeChecked();
  await page.locator('#preset-name').fill('Renamed bird settings');
  await page.locator('#rename-preset').click();
  await expect(page.locator('#saved-preset option:checked')).toHaveText('Renamed bird settings');
  await page.reload();
  await page.locator('#saved-preset').selectOption('0');
  await expect(page.locator('#scene')).toHaveValue('birds-wind');
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#takes-list .take-row')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-preset').click();
  await expect(page.locator('#saved-preset option')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('controls stay within a narrow viewport and retain keyboard EQ access', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.locator('#eq-editor')).toBeVisible();
  // Layout assertion reads geometry only; the UI remains the interaction surface.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(overflow).toBe(false);
  await page.locator('.eq-node[data-band="0"]').press('ArrowUp');
  await expect(page.locator('[data-control="gain"]')).toHaveValue('0.5');
  await expect(page.locator('#scene')).toHaveValue('custom');
  await page.locator('#tab-phase').click();
  await expect(page.locator('#phase-panel')).toBeVisible();
  await page.locator('#tab-phase').press('ArrowRight');
  await expect(page.locator('#tools-panel')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-workbench.png'), fullPage: true });
});
