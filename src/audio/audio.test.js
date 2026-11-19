import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Radix2FFT, SpectralDenoiser, validateNoiseProfile } from './cleanup-processor.js';
import { RnnoiseFrameProcessor, RNNOISE_LATENCY_SAMPLES } from './rnnoise-processor.js';
import { LinkedDynamics, limitSample } from './dynamics-processor.js';
import { measureStereoChannels } from '../ui/channel-metrics.js';

function randomSamples(length, amplitude = 0.1, seed = 1) {
  let state = seed >>> 0;
  return Float32Array.from({ length }, () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 0x100000000 * 2 - 1) * amplitude;
  });
}

function run(processor, inputs, blockSize = 128) {
  const outputs = inputs.map((input) => new Float32Array(input.length));
  for (let start = 0; start < inputs[0].length; start += blockSize) {
    const end = Math.min(inputs[0].length, start + blockSize);
    processor.process(inputs.map((input) => input.subarray(start, end)), outputs.map((output) => output.subarray(start, end)));
  }
  return outputs;
}

function rms(array) {
  let sum = 0;
  for (const value of array) sum += value * value;
  return Math.sqrt(sum / array.length);
}

test('FFT forward/inverse preserves samples and quadrature', () => {
  const fft = new Radix2FFT(1024);
  const real = Float64Array.from(randomSamples(1024, 0.9));
  const imaginary = new Float64Array(1024);
  const original = real.slice();
  fft.transform(real, imaginary);
  fft.transform(real, imaginary, true);
  for (let i = 0; i < real.length; i += 1) {
    assert.ok(Math.abs(real[i] - original[i]) < 1e-12);
    assert.ok(Math.abs(imaginary[i]) < 1e-12);
  }
});

test('spectral bypass preserves independent channels with exactly 1024 samples latency', () => {
  const input = [randomSamples(16384, 0.8, 4), randomSamples(16384, 0.4, 7)];
  const processor = new SpectralDenoiser();
  const output = run(processor, input);
  for (let channel = 0; channel < 2; channel += 1) {
    for (let i = 0; i < 1024; i += 1) assert.ok(Math.abs(output[channel][i]) < 1e-10);
    for (let i = 1024; i < input[channel].length; i += 1) assert.ok(Math.abs(output[channel][i] - input[channel][i - 1024]) < 2e-7);
  }
});

test('spectral processing is independent of input block size', () => {
  const input = [randomSamples(12288, 0.7, 12), randomSamples(12288, 0.3, 18)];
  const a = run(new SpectralDenoiser(), input, 128);
  const b = run(new SpectralDenoiser(), input, 317);
  assert.deepEqual(a, b);
});

test('learned stationary noise is reduced while a strong new tone is retained', () => {
  const learner = new SpectralDenoiser();
  learner.learn(1);
  const noise = randomSamples(60000, 0.05, 1234);
  run(learner, [noise, noise]);
  assert.ok(learner.profile);
  assert.equal(learner.profile.power.length, 513);
  const noisy = randomSamples(48000, 0.05, 99);
  const reducer = new SpectralDenoiser();
  reducer.setProfile(learner.profile);
  reducer.setStrength(0.8);
  const reduced = run(reducer, [noisy, noisy])[0];
  assert.ok(rms(reduced.subarray(6000)) < rms(noisy.subarray(6000)) * 0.65);

  const tone = Float32Array.from(noisy, (sample, index) => sample + 0.3 * Math.sin(2 * Math.PI * 2400 * index / 48000));
  const tonalReducer = new SpectralDenoiser();
  tonalReducer.setProfile(learner.profile);
  tonalReducer.setStrength(0.8);
  const tonalOutput = run(tonalReducer, [tone, tone])[0];
  let quadrature = 0;
  let inPhase = 0;
  const start = 6000;
  for (let i = start; i < tonalOutput.length; i += 1) {
    const angle = 2 * Math.PI * 2400 * (i - 1024) / 48000;
    inPhase += tonalOutput[i] * Math.sin(angle);
    quadrature += tonalOutput[i] * Math.cos(angle);
  }
  const amplitude = 2 * Math.hypot(inPhase, quadrature) / (tonalOutput.length - start);
  assert.ok(amplitude > 0.27 && amplitude < 0.33, `tone amplitude ${amplitude}`);
});

test('profile schema rejects incompatible spectra and nonfinite powers', () => {
  const valid = { version: 1, sampleRate: 48000, fftSize: 1024, power: Array(513).fill(0) };
  assert.deepEqual(validateNoiseProfile(valid, 48000), valid);
  assert.throws(() => validateNoiseProfile({ ...valid, sampleRate: 44100 }, 48000));
  assert.throws(() => validateNoiseProfile({ ...valid, power: Array(513).fill(NaN) }, 48000));
  assert.throws(() => validateNoiseProfile({ ...valid, power: [-1] }, 48000));
});

