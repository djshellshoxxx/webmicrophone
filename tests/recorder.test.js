import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { maxRecordingFrames, RECORDING_LIMITS, copyChunkToBuffer, recoverMetadata, memoryTakes } from '../src/recording/storage.js';
import { validateSourceShape, parseWavFormat } from '../src/recording/import-audio.js';
import { TakeRecorder } from '../src/recording/recorder.js';

test('timed capture is frame-bounded and session fallback counts both stored tracks', () => {
  assert.equal(maxRecordingFrames(48000, 2, 'indexeddb', 3.125), 150000);
  assert.equal(maxRecordingFrames(48000, 2, 'indexeddb'), 28800000);
  assert.equal(maxRecordingFrames(48000, 2, 'memory'), RECORDING_LIMITS.maxMemoryBytes / 16);
  assert.throws(() => maxRecordingFrames(48000, 6), /one or two/);
  assert.throws(() => maxRecordingFrames(48000, 2, 'indexeddb', -1), /positive/);
});

test('loading a shared capture chunk preserves separate tracks, stereo, and valid frame count', () => {
  const packed = new Float32Array([1, 2, 99, -1, -2, 99, 0.5, 1, 99, -0.5, -1, 99]);
  const chunk = { frameStart: 1, frames: 2, capacity: 3, channels: 2, trackCount: 2, data: packed.buffer };
  const createTarget = () => {
    const samples = [new Float32Array(4), new Float32Array(4)];
    return { samples, numberOfChannels: 2, length: 4, copyToChannel: (values, channel, offset) => samples[channel].set(values, offset) };
  };
  const original = createTarget();
  const processed = createTarget();
  copyChunkToBuffer(chunk, original, 'raw');
  copyChunkToBuffer(chunk, processed, 'processed');
  assert.deepEqual(Array.from(original.samples[0]), [0, 1, 2, 0]);
  assert.deepEqual(Array.from(original.samples[1]), [0, -1, -2, 0]);
  assert.deepEqual(Array.from(processed.samples[0]), [0, 0.5, 1, 0]);
  assert.deepEqual(Array.from(processed.samples[1]), [0, -0.5, -1, 0]);
  assert.equal(packed[0], 1);
  assert.throws(() => copyChunkToBuffer({ ...chunk, trackCount: 1 }, processed, 'processed'), /does not contain/);
  assert.throws(() => copyChunkToBuffer({ ...chunk, frameStart: 3 }, original), /metadata/);
});

test('a recording left active by a closed tab is presented as a recovered interruption', () => {
  const stored = { id: 'closed-tab', status: 'recording', frameCount: 16384 };
  const recovered = recoverMetadata(stored);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.recovered, true);
  assert.equal(stored.status, 'recording');
  assert.equal(recovered.frameCount, 16384);
});

test('decoded source limits account for channel count, sample rate and duration', () => {
  assert.doesNotThrow(() => validateSourceShape({ sampleRate: 48000, channels: 2, frames: 28800000 }));
  assert.throws(() => validateSourceShape({ sampleRate: 48000, channels: 2, frames: 48000 * 601 }), /10 minutes/);
  assert.throws(() => validateSourceShape({ sampleRate: 48000, channels: 2, frames: 48000 * 600 + 1 }), /10 minutes/);
  assert.throws(() => validateSourceShape({ sampleRate: 96000, channels: 2, frames: 96000 * 600 }), /256 MiB/);
  assert.throws(() => validateSourceShape({ sampleRate: 48000, channels: 6, frames: 48000 }), /multichannel/);
  assert.throws(() => validateSourceShape({ sampleRate: 48000, channels: 1, frames: 0 }), /duration/);
});

test('WAV format inspection reads source rate without treating it as the working rate', () => {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 96000, true);
  view.setUint32(8, 576000, true);
  view.setUint16(12, 6, true);
  view.setUint16(14, 24, true);
  assert.deepEqual(parseWavFormat(bytes), { audioFormat: 1, channels: 2, sampleRate: 96000, blockAlign: 6, bitDepth: 24 });
  assert.throws(() => parseWavFormat(bytes.subarray(0, 8)), /incomplete/);
});

