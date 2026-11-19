export function toDb(value) { return value > 1e-9 ? 20 * Math.log10(value) : -180; }
export function measure(samples) {
  let power = 0, peak = 0, clipped = 0;
  for (const value of samples) {
    const amplitude = Math.abs(value);
    peak = Math.max(peak, amplitude);
    power += value * value;
    if (amplitude >= 0.999) clipped++;
  }
  const rms = Math.sqrt(power / Math.max(1, samples.length));
  return {peak, rms, peakDb:toDb(peak), rmsDb:toDb(rms), clipped};
}
export function correlation(left, right) {
  let lr = 0, ll = 0, rr = 0;
  const length = Math.min(left.length, right.length);
  for (let i=0;i<length;i++) { lr += left[i]*right[i]; ll += left[i]*left[i]; rr += right[i]*right[i]; }
  return ll*rr > 1e-12 ? Math.max(-1, Math.min(1, lr/Math.sqrt(ll*rr))) : null;
}

// YIN-style difference estimator for monophonic sustained input.
export function detectPitch(samples, sampleRate, reference=440) {
  const {rms} = measure(samples);
  if (rms < 0.002) return null;
  const maxLag = Math.min(Math.floor(sampleRate/55), Math.floor(samples.length/2));
  const minLag = Math.max(2, Math.floor(sampleRate/1500));
  const length = Math.min(samples.length-maxLag, 2048);
  const difference = new Float64Array(maxLag+1);
  let running=0;
  for (let lag=1;lag<=maxLag;lag++) {
    let sum=0;
    for (let i=0;i<length;i+=2) { const d=samples[i]-samples[i+lag]; sum+=d*d; }
    running+=sum;
    difference[lag]=running>0 ? sum*lag/running : 1;
  }
  let lag=-1;
  for (let i=minLag;i<maxLag;i++) {
    if (difference[i] < 0.15) {
      while (i+1<maxLag && difference[i+1]<difference[i]) i++;
      lag=i; break;
    }
  }
  if (lag < 0 || difference[lag] > 0.25) return null;
  const prev=difference[lag-1], center=difference[lag], next=difference[Math.min(maxLag,lag+1)];
  const divisor=2*(2*center-prev-next);
  const precise=lag+(Math.abs(divisor)>1e-12 ? (next-prev)/divisor : 0);
  const frequency=sampleRate/precise;
  const midi=69+12*Math.log2(frequency/reference);
  const nearest=Math.round(midi);
  const names=['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
  return {frequency, note:names[((nearest%12)+12)%12]+(Math.floor(nearest/12)-1), cents:(midi-nearest)*100, confidence:1-center};
}

export function formatTime(seconds) {
  const value=Math.max(0,seconds||0);
  return Math.floor(value/60).toString().padStart(2,'0')+':'+Math.floor(value%60).toString().padStart(2,'0');
}
export function formatDb(value) { return value < -120 || !Number.isFinite(value) ? '−∞' : value.toFixed(1); }
