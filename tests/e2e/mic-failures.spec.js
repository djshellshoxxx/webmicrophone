import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

// Chromium supplies an actual MediaStream and Web Audio graph. Only the failure
// boundary and event timing are controlled here; no physical microphone is used.
test.use({launchOptions: {
  ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}),
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
}});

async function installMediaHarness(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const probe = window.__micTest = {
      requests: [], streams: [], contexts: [], pending: [], pendingEnumerations: [],
      nextError: null, deferNext: false, holdEnumeration: false,
      failSource: false, endBeforeResolve: false, holdRecorderModule: false, pendingRecorderModules: [],
    };
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(...args) {
        super(...args);
        probe.contexts.push(this);
        const nativeAddModule = this.audioWorklet.addModule.bind(this.audioWorklet);
        this.audioWorklet.addModule = async (url, options) => {
          if (probe.holdRecorderModule && String(url).includes('capture-worklet')) {
            await new Promise(resolve => probe.pendingRecorderModules.push(resolve));
          }
          return nativeAddModule(url, options);
        };
      }
      createMediaStreamSource(stream) {
        if (probe.failSource) {
          probe.failSource = false;
          throw new DOMException('Injected source initialization failure.', 'InvalidStateError');
        }
        return super.createMediaStreamSource(stream);
      }
    };
    const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const request = {constraints, state: 'pending'};
      probe.requests.push(request);
      try {
        if (probe.deferNext) {
          probe.deferNext = false;
          await new Promise((resolve, reject) => probe.pending.push({resolve, reject}));
        }
        if (probe.nextError) {
          const name = probe.nextError;
          probe.nextError = null;
          throw new DOMException('Injected microphone failure.', name);
        }
        const stream = await nativeCapture(constraints);
        probe.streams.push(stream);
        if (probe.endBeforeResolve) {
          probe.endBeforeResolve = false;
          stream.getTracks().forEach(track => track.stop());
        }
        request.state = 'resolved';
        return stream;
      } catch (error) { request.state = 'rejected'; throw error; }
    };
    const nativeEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => {
      const devices = await nativeEnumerate();
      if (probe.holdEnumeration) await new Promise(resolve => probe.pendingEnumerations.push(resolve));
      return devices;
    };
  });
  return errors;
}

async function assertInputIdle(page) {
  await expect(page.locator('#connect-mic')).toBeEnabled();
  await expect(page.locator('#connect-mic')).toHaveText('Enable microphone');
  await expect(page.locator('#record')).toBeEnabled();
  await expect(page.locator('#open-audio')).toBeEnabled();
  await expect(page.locator('#stop')).toBeDisabled();
  await expect(page.locator('#stop-mic')).toBeDisabled();
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false');
}

async function assertConnectedMuted(page) {
  await expect(page.locator('#connect-mic')).toHaveText('Microphone enabled');
  await expect(page.locator('#stop-mic')).toBeEnabled();
  await expect(page.locator('#signal-state')).toHaveText('MICROPHONE');
  await expect(page.locator('#monitor')).toHaveAttribute('aria-pressed', 'false');
}

function fixtureWav() {
  const frames = 12000, bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) bytes.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 440 * frame / 48000)), 44 + frame * 2);
  return bytes;
}

test('microphone permission and audio startup wait for a user action', async ({page}) => {
  const errors = await installMediaHarness(page);
  await page.goto('./');
  await expect(page.locator('h1')).toContainText('WebMicrophone');
  expect(await page.evaluate(() => ({requests: __micTest.requests.length, contexts: __micTest.contexts.length})))
    .toEqual({requests: 0, contexts: 0});
  await assertInputIdle(page);
  expect(errors).toEqual([]);
});

for (const [name, message] of [
  ['NotAllowedError', /permission was not granted/i],
  ['NotFoundError', /no microphone was found/i],
  ['NotReadableError', /another application is using it/i],
  ['OverconstrainedError', /choose System default and reconnect/i],
  ['AbortError', /could not|interrupted|try again|retry/i],
]) {
  test(`${name} during Record restores controls and permits a muted retry`, async ({page}) => {
    const errors = await installMediaHarness(page);
    await page.goto('./');
    await page.evaluate(name => { __micTest.nextError = name; }, name);
    await page.locator('#record').click();
    await expect(page.locator('#status-message')).toContainText(message);
    await assertInputIdle(page);
    await expect(page.locator('#takes-list .take-row')).toHaveCount(0);
    await page.locator('#connect-mic').click();
    await assertConnectedMuted(page);
    await page.locator('#stop-mic').click();
    await assertInputIdle(page);
    expect(await page.evaluate(() => __micTest.streams.flatMap(stream => stream.getTracks().map(track => track.readyState))))
      .toEqual(['ended']);
    expect(errors).toEqual([]);
  });
}