function captureProcessor({ maxFrames, poolSize, chunkFrames = 5, latencyFrames = 0 }) {
  const messages = [];
  let Processor;
  const scope = {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (message, transfer = []) => messages.push(structuredClone(message, { transfer })) };
      }
    },
    registerProcessor: (_name, implementation) => { Processor = implementation; },
  };
  vm.runInNewContext(readFileSync(new URL('../src/recording/capture-worklet.js', import.meta.url), 'utf8'), scope);
  const processor = new Processor({ processorOptions: { channels: 2, chunkFrames, maxFrames, latencyFrames } });
  processor.port.onmessage({ data: { type: 'buffers', buffers: Array.from({ length: poolSize }, () => new ArrayBuffer(chunkFrames * 2 * 2 * 4)) } });
  processor.port.onmessage({ data: { type: 'start' } });
  return { processor, messages };
}

function feedCapture(processor, start, length, latencyFrames = 0) {
  const originalLeft = Float32Array.from({ length }, (_, index) => start + index);
  const originalRight = Float32Array.from(originalLeft, (sample) => -sample);
  const filteredLeft = Float32Array.from({ length }, (_, index) => Math.max(0, start + index - latencyFrames) / 2);
  const filteredRight = Float32Array.from(filteredLeft, (sample) => -sample);
  processor.process([[originalLeft, originalRight], [filteredLeft, filteredRight]], [[new Float32Array(length)]]);
}

test('actual capture worklet stops at an exact frame limit across varying quantum sizes', () => {
  const { processor, messages } = captureProcessor({ maxFrames: 12, poolSize: 3 });
  feedCapture(processor, 0, 4);
  feedCapture(processor, 4, 7);
  feedCapture(processor, 11, 3);
  const chunks = messages.filter((message) => message.type === 'chunk');
  assert.deepEqual(chunks.map((chunk) => [chunk.frameStart, chunk.frames]), [[0, 5], [5, 5], [10, 2]]);
  const stopped = messages.find((message) => message.type === 'stopped');
  assert.equal(stopped.reason, 'limit');
  assert.equal(stopped.frameCount, 12);
  const raw = chunks.flatMap((chunk) => [...new Float32Array(chunk.data).subarray(0, chunk.frames)]);
  const processed = chunks.flatMap((chunk) => [...new Float32Array(chunk.data).subarray(chunk.capacity * 2, chunk.capacity * 2 + chunk.frames)]);
  assert.deepEqual(raw, Array.from({ length: 12 }, (_, index) => index));
  assert.deepEqual(processed, raw.map((sample) => sample / 2));
});

test('actual capture worklet stops on exhausted storage buffers instead of overwriting pending audio', () => {
  const { processor, messages } = captureProcessor({ maxFrames: 100, poolSize: 1 });
  feedCapture(processor, 10, 12);
  const chunks = messages.filter((message) => message.type === 'chunk');
  assert.equal(chunks.length, 1);
  assert.deepEqual([...new Float32Array(chunks[0].data).subarray(0, 5)], [10, 11, 12, 13, 14]);
  const stopped = messages.find((message) => message.type === 'stopped');
  assert.equal(stopped.reason, 'storage-backpressure');
  assert.equal(stopped.frameCount, 5);
});

