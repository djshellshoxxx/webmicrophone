/** Stereo-linked gate/compressor and a separate, explicit sample-peak limiter. */

const bounded = (value, fallback, low, high) => Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;

export class LinkedDynamics {
  constructor(sampleRate = 48000, settings = {}) {
    this.sampleRate = sampleRate;
    this.detector = 0;
    this.gateEnvelope = 0;
    this.gateGain = 1;
    this.compressionGain = 1;
    this.gateOpen = true;
    this.hold = 0;
    this.setSettings(settings);
  }

  setSettings(settings) {
    this.gateEnabled = Boolean(settings.gateEnabled);
    this.gateThreshold = 10 ** (bounded(settings.gateThresholdDb, -55, -90, 0) / 20);
    this.gateRelease = Math.exp(-1 / (this.sampleRate * bounded(settings.gateReleaseMs, 150, 10, 3000) / 1000));
    this.gateAttack = Math.exp(-1 / (this.sampleRate * 0.004));
    this.gateDetectorRelease = Math.exp(-1 / (this.sampleRate * 0.03));
    this.compressorEnabled = Boolean(settings.compressorEnabled);
    this.threshold = bounded(settings.compressorThresholdDb, -24, -80, 0);
    this.ratio = bounded(settings.compressorRatio, 3, 1, 20);
    this.attack = Math.exp(-1 / (this.sampleRate * bounded(settings.compressorAttackMs, 10, 0.1, 200) / 1000));
    this.release = Math.exp(-1 / (this.sampleRate * bounded(settings.compressorReleaseMs, 150, 10, 3000) / 1000));
  }

  process(inputs, outputs) {
    const left = inputs[0];
    const right = inputs[1] ?? left;
    const length = outputs[0]?.length ?? 0;
    for (let i = 0; i < length; i += 1) {
      const l = Number.isFinite(left?.[i]) ? left[i] : 0;
      const r = Number.isFinite(right?.[i]) ? right[i] : 0;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      const gateCoefficient = peak > this.gateEnvelope ? this.gateAttack : this.gateDetectorRelease;
      this.gateEnvelope = gateCoefficient * this.gateEnvelope + (1 - gateCoefficient) * peak;
      if (this.gateEnvelope >= this.gateThreshold) { this.gateOpen = true; this.hold = Math.round(this.sampleRate * 0.05); }
      else if (this.hold > 0) this.hold -= 1;
      else if (this.gateEnvelope < this.gateThreshold * 0.708) this.gateOpen = false;
      const desiredGate = !this.gateEnabled || this.gateOpen ? 1 : 0;
      const gateSmoothing = desiredGate > this.gateGain ? this.gateAttack : this.gateRelease;
      this.gateGain = gateSmoothing * this.gateGain + (1 - gateSmoothing) * desiredGate;

      const coefficient = peak > this.detector ? this.attack : this.release;
      this.detector = coefficient * this.detector + (1 - coefficient) * peak;
      const levelDb = 20 * Math.log10(Math.max(1e-12, this.detector));
      const over = levelDb - this.threshold;
      const knee = 6;
      let gainDb = 0;
      if (this.compressorEnabled) {
        if (over >= knee / 2) gainDb = (1 / this.ratio - 1) * over;
        else if (over > -knee / 2) gainDb = (1 / this.ratio - 1) * (over + knee / 2) ** 2 / (2 * knee);
      }
      const desiredCompression = 10 ** (gainDb / 20);
      this.compressionGain += (desiredCompression - this.compressionGain) * 0.02;
      const gain = this.gateGain * this.compressionGain;
      if (outputs[0]) outputs[0][i] = l * gain;
      if (outputs[1]) outputs[1][i] = r * gain;
    }
  }
}

export function limitSample(value, enabled = true) {
  if (!Number.isFinite(value)) return 0;
  return enabled ? Math.max(-0.98, Math.min(0.98, value)) : value;
}

const WorkletBase = globalThis.AudioWorkletProcessor ?? class {};

class DynamicsProcessor extends WorkletBase {
  constructor(options) {
    super();
    this.stopped = false;
    this.role = options.processorOptions?.role ?? 'dynamics';
    this.settings = options.processorOptions?.settings ?? {};
    this.processor = new LinkedDynamics(globalThis.sampleRate, this.settings);
    this.port.onmessage = ({ data }) => {
      if (data.type === 'settings') { this.settings = data.settings; this.processor.setSettings(data.settings); }
      if (data.type === 'dispose') this.stopped = true;
    };
    this.port.postMessage({ type: 'ready' });
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    if (this.role === 'limiter') {
      for (let channel = 0; channel < output.length; channel += 1) {
        const source = input[channel] ?? input[0];
        for (let i = 0; i < output[channel].length; i += 1) output[channel][i] = limitSample(source?.[i] ?? 0, this.settings.limiterEnabled);
      }
    } else this.processor.process(input, output);
    return true;
  }
}

if (globalThis.registerProcessor) globalThis.registerProcessor('cdl-dynamics', DynamicsProcessor);
