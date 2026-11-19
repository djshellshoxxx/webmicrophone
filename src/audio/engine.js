import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import { validateSettings } from '../state.js';

export const PROCESSING_SAMPLE_RATE = 48000;
export const PROCESSING_LATENCY_SAMPLES = 1984;

const moduleLoads = new WeakMap();
let rnnoiseModulePromise;
const dbGain = (db) => 10 ** (db / 20);
const copyProfile = (profile) => profile ? { ...profile, power: profile.power.slice() } : null;
const dynamicsSettings = (settings) => ({
  gateEnabled: settings.gateEnabled, gateThresholdDb: settings.gateThresholdDb, gateReleaseMs: settings.gateReleaseMs,
  compressorEnabled: settings.compressorEnabled, compressorThresholdDb: settings.compressorThresholdDb,
  compressorRatio: settings.compressorRatio, compressorAttackMs: settings.compressorAttackMs,
  compressorReleaseMs: settings.compressorReleaseMs,
});
const sameProfile = (left, right) => left === right || (left && right
  && left.sampleRate === right.sampleRate && left.fftSize === right.fftSize
  && left.power.length === right.power.length && left.power.every((value, index) => value === right.power[index]));

async function loadWorklets(context) {
  if (!moduleLoads.has(context)) {
    const promise = Promise.all([
      context.audioWorklet.addModule(new URL('./cleanup-processor.js', import.meta.url).href),
      context.audioWorklet.addModule(new URL('./rnnoise-processor.js', import.meta.url).href),
      context.audioWorklet.addModule(new URL('./dynamics-processor.js', import.meta.url).href),
    ]).catch((error) => { moduleLoads.delete(context); throw error; });
    moduleLoads.set(context, promise);
  }
  await moduleLoads.get(context);
}

async function loadRnnoiseModule() {
  if (!rnnoiseModulePromise) {
    rnnoiseModulePromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(rnnoiseWasmUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`Local speech engine could not load (${response.status}).`);
        return await WebAssembly.compile(await response.arrayBuffer());
      } finally { clearTimeout(timeout); }
    })().catch((error) => { rnnoiseModulePromise = undefined; throw error; });
  }
  return rnnoiseModulePromise;
}

/**
 * The same processing graph is used for capture, file previews and offline rendering.
 * All graph-wide buffering is a fixed 1984 samples at 48 kHz. Channel delay and
 * all-pass phase are intentional effects, not additional global compensation.
 * Offline callers append a tail, then trim latencySamples from the rendered start.
 */
