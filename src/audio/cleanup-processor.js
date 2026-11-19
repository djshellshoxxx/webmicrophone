/**
 * Local, linked-stereo spectral noise reduction.
 * A periodic sqrt-Hann STFT (1024 / 256) has a fixed 1024-sample delay.
 * Noise powers use |FFT(windowed input)|² / FFT-size², averaged over channels.
 * The original is never modified. A profile is learned only on an explicit request.
 */

export class Radix2FFT {
  constructor(size) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two.');
    this.size = size;
    this.reverse = new Uint16Array(size);
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i += 1) {
      let n = i;
      let r = 0;
      for (let b = 0; b < bits; b += 1) { r = (r << 1) | (n & 1); n >>>= 1; }
      this.reverse[i] = r;
    }
    for (let i = 0; i < size / 2; i += 1) {
      this.cos[i] = Math.cos(2 * Math.PI * i / size);
      this.sin[i] = Math.sin(2 * Math.PI * i / size);
    }
  }

  transform(real, imaginary, inverse = false) {
    const n = this.size;
    for (let i = 0; i < n; i += 1) {
      const j = this.reverse[i];
      if (j > i) {
        let value = real[i]; real[i] = real[j]; real[j] = value;
        value = imaginary[i]; imaginary[i] = imaginary[j]; imaginary[j] = value;
      }
    }
    for (let length = 2; length <= n; length *= 2) {
      const half = length / 2;
      const step = n / length;
      for (let start = 0; start < n; start += length) {
        for (let j = 0; j < half; j += 1) {
          const index = j * step;
          const wr = this.cos[index];
          const wi = this.sin[index] * (inverse ? 1 : -1);
          const even = start + j;
          const odd = even + half;
          const tr = wr * real[odd] - wi * imaginary[odd];
          const ti = wr * imaginary[odd] + wi * real[odd];
          real[odd] = real[even] - tr;
          imaginary[odd] = imaginary[even] - ti;
          real[even] += tr;
          imaginary[even] += ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i += 1) { real[i] /= n; imaginary[i] /= n; }
    }
  }
}

export function validateNoiseProfile(profile, sampleRate, fftSize = 1024) {
  if (profile === null || profile === undefined) return null;
  if (profile.version !== 1 || profile.sampleRate !== sampleRate || profile.fftSize !== fftSize
    || !Array.isArray(profile.power) || profile.power.length !== fftSize / 2 + 1
    || profile.power.some((value) => !Number.isFinite(value) || value < 0 || value > 1e8)) {
    throw new Error('Noise profile does not match this audio engine. Learn a new profile.');
  }
  return { version: 1, sampleRate, fftSize, power: profile.power.slice() };
}

