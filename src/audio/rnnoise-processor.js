/**
 * A synchronous AudioWorklet adapter for the pinned RNNoise WASM asset.
 * Asset: @sapphi-red/web-noise-suppressor 0.4.1 (MIT), built by
 * @shiguredo/rnnoise-wasm 2022.2.0 (Apache-2.0), RNNoise fork 2022.1.0 (BSD-3).
 * See docs/specs third-party notices. No package worklet code is copied here.
 *
 * 480 samples of RNNoise lookahead + 480 samples of frame adaptation = 960.
 * Disabled speech uses the same fixed delay, keeping wet/dry paths aligned.
 */

export const RNNOISE_LATENCY_SAMPLES = 960;

export class RnnoiseFrameProcessor {
  constructor(module, { channels = 2, speech = false } = {}) {
    this.channels = channels;
    this.frameSize = 480;
    this.phase = 0;
    this.delayPosition = 0;
    this.available = Boolean(module);
    this.mix = speech && this.available ? 1 : 0;
    this.targetMix = this.mix;
    this.destroyed = false;
    this.inputFrames = Array.from({ length: channels }, () => new Float32Array(480));
    this.outputFrames = Array.from({ length: channels }, () => new Float32Array(480));
    this.delay = Array.from({ length: channels }, () => new Float32Array(RNNOISE_LATENCY_SAMPLES));
    this.states = [];
    this.pointers = [];
    if (module) {
      let api;
      let heapBytes;
      const instance = new WebAssembly.Instance(module, {
        env: {
          emscripten_memcpy_big: (destination, source, count) => {
            heapBytes.copyWithin(destination, source, source + count);
            return destination;
          },
          // The pinned module has 16 MiB: two states need only a small fraction.
          // A bounded allocation failure is preferable to a real-time heap grow.
          emscripten_resize_heap: () => 0,
          __assert_fail: () => { throw new Error('RNNoise reported an internal assertion.'); },
        },
      });
      api = instance.exports;
      heapBytes = new Uint8Array(api.memory.buffer);
      api.emscripten_stack_init();
      api.__wasm_call_ctors();
      if (api.rnnoise_get_frame_size() !== this.frameSize) throw new Error('Unsupported RNNoise frame size.');
      this.api = api;
      for (let channel = 0; channel < channels; channel += 1) {
        const state = api.rnnoise_create(0);
        const pointer = api.malloc(this.frameSize * 4);
        if (!state || !pointer) throw new Error('RNNoise could not allocate a channel.');
        this.states.push(state);
        this.pointers.push(pointer);
      }
      this.heapFrames = this.pointers.map((pointer) => new Float32Array(api.memory.buffer, pointer, this.frameSize));
    }
  }

  setSpeech(enabled) { this.targetMix = enabled && this.available ? 1 : 0; }

  process(inputs, outputs) {
    const length = outputs[0]?.length ?? 0;
    for (let sample = 0; sample < length; sample += 1) {
      this.mix += Math.max(-1 / 1440, Math.min(1 / 1440, this.targetMix - this.mix));
      for (let channel = 0; channel < this.channels; channel += 1) {
        const input = inputs[channel] ?? inputs[0];
        const inputValue = input?.[sample] ?? 0;
        const value = Number.isFinite(inputValue) ? inputValue : 0;
        const dry = this.delay[channel][this.delayPosition];
        this.delay[channel][this.delayPosition] = value;
        this.inputFrames[channel][this.phase] = value * 32767;
        const clean = this.outputFrames[channel][this.phase];
        if (outputs[channel]) outputs[channel][sample] = dry * (1 - this.mix) + clean * this.mix;
      }
      this.delayPosition = (this.delayPosition + 1) % RNNOISE_LATENCY_SAMPLES;
      this.phase += 1;
      if (this.phase === this.frameSize) {
        this.phase = 0;
        if (this.available) {
          // Keep the small model warm even in bypass so enabling speech does not
          // start a stale/reinitialized recurrent state in the middle of a phrase.
          for (let channel = 0; channel < this.channels; channel += 1) {
            const heap = this.heapFrames[channel];
            heap.set(this.inputFrames[channel]);
            this.api.rnnoise_process_frame(this.states[channel], this.pointers[channel], this.pointers[channel]);
            for (let i = 0; i < this.frameSize; i += 1) {
              const clean = heap[i] / 32767;
              this.outputFrames[channel][i] = Number.isFinite(clean) ? clean : 0;
            }
          }
        }
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const state of this.states) this.api.rnnoise_destroy(state);
    for (const pointer of this.pointers) this.api.free(pointer);
    this.states.length = 0;
    this.pointers.length = 0;
  }
}

const WorkletBase = globalThis.AudioWorkletProcessor ?? class {};

class RnnoiseProcessor extends WorkletBase {
  constructor(options) {
    super();
    this.stopped = false;
    const { wasmModule, speech = false } = options.processorOptions ?? {};
    this.processor = new RnnoiseFrameProcessor(wasmModule, { speech });
    this.port.onmessage = ({ data }) => {
      if (data.type === 'settings') this.processor.setSpeech(data.speech);
      if (data.type === 'dispose') { this.stopped = true; this.processor.destroy(); }
    };
    this.port.postMessage({ type: 'ready', speechAvailable: this.processor.available });
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    this.processor.process(inputs[0] ?? [], outputs[0] ?? []);
    return true;
  }
}

if (globalThis.registerProcessor) globalThis.registerProcessor('cdl-rnnoise', RnnoiseProcessor);
