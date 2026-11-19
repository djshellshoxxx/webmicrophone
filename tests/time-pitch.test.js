import test from 'node:test';
import assert from 'node:assert/strict';
import { processTimePitchPCM } from '../src/editing/time-pitch-pcm.js';
import { transformAudioBuffer, getTimePitchPlan, getTransformedFrameCount, normalizeTimePitchSettings } from '../src/editing/time-pitch.js';

const RATE = 48000;
const tone = (frames = RATE, frequency = 440) => Float32Array.from({ length: frames }, (_, frame) => 0.5 * Math.sin(2 * Math.PI * frequency * frame / RATE));
const peak = (samples) => samples.reduce((largest, sample) => Math.max(largest, Math.abs(sample)), 0);

function measuredFrequency(samples) {
  const crossings = [];
  const start = Math.floor(samples.length * 0.2);
  const end = Math.floor(samples.length * 0.8);
  for (let frame = start + 1; frame < end; frame += 1) {
    if (samples[frame - 1] <= 0 && samples[frame] > 0) {
      crossings.push(frame - 1 - samples[frame - 1] / (samples[frame] - samples[frame - 1]));
    }
  }
  assert.ok(crossings.length >= 10, 'The processed tone did not contain enough periods.');
  const periods = crossings.slice(1).map((position, index) => position - crossings[index]).sort((a, b) => a - b);
  return RATE / periods[Math.floor(periods.length / 2)];
}

test('time and pitch settings enforce ranges, exact output duration and allocation bounds before processing', () => {
  assert.deepEqual(normalizeTimePitchSettings(), { speed: 1, stretch: 1, pitchSemitones: 0 });
  assert.equal(getTransformedFrameCount(48001, { speed: 1.5, stretch: 1.25 }), 40001);
  assert.throws(() => normalizeTimePitchSettings({ speed: 0 }), /Speed/);
  assert.throws(() => normalizeTimePitchSettings({ stretch: Infinity }), /Stretch/);
  assert.throws(() => normalizeTimePitchSettings({ pitchSemitones: NaN }), /Pitch/);
  assert.throws(() => getTransformedFrameCount(0), /nonempty/);
  assert.throws(() => getTimePitchPlan({ length: RATE * 301, sampleRate: RATE, numberOfChannels: 2 }, { stretch: 2 }), /10-minute/);
  assert.throws(() => getTimePitchPlan({ length: 192000 * 200, sampleRate: 192000, numberOfChannels: 2 }), /256 MiB/);
  assert.throws(() => getTimePitchPlan({ length: 100, sampleRate: RATE, numberOfChannels: 6 }), /mono or stereo/);
});

test('identity and mathematically cancelling controls preserve the original PCM exactly', async () => {
  const channels = [tone(2000), tone(2000, 660)];
  assert.strictEqual(await processTimePitchPCM(channels, RATE), channels);
  assert.strictEqual(await processTimePitchPCM(channels, RATE, { speed: 2, stretch: 2, pitchSemitones: -12 }), channels);
  const buffer = { numberOfChannels: 2, sampleRate: RATE, length: 2000 };
  assert.strictEqual(await transformAudioBuffer(buffer), buffer);
});

test('varispeed changes both duration and pitch while stretch preserves tone pitch', async () => {
  const source = tone();
  const original = source.slice();
  for (const settings of [{ speed: 0.5 }, { speed: 2 }, { stretch: 0.5 }, { stretch: 2 }]) {
    const [output] = await processTimePitchPCM([source], RATE, settings);
    assert.equal(output.length, Math.round(source.length * (settings.stretch ?? 1) / (settings.speed ?? 1)));
    const frequency = measuredFrequency(output);
    const expected = 440 * (settings.speed ?? 1);
    assert.ok(Math.abs(frequency - expected) / expected < 0.01, `${JSON.stringify(settings)} produced ${frequency} Hz instead of ${expected} Hz.`);
    assert.ok(output.every(Number.isFinite));
  }
  assert.deepEqual(source, original);
});

