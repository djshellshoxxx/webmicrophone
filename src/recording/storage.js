const DB_NAME = 'webmicrophone-audio-v1';
const DB_VERSION = 1;
let databasePromise;

// Session-only storage is an explicit fallback, never described as persistent.
export const memoryTakes = new Map();
export const activeTakeIds = new Set();

export const RECORDING_LIMITS = Object.freeze({
  maxDurationSeconds: 600,
  maxSourceBytes: 256 * 1024 * 1024,
  maxInputBytes: 256 * 1024 * 1024,
  maxMemoryBytes: 64 * 1024 * 1024,
  chunkFrames: 16384,
  poolSize: 6,
});

export function createTakeId() {
  return globalThis.crypto?.randomUUID?.() ?? `take-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function maxRecordingFrames(sampleRate, channels, storageMode = 'indexeddb', durationSeconds = 600) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || ![1, 2].includes(channels)) {
    throw new Error('Recording requires a valid sample rate and one or two channels.');
  }
  const duration = Math.min(RECORDING_LIMITS.maxDurationSeconds, Number(durationSeconds) || RECORDING_LIMITS.maxDurationSeconds);
  if (duration <= 0) throw new Error('Recording duration must be positive.');
  const sourceLimit = Math.floor(RECORDING_LIMITS.maxSourceBytes / (channels * 4));
  const memoryLimit = storageMode === 'memory'
    ? Math.floor(RECORDING_LIMITS.maxMemoryBytes / (channels * 4 * 2))
    : Infinity;
  return Math.min(Math.floor(duration * sampleRate), sourceLimit, memoryLimit);
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Browser storage request failed.'));
  });
}

export function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage write failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage write was interrupted.'));
  });
}

export async function openAudioDatabase() {
  if (!globalThis.indexedDB) throw new Error('Persistent browser storage is unavailable.');
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      const timeout = setTimeout(() => reject(new Error('Browser storage did not open. Close other tabs using this app and retry.')), 6000);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('takes')) db.createObjectStore('takes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) {
          const chunks = db.createObjectStore('chunks', { keyPath: ['takeId', 'index'] });
          chunks.createIndex('takeId', 'takeId');
        }
        if (!db.objectStoreNames.contains('originals')) db.createObjectStore('originals', { keyPath: 'takeId' });
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        request.result.onversionchange = () => {
          request.result.close();
          databasePromise = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => { clearTimeout(timeout); reject(request.error); };
      request.onblocked = () => { clearTimeout(timeout); reject(new Error('Browser storage is blocked by another app tab.')); };
    }).catch((error) => { databasePromise = undefined; throw error; });
  }
  return databasePromise;
}

export async function writeMetadata(db, metadata) {
  const tx = db.transaction('takes', 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('takes').put(metadata);
  await done;
}

export async function writeChunk(db, chunk, metadata) {
  const tx = db.transaction(['takes', 'chunks'], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('chunks').put(chunk);
  tx.objectStore('takes').put(metadata);
  await done;
}

export function recoverMetadata(metadata) {
  if (metadata.status === 'recording' && !activeTakeIds.has(metadata.id)) {
    return { ...metadata, status: 'interrupted', recovered: true, message: 'Recovered the last fully saved recording chunk.' };
  }
  return { ...metadata };
}

export async function listTakes() {
  let stored = [];
  try {
    const db = await openAudioDatabase();
    stored = await requestValue(db.transaction('takes').objectStore('takes').getAll());
  } catch { /* Session-only recordings remain usable when persistence is denied. */ }
  const merged = new Map(stored.map((take) => [take.id, recoverMetadata(take)]));
  for (const [id, take] of memoryTakes) merged.set(id, recoverMetadata(take.metadata));
  return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTakeMetadata(id) {
  if (memoryTakes.has(id)) return recoverMetadata(memoryTakes.get(id).metadata);
  const db = await openAudioDatabase();
  const metadata = await requestValue(db.transaction('takes').objectStore('takes').get(id));
  if (!metadata) throw new Error('This recording is no longer available in this browser.');
  return recoverMetadata(metadata);
}

export function copyChunkToBuffer(chunk, buffer, track = 'raw') {
  const trackIndex = track === 'processed' ? 1 : 0;
  if (trackIndex >= chunk.trackCount) throw new Error('This take does not contain a recorded processed track. Render it from the original instead.');
  if (chunk.channels !== buffer.numberOfChannels || chunk.frameStart < 0 || chunk.frameStart + chunk.frames > buffer.length) {
    throw new Error('Saved recording metadata does not match its audio chunks.');
  }
  const samples = new Float32Array(chunk.data);
  if (samples.length < chunk.capacity * chunk.channels * chunk.trackCount || chunk.frames > chunk.capacity) {
    throw new Error('A saved audio chunk is incomplete.');
  }
  for (let channel = 0; channel < chunk.channels; channel += 1) {
    const offset = (trackIndex * chunk.channels + channel) * chunk.capacity;
    buffer.copyToChannel(samples.subarray(offset, offset + chunk.frames), channel, chunk.frameStart);
  }
}

export async function loadTake(id, { track = 'raw', context } = {}) {
  if (!context?.createBuffer) throw new Error('An audio context is required to load a recording.');
  if (!['raw', 'processed'].includes(track)) throw new Error('Choose the original or processed track.');
  const metadata = await getTakeMetadata(id);
  if (!metadata.frameCount) throw new Error('This recording contains no saved audio samples.');
  if (track === 'processed' && !metadata.processedAvailable) throw new Error('This source has no saved processed take. Render it using the current settings.');
  const buffer = context.createBuffer(metadata.channels, metadata.frameCount, metadata.sampleRate);
  let nextFrame = 0;
  const acceptChunk = (chunk) => {
    if (chunk.frameStart !== nextFrame) throw new Error('The recording contains a missing chunk. The saved audio has not been joined across that gap.');
    copyChunkToBuffer(chunk, buffer, track);
    nextFrame += chunk.frames;
  };
  if (memoryTakes.has(id)) {
    for (const chunk of memoryTakes.get(id).chunks) acceptChunk(chunk);
  } else {
    const db = await openAudioDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('chunks');
      const cursor = tx.objectStore('chunks').index('takeId').openCursor(IDBKeyRange.only(id));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        try { acceptChunk(cursor.result.value); cursor.result.continue(); }
        catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Loading this recording was interrupted.'));
    });
  }
  if (nextFrame !== metadata.frameCount) throw new Error('The recording ended before its saved duration.');
  return { buffer, metadata };
}

export async function getOriginalFile(takeId) {
  const memory = memoryTakes.get(takeId);
  if (memory) return memory.originalFile ?? null;
  const db = await openAudioDatabase();
  const result = await requestValue(db.transaction('originals').objectStore('originals').get(takeId));
  return result ? { blob: result.blob, filename: result.filename } : null;
}

export async function deleteTake(id) {
  if (activeTakeIds.has(id)) throw new Error('Stop this recording before deleting it.');
  if (memoryTakes.delete(id)) return;
  try {
    const db = await openAudioDatabase();
    const tx = db.transaction(['takes', 'chunks', 'originals'], 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('takes').delete(id);
    tx.objectStore('originals').delete(id);
    const request = tx.objectStore('chunks').index('takeId').openCursor(IDBKeyRange.only(id));
    request.onsuccess = () => {
      if (request.result) { request.result.delete(); request.result.continue(); }
    };
    await done;
  } catch (error) {
    // A denied database cannot contain an accessible persistent copy to delete.
    if (globalThis.indexedDB) throw error;
  }
}
