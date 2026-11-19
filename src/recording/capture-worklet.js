// One node captures both inputs on the same sample clock. Original samples and
// their capture mask wait for the engine's fixed delay, so original/processed
// pairs stay aligned across start, pause, resume and stop. Output is silent.
// Buffers are recycled only after the main thread acknowledges a completed write.
class TakeCaptureProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.channels = processorOptions.channels;
    this.capacity = processorOptions.chunkFrames;
    this.maxFrames = processorOptions.maxFrames;
    this.pool = [];
    this.current = null;
    this.offset = 0;
    this.frameCount = 0;
    this.chunkIndex = 0;
    this.latencyFrames = Math.max(0, Math.round(processorOptions.latencyFrames || 0));
    this.rawDelay = Array.from({ length: this.channels }, () => new Float32Array(this.latencyFrames));
    this.captureMask = new Uint8Array(this.latencyFrames);
    this.ringPosition = 0;
    this.capturedFrames = 0;
    this.captureEnabled = false;
    this.mode = 'idle';
    this.drainRemaining = 0;
    this.stopReason = 'manual';
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'buffers') {
        for (const buffer of data.buffers) this.pool.push(this.wrapBuffer(buffer));
        this.port.postMessage({ type: 'ready' });
      } else if (data.type === 'recycle') {
        if (!this.stopped) this.pool.push(this.wrapBuffer(data.buffer));
      } else if (data.type === 'start') {
        this.captureEnabled = true;
        this.mode = 'recording';
        this.port.postMessage({ type: 'started' });
      } else if (data.type === 'pause') {
        this.beginDrain('pause');
      } else if (data.type === 'resume' && !this.stopped && this.mode === 'paused') {
        this.captureEnabled = true;
        this.mode = 'recording';
        this.port.postMessage({ type: 'resumed' });
      } else if (data.type === 'stop') {
        this.beginDrain('stop');
      }
    };
  }

  wrapBuffer(buffer) {
    const views = [];
    for (let i = 0; i < this.channels * 2; i += 1) {
      views.push(new Float32Array(buffer, i * this.capacity * 4, this.capacity));
    }
    return { buffer, views };
  }

  flush() {
    if (!this.current || this.offset === 0) return;
    const buffer = this.current.buffer;
    this.port.postMessage({
      type: 'chunk',
      index: this.chunkIndex++,
      frameStart: this.frameCount - this.offset,
      frames: this.offset,
      capacity: this.capacity,
      channels: this.channels,
      trackCount: 2,
      data: buffer,
    }, [buffer]);
    this.current = null;
    this.offset = 0;
  }

  finish(reason) {
    if (this.stopped) return;
    this.captureEnabled = false;
    this.flush();
    this.stopped = true;
    this.mode = 'stopped';
    this.port.postMessage({ type: 'stopped', reason, frameCount: this.frameCount, capturedFrames: this.capturedFrames });
  }

  beginDrain(operation, reason = 'manual') {
    if (this.stopped || this.mode === 'stopping') return;
    this.captureEnabled = false;
    if (operation === 'stop') this.stopReason = reason;
    if (this.mode === 'pausing' && operation === 'stop') {
      this.mode = 'stopping';
      return;
    }
    this.mode = operation === 'pause' ? 'pausing' : 'stopping';
    this.drainRemaining = this.latencyFrames;
    if (this.drainRemaining === 0) this.completeDrain();
  }

  completeDrain() {
    if (this.mode === 'pausing') {
      this.flush();
      this.mode = 'paused';
      this.port.postMessage({ type: 'paused', frameCount: this.frameCount });
    } else if (this.mode === 'stopping') this.finish(this.stopReason);
  }

  process(inputs, outputs) {
    // Inspect the current quantum length; do not assume a fixed 128-frame block.
    const quantumFrames = outputs[0]?.[0]?.length ?? inputs[0]?.[0]?.length ?? 0;
    if (this.stopped) return true;
    for (let frame = 0; frame < quantumFrames; frame += 1) {
      if (this.captureEnabled && this.capturedFrames >= this.maxFrames) {
        this.beginDrain('stop', 'limit');
        if (this.stopped) break;
      }
      const captureNow = this.captureEnabled;
      const emitPair = this.latencyFrames ? this.captureMask[this.ringPosition] === 1 : captureNow;
      if (captureNow) this.capturedFrames += 1;
      if (emitPair && !this.current) {
        this.current = this.pool.pop();
        if (!this.current) {
          // Never overwrite audio that is still waiting to be saved.
          this.finish('storage-backpressure');
          break;
        }
      }
      for (let channel = 0; channel < this.channels; channel += 1) {
        const original = inputs[0]?.[channel]?.[frame] ?? 0;
        const alignedOriginal = this.latencyFrames ? this.rawDelay[channel][this.ringPosition] : original;
        if (this.latencyFrames) this.rawDelay[channel][this.ringPosition] = original;
        if (emitPair) {
          this.current.views[channel][this.offset] = alignedOriginal;
          this.current.views[this.channels + channel][this.offset] = inputs[1]?.[channel]?.[frame] ?? 0;
        }
      }
      if (this.latencyFrames) {
        this.captureMask[this.ringPosition] = captureNow ? 1 : 0;
        this.ringPosition = (this.ringPosition + 1) % this.latencyFrames;
      }
      if (emitPair) {
        this.offset += 1;
        this.frameCount += 1;
        if (this.offset === this.capacity) this.flush();
      }
      if ((this.mode === 'pausing' || this.mode === 'stopping') && this.drainRemaining > 0) {
        this.drainRemaining -= 1;
        if (this.drainRemaining === 0) {
          this.completeDrain();
          if (this.stopped) break;
        }
      }
    }
    return true;
  }
}

registerProcessor('take-capture', TakeCaptureProcessor);