test('independent and combined pitch controls produce the expected tone without changing requested duration', async () => {
  const source = tone();
  for (const settings of [
    { pitchSemitones: -12 }, { pitchSemitones: 12 },
    { speed: 2, stretch: 0.5, pitchSemitones: 12 },
    { speed: 0.5, stretch: 2, pitchSemitones: -12 },
    { speed: 0.5, stretch: 2, pitchSemitones: 12 },
    { speed: 2, stretch: 0.5, pitchSemitones: -12 },
    { speed: 1.23, stretch: 0.73, pitchSemitones: 3.5 },
  ]) {
    const [output] = await processTimePitchPCM([source], RATE, settings);
    const expected = 440 * (settings.speed ?? 1) * 2 ** (settings.pitchSemitones / 12);
    assert.equal(output.length, getTransformedFrameCount(source.length, settings));
    assert.ok(Math.abs(measuredFrequency(output) - expected) / expected < 0.01, JSON.stringify(settings));
    assert.ok(output.every(Number.isFinite));
  }
});

test('stereo processing shares alignment and keeps an antiphase amplitude relationship', async () => {
  const left = tone(RATE, 330);
  const right = Float32Array.from(left, (sample) => sample * -0.5);
  const output = await processTimePitchPCM([left, right], RATE, { speed: 0.8, stretch: 1.3, pitchSemitones: 7 });
  assert.equal(output.length, 2);
  assert.equal(output[0].length, output[1].length);
  for (let i = 0; i < output[0].length; i += 1) assert.ok(Math.abs(output[1][i] + output[0][i] * 0.5) < 1e-6);
});

test('short clips, silence and final transients survive complete flushing at both ratio extremes', async () => {
  for (const frames of [1, 32, 128, 4800, RATE]) {
    const source = new Float32Array(frames);
    source[0] = 0.4;
    source[frames - 1] = 0.7;
    for (const settings of [
      { stretch: 0.5 }, { stretch: 2 },
      { speed: 2, stretch: 0.5, pitchSemitones: 12 },
      { speed: 0.5, stretch: 2, pitchSemitones: -12 },
      { speed: 0.5, stretch: 2, pitchSemitones: 12 },
      { speed: 2, stretch: 0.5, pitchSemitones: -12 },
    ]) {
      const [output] = await processTimePitchPCM([source], RATE, settings);
      assert.equal(output.length, getTransformedFrameCount(frames, settings));
      assert.ok(output.every(Number.isFinite));
      assert.ok(peak(output.subarray(Math.max(0, output.length - 64))) > 0.05, `Missing tail: ${frames} frames, ${JSON.stringify(settings)}`);
      assert.ok(peak(output.subarray(0, Math.min(64, output.length))) > 0.02, `Missing onset: ${frames} frames, ${JSON.stringify(settings)}`);
    }
  }
  const [silent] = await processTimePitchPCM([new Float32Array(128)], RATE, { stretch: 2, pitchSemitones: -12 });
  assert.equal(peak(silent), 0);
});

test('downsampling suppresses a tone that would otherwise alias into the audible output', async () => {
  const source = tone(RATE, 18000);
  const [output] = await processTimePitchPCM([source], RATE, { speed: 2 });
  const middle = output.subarray(5000, output.length - 5000);
  const rms = Math.sqrt(middle.reduce((sum, sample) => sum + sample * sample, 0) / middle.length);
  assert.ok(rms < 0.005, `Out-of-band residual RMS was ${rms}.`);
});

test('cancellation rejects preparation and leaves source samples intact', async () => {
  const source = tone(RATE * 3);
  const snapshot = source.slice();
  const controller = new AbortController();
  await assert.rejects(processTimePitchPCM([source], RATE, { stretch: 2 }, {
    signal: controller.signal,
    onProgress: ({ progress }) => { if (progress > 0) controller.abort(); },
  }), { name: 'AbortError' });
  assert.deepEqual(source, snapshot);
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(transformAudioBuffer({ length: 1, sampleRate: RATE, numberOfChannels: 1 }, {}, { signal: preAborted.signal }), { name: 'AbortError' });
  await assert.rejects(processTimePitchPCM([Float32Array.of(NaN)], RATE), /non-finite/);
});

test('worker cancellation terminates processing and ignores a stale completion', async () => {
  const OriginalWorker = globalThis.Worker;
  let worker;
  globalThis.Worker = class {
    constructor() { worker = this; this.terminated = false; }
    postMessage() {}
    terminate() { this.terminated = true; }
  };
  try {
    const controller = new AbortController();
    const input = { length: 16, sampleRate: RATE, numberOfChannels: 1, copyFromChannel: (target) => target.fill(0.25) };
    const pending = transformAudioBuffer(input, { stretch: 2 }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(worker.terminated, true);
    assert.doesNotThrow(() => worker.onmessage({ data: { type: 'complete', channels: [new Float32Array(32).buffer] } }));
  } finally { globalThis.Worker = OriginalWorker; }
});
