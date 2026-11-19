import { RECORDING_LIMITS } from '../recording/storage.js';
import { trimFrameRange, wavFormat } from './wav.js';

export { trimFrameRange } from './wav.js';

function abortError() { return new DOMException('Operation cancelled.', 'AbortError'); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function yieldToUi() { return new Promise((resolve) => setTimeout(resolve, 0)); }

function requireAudioBuffer(buffer) {
  if (!buffer?.getChannelData || !buffer.length || ![1, 2].includes(buffer.numberOfChannels)) throw new Error('Choose a non-empty mono or stereo source first.');
}

function offlineContext(channels, frames, sampleRate) {
  const Context = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!Context) throw new Error('This browser cannot render audio offline.');
  return new Context(channels, frames, sampleRate);
}

async function abortable(promise, signal) {
  checkAbort(signal);
  if (!signal) return promise;
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export async function prepareExportBuffer(buffer, {
  sampleRate = buffer?.sampleRate, normalize = false, normalizePeakDb = -1,
  trim, signal, onProgress = () => {},
} = {}) {
  requireAudioBuffer(buffer);
  checkAbort(signal);
  const targetRate = Number(sampleRate);
  if (!Number.isInteger(targetRate) || targetRate < 8000 || targetRate > 192000) throw new Error('Choose a valid export sample rate between 8 and 192 kHz.');
  const range = trimFrameRange(buffer, trim);
  const outputFrames = Math.max(1, Math.round(range.frames * targetRate / buffer.sampleRate));
  if (outputFrames * buffer.numberOfChannels * 4 > RECORDING_LIMITS.maxSourceBytes) throw new Error('This export would exceed the 256 MiB working audio limit. Choose a shorter selection or a lower sample rate.');
  const wholeSource = range.startFrame === 0 && range.endFrame === buffer.length;
  let prepared = buffer;
  if (targetRate !== buffer.sampleRate) {
    onProgress({ phase: 'Resampling audio', progress: null });
    const offline = offlineContext(buffer.numberOfChannels, outputFrames, targetRate);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start(0, range.startFrame / buffer.sampleRate, range.frames / buffer.sampleRate);
    // Native rendering has no hard cancellation API. Discard its result after
    // cancellation and release its graph only once the native render finishes.
    const rendering = offline.startRendering().finally(() => { source.disconnect(); source.buffer = null; });
    prepared = await abortable(rendering, signal);
  } else if (!wholeSource || normalize) {
    prepared = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: range.frames, sampleRate: buffer.sampleRate });
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) prepared.copyToChannel(buffer.getChannelData(channel).subarray(range.startFrame, range.endFrame), channel);
  }
  checkAbort(signal);
  if (normalize) {
    const targetDb = Number(normalizePeakDb);
    if (!Number.isFinite(targetDb) || targetDb > 0 || targetDb < -30) throw new Error('Normalization target must be between −30 and 0 dBFS.');
    let peak = 0;
    const channels = Array.from({ length: prepared.numberOfChannels }, (_, channel) => prepared.getChannelData(channel));
    for (let start = 0; start < prepared.length; start += 65536) {
      const end = Math.min(prepared.length, start + 65536);
      for (const samples of channels) for (let frame = start; frame < end; frame += 1) if (Number.isFinite(samples[frame])) peak = Math.max(peak, Math.abs(samples[frame]));
      onProgress({ phase: 'Measuring sample peak', progress: end / prepared.length });
      checkAbort(signal);
      await yieldToUi();
    }
    const gain = peak > 0 ? 10 ** (targetDb / 20) / peak : 1;
    for (let start = 0; start < prepared.length; start += 65536) {
      const end = Math.min(prepared.length, start + 65536);
      for (const samples of channels) for (let frame = start; frame < end; frame += 1) samples[frame] = Number.isFinite(samples[frame]) ? samples[frame] * gain : 0;
      onProgress({ phase: 'Normalizing sample peak', progress: end / prepared.length });
      checkAbort(signal);
      await yieldToUi();
    }
  }
  return prepared;
}