test('profile powers are input-referred across input gain changes', () => {
  const source = randomSamples(60000, 0.1, 102);
  const a = new SpectralDenoiser(); a.learn(1);
  run(a, [source, source]);
  const b = new SpectralDenoiser(); b.setProfileScale(4); b.learn(1);
  const gained = Float32Array.from(source, (value) => value * 2);
  run(b, [gained, gained]);
  assert.deepEqual(a.profile, b.profile);
});

test('RNNoise unavailable/bypassed path has exact independent stereo 960-sample latency', () => {
  const input = [randomSamples(8192, 0.7, 12), randomSamples(8192, 0.5, 19)];
  const processor = new RnnoiseFrameProcessor(null);
  const output = run(processor, input);
  for (let channel = 0; channel < 2; channel += 1) {
    for (let i = RNNOISE_LATENCY_SAMPLES; i < input[channel].length; i += 1) {
      assert.equal(output[channel][i], input[channel][i - RNNOISE_LATENCY_SAMPLES]);
    }
  }
  processor.destroy();
  processor.destroy();
});

test('real pinned RNNoise module initializes synchronously and retains a periodic signal at measured latency', async () => {
  const bytes = await readFile(new URL('../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise.wasm', import.meta.url));
  const module = await WebAssembly.compile(bytes);
  const processor = new RnnoiseFrameProcessor(module, { speech: true });
  const source = Float32Array.from({ length: 48000 }, (_, i) => i > 3000 && i < 40000
    ? 0.2 * (Math.sin(i * 0.13) + 0.6 * Math.sin(i * 0.019) + 0.2 * Math.sin(i * 0.413)) : 0);
  const output = run(processor, [source, source])[0];
  let xy = 0; let xx = 0; let yy = 0;
  for (let i = 8000; i < 38000; i += 1) {
    const x = source[i - 960]; const y = output[i];
    xy += x * y; xx += x * x; yy += y * y;
  }
  assert.ok(xy / Math.sqrt(xx * yy) > 0.9, 'RNNoise periodic fixture correlates after 960-sample compensation');
  assert.ok(output.every(Number.isFinite));
  assert.ok(rms(output) > 0.01);
  processor.destroy();
});

test('complete buffering preserves every source sample at exactly 1984-sample latency', () => {
  const input = [randomSamples(32768, 0.7, 1), randomSamples(32768, 0.7, 2)];
  const spectral = run(new SpectralDenoiser(), input);
  const output = run(new RnnoiseFrameProcessor(null), spectral);
  for (let channel = 0; channel < 2; channel += 1) for (let i = 1984; i < input[channel].length; i += 1) {
    assert.ok(Math.abs(output[channel][i] - input[channel][i - 1984]) < 2e-7);
  }
});

test('linked dynamics bypass is exact and compression preserves stereo proportions', () => {
  const left = new Float32Array(24000).fill(0.5);
  const right = new Float32Array(24000).fill(-0.25);
  const bypass = run(new LinkedDynamics(), [left, right]);
  assert.deepEqual(bypass, [left, right]);
  const processor = new LinkedDynamics(48000, { compressorEnabled: true, compressorThresholdDb: -24, compressorRatio: 4 });
  const compressed = run(processor, [left, right]);
  assert.ok(Math.abs(compressed[0].at(-1)) < 0.15);
  for (let i = 0; i < left.length; i += 1) assert.equal(compressed[1][i], -compressed[0][i] / 2);
});

test('sample limiter bounds finite peaks and leaves the quiet range unchanged', () => {
  assert.equal(limitSample(0.25), 0.25);
  assert.equal(limitSample(-0.25), -0.25);
  assert.equal(limitSample(2), 0.98);
  assert.equal(limitSample(-2), -0.98);
  assert.equal(limitSample(2, false), 2);
  assert.equal(limitSample(NaN), 0);
  assert.equal(limitSample(Infinity), 0);
});

test('stereo peak and RMS meters do not cancel antiphase channels', () => {
  const left = new Float32Array(2048).fill(0.8);
  const right = new Float32Array(2048).fill(-0.8);
  const result = measureStereoChannels(left, right);
  assert.ok(Math.abs(result.peak - 0.8) < 1e-7);
  assert.ok(Math.abs(result.rms - 0.8) < 1e-7);
  assert.ok(Math.abs(result.peakDb - 20 * Math.log10(0.8)) < 1e-5);
  const overloaded = measureStereoChannels(Float32Array.of(1.1), Float32Array.of(-1.1));
  assert.equal(overloaded.clipped, 2);
  assert.ok(overloaded.peak > 1);
  const unequal = measureStereoChannels(Float32Array.of(1), Float32Array.of(0));
  assert.equal(unequal.rms, Math.SQRT1_2);
});

test('channel meters handle silence and invalid samples without NaN readouts', () => {
  const silence = measureStereoChannels(new Float32Array(128), new Float32Array(128));
  assert.equal(silence.peak, 0);
  assert.equal(silence.rms, 0);
  const invalid = measureStereoChannels(Float32Array.of(NaN, Infinity, -0.5), Float32Array.of(0, 0, 0.5));
  assert.equal(invalid.invalidSamples, 2);
  assert.equal(invalid.peak, 0.5);
  assert.ok(Number.isFinite(invalid.rmsDb));
});
