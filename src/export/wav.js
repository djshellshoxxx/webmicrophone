export function wavFormat(bitDepth = 16) {
  if (bitDepth === 16 || bitDepth === '16') return { bits: 16, bytes: 2, formatTag: 1 };
  if (bitDepth === 24 || bitDepth === '24') return { bits: 24, bytes: 3, formatTag: 1 };
  if (bitDepth === 32 || bitDepth === '32' || bitDepth === '32float') return { bits: 32, bytes: 4, formatTag: 3 };
  throw new Error('WAV supports 16-bit PCM, 24-bit PCM, or 32-bit float in this app.');
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

export function createWavHeader({ sampleRate, channels, frames, bitDepth = 16 }) {
  const format = wavFormat(bitDepth);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Choose a supported WAV sample rate between 8 and 192 kHz.');
  if (![1, 2].includes(channels) || !Number.isInteger(frames) || frames < 1) throw new Error('WAV needs at least one frame of mono or stereo audio.');
  const dataBytes = frames * channels * format.bytes;
  const padding = dataBytes % 2;
  // IEEE float uses WAVEFORMATEX and a fact chunk, as required for non-PCM WAVE.
  const float = format.formatTag === 3;
  const headerBytes = float ? 58 : 44;
  const riffBytes = headerBytes - 8 + dataBytes + padding;
  if (riffBytes > 0xffffffff) throw new Error('This export exceeds the RIFF/WAV 4 GiB limit. Export a shorter selection.');
  const buffer = new ArrayBuffer(headerBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, riffBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, float ? 18 : 16, true);
  view.setUint16(20, format.formatTag, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * format.bytes, true);
  view.setUint16(32, channels * format.bytes, true);
  view.setUint16(34, format.bits, true);
  if (float) {
    view.setUint16(36, 0, true); // cbSize
    writeAscii(view, 38, 'fact');
    view.setUint32(42, 4, true);
    view.setUint32(46, frames, true);
    writeAscii(view, 50, 'data');
    view.setUint32(54, dataBytes, true);
  } else {
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataBytes, true);
  }
  return { buffer, dataBytes, padding, headerBytes, format };
}

export function encodePcmBlock(channelData, bitDepth = 16) {
  const format = wavFormat(bitDepth);
  const channels = channelData.length;
  const frames = channelData[0]?.length ?? 0;
  if (![1, 2].includes(channels) || !frames || channelData.some((channel) => channel.length !== frames)) throw new Error('PCM channel lengths must match.');
  const output = new Uint8Array(frames * channels * format.bytes);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const raw = channelData[channel][frame];
      const sample = Number.isFinite(raw) ? raw : 0;
      if (format.formatTag === 3) {
        // Float WAV preserves finite overshoots; integer encoders must clip.
        view.setFloat32(offset, sample, true);
      } else {
        const clipped = Math.max(-1, Math.min(1, sample));
        if (format.bits === 16) view.setInt16(offset, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
        else {
          const value = Math.round(clipped * (clipped < 0 ? 8388608 : 8388607));
          view.setUint8(offset, value & 0xff);
          view.setUint8(offset + 1, (value >> 8) & 0xff);
          view.setUint8(offset + 2, (value >> 16) & 0xff);
        }
      }
      offset += format.bytes;
    }
  }
  return output;
}

export function trimFrameRange(buffer, trim) {
  const start = trim?.start ?? 0;
  const end = trim?.end ?? buffer.duration;
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > buffer.duration + 1 / buffer.sampleRate) {
    throw new Error('Trim start and end must form a non-empty selection within the recording.');
  }
  const startFrame = Math.round(start * buffer.sampleRate);
  const endFrame = Math.min(buffer.length, Math.round(end * buffer.sampleRate));
  if (startFrame >= endFrame) throw new Error('The trim selection contains no audio samples.');
  return { startFrame, endFrame, frames: endFrame - startFrame };
}