test('denied microphone permission leaves file import and original-file download usable', async ({page}, testInfo) => {
  const errors = await installMediaHarness(page);
  await page.goto('./');
  await page.evaluate(() => { __micTest.nextError = 'NotAllowedError'; });
  await page.locator('#connect-mic').click();
  await expect(page.locator('#status-message')).toContainText('permission was not granted');
  const original = fixtureWav();
  await page.locator('#audio-file').setInputFiles({name: 'after-denial.wav', mimeType: 'audio/wav', buffer: original});
  await expect(page.locator('#takes-list .take-row')).toHaveCount(1);
  await expect(page.locator('#export-audio')).toBeEnabled();
  const pending = page.waitForEvent('download');
  await page.locator('#download-original').click();
  const downloaded = await pending;
  const path = testInfo.outputPath('after-denial-original.wav');
  await downloaded.saveAs(path);
  expect((await readFile(path)).equals(original)).toBe(true);
  expect(await page.evaluate(() => __micTest.requests.length)).toBe(1);
  expect(errors).toEqual([]);
});

test('missing microphone API reports the requirement without locking file processing', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: undefined}));
  await page.goto('./');
  await page.locator('#record').click();
  await expect(page.locator('#status-message')).toContainText('secure HTTPS page');
  await assertInputIdle(page);
  await page.locator('#audio-file').setInputFiles({name: 'without-mic-api.wav', mimeType: 'audio/wav', buffer: fixtureWav()});
  await expect(page.locator('#takes-list .take-row')).toHaveCount(1);
  await expect(page.locator('#export-audio')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('source initialization failure releases the granted microphone and allows retry', async ({page}) => {
  const errors = await installMediaHarness(page);
  await page.goto('./');
  await page.evaluate(() => { __micTest.failSource = true; });
  await page.locator('#connect-mic').click();
  await expect(page.locator('#status-message')).toContainText('Injected source initialization failure');
  await assertInputIdle(page);
  expect(await page.evaluate(() => __micTest.streams[0].getAudioTracks()[0].readyState)).toBe('ended');
  await page.locator('#connect-mic').click();
  await assertConnectedMuted(page);
  expect(errors).toEqual([]);
});

test('an already ended microphone track is rejected and retry remains available', async ({page}) => {
  const errors = await installMediaHarness(page);
  await page.goto('./');
  await page.evaluate(() => { __micTest.endBeforeResolve = true; });
  await page.locator('#connect-mic').click();
  await expect.poll(() => page.evaluate(() => __micTest.requests[0]?.state)).toBe('resolved');
  await expect(page.locator('#status-message')).toContainText(/disconnected|ended|unavailable|no active audio/i);
  await assertInputIdle(page);
  await page.locator('#connect-mic').click();
  await assertConnectedMuted(page);
  expect(errors).toEqual([]);
});

test('cancelling pending permission stops a late grant without starting a take', async ({page}) => {
  const errors = await installMediaHarness(page);
  await page.goto('./');
  await page.evaluate(() => { __micTest.deferNext = true; });
  await page.locator('#record').click();
  await expect.poll(() => page.evaluate(() => __micTest.pending.length)).toBe(1);
  await page.locator('#stop').click();
  await assertInputIdle(page);
  await page.evaluate(() => __micTest.pending.shift().resolve());
  await expect.poll(() => page.evaluate(() => __micTest.streams[0]?.getAudioTracks()[0].readyState)).toBe('ended');
  await expect(page.locator('#takes-list .take-row')).toHaveCount(0);
  await expect(page.locator('#record-state')).toContainText('cancelled');
  await assertInputIdle(page);
  expect(errors).toEqual([]);
});

test('late permission denial from a cancelled attempt cannot overwrite a newer connection', async ({page}) => {
  const errors = await installMediaHarness(page);
  await page.goto('./');
  await page.evaluate(() => { __micTest.deferNext = true; });
  await page.locator('#record').click();
  await expect.poll(() => page.evaluate(() => __micTest.pending.length)).toBe(1);
  await page.locator('#stop').click();
  await page.locator('#connect-mic').click();
  await assertConnectedMuted(page);
  await expect(page.locator('#status-message')).toContainText('Microphone connected');
  await page.evaluate(() => __micTest.pending.shift().reject(new DOMException('Old permission response.', 'NotAllowedError')));
  await expect.poll(() => page.evaluate(() => __micTest.requests[0].state)).toBe('rejected');
  await expect(page.locator('#status-message')).toContainText('Microphone connected');
  await expect(page.locator('#status')).not.toHaveClass(/error/);
  await assertConnectedMuted(page);
  expect(errors).toEqual([]);
});

test('device loss while enumeration is pending keeps the disconnected notice', async ({page}) => {
  const errors = await installMediaHarness(page);
  await page.goto('./');
  await page.evaluate(() => { __micTest.holdEnumeration = true; });
  await page.locator('#connect-mic').click();
  await expect.poll(() => page.evaluate(() => __micTest.pendingEnumerations.length)).toBeGreaterThan(0);
  await page.evaluate(() => {
    const track = __micTest.streams[0].getAudioTracks()[0];
    track.stop();
    track.dispatchEvent(new Event('ended'));
  });
  await expect(page.locator('#status-message')).toContainText('Microphone disconnected');
  await page.evaluate(() => {
    __micTest.holdEnumeration = false;
    __micTest.pendingEnumerations.splice(0).forEach(resolve => resolve());
  });
  await assertInputIdle(page);
  await expect(page.locator('#status-message')).toContainText('Microphone disconnected');
  await expect(page.locator('#status')).toHaveClass(/error/);
  expect(errors).toEqual([]);
});

test('cancelled arming enumeration cannot disconnect a newer recording', async ({page}) => {
  const errors = await installMediaHarness(page);
  await page.goto('./');
  await page.evaluate(() => { __micTest.holdEnumeration = true; });
  await page.locator('#record').click();
  await expect.poll(() => page.evaluate(() => __micTest.pendingEnumerations.length)).toBeGreaterThan(0);
  await page.locator('#stop').click();
  await page.evaluate(() => { __micTest.holdEnumeration = false; });
  await page.locator('#record').click();
  await expect(page.locator('#record-state')).toHaveText('Recording original + processed');
  await page.evaluate(() => __micTest.pendingEnumerations.splice(0).forEach(resolve => resolve()));
  await expect(page.locator('#record-time')).toHaveText('00:01');
  await expect(page.locator('#connect-mic')).toHaveText('Microphone enabled');
  expect(await page.evaluate(() => __micTest.streams.at(-1).getAudioTracks()[0].readyState)).toBe('live');
  await page.locator('#stop').click();
  await expect(page.locator('#record')).toBeEnabled();
  await expect(page.locator('#takes-list .take-row')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('late cancelled request cannot let Stop finish before the newer recorder initializes', async ({page}) => {
  const errors = await installMediaHarness(page);
  await page.goto('./');
  await page.evaluate(() => { __micTest.deferNext = true; });
  await page.locator('#record').click();
  await expect.poll(() => page.evaluate(() => __micTest.pending.length)).toBe(1);
  await page.locator('#stop').click();
  await page.evaluate(() => { __micTest.holdRecorderModule = true; });
  await page.locator('#record').click();
  await expect.poll(() => page.evaluate(() => __micTest.pendingRecorderModules.length)).toBe(1);
  await page.evaluate(() => __micTest.pending.shift().reject(new DOMException('Old permission response.', 'NotAllowedError')));
  await expect.poll(() => page.evaluate(() => __micTest.requests[0].state)).toBe('rejected');
  await page.locator('#stop').click();
  await expect(page.locator('#record')).toBeDisabled();
  await expect(page.locator('#stop')).toBeEnabled();
  await page.evaluate(() => {
    __micTest.holdRecorderModule = false;
    __micTest.pendingRecorderModules.splice(0).forEach(resolve => resolve());
  });
  await expect(page.locator('#record')).toBeEnabled();
  await expect(page.locator('#stop')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('device loss saves captured audio, permits reload and recording after reconnection', async ({page}) => {
  const errors = await installMediaHarness(page);
  await page.goto('./');
  await page.locator('#record').click();
  await expect(page.locator('#record-state')).toHaveText('Recording original + processed');
  await expect(page.locator('#record-time')).toHaveText('00:01');
  await page.evaluate(() => {
    const track = __micTest.streams[0].getAudioTracks()[0];
    track.stop();
    track.dispatchEvent(new Event('ended'));
  });
  await expect(page.locator('#takes-list .take-row')).toHaveCount(1);
  await expect(page.locator('#takes-list .take-row small')).toContainText('interrupted');
  await expect(page.locator('#record-state')).toContainText('Interrupted take');
  await assertInputIdle(page);
  await expect(page.locator('#download-original')).toBeEnabled();
  await page.reload();
  await expect(page.locator('#takes-list .take-row')).toHaveCount(1);
  await page.locator('.take-select').click();
  await expect(page.locator('#export-audio')).toBeEnabled();
  await page.locator('#record').click();
  await expect(page.locator('#record-time')).toHaveText('00:01');
  await page.locator('#stop').click();
  await expect(page.locator('#takes-list .take-row')).toHaveCount(2);
  await expect(page.locator('#record-state')).toHaveText('Original + processed take saved');
  expect(errors).toEqual([]);
});