test('capture delay compensation preserves first and last impulses and drains the final processed samples', () => {
  const latencyFrames = 3;
  const { processor, messages } = captureProcessor({ maxFrames: 12, poolSize: 3, latencyFrames });
  const value = (frame) => frame === 0 ? 0.5 : frame === 11 ? 0.25 : 0;
  let cursor = 0;
  for (const length of [4, 7, 4]) {
    const original = Float32Array.from({ length }, (_, index) => value(cursor + index));
    const processed = Float32Array.from({ length }, (_, index) => value(cursor + index - latencyFrames) * 2);
    processor.process([[original, original], [processed, processed]], [[new Float32Array(length)]]);
    cursor += length;
  }
  const chunks = messages.filter((message) => message.type === 'chunk');
  const raw = chunks.flatMap((chunk) => [...new Float32Array(chunk.data).subarray(0, chunk.frames)]);
  const processed = chunks.flatMap((chunk) => [...new Float32Array(chunk.data).subarray(chunk.capacity * 2, chunk.capacity * 2 + chunk.frames)]);
  assert.deepEqual(raw, [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25]);
  assert.deepEqual(processed, raw.map((sample) => sample * 2));
  const stopped = messages.find((message) => message.type === 'stopped');
  assert.equal(stopped.frameCount, 12);
  assert.equal(stopped.capturedFrames, 12);
  assert.equal(stopped.reason, 'limit');
});

test('capture masks preserve pause and resume boundaries while keeping both tracks aligned', () => {
  const latencyFrames = 3;
  const { processor, messages } = captureProcessor({ maxFrames: 20, poolSize: 3, latencyFrames });
  feedCapture(processor, 0, 5, latencyFrames);
  processor.port.onmessage({ data: { type: 'pause' } });
  assert.equal(messages.some((message) => message.type === 'paused'), false);
  feedCapture(processor, 5, 3, latencyFrames);
  assert.equal(messages.find((message) => message.type === 'paused').frameCount, 5);
  feedCapture(processor, 8, 4, latencyFrames);
  processor.port.onmessage({ data: { type: 'resume' } });
  feedCapture(processor, 12, 4, latencyFrames);
  processor.port.onmessage({ data: { type: 'stop' } });
  assert.equal(messages.some((message) => message.type === 'stopped'), false);
  feedCapture(processor, 16, 3, latencyFrames);
  const chunks = messages.filter((message) => message.type === 'chunk');
  const raw = chunks.flatMap((chunk) => [...new Float32Array(chunk.data).subarray(0, chunk.frames)]);
  const processed = chunks.flatMap((chunk) => [...new Float32Array(chunk.data).subarray(chunk.capacity * 2, chunk.capacity * 2 + chunk.frames)]);
  assert.deepEqual(raw, [0, 1, 2, 3, 4, 12, 13, 14, 15]);
  assert.deepEqual(processed, raw.map((sample) => sample / 2));
  assert.equal(messages.find((message) => message.type === 'stopped').frameCount, 9);
});

test('stop supersedes a draining pause without duplicate commands, stale state or late timeout', async () => {
  const commands = [];
  const statuses = [];
  const recorder = new TakeRecorder({ sampleRate: 48000, state: 'running' }, { onStatus: (status) => statuses.push(status.state) });
  recorder.storageMode = 'memory';
  recorder.state = 'recording';
  recorder.metadata = { id: 'pause-stop-boundary', frameCount: 128, duration: 128 / 48000, pauses: [] };
  recorder.node = { port: { postMessage: (message) => commands.push(message.type), close() {} }, disconnect() {} };
  memoryTakes.set(recorder.metadata.id, { metadata: { ...recorder.metadata }, chunks: [] });
  try {
    const firstPause = recorder.pause();
    const secondPause = recorder.pause();
    assert.strictEqual(firstPause, secondPause);
    assert.deepEqual(commands, ['pause']);
    const stopped = recorder.stop({ reason: 'device-ended' });
    recorder.handleMessage({ type: 'stopped', reason: 'manual' });
    const [metadata] = await Promise.all([stopped, firstPause, secondPause]);
    assert.equal(metadata.stopReason, 'device-ended');
    assert.equal(metadata.status, 'interrupted');
    assert.equal(recorder.state, 'stopped');
    assert.equal(recorder.waiters.size, 0);
    assert.deepEqual(metadata.pauses, []);
    assert.equal(statuses.includes('paused'), false);
  } finally { memoryTakes.delete(recorder.metadata.id); }
});
