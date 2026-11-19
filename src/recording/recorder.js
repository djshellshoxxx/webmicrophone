import {
  RECORDING_LIMITS, activeTakeIds, createTakeId, maxRecordingFrames,
  memoryTakes, openAudioDatabase, writeChunk, writeMetadata,
} from './storage.js';

export { RECORDING_LIMITS, listTakes, loadTake, deleteTake, getOriginalFile } from './storage.js';
export { importAudioFile } from './import-audio.js';

const loadedContexts = new WeakSet();

export class TakeRecorder {
  constructor(context, { onStatus = () => {}, onError = () => {} } = {}) {
    this.context = context;
    this.onStatus = onStatus;
    this.onError = onError;
    this.storageMode = 'indexeddb';
    this.state = 'idle';
    this.pendingWrites = Promise.resolve();
    this.waiters = new Map();
  }

  async init() {
    if (!this.context.audioWorklet) throw new Error('This browser does not provide the audio worklet required for recording. File processing may still be available.');
    if (!loadedContexts.has(this.context)) {
      await this.context.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
      loadedContexts.add(this.context);
    }
    try { this.db = await openAudioDatabase(); }
    catch {
      this.db = null;
      this.storageMode = 'memory';
      this.emitStatus('Persistent storage is unavailable. This take will be session-only, with a 64 MiB total limit. Download it before closing this page.');
    }
    this.initialized = true;
    return this;
  }

  emitStatus(message = '') {
    this.onStatus({
      state: this.state, storageMode: this.storageMode,
      frameCount: this.metadata?.frameCount ?? 0,
      duration: this.metadata?.duration ?? 0,
      maxDuration: this.maxFrames ? this.maxFrames / this.context.sampleRate : null,
      message,
    });
  }

