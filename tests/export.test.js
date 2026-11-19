import test from 'node:test';
import assert from 'node:assert/strict';
import { createWavHeader, encodePcmBlock, trimFrameRange, wavFormat } from '../src/export/wav.js';

function inspectWave(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, size) => new TextDecoder().decode(bytes.subarray(offset, offset + size));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(view.getUint32(4, true) + 8, bytes.length);
  const chunks = new Map();
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset + 4, true);
    chunks.set(text(offset, 4), { offset: offset + 8, length });
    offset += 8 + length + length % 2;
  }
  return { view, chunks };
}

function wave(channelData, bitDepth) {
  const header = createWavHeader({ sampleRate: 48000, channels: channelData.length, frames: channelData[0].length, bitDepth });
  const pcm = encodePcmBlock(channelData, bitDepth);
  const result = new Uint8Array(header.headerBytes + pcm.length + header.padding);
  result.set(new Uint8Array(header.buffer));
  result.set(pcm, header.headerBytes);
  return inspectWave(result);
}

test('PCM16 WAV has correct stereo layout, byte rate, and signed endpoint values', () => {
  const { view, chunks } = wave([new Float32Array([-1, 0, 1]), new Float32Array([0.5, -0.5, 2])], 16);
  const fmt = chunks.get('fmt ').offset;
  const data = chunks.get('data');
  assert.equal(view.getUint16(fmt, true), 1);
  assert.equal(view.getUint16(fmt + 2, true), 2);
  assert.equal(view.getUint32(fmt + 4, true), 48000);
  assert.equal(view.getUint32(fmt + 8, true), 192000);
  assert.equal(view.getUint16(fmt + 12, true), 4);
  assert.equal(view.getUint16(fmt + 14, true), 16);
  assert.equal(data.length, 12);
  const samples = Array.from({ length: 6 }, (_, index) => view.getInt16(data.offset + index * 2, true));
  assert.deepEqual(samples, [-32768, 16384, 0, -16384, 32767, 32767]);
});

test('PCM24 endpoints are signed little-endian and an odd data chunk is padded', () => {
  const { view, chunks } = wave([new Float32Array([-1, 0, 1])], 24);
  const data = chunks.get('data');
  assert.equal(data.length, 9);
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const offset = data.offset + i * 3;
    const unsigned = view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16;
    samples.push(unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned);
  }
  assert.deepEqual(samples, [-8388608, 0, 8388607]);
  assert.equal(view.getUint8(view.byteLength - 1), 0);
});

test('float32 WAV identifies IEEE float, includes fact count, and preserves finite overshoots', () => {
  const { view, chunks } = wave([new Float32Array([-1.25, 0.25, 1.5, NaN])], '32float');
  assert.equal(view.getUint16(chunks.get('fmt ').offset, true), 3);
  assert.equal(chunks.get('fmt ').length, 18);
  assert.equal(view.getUint32(chunks.get('fact').offset, true), 4);
  const offset = chunks.get('data').offset;
  assert.deepEqual(Array.from({ length: 4 }, (_, i) => view.getFloat32(offset + i * 4, true)), [-1.25, 0.25, 1.5, 0]);
});

test('WAV rejects invalid sizes and unsupported settings before allocating sample storage', () => {
  assert.throws(() => createWavHeader({ sampleRate: 48000, channels: 2, frames: 0, bitDepth: 16 }), /one frame/);
  assert.throws(() => createWavHeader({ sampleRate: 48000, channels: 2, frames: 2 ** 32, bitDepth: 24 }), /4 GiB/);
  assert.throws(() => wavFormat(8), /16-bit/);
  assert.throws(() => encodePcmBlock([new Float32Array(2), new Float32Array(3)], 16), /lengths must match/);
});

test('non-destructive trim uses sample boundaries and rejects reversed/outside selections', () => {
  const source = { sampleRate: 48000, length: 48000, duration: 1 };
  assert.deepEqual(trimFrameRange(source, { start: 0.125, end: 0.25 }), { startFrame: 6000, endFrame: 12000, frames: 6000 });
  assert.deepEqual(trimFrameRange(source), { startFrame: 0, endFrame: 48000, frames: 48000 });
  for (const trim of [{ start: -1, end: 1 }, { start: 0.5, end: 0.2 }, { start: 0, end: 2 }, { start: NaN, end: 1 }]) {
    assert.throws(() => trimFrameRange(source, trim), /Trim/);
  }
  assert.equal(source.length, 48000);
});
