import { toDb } from '../analysis.js';

/** Meter channels before any mono summing, so antiphase stereo cannot hide peaks. */
export function measureStereoChannels(left, right = left) {
  const channels = right ? [left, right] : [left];
  let peak = 0;
  let meanPower = 0;
  let clipped = 0;
  let invalidSamples = 0;
  let activeChannels = 0;
  for (const samples of channels) {
    if (!samples?.length) continue;
    let power = 0;
    for (const value of samples) {
      if (!Number.isFinite(value)) { invalidSamples += 1; continue; }
      const amplitude = Math.abs(value);
      peak = Math.max(peak, amplitude);
      power += value * value;
      if (amplitude >= 0.999) clipped += 1;
    }
    meanPower += power / samples.length;
    activeChannels += 1;
  }
  const rms = Math.sqrt(meanPower / Math.max(1, activeChannels));
  return { peak, rms, peakDb: toDb(peak), rmsDb: toDb(rms), clipped, invalidSamples };
}