  waitFor(type, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(type);
        reject(new Error(`The recorder did not ${type === 'ready' ? 'initialize' : type}. Check that the audio context is running.`));
      }, timeoutMs);
      this.waiters.set(type, { resolve: (data) => { clearTimeout(timeout); resolve(data); }, reject });
    });
  }

  async start({ rawNode, processedNode, channels = 2, inputChannelCount = channels, label = 'Microphone take', settingsSnapshot = null, latencyFrames = 0, durationSeconds = 600 } = {}) {
    if (['starting', 'recording', 'paused', 'stopping'].includes(this.state)) throw new Error('A recording is already active.');
    if (!rawNode?.connect || !processedNode?.connect) throw new Error('Connect an original and processed audio source before recording.');
    if (!Number.isFinite(Number(latencyFrames)) || latencyFrames < 0 || latencyFrames > this.context.sampleRate) throw new Error('The processing delay must be a finite value between zero and one second.');
    this.state = 'starting';
    this.emitStatus();
    try {
      if (!this.initialized) await this.init();
      if (this.context.state !== 'running') await this.context.resume();
      if (this.storageMode === 'memory') {
        let used = 0;
        for (const take of memoryTakes.values()) for (const chunk of take.chunks) used += chunk.data.byteLength;
        if (used > 0) throw new Error('Download and remove previous session-only takes before recording again. The fallback keeps a bounded 64 MiB audio store.');
      }
      this.maxFrames = maxRecordingFrames(this.context.sampleRate, channels, this.storageMode, durationSeconds);
      this.metadata = {
        id: createTakeId(), label: String(label).slice(0, 160), createdAt: new Date().toISOString(),
        status: 'recording', sampleRate: this.context.sampleRate, channels, inputChannelCount,
        frameCount: 0, duration: 0, rawAvailable: true, processedAvailable: true,
        storageMode: this.storageMode, sourceKind: 'microphone', sourceFormat: 'float32-pcm',
        settingsSnapshot: settingsSnapshot ? structuredClone(settingsSnapshot) : null,
        latencyFrames: Math.max(0, Math.round(Number(latencyFrames) || 0)), latencyCompensated: true,
        captureNote: 'Original is browser-delivered PCM. A sample and capture-mask delay aligns the processed take; pause and stop drain the processing tail before completing.',
        pauses: [],
      };
      this.pendingWrites = Promise.resolve();
      this.writeFailure = null;
      this.interruptionError = null;
      this.requestedStopReason = null;
      this.stopPromise = null;
      this.pausePromise = null;
      this.resumePromise = null;
      this.finalizing = false;
      if (this.db) await writeMetadata(this.db, this.metadata);
      else memoryTakes.set(this.metadata.id, { metadata: { ...this.metadata }, chunks: [] });
      activeTakeIds.add(this.metadata.id);
      this.rawNode = rawNode;
      this.processedNode = processedNode;
      this.node = new AudioWorkletNode(this.context, 'take-capture', {
        numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete',
        processorOptions: { channels, chunkFrames: RECORDING_LIMITS.chunkFrames, maxFrames: this.maxFrames, latencyFrames: this.metadata.latencyFrames },
      });
      this.node.port.onmessage = ({ data }) => this.handleMessage(data);
      this.node.onprocessorerror = () => {
        this.interruptionError = new Error('The recording processor stopped unexpectedly. Recovering saved chunks.');
        this.onError(this.interruptionError);
        void this.finalize({ reason: 'processor-error' });
      };
      this.silentSink = this.context.createGain();
      this.silentSink.gain.value = 0;
      this.node.connect(this.silentSink).connect(this.context.destination);
      rawNode.connect(this.node, 0, 0);
      processedNode.connect(this.node, 0, 1);
      const ready = this.waitFor('ready');
      const buffers = Array.from({ length: RECORDING_LIMITS.poolSize }, () => new ArrayBuffer(RECORDING_LIMITS.chunkFrames * channels * 2 * 4));
      this.node.port.postMessage({ type: 'buffers', buffers }, buffers);
      await ready;
      const started = this.waitFor('started');
      this.node.port.postMessage({ type: 'start' });
      await started;
      this.state = 'recording';
      this.emitStatus(this.storageMode === 'memory' ? 'Session-only recording: download before closing this page.' : 'Recording original and processed audio.');
      return { ...this.metadata };
    } catch (error) {
      this.state = 'idle';
      this.disconnect();
      if (this.metadata) activeTakeIds.delete(this.metadata.id);
      this.onError(error);
      throw error;
    }
  }

  handleMessage(data) {
    const waiter = this.waiters.get(data.type);
    if (waiter) { this.waiters.delete(data.type); waiter.resolve(data); }
    if (data.type === 'chunk') this.queueChunk(data);
    if (data.type === 'stopped') void this.finalize({ ...data, reason: data.reason === 'manual' ? this.requestedStopReason || 'manual' : data.reason });
  }

  queueChunk(data) {
    const chunk = {
      takeId: this.metadata.id, index: data.index, frameStart: data.frameStart,
      frames: data.frames, capacity: data.capacity, channels: data.channels,
      trackCount: data.trackCount, data: data.data,
    };
    this.pendingWrites = this.pendingWrites.then(async () => {
      if (this.writeFailure) return;
      try {
        if (chunk.frameStart !== this.metadata.frameCount) throw new Error('The recorder detected a discontinuity and stopped before joining audio across a missing chunk.');
        const metadata = { ...this.metadata, frameCount: chunk.frameStart + chunk.frames, duration: (chunk.frameStart + chunk.frames) / this.context.sampleRate };
        if (this.db) await writeChunk(this.db, chunk, metadata);
        else {
          // Clone before recycling the worklet's buffer back to the audio thread.
          const savedChunk = { ...chunk, data: chunk.data.slice(0) };
          memoryTakes.get(metadata.id).chunks.push(savedChunk);
          memoryTakes.get(metadata.id).metadata = { ...metadata };
        }
        this.metadata = metadata;
        this.emitStatus();
        if (this.node && !this.finalizing) this.node.port.postMessage({ type: 'recycle', buffer: chunk.data }, [chunk.data]);
      } catch (error) {
        this.writeFailure = new Error(`Recording stopped because audio could not be saved. The committed portion is recoverable. ${error.message}`);
        this.onError(this.writeFailure);
        this.state = 'stopping';
        this.node?.port.postMessage({ type: 'stop' });
      }
    });
  }

  pause() {
    if (this.pausePromise) return this.pausePromise;
    if (this.state !== 'recording') return Promise.resolve();
    this.pausePromise = (async () => {
      const paused = this.waitFor('paused');
      this.node.port.postMessage({ type: 'pause' });
      const acknowledgement = await paused;
      await this.pendingWrites;
      if (acknowledgement.cancelled || this.state !== 'recording') return;
      this.metadata.pauses.push({ frame: this.metadata.frameCount, at: new Date().toISOString() });
      this.state = 'paused';
      this.emitStatus('Paused. Resuming continues the take without adding the paused interval.');
    })().finally(() => { this.pausePromise = null; });
    return this.pausePromise;
  }

  resume() {
    if (this.resumePromise) return this.resumePromise;
    if (this.state !== 'paused') return Promise.resolve();
    this.resumePromise = (async () => {
      if (this.context.state !== 'running') await this.context.resume();
      if (this.state !== 'paused') return;
      const resumed = this.waitFor('resumed');
      this.node.port.postMessage({ type: 'resume' });
      const acknowledgement = await resumed;
      if (acknowledgement.cancelled || this.state !== 'paused') return;
      this.state = 'recording';
      this.emitStatus();
    })().finally(() => { this.resumePromise = null; });
    return this.resumePromise;
  }

  stop({ reason = 'manual' } = {}) {
    if (this.stopPromise) return this.stopPromise;
    if (!this.node || ['idle', 'stopped'].includes(this.state)) return Promise.resolve(this.metadata ? { ...this.metadata } : null);
    this.requestedStopReason = reason;
    this.state = 'stopping';
    this.emitStatus('Finishing pending audio writes…');
    this.stopPromise = new Promise((resolve) => { this.resolveStop = resolve; });
    this.node.port.postMessage({ type: 'stop' });
    // A suspended/destroyed context may not deliver a final worklet message.
    this.stopTimeout = setTimeout(() => {
      if (!this.finalizing) {
        this.interruptionError ??= new Error('The audio context stopped before its last capture buffer could be delivered. Saved chunks were recovered.');
        void this.finalize({ reason: 'context-interrupted' });
      }
    }, 6000);
    return this.stopPromise;
  }

  async finalize({ reason = 'manual' } = {}) {
    if (this.finalizing) return;
    this.finalizing = true;
    clearTimeout(this.stopTimeout);
    if (!this.stopPromise) this.stopPromise = new Promise((resolve) => { this.resolveStop = resolve; });
    this.state = 'stopping';
    // Stop can supersede a pause while its delayed capture mask is draining.
    // Settle those controls without a stale acknowledgement or later timeout.
    for (const type of ['paused', 'resumed']) {
      const waiter = this.waiters.get(type);
      if (waiter) { this.waiters.delete(type); waiter.resolve({ type, cancelled: true }); }
    }
    await this.pendingWrites;
    const interrupted = Boolean(this.writeFailure || this.interruptionError) || !['manual', 'limit'].includes(reason);
    this.metadata = {
      ...this.metadata, status: interrupted ? 'interrupted' : 'complete',
      completedAt: new Date().toISOString(), stopReason: reason,
      message: this.writeFailure?.message ?? this.interruptionError?.message ?? (reason === 'storage-backpressure'
        ? 'Storage could not keep up. Recording stopped with the saved audio intact.'
        : reason === 'limit' ? 'The configured recording duration or capacity limit was reached.'
          : reason === 'manual' ? '' : `Recording was interrupted (${reason}). The saved capture is available.`),
    };
    try {
      if (this.db) await writeMetadata(this.db, this.metadata);
      else memoryTakes.get(this.metadata.id).metadata = { ...this.metadata };
    } catch {
      this.metadata.status = 'interrupted';
      this.metadata.message ||= 'Final metadata could not be saved; the committed chunks are recoverable on reload.';
    }
    activeTakeIds.delete(this.metadata.id);
    this.disconnect();
    this.state = 'stopped';
    this.emitStatus(this.metadata.message || 'Original and processed audio saved.');
    if (reason === 'storage-backpressure') this.onError(new Error(this.metadata.message));
    this.resolveStop?.({ ...this.metadata });
  }

  disconnect() {
    if (this.node) {
      try { this.rawNode?.disconnect(this.node, 0, 0); } catch { /* Already disconnected. */ }
      try { this.processedNode?.disconnect(this.node, 0, 1); } catch { /* Already disconnected. */ }
      this.node.disconnect();
      this.node.port.close();
    }
    this.silentSink?.disconnect();
    this.node = null;
    this.silentSink = null;
  }

  async dispose() {
    await this.stop();
    this.disconnect();
    this.waiters.clear();
  }
}
