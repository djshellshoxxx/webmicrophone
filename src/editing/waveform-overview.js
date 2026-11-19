// Cache extrema rather than sparsely sampling: short impacts must stay visible.
export function waveformOverview(channels, maximumBins = 2048) {
  const length = channels[0]?.length || 0;
  const bins = Math.min(maximumBins, length);
  const minimum = new Float32Array(bins), maximum = new Float32Array(bins);
  minimum.fill(Infinity); maximum.fill(-Infinity);
  for (const samples of channels) {
    for (let bin = 0; bin < bins; bin++) {
      const start = Math.floor(bin * length / bins), end = Math.floor((bin + 1) * length / bins);
      let low = minimum[bin], high = maximum[bin];
      for (let frame = start; frame < end; frame++) {
        const value = Number.isFinite(samples[frame]) ? samples[frame] : 0;
        if (value < low) low = value;
        if (value > high) high = value;
      }
      minimum[bin] = low; maximum[bin] = high;
    }
  }
  return {minimum, maximum};
}
