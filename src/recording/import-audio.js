import {
  RECORDING_LIMITS, createTakeId, memoryTakes, openAudioDatabase,
  transactionDone, writeChunk, writeMetadata, deleteTake,
} from './storage.js';

export function validateSourceShape({ sampleRate, channels, frames, duration = frames / sampleRate }) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(frames) || frames <= 0) throw new Error('The audio file has no valid, finite duration.');
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('The audio sample rate is outside the supported 8–192 kHz range.');
  if (![1, 2].includes(channels)) throw new Error('Import supports mono and stereo audio. Convert multichannel audio to a chosen mono or stereo mix first.');
  if (duration > RECORDING_LIMITS.maxDurationSeconds + 1 / sampleRate) throw new Error('This version accepts recordings up to 10 minutes. Trim this file before importing.');
  if (frames * channels * 4 > RECORDING_LIMITS.maxSourceBytes) throw new Error('Decoded audio exceeds the 256 MiB source limit. Use a shorter recording.');
}

function fourCC(view, offset) {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

export function parseWavFormat(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 16) throw new Error('The WAV format chunk is incomplete.');
  const audioFormat = view.getUint16(0, true);
  const channels = view.getUint16(2, true);
  const sampleRate = view.getUint32(4, true);
  const blockAlign = view.getUint16(12, true);
  const bitDepth = view.getUint16(14, true);
  if (!blockAlign || !sampleRate || !channels || bitDepth === 0) throw new Error('The WAV format header is invalid.');
  if (![1, 3, 0xfffe].includes(audioFormat)) throw new Error('This WAV uses an unsupported compressed encoding. Export PCM or IEEE float WAV first.');
  return { audioFormat, channels, sampleRate, blockAlign, bitDepth };
}

async function inspectWav(file) {
  const prefix = new DataView(await file.slice(0, 12).arrayBuffer());
  if (prefix.byteLength < 12 || fourCC(prefix, 0) !== 'RIFF' || fourCC(prefix, 8) !== 'WAVE') return null;
  let offset = 12;
  let format;
  let dataBytes;
  while (offset + 8 <= file.size) {
    const header = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
    const id = fourCC(header, 0);
    const length = header.getUint32(4, true);
    if (offset + 8 + length > file.size) throw new Error('The WAV file is truncated.');
    if (id === 'fmt ') format = parseWavFormat(new Uint8Array(await file.slice(offset + 8, offset + 8 + Math.min(length, 64)).arrayBuffer()));
    if (id === 'data') dataBytes = length;
    if (format && dataBytes !== undefined) break;
    offset += 8 + length + (length % 2);
  }
  if (!format || dataBytes === undefined || dataBytes % format.blockAlign !== 0) throw new Error('The WAV file does not contain a valid format and sample data.');
  const frames = dataBytes / format.blockAlign;
  return { ...format, frames, duration: frames / format.sampleRate };
}

async function inspectBrowserDuration(file) {
  const url = URL.createObjectURL(file);
  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The browser could not inspect this file duration. Try a PCM WAV file.')), 15000);
      audio.onloadedmetadata = () => {
        clearTimeout(timer);
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) reject(new Error('This file has no usable duration metadata. Re-export it as WAV before importing.'));
        else resolve(audio.duration);
      };
      audio.onerror = () => { clearTimeout(timer); reject(new Error('This browser cannot read this audio format. Try PCM WAV.')); };
      audio.src = url;
    });
  } finally {
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(url);
  }
}

