import { createWavHeader, encodePcmBlock } from './wav.js';

let parts = [];
let format;
let expectedFrames = 0;
let receivedFrames = 0;
let channelCount = 0;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'start') {
      const header = createWavHeader(data);
      parts = [header.buffer];
      format = { bitDepth: data.bitDepth, padding: header.padding };
      expectedFrames = data.frames;
      receivedFrames = 0;
      channelCount = data.channels;
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'chunk') {
      if (!format || data.channels.length !== channelCount) throw new Error('WAV export received an invalid channel layout.');
      const channels = data.channels.map((buffer) => new Float32Array(buffer));
      parts.push(encodePcmBlock(channels, format.bitDepth));
      receivedFrames += channels[0].length;
      self.postMessage({ type: 'chunk-saved', frames: receivedFrames });
    } else if (data.type === 'finish') {
      if (receivedFrames !== expectedFrames) throw new Error('WAV export received an incomplete set of audio samples.');
      if (format.padding) parts.push(new Uint8Array(1));
      const blob = new Blob(parts, { type: 'audio/wav' });
      parts = [];
      self.postMessage({ type: 'complete', blob });
    }
  } catch (error) {
    parts = [];
    self.postMessage({ type: 'error', message: error.message });
  }
};