export async function encodeWav(buffer, options = {}) {
  const { bitDepth = 16, signal, onProgress = () => {} } = options;
  wavFormat(bitDepth);
  const prepared = await prepareExportBuffer(buffer, options);
  checkAbort(signal);
  const worker = new Worker(new URL('./wav-worker.js', import.meta.url), { type: 'module' });
  let pending;
  let failed;
  const wait = (type) => new Promise((resolve, reject) => {
    if (failed) { reject(failed); return; }
    pending = { type, resolve, reject };
  });
  worker.onmessage = ({ data }) => {
    if (data.type === 'error') {
      failed = new Error(data.message);
      pending?.reject(failed);
      pending = null;
    } else if (pending?.type === data.type) {
      pending.resolve(data);
      pending = null;
    }
  };
  worker.onerror = (event) => {
    failed = new Error(event.message || 'The WAV encoder could not start.');
    pending?.reject(failed);
    pending = null;
  };
  const cancel = () => { failed = abortError(); pending?.reject(failed); worker.terminate(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const ready = wait('ready');
    worker.postMessage({ type: 'start', channels: prepared.numberOfChannels, frames: prepared.length, sampleRate: prepared.sampleRate, bitDepth });
    await ready;
    for (let start = 0; start < prepared.length; start += 65536) {
      checkAbort(signal);
      const end = Math.min(prepared.length, start + 65536);
      const channels = Array.from({ length: prepared.numberOfChannels }, (_, channel) => prepared.getChannelData(channel).slice(start, end).buffer);
      const saved = wait('chunk-saved');
      worker.postMessage({ type: 'chunk', channels }, channels);
      await saved;
      onProgress({ phase: 'Encoding WAV', progress: end / prepared.length });
    }
    const complete = wait('complete');
    worker.postMessage({ type: 'finish' });
    return (await complete).blob;
  } finally {
    signal?.removeEventListener('abort', cancel);
    worker.terminate();
  }
}

const compressedCandidates = [
  { id: 'opus-webm', label: 'Opus / WebM', mimeType: 'audio/webm;codecs=opus', extension: 'webm', codec: 'Opus' },
  { id: 'opus-ogg', label: 'Opus / Ogg', mimeType: 'audio/ogg;codecs=opus', extension: 'ogg', codec: 'Opus' },
  { id: 'aac-mp4', label: 'AAC / MP4', mimeType: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a', codec: 'AAC' },
  { id: 'mp4-auto', label: 'Browser audio / MP4', mimeType: 'audio/mp4', extension: 'm4a', codec: 'browser selected' },
];

export function getCompressedFormats() {
  if (!globalThis.MediaRecorder?.isTypeSupported) return [];
  return compressedCandidates.filter((format) => {
    try { return MediaRecorder.isTypeSupported(format.mimeType); } catch { return false; }
  }).map((format) => ({ ...format }));
}

export async function exportCompressed(buffer, options = {}) {
  const { signal, onProgress = () => {} } = options;
  const formats = getCompressedFormats();
  const requested = options.format ?? options.mimeType ?? formats[0]?.id;
  const selected = formats.find((format) => format.id === requested || format.mimeType === requested);
  if (!selected) throw new Error('This browser does not provide the requested compressed encoder. Choose WAV or an available encoder.');
  const bitrate = Number(options.bitrateKbps ?? options.bitrate ?? 128);
  const bitsPerSecond = bitrate < 1000 ? bitrate * 1000 : bitrate;
  if (![64000, 96000, 128000, 192000, 256000].includes(bitsPerSecond)) throw new Error('Choose 64, 96, 128, 192 or 256 kbps for compressed export.');
  const prepared = await prepareExportBuffer(buffer, options);
  checkAbort(signal);
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const context = new Context({ sampleRate: prepared.sampleRate });
  const destination = context.createMediaStreamDestination();
  destination.channelCount = prepared.numberOfChannels;
  destination.channelCountMode = 'explicit';
  const source = context.createBufferSource();
  source.buffer = prepared;
  source.connect(destination); // No connection to speakers.
  let recorder;
  let progressTimer;
  let cancel;
  try {
    recorder = new MediaRecorder(destination.stream, { mimeType: selected.mimeType, audioBitsPerSecond: bitsPerSecond });
    await context.resume();
    const result = await new Promise((resolve, reject) => {
      const chunks = [];
      let cancelled = false;
      let encoderError;
      recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
      recorder.onerror = (event) => {
        encoderError = event.error ?? new Error('The browser encoder failed. Try WAV export.');
        if (recorder.state !== 'inactive') recorder.stop();
        else reject(encoderError);
      };
      recorder.onstop = () => {
        if (cancelled) { reject(abortError()); return; }
        if (encoderError) { reject(encoderError); return; }
        const mimeType = recorder.mimeType || chunks[0]?.type || selected.mimeType;
        const extension = /mp4/i.test(mimeType) ? 'm4a' : /ogg/i.test(mimeType) ? 'ogg' : /webm/i.test(mimeType) ? 'webm' : selected.extension;
        const blob = new Blob(chunks, { type: mimeType });
        if (!blob.size) { reject(new Error('The encoder produced an empty file. Try WAV export.')); return; }
        resolve({ blob, mimeType, extension, bitrate: recorder.audioBitsPerSecond || null, requestedBitrate: bitsPerSecond });
      };
      cancel = () => {
        cancelled = true;
        try { source.stop(); } catch { /* Source may not have started. */ }
        if (recorder.state !== 'inactive') recorder.stop();
        else reject(abortError());
      };
      signal?.addEventListener('abort', cancel, { once: true });
      source.onended = () => { if (recorder.state !== 'inactive') recorder.stop(); };
      recorder.start(1000);
      const startedAt = context.currentTime;
      source.start();
      progressTimer = setInterval(() => {
        onProgress({ phase: 'Encoding compressed audio in real time', progress: Math.min(0.999, (context.currentTime - startedAt) / prepared.duration) });
      }, 200);
      if (signal?.aborted) cancel();
    });
    onProgress({ phase: 'Compressed export ready', progress: 1 });
    return result;
  } finally {
    clearInterval(progressTimer);
    signal?.removeEventListener('abort', cancel);
    if (recorder?.state !== 'inactive') { try { recorder?.stop(); } catch { /* Encoder already stopped. */ } }
    source.disconnect();
    source.buffer = null;
    for (const track of destination.stream.getTracks()) track.stop();
    await context.close().catch(() => {});
  }
}

export async function renderProcessed(buffer, settings, {
  onProgress = () => {}, signal, sampleRate = 48000, includeTailSeconds = 0,
} = {}) {
  requireAudioBuffer(buffer);
  checkAbort(signal);
  const tailSeconds = Number(includeTailSeconds);
  if (!Number.isFinite(tailSeconds) || tailSeconds < 0 || tailSeconds > 2) throw new Error('Additional render tail must be between zero and two seconds.');
  const workingRate = 48000;
  const inputFrames = Math.round(buffer.length * workingRate / buffer.sampleRate);
  const tailFrames = Math.round(tailSeconds * workingRate);
  const paddingFrames = workingRate + tailFrames;
  const stereoEffect = settings.phaseEnabled || settings.channelDelayMs !== 0 || settings.polarityL !== settings.polarityR;
  const outputChannels = settings.mono ? 1 : stereoEffect ? 2 : buffer.numberOfChannels;
  if ((inputFrames + paddingFrames) * outputChannels * 4 > RECORDING_LIMITS.maxSourceBytes + workingRate * 2 * 4) throw new Error('This render exceeds the working audio limit. Trim the source first.');
  onProgress({ phase: 'Preparing processing engine', progress: null });
  const offline = offlineContext(outputChannels, inputFrames + paddingFrames, workingRate);
  const { createProcessingGraph } = await import('../audio/engine.js');
  const errors = [];
  const graph = await createProcessingGraph(offline, structuredClone(settings), { offline: true, onError: (error) => errors.push(error) });
  const latencyFrames = Math.round(Number(graph.latencySamples ?? 0));
  if (!Number.isFinite(latencyFrames) || latencyFrames < 0 || latencyFrames > paddingFrames - tailFrames) {
    graph.dispose();
    throw new Error('The processing engine reported an unsupported render delay.');
  }
  if (signal?.aborted) { graph.dispose(); throw abortError(); }
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(graph.input);
  graph.output.connect(offline.destination);
  source.start();
  onProgress({ phase: 'Rendering from the preserved original', progress: null });
  const rendering = offline.startRendering().finally(() => {
    source.disconnect();
    source.buffer = null;
    graph.dispose();
  });
  const rendered = await abortable(rendering, signal);
  checkAbort(signal);
  if (errors.length) throw new Error(`Processing did not complete with the requested settings: ${errors.map((error) => error.message ?? String(error)).join('; ')}`);
  const cropped = new AudioBuffer({ numberOfChannels: outputChannels, length: inputFrames + tailFrames, sampleRate: workingRate });
  for (let channel = 0; channel < outputChannels; channel += 1) cropped.copyToChannel(rendered.getChannelData(channel).subarray(latencyFrames, latencyFrames + cropped.length), channel);
  const output = Number(sampleRate) === workingRate ? cropped : await prepareExportBuffer(cropped, { sampleRate, signal, onProgress });
  onProgress({ phase: 'Processed render ready', progress: 1 });
  return output;
}