export class SpectralDenoiser {
  constructor({ sampleRate = 48000, channels = 2, onProfile = () => {} } = {}) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.size = 1024;
    this.hop = 256;
    this.latencySamples = this.size;
    this.ringSize = this.size * 4;
    this.fft = new Radix2FFT(this.size);
    this.window = Float64Array.from({ length: this.size }, (_, i) => Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.size)));
    this.input = Array.from({ length: channels }, () => new Float64Array(this.size));
    this.output = Array.from({ length: channels }, () => new Float64Array(this.ringSize));
    this.real = Array.from({ length: channels }, () => new Float64Array(this.size));
    this.imaginary = Array.from({ length: channels }, () => new Float64Array(this.size));
    this.power = new Float64Array(this.size / 2 + 1);
    this.previousPower = new Float64Array(this.power.length);
    this.targetGains = new Float64Array(this.power.length).fill(1);
    this.gains = new Float64Array(this.power.length).fill(1);
    this.learnedPower = new Float64Array(this.power.length);
    this.learnRemaining = 0;
    this.learnTotal = 0;
    this.profile = null;
    this.profileScale = 1;
    this.strength = 0;
    this.inputPosition = 0;
    this.outputPosition = 0;
    this.hopPosition = 0;
    this.onProfile = onProfile;
  }

  setProfile(profile) { this.profile = validateNoiseProfile(profile, this.sampleRate, this.size); }
  setStrength(strength) { this.strength = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0; }
  setProfileScale(scale) { this.profileScale = Number.isFinite(scale) && scale > 0 ? scale : 1; }
  cancelLearning() { this.learnRemaining = 0; }

  learn(seconds = 2) {
    if (!Number.isFinite(seconds)) throw new Error('Noise sample duration must be finite.');
    this.learnTotal = Math.ceil(Math.max(0.25, Math.min(10, seconds)) * this.sampleRate / this.hop);
    this.learnRemaining = this.learnTotal;
    this.learnedPower.fill(0);
  }

  process(inputs, outputs) {
    const length = outputs[0]?.length ?? 0;
    for (let i = 0; i < length; i += 1) {
      for (let channel = 0; channel < this.channels; channel += 1) {
        const input = inputs[channel] ?? inputs[0];
        const value = input?.[i] ?? 0;
        this.input[channel][this.inputPosition] = Number.isFinite(value) ? value : 0;
        if (outputs[channel]) outputs[channel][i] = this.output[channel][this.outputPosition];
        this.output[channel][this.outputPosition] = 0;
      }
      this.inputPosition = (this.inputPosition + 1) % this.size;
      this.hopPosition += 1;
      if (this.hopPosition === this.hop) {
        this.hopPosition = 0;
        this.processFrame();
      }
      this.outputPosition = (this.outputPosition + 1) % this.ringSize;
    }
  }

  processFrame() {
    const n = this.size;
    this.power.fill(0);
    for (let channel = 0; channel < this.channels; channel += 1) {
      const real = this.real[channel];
      const imaginary = this.imaginary[channel];
      for (let i = 0; i < n; i += 1) {
        real[i] = this.input[channel][(this.inputPosition + i) % n] * this.window[i];
        imaginary[i] = 0;
      }
      this.fft.transform(real, imaginary);
      for (let k = 0; k < this.power.length; k += 1) {
        this.power[k] += (real[k] * real[k] + imaginary[k] * imaginary[k]) / (n * n * this.channels);
      }
    }

    if (this.learnRemaining > 0) {
      for (let k = 0; k < this.power.length; k += 1) this.learnedPower[k] += this.power[k] / (this.learnTotal * this.profileScale);
      this.learnRemaining -= 1;
      if (this.learnRemaining === 0) {
        this.profile = { version: 1, sampleRate: this.sampleRate, fftSize: n, power: Array.from(this.learnedPower) };
        this.onProfile(this.profile);
      }
    }

    const reduce = this.strength > 0 && this.profile && this.learnRemaining === 0;
    if (reduce) {
      const floor = 10 ** (-24 * this.strength / 20);
      for (let k = 0; k < this.power.length; k += 1) {
        const power = this.power[k];
        const noise = this.profile.power[k] * this.profileScale;
        let gain = Math.sqrt(Math.max(0, power - noise * (0.3 + 1.7 * this.strength)) / Math.max(1e-20, power));
        // Sudden energy increases may be wanted impacts or consonants: preserve them conservatively.
        if (power > this.previousPower[k] * 5 && power > noise * 3) gain = Math.max(gain, 0.75);
        this.targetGains[k] = Math.max(floor, Math.min(1, gain));
      }
      for (let k = 0; k < this.power.length; k += 1) {
        const left = this.targetGains[Math.max(0, k - 1)];
        const right = this.targetGains[Math.min(this.power.length - 1, k + 1)];
        const target = (left + 2 * this.targetGains[k] + right) / 4;
        this.gains[k] += (target - this.gains[k]) * (target > this.gains[k] ? 0.65 : 0.2);
      }
    } else {
      this.gains.fill(1);
    }
    this.previousPower.set(this.power);

    const outputStart = (this.outputPosition + 1) % this.ringSize;
    for (let channel = 0; channel < this.channels; channel += 1) {
      const real = this.real[channel];
      const imaginary = this.imaginary[channel];
      for (let k = 0; k < n; k += 1) {
        const gain = this.gains[k <= n / 2 ? k : n - k];
        real[k] *= gain;
        imaginary[k] *= gain;
      }
      this.fft.transform(real, imaginary, true);
      for (let i = 0; i < n; i += 1) {
        // Four overlapping periodic Hann windows sum to two.
        this.output[channel][(outputStart + i) % this.ringSize] += real[i] * this.window[i] / 2;
      }
    }
  }
}

const WorkletBase = globalThis.AudioWorkletProcessor ?? class {};

class CleanupProcessor extends WorkletBase {
  constructor(options) {
    super();
    this.stopped = false;
    this.learnRequestId = null;
    this.processor = new SpectralDenoiser({
      sampleRate: globalThis.sampleRate,
      channels: 2,
      onProfile: (profile) => this.port.postMessage({ type: 'profile', profile, requestId: this.learnRequestId }),
    });
    this.processor.setStrength(options.processorOptions?.denoise ?? 0);
    this.processor.setProfileScale(options.processorOptions?.profileScale ?? 1);
    this.processor.setProfile(options.processorOptions?.noiseProfile ?? null);
    this.port.onmessage = ({ data }) => {
      try {
        if (data.type === 'settings') { this.processor.setStrength(data.denoise); this.processor.setProfileScale(data.profileScale); }
        if (data.type === 'profile') this.processor.setProfile(data.profile);
        if (data.type === 'learn') { this.learnRequestId = data.requestId; this.processor.learn(data.seconds); }
        if (data.type === 'cancel-learn') { this.learnRequestId = null; this.processor.cancelLearning(); }
        if (data.type === 'dispose') this.stopped = true;
      } catch (error) {
        this.port.postMessage({ type: 'error', message: error.message, requestId: data.requestId });
      }
    };
    this.port.postMessage({ type: 'ready' });
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    this.processor.process(inputs[0] ?? [], outputs[0] ?? []);
    return true;
  }
}

if (globalThis.registerProcessor) globalThis.registerProcessor('cdl-spectral-cleanup', CleanupProcessor);
