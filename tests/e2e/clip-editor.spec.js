import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

const panel = page => page.locator('#compact-clip-editor');
const action = (page, name) => panel(page).locator(`[data-clip-action="${name}"]`);
const number = (page, name) => panel(page).locator(`[data-clip-input="${name}"]`);
const transform = (page, name) => panel(page).locator(`[data-clip-transform="${name}"]`);
async function enter(locator, value) { await locator.fill(String(value)); await locator.press('Tab'); }

function fixtureWav() {
  const frames = 48000, bytes = Buffer.alloc(44 + frames * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame++) {
    const value = (1 + Math.floor(frame / 12000)) * 1000;
    bytes.writeInt16LE(value, 44 + frame * 4); bytes.writeInt16LE(-value, 46 + frame * 4);
  }
  return bytes;
}

function wavInfo(bytes) {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  const channels = bytes.readUInt16LE(22), rate = bytes.readUInt32LE(24), bits = bytes.readUInt16LE(34), tag = bytes.readUInt16LE(20);
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') return {channels, rate, bits, tag, offset: offset + 8, frames: length / (channels * bits / 8)};
    offset += 8 + length + length % 2;
  }
  throw new Error('WAV has no data chunk');
}

async function download(page, button, path) {
  const pending = page.waitForEvent('download');
  await button.click();
  const file = await pending;
  await file.saveAs(path);
  return readFile(path);
}

test('compact editor changes real stereo samples, restores history and preserves the imported original', async ({page}, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width: 1440, height: 1000});
  await page.goto('./');
  await expect(action(page, 'play')).toBeDisabled();
  const original = fixtureWav();
  await page.locator('#audio-file').setInputFiles({name: 'quarter-sections.wav', mimeType: 'audio/wav', buffer: original});
  await expect(panel(page).locator('[data-clip-duration]')).toHaveText('1.00 s');
  await page.locator('#export-source').selectOption('original');
  await page.locator('#export-format').selectOption('wav32');
  // Browser decoders can use different full-scale integer normalization. Compare
  // edits against this browser's decoded source, with exact Float32 equality.
  const reference = await download(page, page.locator('#export-audio'), testInfo.outputPath('decoded-reference.wav'));
  const referenceInfo = wavInfo(reference);
  expect(referenceInfo).toMatchObject({channels: 2, rate: 48000, bits: 32, tag: 3, frames: 48000});

  await enter(number(page, 'start'), 0.25);
  await enter(number(page, 'end'), 0.5);
  await action(page, 'cut').click();
  await expect(panel(page).locator('[data-clip-duration]')).toHaveText('0.75 s');
  await expect(action(page, 'paste')).toBeEnabled();
  await action(page, 'undo').click();
  await expect(panel(page).locator('[data-clip-duration]')).toHaveText('1.00 s');
  await action(page, 'redo').click();
  await expect(panel(page).locator('[data-clip-duration]')).toHaveText('0.75 s');
  await enter(number(page, 'cursor'), 0.75);
  await action(page, 'paste').click();
  await expect(panel(page).locator('[data-clip-duration]')).toHaveText('1.00 s');
  await action(page, 'select-all').click();
  await action(page, 'reverse').click();

  await page.locator('#export-source').selectOption('original');
  await page.locator('#export-format').selectOption('wav32');
  const rendered = await download(page, page.locator('#export-audio'), testInfo.outputPath('edited-stereo.wav'));
  const info = wavInfo(rendered);
  expect(info).toMatchObject({channels: 2, rate: 48000, bits: 32, tag: 3, frames: 48000});
  for (const [index, sourceQuarter] of [1, 3, 2, 0].entries()) {
    const at = info.offset + (index * 12000 + 6000) * 8;
    const before = referenceInfo.offset + (sourceQuarter * 12000 + 6000) * 8;
    expect(rendered.readFloatLE(at)).toBe(reference.readFloatLE(before));
    expect(rendered.readFloatLE(at + 4)).toBe(reference.readFloatLE(before + 4));
  }
  const recovered = await download(page, page.locator('#download-original'), testInfo.outputPath('unchanged-original.wav'));
  expect(recovered.equals(original)).toBe(true);

  await enter(number(page, 'cursor'), 0.5);
  await action(page, 'split').click();
  const canvas = panel(page).locator('canvas');
  const box = await canvas.boundingBox();
  await canvas.dblclick({position: {x: box.width * 0.75, y: box.height * 0.5}});
  await expect(number(page, 'start')).toHaveValue('0.500');
  await expect(number(page, 'end')).toHaveValue('1.000');
  await action(page, 'keep').click();
  await expect(panel(page).locator('[data-clip-duration]')).toHaveText('0.50 s');

  const bounds = await page.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height}; };
    return {editor: box('#compact-clip-editor'), source: box('.source-rack'), processing: box('.processing-panel'), overflowing: document.documentElement.scrollWidth > innerWidth + 1};
  });
  expect(bounds.editor.left).toBeCloseTo(bounds.source.left, 0);
  expect(bounds.editor.right).toBeLessThanOrEqual(bounds.source.right + 1);
  expect(bounds.editor.top).toBeGreaterThan(bounds.source.bottom);
  expect(bounds.editor.bottom).toBeLessThanOrEqual(bounds.processing.bottom + 2);
  expect(bounds.editor.height).toBeGreaterThan(160);
  expect(bounds.overflowing).toBe(false);
  await panel(page).scrollIntoViewIfNeeded();
  await page.screenshot({path: testInfo.outputPath('compact-editor-desktop.png')});
  expect(errors).toEqual([]);
});