async function saveImportedSource(buffer, file, metadata) {
  const db = await openAudioDatabase();
  const tx = db.transaction(['takes', 'originals'], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('takes').put({ ...metadata, frameCount: 0, duration: 0, status: 'recording' });
  tx.objectStore('originals').put({ takeId: metadata.id, blob: file, filename: file.name });
  await done;
  let index = 0;
  try {
    for (let start = 0; start < buffer.length; start += RECORDING_LIMITS.chunkFrames) {
      const frames = Math.min(RECORDING_LIMITS.chunkFrames, buffer.length - start);
      const data = new Float32Array(frames * buffer.numberOfChannels);
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) data.set(buffer.getChannelData(channel).subarray(start, start + frames), channel * frames);
      await writeChunk(db, {
        takeId: metadata.id, index: index++, frameStart: start, frames,
        capacity: frames, channels: buffer.numberOfChannels, trackCount: 1, data: data.buffer,
      }, { ...metadata, status: 'recording', frameCount: start + frames, duration: (start + frames) / buffer.sampleRate });
    }
    await writeMetadata(db, metadata);
  } catch (error) {
    // An incomplete import must not appear as a fully saved source.
    await deleteTake(metadata.id).catch(() => {});
    throw error;
  }
}

export async function importAudioFile(file, context, { onProgress = () => {}, signal } = {}) {
  if (!file?.arrayBuffer || !context?.decodeAudioData) throw new Error('Choose a local audio file.');
  if (file.size === 0) throw new Error('The selected file is empty.');
  if (file.size > RECORDING_LIMITS.maxInputBytes) throw new Error('This version accepts files up to 256 MiB and 10 minutes. Trim or convert this file before importing.');
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError'); };
  checkAbort();
  onProgress({ phase: 'Inspecting audio', progress: null });
  const wav = await inspectWav(file);
  const duration = wav?.duration ?? await inspectBrowserDuration(file);
  const framesAtWorkingRate = Math.ceil(duration * context.sampleRate);
  validateSourceShape({ sampleRate: context.sampleRate, channels: wav?.channels ?? 2, frames: framesAtWorkingRate, duration });
  checkAbort();
  onProgress({ phase: 'Decoding audio', progress: null });
  let buffer;
  try { buffer = await context.decodeAudioData(await file.arrayBuffer()); }
  catch (error) { throw new Error(`This browser could not decode the file. Try a PCM WAV recording. ${error.message}`); }
  validateSourceShape({ sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, frames: buffer.length });
  checkAbort();
  const metadata = {
    id: createTakeId(), label: String(file.name || 'Imported audio').slice(0, 160),
    createdAt: new Date().toISOString(), status: 'complete', sourceKind: 'file',
    originalFilename: file.name || 'original-audio', originalBytes: file.size,
    originalMimeType: file.type || 'application/octet-stream',
    inputSampleRate: wav?.sampleRate ?? null,
    sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
    frameCount: buffer.length, duration: buffer.duration,
    rawAvailable: true, processedAvailable: false, originalFileAvailable: true,
    storageMode: 'indexeddb', latencyFrames: 0,
  };
  onProgress({ phase: 'Saving original locally', progress: null });
  try { await saveImportedSource(buffer, file, metadata); }
  catch (error) {
    metadata.storageMode = 'session';
    metadata.message = `The source is available for this session, but could not be saved for reload: ${error.message}`;
    // Avoid an unbounded second PCM copy in the fallback. The returned AudioBuffer
    // remains owned by the active UI; a small source can also appear in the library.
    const bytes = buffer.length * buffer.numberOfChannels * 4 + file.size;
    let memoryUsed = 0;
    for (const take of memoryTakes.values()) {
      for (const chunk of take.chunks) memoryUsed += chunk.data.byteLength;
      memoryUsed += take.originalFile?.blob?.size ?? 0;
    }
    if (bytes + memoryUsed <= RECORDING_LIMITS.maxMemoryBytes) {
      const data = new Float32Array(buffer.length * buffer.numberOfChannels);
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) data.set(buffer.getChannelData(channel), channel * buffer.length);
      metadata.storageMode = 'memory';
      memoryTakes.set(metadata.id, {
        metadata: { ...metadata }, originalFile: { blob: file, filename: file.name },
        chunks: [{ takeId: metadata.id, index: 0, frameStart: 0, frames: buffer.length, capacity: buffer.length, channels: buffer.numberOfChannels, trackCount: 1, data: data.buffer }],
      });
    }
  }
  checkAbort();
  onProgress({ phase: 'Audio ready', progress: 1 });
  return { buffer, metadata, takeId: metadata.storageMode === 'session' ? null : metadata.id, originalFile: file };
}