export async function createProcessingGraph(context, settings, { offline = false, onError = () => {} } = {}) {
  if (context.sampleRate !== PROCESSING_SAMPLE_RATE) throw new Error('The processing context must run at 48,000 Hz. Resample on import/export.');
  if (!context.audioWorklet) throw new Error('This browser does not provide AudioWorklet processing.');
  let current = validateSettings(settings);
  await loadWorklets(context);
  let wasmModule = null;
  let speechLoadError = null;
  try { wasmModule = await loadRnnoiseModule(); }
  catch (error) {
    speechLoadError = error;
    if (current.speech) onError(new Error(`${error.message} Speech enhancement is unavailable; other processing still works.`));
  }

  let disposed = false;
  let initializing = true;
  let profile = copyProfile(current.noiseProfile);
  let learningRequest = null;
  let requestCounter = 0;
  const nodes = [];
  const worklets = [];
  const remember = (node) => { nodes.push(node); return node; };
  const gain = (value = 1) => { const node = remember(context.createGain()); node.gain.value = value; return node; };
  const delay = (seconds = 0, maximum = 1) => { const node = remember(context.createDelay(maximum)); node.delayTime.value = seconds; return node; };
  const analyser = () => {
    const node = remember(context.createAnalyser());
    node.fftSize = 2048;
    node.minDecibels = -110;
    node.maxDecibels = -5;
    node.smoothingTimeConstant = 0.65;
    return node;
  };
  const setParam = (parameter, value) => {
    const time = context.currentTime;
    parameter.cancelScheduledValues(time);
    if (initializing || offline) parameter.setValueAtTime(value, time);
    else parameter.setTargetAtTime(value, time, 0.012);
  };
  const report = (error) => { if (!disposed) onError(error instanceof Error ? error : new Error(String(error))); };
  const makeWorklet = (name, processorOptions) => {
    const node = remember(new AudioWorkletNode(context, name, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers', processorOptions,
    }));
    worklets.push(node);
    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error(`${name} did not initialize.`)); }
      }, 12000);
      node.onprocessorerror = () => {
        const error = new Error(`${name} stopped processing. Restart the audio input.`);
        if (!settled) { settled = true; clearTimeout(timeout); reject(error); }
        report(error);
      };
      node.port.onmessage = ({ data }) => {
        if (data.type === 'ready' && !settled) { settled = true; clearTimeout(timeout); resolve(data); }
        else if (data.type === 'profile') {
          profile = copyProfile(data.profile);
          if (learningRequest?.id === data.requestId) {
            clearTimeout(learningRequest.timeout);
            learningRequest.resolve(copyProfile(profile));
            learningRequest = null;
          }
        } else if (data.type === 'error') {
          const error = new Error(data.message);
          if (learningRequest?.id === data.requestId) {
            clearTimeout(learningRequest.timeout);
            learningRequest.reject(error);
            learningRequest = null;
          }
          report(error);
        }
      };
    });
    return { node, ready };
  };

  const input = gain();
  const inputAnalyser = analyser();
  const originalOutput = gain();
  originalOutput.channelCount = 2;
  originalOutput.channelCountMode = 'explicit';
  originalOutput.channelInterpretation = 'speakers';
  input.connect(originalOutput);
  const inputSplitter = remember(context.createChannelSplitter(2));
  const inputLeftAnalyser = analyser();
  const inputRightAnalyser = analyser();
  originalOutput.connect(inputSplitter);
  inputSplitter.connect(inputAnalyser, 0);
  inputSplitter.connect(inputLeftAnalyser, 0);
  inputSplitter.connect(inputRightAnalyser, 1);
  const inputTrim = gain();
  input.connect(inputTrim);

  const cleanup = makeWorklet('cdl-spectral-cleanup', {
    denoise: current.denoise, noiseProfile: current.noiseProfile, profileScale: dbGain(current.inputGainDb) ** 2,
  });
  const speech = makeWorklet('cdl-rnnoise', { wasmModule, speech: current.speech });
  const dynamics = makeWorklet('cdl-dynamics', { role: 'dynamics', settings: dynamicsSettings(current) });
  const limiter = makeWorklet('cdl-dynamics', { role: 'limiter', settings: { limiterEnabled: current.limiterEnabled } });
  inputTrim.connect(cleanup.node);
  cleanup.node.connect(speech.node);

  const splitter = remember(context.createChannelSplitter(2));
  speech.node.connect(splitter);
  const polarity = [gain(), gain()];
  const channelDelays = [delay(0, 0.1), delay(0, 0.1)];
  for (let channel = 0; channel < 2; channel += 1) {
    splitter.connect(polarity[channel], channel);
    polarity[channel].connect(channelDelays[channel]);
  }
  const allpass = remember(context.createBiquadFilter());
  allpass.type = 'allpass';
  const phaseDry = gain();
  const phaseWet = gain(0);
  const rightPhase = gain();
  channelDelays[1].connect(phaseDry).connect(rightPhase);
  channelDelays[1].connect(allpass).connect(phaseWet).connect(rightPhase);

  const merger = remember(context.createChannelMerger(2));
  const matrix = [gain(), gain(0), gain(0), gain()];
  channelDelays[0].connect(matrix[0]).connect(merger, 0, 0);
  channelDelays[0].connect(matrix[1]).connect(merger, 0, 1);
  rightPhase.connect(matrix[2]).connect(merger, 0, 0);
  rightPhase.connect(matrix[3]).connect(merger, 0, 1);

  const switchableFilter = (type) => {
    const incoming = gain();
    const filter = remember(context.createBiquadFilter());
    filter.type = type;
    const filtered = gain();
    const bypass = gain(0);
    const outgoing = gain();
    incoming.connect(filter).connect(filtered).connect(outgoing);
    incoming.connect(bypass).connect(outgoing);
    return { input: incoming, output: outgoing, filter, setEnabled(enabled) { setParam(filtered.gain, enabled ? 1 : 0); setParam(bypass.gain, enabled ? 0 : 1); } };
  };
  const highpass = switchableFilter('highpass');
  const lowpass = switchableFilter('lowpass');
  const hum = switchableFilter('notch');
  merger.connect(highpass.input);
  highpass.output.connect(lowpass.input);
  lowpass.output.connect(hum.input);
  const eq = Array.from({ length: 10 }, () => switchableFilter('peaking'));
  hum.output.connect(eq[0].input);
  for (let index = 0; index < eq.length - 1; index += 1) eq[index].output.connect(eq[index + 1].input);
  const solo = switchableFilter('bandpass');
  eq.at(-1).output.connect(solo.input);
  solo.output.connect(dynamics.node);

  const wetGain = gain();
  const dryDelay = delay(PROCESSING_LATENCY_SAMPLES / context.sampleRate);
  const dryGain = gain(0);
  const mixed = gain();
  dynamics.node.connect(wetGain).connect(mixed);
  inputTrim.connect(dryDelay).connect(dryGain).connect(mixed);
  const outputTrim = gain();
  mixed.connect(outputTrim).connect(limiter.node);
  const output = gain();
  limiter.node.connect(output);
  const processedAnalyser = analyser();

  const rawDelay = delay(PROCESSING_LATENCY_SAMPLES / context.sampleRate);
  const alignedRawOutput = gain();
  alignedRawOutput.channelCount = 2;
  alignedRawOutput.channelCountMode = 'explicit';
  alignedRawOutput.channelInterpretation = 'speakers';
  const rawSplitter = remember(context.createChannelSplitter(2));
  const rawAnalyser = analyser();
  const rawRightAnalyser = analyser();
  input.connect(rawDelay).connect(alignedRawOutput);
  alignedRawOutput.connect(rawSplitter);
  rawSplitter.connect(rawAnalyser, 0);
  rawSplitter.connect(rawRightAnalyser, 1);
  const differenceOutput = gain();
  const subtract = gain(-1);
  alignedRawOutput.connect(differenceOutput);
  output.connect(subtract).connect(differenceOutput);
  const outputSplitter = remember(context.createChannelSplitter(2));
  output.connect(outputSplitter);
  outputSplitter.connect(processedAnalyser, 0);
  const leftAnalyser = analyser();
  const rightAnalyser = analyser();
  outputSplitter.connect(leftAnalyser, 0);
  outputSplitter.connect(rightAnalyser, 1);

  const update = (nextSettings) => {
    if (disposed) return;
    const next = validateSettings(nextSettings);
    setParam(inputTrim.gain, dbGain(next.inputGainDb));
    setParam(outputTrim.gain, dbGain(next.outputGainDb));
    setParam(wetGain.gain, next.mix);
    setParam(dryGain.gain, 1 - next.mix);
    setParam(polarity[0].gain, next.polarityL ? -1 : 1);
    setParam(polarity[1].gain, next.polarityR ? -1 : 1);
    setParam(channelDelays[0].delayTime, Math.max(0, -next.channelDelayMs) / 1000);
    setParam(channelDelays[1].delayTime, Math.max(0, next.channelDelayMs) / 1000);
    setParam(allpass.frequency, next.phaseFrequency);
    setParam(allpass.Q, next.phaseQ);
    setParam(phaseDry.gain, next.phaseEnabled ? 0 : 1);
    setParam(phaseWet.gain, next.phaseEnabled ? 1 : 0);
    matrix.forEach((node, index) => setParam(node.gain, next.mono ? 0.5 : (index === 0 || index === 3 ? 1 : 0)));
    setParam(highpass.filter.frequency, next.highpassHz);
    setParam(highpass.filter.Q, 20 * Math.log10(Math.SQRT1_2));
    setParam(lowpass.filter.frequency, next.lowpassHz);
    setParam(lowpass.filter.Q, 20 * Math.log10(Math.SQRT1_2));
    // Min/max cut positions are true bypass: the neutral scene is uncolored.
    highpass.setEnabled(next.highpassHz > 20);
    lowpass.setEnabled(next.lowpassHz < 20000);
    hum.setEnabled(next.humHz !== 0);
    setParam(hum.filter.frequency, next.humHz || 60);
    setParam(hum.filter.Q, 30);
    next.eq.forEach((band, index) => {
      const filter = eq[index].filter;
      filter.type = band.type;
      setParam(filter.frequency, Math.min(context.sampleRate / 2 - 1, band.frequency));
      setParam(filter.gain, band.gain);
      setParam(filter.Q, band.type === 'highpass' || band.type === 'lowpass' ? 20 * Math.log10(band.q) : band.q);
      eq[index].setEnabled(next.eqEnabled && band.enabled);
    });
    const soloEnabled = !offline && next.soloBand >= 0;
    solo.setEnabled(soloEnabled);
    if (soloEnabled) {
      const band = next.eq[next.soloBand];
      setParam(solo.filter.frequency, band.frequency);
      setParam(solo.filter.Q, Math.max(0.5, band.q));
    }
    cleanup.node.port.postMessage({ type: 'settings', denoise: next.denoise, profileScale: dbGain(next.inputGainDb) ** 2 });
    if (!sameProfile(profile, next.noiseProfile)) {
      profile = copyProfile(next.noiseProfile);
      cleanup.node.port.postMessage({ type: 'profile', profile });
    }
    speech.node.port.postMessage({ type: 'settings', speech: next.speech });
    dynamics.node.port.postMessage({ type: 'settings', settings: dynamicsSettings(next) });
    limiter.node.port.postMessage({ type: 'settings', settings: { limiterEnabled: next.limiterEnabled } });
    if (next.speech && !wasmModule && !current.speech) report(new Error('Speech enhancement is unavailable. Retry loading the audio engine.'));
    current = next;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (learningRequest) {
      clearTimeout(learningRequest.timeout);
      learningRequest.reject(new Error('Audio input closed before the noise profile finished.'));
      learningRequest = null;
    }
    for (const node of worklets) {
      node.port.postMessage({ type: 'dispose' });
      node.port.onmessage = null;
      node.onprocessorerror = null;
      node.port.close();
    }
    for (const node of nodes) { try { node.disconnect(); } catch {} }
  };

  try {
    update(current);
    await Promise.all([cleanup.ready, speech.ready, dynamics.ready, limiter.ready]);
    initializing = false;
  } catch (error) { dispose(); throw error; }

  return {
    input, output, originalOutput, rawOutput: originalOutput, alignedRawOutput, differenceOutput,
    originalChannelPolicy: 'Stereo sources retained; mono sources duplicated identically into two recording channels.',
    inputAnalyser, inputLeftAnalyser, inputRightAnalyser, rawAnalyser, rawRightAnalyser, processedAnalyser, leftAnalyser, rightAnalyser,
    eqNodes: eq.map((band) => band.filter),
    latencySamples: PROCESSING_LATENCY_SAMPLES,
    latencySeconds: PROCESSING_LATENCY_SAMPLES / context.sampleRate,
    latencyExact: true,
    speechAvailable: Boolean(wasmModule),
    speechLoadError,
    update, dispose,
    getNoiseProfile: () => copyProfile(profile),
    setNoiseProfile(nextProfile) {
      const next = validateSettings({ ...current, noiseProfile: nextProfile });
      if (learningRequest) {
        clearTimeout(learningRequest.timeout);
        learningRequest.reject(new Error('Noise profile capture was cancelled.'));
        learningRequest = null;
        cleanup.node.port.postMessage({ type: 'cancel-learn' });
      }
      update(next);
    },
    learnNoise(seconds = 2) {
      if (disposed) return Promise.reject(new Error('The audio graph is closed.'));
      if (offline || context.state !== 'running') return Promise.reject(new Error('Start the microphone or play a noise-only region before learning a profile.'));
      if (!Number.isFinite(seconds)) return Promise.reject(new Error('Noise sample duration must be finite.'));
      if (learningRequest) return Promise.reject(new Error('A noise profile is already being sampled.'));
      const duration = Math.max(0.25, Math.min(10, seconds));
      return new Promise((resolve, reject) => {
        const id = ++requestCounter;
        const timeout = setTimeout(() => {
          learningRequest = null;
          cleanup.node.port.postMessage({ type: 'cancel-learn' });
          reject(new Error('No continuous audio arrived. Resume playback and sample the noise again.'));
        }, (duration + 8) * 1000);
        learningRequest = { id, resolve, reject, timeout };
        cleanup.node.port.postMessage({ type: 'learn', seconds: duration, requestId: id });
      });
    },
    getFrequencyResponse(frequencies) {
      const values = frequencies instanceof Float32Array ? frequencies : new Float32Array(frequencies);
      const magnitude = new Float32Array(values.length).fill(1);
      const phase = new Float32Array(values.length);
      const bandMagnitude = new Float32Array(values.length);
      const bandPhase = new Float32Array(values.length);
      if (current.eqEnabled) current.eq.forEach((band, index) => {
        if (!band.enabled) return;
        eq[index].filter.getFrequencyResponse(values, bandMagnitude, bandPhase);
        for (let i = 0; i < values.length; i += 1) { magnitude[i] *= bandMagnitude[i]; phase[i] += bandPhase[i]; }
      });
      return { magnitude, phase };
    },
  };
}
