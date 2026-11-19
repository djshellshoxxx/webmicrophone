import { getTimePitchPlan, throwIfTimePitchAborted } from './time-pitch-settings.js';
export { TIME_PITCH_LIMITS, normalizeTimePitchSettings, getTransformedFrameCount, getTimePitchPlan } from './time-pitch-settings.js';

/** Local worker transform shared by audition and export. Cancelling terminates
 * the worker, so a previous render cannot continue consuming CPU or resolve a
 * stale result. The preserved input buffer is never transferred or modified. */
export async function transformAudioBuffer(buffer, settings = {}, { signal, onProgress } = {}) {
  throwIfTimePitchAborted(signal);
  const plan = getTimePitchPlan(buffer, settings);
  if (plan.identity) { onProgress?.({ phase: 'complete', progress: 1 }); return buffer; }
  if (typeof Worker !== 'function') throw new Error('This browser does not support the worker required for time and pitch editing.');
  const channels = [];
  let lastYield = performance.now();
  for (let channel = 0; channel < plan.channelCount; channel += 1) {
    const copy = new Float32Array(plan.inputFrames);
    channels.push(copy.buffer);
    for (let offset = 0; offset < plan.inputFrames; offset += 65536) {
      throwIfTimePitchAborted(signal);
      const block = copy.subarray(offset, Math.min(plan.inputFrames, offset + 65536));
      buffer.copyFromChannel(block, channel, offset);
      if (performance.now() - lastYield > 12) {
        onProgress?.({ phase: 'copying', progress: 0.05 * (channel + offset / plan.inputFrames) / plan.channelCount });
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
  }
  throwIfTimePitchAborted(signal);
  return new Promise((resolve, reject) => {
    let worker;
    let finished = false;
    const cleanup = () => { finished = true; signal?.removeEventListener('abort', abort); worker?.terminate(); };
    const fail = (error) => { if (finished) return; cleanup(); reject(error); };
    const abort = () => fail(new DOMException('Audio preparation cancelled.', 'AbortError'));
    try {
      worker = new Worker(new URL('./time-pitch-worker.js', import.meta.url), { type: 'module' });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      worker.onerror = (event) => fail(new Error(event.message || 'Time and pitch processing could not load.'));
      worker.onmessageerror = () => fail(new Error('Time and pitch processing returned unreadable audio.'));
      worker.onmessage = ({ data }) => {
        if (finished) return;
        if (data.type === 'progress') {
          onProgress?.({ phase: data.phase, progress: 0.05 + 0.94 * data.progress });
          return;
        }
        if (data.type === 'error') {
          const error = new Error(data.message); error.name = data.name;
          fail(error); return;
        }
        if (data.type === 'complete') {
          try {
            throwIfTimePitchAborted(signal);
            const result = new AudioBuffer({ numberOfChannels: plan.channelCount, length: plan.outputFrames, sampleRate: plan.sampleRate });
            for (let channel = 0; channel < plan.channelCount; channel += 1) result.copyToChannel(new Float32Array(data.channels[channel]), channel);
            cleanup(); onProgress?.({ phase: 'complete', progress: 1 }); resolve(result);
          } catch (error) { fail(error); }
        }
      };
      worker.postMessage({ channels, sampleRate: plan.sampleRate, settings }, channels);
    } catch (error) { fail(error); }
  });
}
