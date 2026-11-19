import { processTimePitchPCM } from './time-pitch-pcm.js';

self.onmessage = async ({ data }) => {
  try {
    const channels = data.channels.map((buffer) => new Float32Array(buffer));
    const output = await processTimePitchPCM(channels, data.sampleRate, data.settings, {
      onProgress: (progress) => self.postMessage({ type: 'progress', ...progress }),
    });
    const buffers = output.map((channel) => channel.buffer);
    self.postMessage({ type: 'complete', channels: buffers }, buffers);
  } catch (error) {
    self.postMessage({ type: 'error', name: error.name, message: error.message });
  }
};
