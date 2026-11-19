import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings} from '../src/state.js';
import {bandCoefficients, equalizerResponse, frequencyToUnit, magnitudeAt, unitToFrequency} from '../src/ui/eq-response.js';

const db = value => 20 * Math.log10(value);
const sampleRate = 48000;
const band = patch => ({frequency: 1000, gain: 0, q: Math.SQRT1_2, type: 'peaking', enabled: true, ...patch});

test('logarithmic EQ coordinates preserve frequencies and bounds', () => {
  for (const value of [20, 31.5, 100, 1000, 16000, 20000]) {
    assert.ok(Math.abs(unitToFrequency(frequencyToUnit(value)) - value) < 1e-8);
  }
  assert.equal(unitToFrequency(-1), 20);
  assert.equal(unitToFrequency(2), 20000);
});

test('neutral ten-band EQ and bypass are flat', () => {
  const settings = defaultSettings();
  const frequencies = new Float32Array([20, 40, 100, 1000, 10000, 20000]);
  for (const value of equalizerResponse(settings, frequencies)) assert.ok(Math.abs(value - 1) < 1e-6);
  settings.eq[4].gain = 18;
  settings.eqEnabled = false;
  assert.deepEqual([...equalizerResponse(settings, frequencies)], [1, 1, 1, 1, 1, 1]);
});

test('peaking EQ reaches the requested boost and cut at its center', () => {
  for (const gain of [-18, -6, 6, 18]) {
    const coefficients = bandCoefficients(band({gain, q: 1.2}), sampleRate);
    assert.ok(Math.abs(db(magnitudeAt(coefficients, 1000, sampleRate)) - gain) < 1e-8);
  }
});

test('disabled band contributes no response', () => {
  const coefficients = bandCoefficients(band({enabled: false, gain: 18}), sampleRate);
  for (const frequency of [20, 1000, 20000]) assert.equal(magnitudeAt(coefficients, frequency, sampleRate), 1);
});

test('pass filters use physical Q and attenuate the expected side', () => {
  const low = bandCoefficients(band({type: 'lowpass'}), sampleRate);
  const high = bandCoefficients(band({type: 'highpass'}), sampleRate);
  assert.ok(Math.abs(db(magnitudeAt(low, 1000, sampleRate)) + 3.0102999566) < 1e-6);
  assert.ok(Math.abs(db(magnitudeAt(high, 1000, sampleRate)) + 3.0102999566) < 1e-6);
  assert.ok(db(magnitudeAt(low, 10000, sampleRate)) < -35);
  assert.ok(db(magnitudeAt(high, 100, sampleRate)) < -35);
});

test('notch suppresses its center while leaving far frequencies', () => {
  const notch = bandCoefficients(band({type: 'notch', q: 8}), sampleRate);
  assert.ok(magnitudeAt(notch, 1000, sampleRate) < 1e-10);
  assert.ok(Math.abs(db(magnitudeAt(notch, 100, sampleRate))) < 0.01);
});

test('shelf response has expected asymptotic gain and fixed slope', () => {
  const low = bandCoefficients(band({type: 'lowshelf', gain: 12}), sampleRate);
  const high = bandCoefficients(band({type: 'highshelf', gain: -12}), sampleRate);
  assert.ok(Math.abs(db(magnitudeAt(low, 20, sampleRate)) - 12) < 0.01);
  assert.ok(Math.abs(db(magnitudeAt(low, 20000, sampleRate))) < 0.01);
  assert.ok(Math.abs(db(magnitudeAt(high, 20000, sampleRate)) + 12) < 0.01);
  assert.deepEqual(low, bandCoefficients(band({type: 'lowshelf', gain: 12, q: 20}), sampleRate));
});
