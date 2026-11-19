// RBJ/Web Audio-compatible biquad response helpers. Q is physical Q for
// pass/notch/peaking filters; Web Audio shelves use their fixed slope.
export const EQ_MIN_HZ = 20;
export const EQ_MAX_HZ = 20000;
export const EQ_MAX_GAIN = 18;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function frequencyToUnit(frequency, maxFrequency = EQ_MAX_HZ) {
  return Math.log(clamp(frequency, EQ_MIN_HZ, maxFrequency) / EQ_MIN_HZ) /
    Math.log(maxFrequency / EQ_MIN_HZ);
}

export function unitToFrequency(unit, maxFrequency = EQ_MAX_HZ) {
  return EQ_MIN_HZ * (maxFrequency / EQ_MIN_HZ) ** clamp(unit, 0, 1);
}

export function bandHasGain(type) {
  return ['peaking', 'lowshelf', 'highshelf'].includes(type);
}

export function bandHasQ(type) {
  return !['lowshelf', 'highshelf'].includes(type);
}

export function bandCoefficients(band, sampleRate = 48000) {
  if (band.enabled === false) return {b0: 1, b1: 0, b2: 0, a1: 0, a2: 0};
  const frequency = clamp(band.frequency, 1, sampleRate * 0.499999);
  const w = 2 * Math.PI * frequency / sampleRate;
  const c = Math.cos(w), s = Math.sin(w);
  const q = clamp(band.q || 1, 0.1, 20);
  const alpha = s / (2 * q);
  const A = 10 ** ((band.gain || 0) / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (band.type) {
    case 'highpass':
      b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0;
      a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
      break;
    case 'lowpass':
      b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0;
      a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * c; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
      break;
    case 'lowshelf': {
      const beta = Math.sqrt(2 * A) * s;
      b0 = A * ((A + 1) - (A - 1) * c + beta);
      b1 = 2 * A * ((A - 1) - (A + 1) * c);
      b2 = A * ((A + 1) - (A - 1) * c - beta);
      a0 = (A + 1) + (A - 1) * c + beta;
      a1 = -2 * ((A - 1) + (A + 1) * c);
      a2 = (A + 1) + (A - 1) * c - beta;
      break;
    }
    case 'highshelf': {
      const beta = Math.sqrt(2 * A) * s;
      b0 = A * ((A + 1) + (A - 1) * c + beta);
      b1 = -2 * A * ((A - 1) + (A + 1) * c);
      b2 = A * ((A + 1) + (A - 1) * c - beta);
      a0 = (A + 1) - (A - 1) * c + beta;
      a1 = 2 * ((A - 1) - (A + 1) * c);
      a2 = (A + 1) - (A - 1) * c - beta;
      break;
    }
    case 'peaking':
    default:
      b0 = 1 + alpha * A; b1 = -2 * c; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * c; a2 = 1 - alpha / A;
  }
  return {b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0};
}

export function magnitudeAt(coefficients, frequency, sampleRate = 48000) {
  const w = 2 * Math.PI * frequency / sampleRate;
  const c = Math.cos(w), s = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const {b0, b1, b2, a1, a2} = coefficients;
  const nr = b0 + b1 * c + b2 * c2, ni = -b1 * s - b2 * s2;
  const dr = 1 + a1 * c + a2 * c2, di = -a1 * s - a2 * s2;
  return Math.sqrt((nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di));
}

export function equalizerResponse(settings, frequencies, sampleRate = 48000) {
  const response = new Float32Array(frequencies.length).fill(1);
  if (settings.eqEnabled === false) return response;
  for (const band of settings.eq) {
    if (band.enabled === false) continue;
    const coefficients = bandCoefficients(band, sampleRate);
    for (let i = 0; i < frequencies.length; i++) {
      response[i] *= magnitudeAt(coefficients, frequencies[i], sampleRate);
    }
  }
  return response;
}

export function formatFrequency(frequency) {
  return frequency >= 1000 ? `${(frequency / 1000).toFixed(frequency >= 10000 ? 1 : 2).replace(/\.?0+$/, '')}k` :
    `${Math.round(frequency)}`;
}

