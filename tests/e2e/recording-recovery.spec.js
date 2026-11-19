import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Keep fault injection at the browser API boundary so these checks exercise the
// actual UI, worklet, IndexedDB transactions and exported samples on Pages too.
async function installRecoveryHooks(page, { denyStorage = false } = {}) {
  await page.addInitScript(({ denyStorage }) => {
    const hooks = { contexts: [], captures: [], abortChunks: false };
    window.__recordingRecovery = hooks;
    window.AudioContext = new Proxy(window.AudioContext, {
      construct(Target, args) {
        const context = new Target(...args);
        hooks.contexts.push(context);
        return context;
      },
    });
    window.AudioWorkletNode = new Proxy(window.AudioWorkletNode, {
      construct(Target, args) {
        const node = new Target(...args);
        if (args[1] === 'take-capture') hooks.captures.push(node);
        return node;
      },
    });
    if (denyStorage) {
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    } else {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const request = put.apply(this, args);
        // Aborting a real readwrite transaction also rolls back its metadata
        // checkpoint. It models the failure boundary without a fake database.
        if (this.name === 'chunks' && hooks.abortChunks) {
          const transaction = this.transaction;
          queueMicrotask(() => transaction.abort());
        }
        return request;
      };
    }
  }, { denyStorage });
}

async function readTakes(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('webmicrophone-audio-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('takes').objectStore('takes').getAll();
        request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
}

async function snapshot(page, id, frameLimit = null) {
  return page.evaluate(async ({ id, frameLimit }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('webmicrophone-audio-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(['takes', 'chunks']);
      const value = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [metadata, chunks] = await Promise.all([
        value(tx.objectStore('takes').get(id)),
        value(tx.objectStore('chunks').index('takeId').getAll(IDBKeyRange.only(id))),
      ]);
      let end = 0;
      for (const chunk of chunks) {
        if (chunk.frameStart !== end) throw new Error('The recovered recording contains a gap.');
        end += chunk.frames;
      }
      if (end !== metadata.frameCount) throw new Error('Committed chunks and metadata disagree.');
      const frames = frameLimit ?? metadata.frameCount;
      if (frames > end) throw new Error('The previously committed prefix was lost.');
      const hashes = [];
      for (let track = 0; track < 2; track++) {
        const pcm = new Float32Array(frames * metadata.channels);
        for (const chunk of chunks) {
          const length = Math.max(0, Math.min(chunk.frames, frames - chunk.frameStart));
          if (!length) continue;
          const samples = new Float32Array(chunk.data);
          for (let channel = 0; channel < metadata.channels; channel++) {
            const start = (track * chunk.channels + channel) * chunk.capacity;
            pcm.set(samples.subarray(start, start + length), channel * frames + chunk.frameStart);
          }
        }
        if (!pcm.some(sample => Math.abs(sample) > 0.001)) throw new Error('The recovered track unexpectedly contains silence.');
        hashes.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pcm.buffer)), n => n.toString(16).padStart(2, '0')).join(''));
      }
      return { metadata, frames, rawHash: hashes[0], processedHash: hashes[1] };
    } finally { db.close(); }
  }, { id, frameLimit });
}

async function startGeneratedTake(page) {
  await page.locator('#demo').click();
  await expect(page.locator('#record')).toBeEnabled();
  await page.locator('#countdown').selectOption('0');
  await page.locator('#duration').selectOption('10');
  await page.locator('#record').click();
  await expect(page.locator('#record-state')).toHaveText('Recording original + processed');
}

async function committedTake(page) {
  await expect.poll(async () => (await readTakes(page))[0]?.frameCount ?? 0).toBeGreaterThanOrEqual(32768);
  return (await readTakes(page))[0];
}

async function finishTake(page, count = 1) {
  await page.locator('#stop').click();
  await expect(page.locator('#takes-list .take-row')).toHaveCount(count);
  await expect(page.locator('#record')).toBeEnabled();
  await expect(page.locator('#download-original')).toBeEnabled();
}

async function downloadWav(page, testInfo, selector, filename) {
  const downloadPromise = page.waitForEvent('download');
  await page.locator(selector).click();
  const download = await downloadPromise;
  const path = testInfo.outputPath(filename);
  await download.saveAs(path);
  const wav = await readFile(path);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  let channels, sampleRate, data;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    const type = wav.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') {
      expect(wav.readUInt16LE(offset + 8)).toBe(3); // IEEE float PCM
      channels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
      expect(wav.readUInt16LE(offset + 22)).toBe(32);
    }
    if (type === 'data') data = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  expect(data?.length).toBeGreaterThan(0);
  const frames = data.length / (channels * 4);
  const planar = Buffer.alloc(data.length);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      data.copy(planar, (channel * frames + frame) * 4, (frame * channels + channel) * 4, (frame * channels + channel + 1) * 4);
    }
  }
  return { frames, channels, sampleRate, hash: createHash('sha256').update(planar).digest('hex') };
}

