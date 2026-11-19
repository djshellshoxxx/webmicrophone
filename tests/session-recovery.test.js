import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SessionUI } from '../src/session-ui.js';
import { createWavHeader, encodePcmBlock } from '../src/export/wav.js';
import { memoryTakes } from '../src/recording/storage.js';

// Exercise the real download method and real WAV encoder without requiring
// microphone hardware or a browser process. Only Worker messaging and the
// download anchor are adapted; the production worker handles the PCM bytes.
const workerSource = readFileSync(new URL('../src/export/wav-worker.js', import.meta.url), 'utf8')
  .replace(/^import .* from '\.\/wav\.js';\s*/m, '');

function installDownloadEnvironment(t) {
  const downloads = [];
  const blobs = new Map();
  const replaceGlobal = (name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  };
  replaceGlobal('indexedDB', undefined);
  replaceGlobal('Worker', class {
    constructor(url) {
      assert.ok(url.pathname.endsWith('/src/export/wav-worker.js'));
      this.stopped = false;
      this.worker = {
        postMessage: (data) => queueMicrotask(() => {
          if (!this.stopped) this.onmessage?.({ data });
        }),
      };
      vm.runInNewContext(workerSource, {
        self: this.worker, createWavHeader, encodePcmBlock, Float32Array, Uint8Array, Blob,
      });
    }
    postMessage(data) {
      queueMicrotask(() => {
        if (!this.stopped) this.worker.onmessage({ data: structuredClone(data) });
      });
    }
    terminate() { this.stopped = true; }
  });
  replaceGlobal('document', {
    body: { append() {} },
    createElement(tag) {
      assert.equal(tag, 'a');
      return {
        click() { downloads.push({ blob: blobs.get(this.href), name: this.download }); },
        remove() {},
      };
    },
  });
  t.mock.method(URL, 'createObjectURL', (blob) => {
    const url = `blob:test-${blobs.size}`;
    blobs.set(url, blob);
    return url;
  });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const nativeSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    // The delayed URL cleanup is unrelated to the download assertion.
    if (delay === 60000) return { unref() {} };
    return nativeSetTimeout(fn, delay, ...args);
  });
  return downloads;
}

function loadedSession(metadata, originalFile = null) {
  const left = new Float32Array([0, 0.25, -0.25, 0.5, -0.5, 1.25, -1.25, 0]);
  const right = new Float32Array([0.125, 0.5, -0.5, 0.75, -0.75, 0.25, -0.25, 0.125]);
  const ui = Object.create(SessionUI.prototype);
  ui.state = { recordingBusy: false, sourceConnecting: false, sessionBusy: false };
  ui.buffer = {
    numberOfChannels: 2, sampleRate: 48000, length: left.length, duration: left.length / 48000,
    getChannelData(channel) { return [left, right][channel]; },
  };
  ui.activeTake = { id: 'saved-recovery-take', label: 'Recovered recording', ...metadata };
  ui.originalFile = originalFile;
  ui.onBusyChange = () => {};
  ui.messages = [];
  ui.notify = (message) => ui.messages.push(message);
  return { ui, channels: [left, right] };
}

test('loaded microphone PCM remains downloadable when persistent storage is unavailable', async (t) => {
  const downloads = installDownloadEnvironment(t);
  const { ui, channels } = loadedSession({
    sourceKind: 'microphone', sourceFormat: 'float32-pcm', rawAvailable: true,
    processedAvailable: true, storageMode: 'indexeddb', status: 'interrupted',
  });
  const before = channels.map(channel => Array.from(channel));

  await ui.downloadOriginal();

  assert.equal(ui.state.sessionBusy, false);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].name, /-original\.wav$/);
  const wav = Buffer.from(await downloads[0].blob.arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 3, 'The original download uses IEEE float PCM');
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt16LE(34), 32);
  assert.equal(wav.toString('ascii', 50, 54), 'data');
  assert.equal(wav.readUInt32LE(54), channels[0].length * channels.length * 4);
  for (let frame = 0; frame < channels[0].length; frame++) {
    for (let channel = 0; channel < channels.length; channel++) {
      assert.equal(wav.readFloatLE(58 + (frame * channels.length + channel) * 4), before[channel][frame]);
    }
  }
  assert.deepEqual(channels.map(channel => Array.from(channel)), before, 'Recovery must preserve the selected original PCM');
  assert.match(ui.messages.at(-1), /downloaded/i);
});

test('unavailable imported original bytes are not silently replaced by a reconstructed WAV', async (t) => {
  const downloads = installDownloadEnvironment(t);
  const { ui } = loadedSession({
    sourceKind: 'file', originalFileAvailable: true, originalFilename: 'original.mp3',
    storageMode: 'indexeddb',
  });

  await assert.rejects(ui.downloadOriginal(), /storage|original|unavailable/i);

  assert.equal(downloads.length, 0);
  assert.equal(ui.state.sessionBusy, false);
});

test('an imported take with a missing original-file record does not claim reconstructed PCM is the original', async (t) => {
  const downloads = installDownloadEnvironment(t);
  const { ui } = loadedSession({
    sourceKind: 'file', originalFileAvailable: true, originalFilename: 'missing.mp3',
    storageMode: 'memory',
  });
  memoryTakes.set(ui.activeTake.id, { metadata: ui.activeTake, chunks: [], originalFile: null });
  t.after(() => memoryTakes.delete(ui.activeTake.id));

  await assert.rejects(ui.downloadOriginal(), /original|unavailable|missing/i);

  assert.equal(downloads.length, 0);
  assert.equal(ui.state.sessionBusy, false);
});

test('an imported original still held in memory downloads byte-for-byte during storage failure', async (t) => {
  const downloads = installDownloadEnvironment(t);
  const bytes = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0, 255, 251, 0, 17]);
  const original = { blob: new Blob([bytes], { type: 'audio/mpeg' }), filename: 'original.mp3' };
  const { ui } = loadedSession({
    sourceKind: 'file', originalFileAvailable: true, storageMode: 'indexeddb',
  }, original);

  await ui.downloadOriginal();

  assert.equal(ui.state.sessionBusy, false);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, 'original.mp3');
  assert.deepEqual(new Uint8Array(await downloads[0].blob.arrayBuffer()), bytes);
});