test('pitch and stretch reach playback and WAV export with pause, seeking, looping and responsive containment', async ({page}, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.locator('#demo').click();
  await expect(action(page, 'play')).toBeEnabled();
  await panel(page).locator('[data-clip-tab="time"]').click();
  await enter(transform(page, 'stretch'), 150);
  await enter(transform(page, 'pitchSemitones'), 12);
  await expect(panel(page).locator('[data-clip-duration]')).toHaveText('9.00 s');
  await action(page, 'play').click();
  await expect(panel(page).locator('[data-clip-state]')).toHaveText('PLAYING');
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#stop-mic')).toBeDisabled();
  await expect.poll(async () => Number(await panel(page).locator('canvas').getAttribute('aria-valuenow'))).toBeGreaterThan(0.1);
  await action(page, 'pause').click();
  await expect(panel(page).locator('[data-clip-state]')).toHaveText('PAUSED');
  const paused = await panel(page).locator('canvas').getAttribute('aria-valuenow');
  await page.waitForTimeout(150);
  expect(await panel(page).locator('canvas').getAttribute('aria-valuenow')).toBe(paused);
  await enter(number(page, 'cursor'), 2);
  await action(page, 'play').click();
  await expect(panel(page).locator('[data-clip-state]')).toHaveText('PLAYING');
  await expect.poll(async () => Number(await panel(page).locator('canvas').getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(2);
  await panel(page).locator('[data-clip-loop]').check();
  await expect(page.locator('#loop')).toBeChecked();
  await action(page, 'stop').click();
  await expect(panel(page).locator('[data-clip-state]')).toHaveText('READY');

  // Test the browser worker and full export path, not just parameter labels.
  await page.locator('#export-source').selectOption('original');
  await page.locator('#export-format').selectOption('wav32');
  const rendered = await download(page, page.locator('#export-audio'), testInfo.outputPath('stretched-pitched.wav'));
  const info = wavInfo(rendered);
  expect(info).toMatchObject({channels: 2, rate: 48000, bits: 32, tag: 3, frames: 432000});
  const sample = frame => rendered.readFloatLE(info.offset + frame * info.channels * 4);
  // Projection around the expected dominant 880 Hz detects a missing pitch step.
  const powerAt = frequency => {
    let real = 0, imaginary = 0;
    for (let i = 0; i < 4800; i++) { const value = sample(24000 + i), angle = 2 * Math.PI * frequency * i / info.rate; real += value * Math.cos(angle); imaginary += value * Math.sin(angle); }
    return real * real + imaginary * imaginary;
  };
  expect(powerAt(880)).toBeGreaterThan(powerAt(440) * 8);
  await enter(transform(page, 'speed'), 2);
  await expect(panel(page).locator('[data-clip-duration]')).toHaveText('4.50 s');
  await action(page, 'reset-transform').click();
  await expect(panel(page).locator('[data-clip-duration]')).toHaveText('6.00 s');

  await page.setViewportSize({width: 390, height: 844});
  const size = await panel(page).boundingBox();
  expect(size.height).toBeLessThanOrEqual(481);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await panel(page).locator('canvas').press('Home');
  await panel(page).locator('canvas').press('ArrowRight');
  await expect(panel(page).locator('canvas')).toHaveAttribute('aria-valuenow', '0.1');
  await panel(page).scrollIntoViewIfNeeded();
  await page.screenshot({path: testInfo.outputPath('compact-editor-mobile.png')});
  expect(errors).toEqual([]);
});

test('emergency mute cancels a preparing preview and locked legacy controls cannot change its selection', async ({page}) => {
  await page.goto('./');
  await page.locator('#demo').click();
  await panel(page).locator('[data-clip-tab="time"]').click();
  await enter(transform(page, 'stretch'), 200);
  let release, requested = false;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/time-pitch-worker.js*', async route => {
    requested = true;
    await held;
    // Termination can cancel the worker request before the test releases it.
    await route.continue().catch(() => {});
  });
  try {
    await action(page, 'play').click();
    await expect.poll(() => requested).toBe(true);
    await expect(panel(page).locator('[data-clip-state]')).toHaveText('PREPARING');
    await expect(page.locator('#trim-start')).toBeDisabled();
    await expect(page.locator('#trim-end')).toBeDisabled();
    await expect(page.locator('#loop')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(action(page, 'play')).toBeEnabled();
    await expect(panel(page).locator('[data-clip-state]')).toHaveText('READY');
    release();
    await page.waitForTimeout(300);
    await expect(panel(page).locator('[data-clip-state]')).toHaveText('READY');
    await expect(page.locator('#stop-playback')).toBeDisabled();
    await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false');
  } finally { release(); }
});