test('closing an active recording preserves both tracks and an earlier completed take', async ({ page, context }, testInfo) => {
  await page.goto('./');
  await startGeneratedTake(page);
  await committedTake(page);
  await finishTake(page);
  const completed = (await readTakes(page))[0];
  const completedBefore = await snapshot(page, completed.id);

  await startGeneratedTake(page);
  const interrupted = await committedTake(page);
  expect(interrupted.id).not.toBe(completed.id);
  const before = await snapshot(page, interrupted.id);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('./');
  await expect(reopened.locator('#takes-list .take-row')).toHaveCount(2);
  await expect(reopened.locator('.take-select').first()).toContainText('interrupted');
  const prefix = await snapshot(reopened, interrupted.id, before.frames);
  expect(prefix.rawHash).toBe(before.rawHash);
  expect(prefix.processedHash).toBe(before.processedHash);
  expect(await snapshot(reopened, completed.id)).toEqual(completedBefore);

  await reopened.locator('.take-select').first().click();
  await expect(reopened.locator('#download-original')).toBeEnabled();
  const recovered = await snapshot(reopened, interrupted.id);
  const original = await downloadWav(reopened, testInfo, '#download-original', 'recovered-original.wav');
  expect(original.frames).toBe(recovered.frames);
  expect(original.hash).toBe(recovered.rawHash);
  await reopened.locator('#export-source').selectOption('recorded');
  await reopened.locator('#export-format').selectOption('wav32');
  await reopened.locator('#export-rate').selectOption(String(recovered.metadata.sampleRate));
  const filtered = await downloadWav(reopened, testInfo, '#export-audio', 'recovered-filtered.wav');
  expect(filtered.frames).toBe(recovered.frames);
  expect(filtered.hash).toBe(recovered.processedHash);
});

test('an aborted storage transaction retains the committed prefix and allows another take', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await installRecoveryHooks(page);
  await page.goto('./');
  await startGeneratedTake(page);
  const take = await committedTake(page);
  const before = await snapshot(page, take.id);
  await page.evaluate(() => { window.__recordingRecovery.abortChunks = true; });
  await expect(page.locator('#record-state')).toContainText('Interrupted take', { timeout: 15000 });
  await expect(page.locator('#record')).toBeEnabled();
  const prefix = await snapshot(page, take.id, before.frames);
  expect(prefix.rawHash).toBe(before.rawHash);
  expect(prefix.processedHash).toBe(before.processedHash);
  expect(prefix.metadata.status).toBe('interrupted');
  await page.evaluate(() => { window.__recordingRecovery.abortChunks = false; });
  await startGeneratedTake(page);
  const next = await committedTake(page);
  expect(next.id).not.toBe(take.id);
  await finishTake(page, 2);
  expect((await readTakes(page))[0].status).toBe('complete');
  expect(errors).toEqual([]);
});

test('a suspended audio context stops with the committed prefix and usable controls', async ({ page }) => {
  await installRecoveryHooks(page);
  await page.goto('./');
  await startGeneratedTake(page);
  const take = await committedTake(page);
  const before = await snapshot(page, take.id);
  await page.evaluate(() => window.__recordingRecovery.contexts[0].suspend());
  await expect(page.locator('#record-state')).toContainText('Interrupted take', { timeout: 15000 });
  await expect(page.locator('#record')).toBeEnabled();
  await expect(page.locator('#download-original')).toBeEnabled();
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false');
  const prefix = await snapshot(page, take.id, before.frames);
  expect(prefix.rawHash).toBe(before.rawHash);
  expect(prefix.processedHash).toBe(before.processedHash);
  expect(prefix.metadata.status).toBe('interrupted');
  expect(prefix.metadata.stopReason).toBe('context-interrupted');
});

test('a capture processor failure retains saved audio and permits recording again', async ({ page }) => {
  await installRecoveryHooks(page);
  await page.goto('./');
  await startGeneratedTake(page);
  const take = await committedTake(page);
  const before = await snapshot(page, take.id);
  await page.evaluate(() => window.__recordingRecovery.captures.at(-1).dispatchEvent(new Event('processorerror')));
  await expect(page.locator('#record-state')).toContainText('Interrupted take');
  await expect(page.locator('#record')).toBeEnabled();
  const prefix = await snapshot(page, take.id, before.frames);
  expect(prefix.rawHash).toBe(before.rawHash);
  expect(prefix.processedHash).toBe(before.processedHash);
  expect(prefix.metadata.status).toBe('interrupted');
  expect(prefix.metadata.stopReason).toBe('processor-error');
  await startGeneratedTake(page);
  const next = await committedTake(page);
  expect(next.id).not.toBe(take.id);
  await finishTake(page, 2);
});

test('denied persistence uses a downloadable session take and preserves it after a refused retry', async ({ page }, testInfo) => {
  await installRecoveryHooks(page, { denyStorage: true });
  await page.goto('./');
  await startGeneratedTake(page);
  await expect(page.locator('#storage-status')).toContainText('Session-only');
  await expect(page.locator('#record-time')).toHaveText('00:01');
  await finishTake(page);
  await expect(page.locator('.take-select')).toContainText('session only');
  const original = await downloadWav(page, testInfo, '#download-original', 'session-original.wav');

  await page.locator('#record').click();
  await expect(page.locator('#status-message')).toContainText('Download and remove previous session-only takes');
  await expect(page.locator('#record')).toBeEnabled();
  await expect(page.locator('#takes-list .take-row')).toHaveCount(1);
  expect(await downloadWav(page, testInfo, '#download-original', 'session-original-after-retry.wav')).toEqual(original);

  page.once('dialog', dialog => dialog.accept());
  await page.locator('.delete-take').click();
  await expect(page.locator('#takes-list .take-row')).toHaveCount(0);
  await startGeneratedTake(page);
  await expect(page.locator('#record-time')).toHaveText('00:01');
  await finishTake(page);
  await page.reload();
  await expect(page.locator('#takes-list .take-row')).toHaveCount(0);
});
