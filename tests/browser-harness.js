import { TakeRecorder, loadTake, listTakes, deleteTake, importAudioFile, getOriginalFile } from '../src/recording/recorder.js';
import { encodeWav, prepareExportBuffer, getCompressedFormats, exportCompressed, renderProcessed } from '../src/export/index.js';
import { createProcessingGraph } from '../src/audio/engine.js';
import { defaultSettings } from '../src/state.js';
import { measureStereoChannels } from '../src/ui/channel-metrics.js';

const runButton = document.querySelector('#run');
const reloadButton = document.querySelector('#reload-check');
const status = document.querySelector('#status');
const summary = document.querySelector('#summary');
const results = document.querySelector('#results');
const storageKey = 'webmicrophone.verification.take';
const signatureKey = 'webmicrophone.verification.signature';
const report = [];
let context;

function assert(condition, message) { if (!condition) throw new Error(message); }
function near(actual, expected, tolerance, label) { assert(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`); }
function updateSummary() { summary.textContent = JSON.stringify({ userAgent: navigator.userAgent, crossOriginIsolated, results: report }, null, 2); }
async function check(name, action) {
  const row = document.createElement('li'); row.className = 'running'; row.textContent = `${name}: running…`; results.append(row);
  status.textContent = `Running: ${name}`;
  const started = performance.now();
  try {
    const details = await action();
    row.className = 'pass'; row.textContent = `PASS — ${name}`;
    report.push({ name, status: 'pass', milliseconds: Math.round(performance.now() - started), details });
  } catch (error) {
    row.className = 'fail'; row.textContent = `FAIL — ${name}: ${error.message}`;
    report.push({ name, status: 'fail', milliseconds: Math.round(performance.now() - started), error: error.message, stack: error.stack });
  }
  updateSummary();
}

function makeTone(channels = 1, frames = 12000) {
  const buffer = context.createBuffer(channels, frames, 48000);
  for (let channel = 0; channel < channels; channel += 1) {
    for (let frame = 0; frame < frames; frame += 1) buffer.getChannelData(channel)[frame] = (channel ? 0.1 : 0.2) * Math.sin(2 * Math.PI * 440 * frame / 48000);
  }
  return buffer;
}

function maxDifference(left, right) {
  let maximum = 0;
  for (let frame = 0; frame < left.length; frame += 1) maximum = Math.max(maximum, Math.abs(left[frame] - right[frame]));
  return maximum;
}

async function captureCheck() {
  const oldId = sessionStorage.getItem(storageKey);
  if (oldId) await deleteTake(oldId).catch(() => {});
  const left = context.createOscillator(); left.frequency.value = 440;
  const right = context.createOscillator(); right.frequency.value = 660;
  const leftGain = context.createGain(); leftGain.gain.value = 0.25;
  const rightGain = context.createGain(); rightGain.gain.value = -0.125;
  const merger = context.createChannelMerger(2);
  left.connect(leftGain).connect(merger, 0, 0); right.connect(rightGain).connect(merger, 0, 1);
  const delay = context.createDelay(); delay.delayTime.value = 1984 / 48000;
  const half = context.createGain(); half.gain.value = 0.5; merger.connect(delay).connect(half);
  const errors = [];
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const recorder = new TakeRecorder(context, {
    onError: (error) => errors.push(error.message),
    onStatus: (value) => { if (value.state === 'stopped') resolveStopped(); },
  });
  left.start(); right.start();
  try {
    await recorder.init();
    await recorder.start({ rawNode: merger, processedNode: half, channels: 2, durationSeconds: 0.25, latencyFrames: 1984, label: 'Browser verification — safe to remove' });
    await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(new Error('Timed capture did not finish within 12 seconds.')), 12000))]);
    const metadata = await recorder.stop();
    assert(metadata.frameCount === 12000, `Timed capture saved ${metadata.frameCount} frames, expected 12000.`);
    assert(metadata.status === 'complete', metadata.message || 'Take was interrupted.');
    assert(metadata.storageMode === 'indexeddb', 'This environment only supports session recording; persistence check cannot pass.');
    const original = await loadTake(metadata.id, { context, track: 'raw' });
    const processed = await loadTake(metadata.id, { context, track: 'processed' });
    const errorsByChannel = [];
    for (let channel = 0; channel < 2; channel += 1) {
      const raw = original.buffer.getChannelData(channel);
      const wet = processed.buffer.getChannelData(channel);
      let error = 0;
      for (let frame = 0; frame < raw.length; frame += 1) error = Math.max(error, Math.abs(wet[frame] - raw[frame] * 0.5));
      near(error, 0, 0.00001, `Aligned original/processed channel ${channel}`);
      assert(raw.some((sample) => Math.abs(sample) > 0.1), 'Capture unexpectedly contained silence.');
      errorsByChannel.push(error);
    }
    assert(metadata.latencyCompensated === true, 'Recording did not record its alignment policy.');
    assert((await listTakes()).some((take) => take.id === metadata.id), 'Saved take was not listed.');
    assert(errors.length === 0, errors.join('; '));
    sessionStorage.setItem(storageKey, metadata.id);
    sessionStorage.setItem(signatureKey, JSON.stringify({ rawLeft: original.buffer.getChannelData(0)[1000], processedRight: processed.buffer.getChannelData(1)[1000] }));
    reloadButton.disabled = false;
    return { frameCount: metadata.frameCount, tracks: 2, channels: 2, latencyFrames: metadata.latencyFrames, errorsByChannel, storageMode: metadata.storageMode, persistenceTestTake: metadata.id };
  } finally {
    await recorder.dispose(); left.stop(); right.stop(); leftGain.disconnect(); rightGain.disconnect(); merger.disconnect(); delay.disconnect(); half.disconnect();
  }
}

async function wavCheck() {
  const source = makeTone(2);
  const snapshot = source.getChannelData(0).slice();
  const results = [];
  for (const bitDepth of [16, 24, '32float']) {
    const blob = await encodeWav(source, { bitDepth, sampleRate: 44100, trim: { start: 0.05, end: 0.2 }, normalize: true });
    const bytes = await blob.arrayBuffer();
    const header = new DataView(bytes);
    const decoder = new OfflineAudioContext(2, 1, 44100);
    const decoded = await decoder.decodeAudioData(bytes.slice(0));
    assert(header.getUint32(24, true) === 44100, 'Export did not use the requested sample rate.');
    assert(decoded.length === 6615, `Trim/resampling yielded ${decoded.length} frames instead of 6615.`);
    assert(decoded.numberOfChannels === 2, 'Export changed the channel count.');
    const peak = decoded.getChannelData(0).reduce((largest, sample) => Math.max(largest, Math.abs(sample)), 0);
    near(peak, 10 ** (-1 / 20), 0.00005, 'Normalized sample peak');
    const samples = decoded.getChannelData(0);
    let crossings = 0;
    for (let i = 1; i < samples.length; i += 1) if (samples[i - 1] <= 0 && samples[i] > 0) crossings += 1;
    near(crossings / decoded.duration, 440, 8, 'Resampled tone frequency');
    results.push({ bitDepth, bytes: blob.size, frames: decoded.length, sampleRate: decoded.sampleRate, peak });
  }
  near(maxDifference(source.getChannelData(0), snapshot), 0, 0, 'Preserved source');
  return results;
}

async function importCheck() {
  const blob = await encodeWav(makeTone(2), { bitDepth: 24, sampleRate: 44100 });
  const file = new File([blob], 'verification-original.wav', { type: 'audio/wav' });
  const imported = await importAudioFile(file, context);
  try {
    assert(imported.metadata.inputSampleRate === 44100, 'Original WAV rate was not retained in metadata.');
    assert(imported.buffer.sampleRate === 48000, 'Working buffer was not decoded at the processing rate.');
    const saved = await getOriginalFile(imported.takeId);
    assert(saved, 'Original file bytes were not saved.');
    const a = new Uint8Array(await file.arrayBuffer());
    const b = new Uint8Array(await saved.blob.arrayBuffer());
    assert(a.length === b.length && a.every((byte, index) => byte === b[index]), 'Original file changed during import.');
    return { originalRate: imported.metadata.inputSampleRate, workingRate: imported.buffer.sampleRate, originalBytes: b.length };
  } finally { if (imported.takeId) await deleteTake(imported.takeId); }
}

async function renderCheck() {
  const source = makeTone();
  const settings = defaultSettings(); settings.mix = 0; settings.limiterEnabled = false;
  const first = await renderProcessed(source, settings);
  const second = await renderProcessed(source, settings);
  assert(first.length === source.length, 'Rendering changed source duration.');
  const repeatError = maxDifference(first.getChannelData(0), second.getChannelData(0));
  const alignmentError = maxDifference(first.getChannelData(0), source.getChannelData(0));
  near(repeatError, 0, 1e-7, 'Repeat render');
  near(alignmentError, 0, 3e-5, 'Bulk latency compensation');
  return { frames: first.length, repeatError, alignmentError };
}

async function compressedCheck() {
  const formats = getCompressedFormats();
  if (!formats.length) return { supported: false, result: 'No compressed encoder advertised; WAV remains available.' };
  const output = [];
  for (const format of formats) {
    const result = await exportCompressed(makeTone(), { format: format.id, bitrateKbps: 64 });
    assert(result.blob.size > 0, 'Compressed encoder returned an empty file.');
    assert(result.requestedBitrate === 64000, 'Requested bitrate was not supplied to the encoder.');
    const decoded = await context.decodeAudioData(await result.blob.arrayBuffer());
    near(decoded.duration, 0.25, 0.1, 'Compressed duration including codec padding');
    output.push({ format: format.id, mimeType: result.mimeType, extension: result.extension, bytes: result.blob.size, requestedBitrate: result.requestedBitrate, reportedBitrate: result.bitrate, duration: decoded.duration });
  }
  return output;
}

async function rawEngine(settings, fill) {
  const offline = new OfflineAudioContext(2, 53000, 48000);
  const sourceBuffer = offline.createBuffer(2, 48000, 48000);
  fill(sourceBuffer);
  const engineErrors = [];
  const graph = await createProcessingGraph(offline, settings, { offline: true, onError: (error) => engineErrors.push(error.message) });
  const source = offline.createBufferSource(); source.buffer = sourceBuffer;
  source.connect(graph.input); graph.output.connect(offline.destination); source.start();
  try {
    const output = await offline.startRendering();
    assert(engineErrors.length === 0, engineErrors.join('; '));
    return { output, source: sourceBuffer, latency: graph.latencySamples };
  } finally { source.disconnect(); graph.dispose(); }
}

function impulseFill(buffer) { buffer.getChannelData(0)[100] = 0.7; buffer.getChannelData(1)[321] = 0.35; }
function peakIndex(samples) {
  let index = 0;
  for (let i = 1; i < samples.length; i += 1) if (Math.abs(samples[i]) > Math.abs(samples[index])) index = i;
  return index;
}

async function engineNeutralCheck() {
  const settings = defaultSettings(); settings.limiterEnabled = false;
  const full = await rawEngine(settings, impulseFill);
  const left = full.output.getChannelData(0); const right = full.output.getChannelData(1);
  near(peakIndex(left), 2084, 1, 'Left impulse position'); near(left[2084], 0.7, 1e-5, 'Left impulse magnitude');
  near(peakIndex(right), 2305, 1, 'Right impulse position'); near(right[2305], 0.35, 1e-5, 'Right impulse magnitude');
  settings.mix = 0.5;
  const half = await rawEngine(settings, impulseFill);
  const error = Math.max(maxDifference(left, half.output.getChannelData(0)), maxDifference(right, half.output.getChannelData(1)));
  near(error, 0, 3e-5, 'Half wet/dry alignment');
  return { latency: full.latency, leftPeak: peakIndex(left), rightPeak: peakIndex(right), halfMixError: error };
}

async function engineStereoCheck() {
  const settings = defaultSettings(); settings.limiterEnabled = false; settings.polarityL = true; settings.channelDelayMs = 10;
  const result = await rawEngine(settings, impulseFill);
  const left = result.output.getChannelData(0); const right = result.output.getChannelData(1);
  near(left[2084], -0.7, 1e-5, 'Left polarity'); near(peakIndex(right), 2785, 1, '10 ms right delay');
  const mono = makeTone();
  const rendered = await renderProcessed(mono, settings);
  assert(rendered.numberOfChannels === 2, 'Stereo effects applied to mono input were silently collapsed.');
  return { leftPeak: left[2084], rightPeakAt: peakIndex(right), monoInputRenderedChannels: rendered.numberOfChannels };
}

async function inputStereoMeterCheck() {
  const settings = defaultSettings(); settings.limiterEnabled = false;
  const graph = await createProcessingGraph(context, settings);
  const source = context.createBufferSource();
  const fixture = context.createBuffer(2, 4800, 48000);
  fixture.getChannelData(0).fill(0.8);
  fixture.getChannelData(1).fill(-0.8);
  source.buffer = fixture; source.loop = true;
  const silentSink = context.createGain(); silentSink.gain.value = 0;
  source.connect(graph.input);
  graph.output.connect(silentSink).connect(context.destination);
  try {
    assert(graph.inputLeftAnalyser && graph.inputRightAnalyser, 'Independent input-channel analyzers are unavailable.');
    source.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const left = new Float32Array(graph.inputLeftAnalyser.fftSize);
    const right = new Float32Array(graph.inputRightAnalyser.fftSize);
    graph.inputLeftAnalyser.getFloatTimeDomainData(left);
    graph.inputRightAnalyser.getFloatTimeDomainData(right);
    const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
    const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
    near(leftMean, 0.8, 1e-5, 'Input left channel');
    near(rightMean, -0.8, 1e-5, 'Input right channel');
    const metrics = measureStereoChannels(left, right);
    near(metrics.peak, 0.8, 1e-5, 'Antiphase stereo input peak');
    near(metrics.rms, 0.8, 1e-5, 'Antiphase stereo input RMS');
    assert(metrics.invalidSamples === 0, 'Input meters received invalid samples.');
    return { leftMean, rightMean, peak: metrics.peak, rms: metrics.rms, audibleOutput: false };
  } finally {
    try { source.stop(); } catch { /* A failed setup may not have started it. */ }
    source.disconnect(); graph.dispose(); silentSink.disconnect();
  }
}

async function enginePhaseCheck() {
  const settings = defaultSettings(); settings.limiterEnabled = false; settings.phaseEnabled = true; settings.phaseFrequency = 1000;
  const { output } = await rawEngine(settings, (buffer) => {
    for (let i = 0; i < buffer.length; i += 1) buffer.getChannelData(0)[i] = buffer.getChannelData(1)[i] = 0.2 * Math.sin(2 * Math.PI * 1000 * i / 48000);
  });
  let leftEnergy = 0; let rightEnergy = 0; let product = 0;
  const left = output.getChannelData(0); const right = output.getChannelData(1);
  for (let i = 10000; i < 45000; i += 1) { leftEnergy += left[i] ** 2; rightEnergy += right[i] ** 2; product += left[i] * right[i]; }
  const ratio = Math.sqrt(rightEnergy / leftEnergy); const correlation = product / Math.sqrt(leftEnergy * rightEnergy);
  near(ratio, 1, 0.002, 'All-pass amplitude ratio'); assert(correlation < -0.95, `All-pass center did not rotate phase: correlation ${correlation}`);
  return { amplitudeRatio: ratio, correlation };
}

async function engineSpeechCheck() {
  const settings = defaultSettings(); settings.limiterEnabled = false; settings.speech = true;
  const { source, output, latency } = await rawEngine(settings, (buffer) => {
    for (let i = 3000; i < 40000; i += 1) {
      const sample = 0.2 * (Math.sin(0.13 * i) + 0.6 * Math.sin(0.019 * i) + 0.2 * Math.sin(0.413 * i));
      buffer.getChannelData(0)[i] = sample; buffer.getChannelData(1)[i] = sample * 0.5;
    }
  });
  let originalEnergy = 0; let outputEnergy = 0; let product = 0;
  const original = source.getChannelData(0); const processed = output.getChannelData(0);
  assert(processed.every(Number.isFinite), 'Speech engine produced non-finite samples.');
  for (let i = 8000; i < 38000; i += 1) { originalEnergy += original[i] ** 2; outputEnergy += processed[i + latency] ** 2; product += original[i] * processed[i + latency]; }
  const correlation = product / Math.sqrt(originalEnergy * outputEnergy);
  assert(outputEnergy > 0, 'The speech engine returned silent output for this test fixture.');
  assert(correlation > 0.85, `Speech fixture correlation at the declared latency was ${correlation}.`);
  return { latency, correlation, outputEnergy, qualification: 'Execution and timing smoke test, not a speech-quality benchmark.' };
}

async function profileCheck() {
  const settings = defaultSettings(); settings.limiterEnabled = false; settings.denoise = 0.5;
  settings.noiseProfile = { version: 1, sampleRate: 48000, fftSize: 1024, power: Array(513).fill(0.01) };
  const output = await renderProcessed(makeTone(), settings);
  assert(output.getChannelData(0).every(Number.isFinite), 'Noise-profile processing produced invalid samples.');
  assert(output.length === 12000, 'Noise-profile processing changed source duration.');
  return { frames: output.length, speechEnabled: settings.speech, qualification: 'Numerical execution smoke test, not a perceptual separation benchmark.' };
}

runButton.addEventListener('click', async () => {
  runButton.disabled = true; reloadButton.disabled = true; report.length = 0; results.replaceChildren();
  context = new AudioContext({ sampleRate: 48000 });
  try {
    await context.resume();
    await check('Timed stereo capture, original/processed separation, IndexedDB flush', captureCheck);
    await check('WAV16/24/float32, trim, resampling, pitch, normalization', wavCheck);
    await check('Import and original-file byte preservation', importCheck);
    await check('Offline rendering, repeatability and latency compensation', renderCheck);
    await check('Available browser compressed encoders and actual decoding', compressedCheck);
    await check('Neutral engine impulses and half wet/dry alignment', engineNeutralCheck);
    await check('Polarity, relative channel delay and mono-input stereo effects', engineStereoCheck);
    await check('Independent stereo input meters retain antiphase peaks and RMS', inputStereoMeterCheck);
    await check('All-pass phase with unity magnitude', enginePhaseCheck);
    await check('RNNoise initialization, finite output and timing', engineSpeechCheck);
    await check('Non-speech spectral profile processing', profileCheck);
    await check('Cancellation preserves the source', async () => {
      const source = makeTone(); const first = source.getChannelData(0)[1];
      const controller = new AbortController(); controller.abort();
      let cancelled = false;
      try { await prepareExportBuffer(source, { normalize: true, signal: controller.signal }); }
      catch (error) { cancelled = error.name === 'AbortError'; }
      assert(cancelled, 'Cancelled operation was not rejected.');
      assert(source.getChannelData(0)[1] === first, 'Cancellation changed the source.');
      return { cancelled, sourcePreserved: true };
    });
  } catch (error) { status.textContent = error.message; }
  finally {
    await context.close().catch(() => {}); context = null;
    const failed = report.filter((row) => row.status === 'fail').length;
    status.textContent = `${report.length - failed}/${report.length} checks passed. Reload this page, then press “Verify saved take after reload” to check persistence and remove the test take.`;
    runButton.disabled = false; reloadButton.disabled = !sessionStorage.getItem(storageKey); updateSummary();
  }
});

reloadButton.addEventListener('click', async () => {
  reloadButton.disabled = true;
  context = new AudioContext({ sampleRate: 48000 });
  try {
    await context.resume();
    await check('Saved stereo take remains correct in a fresh page', async () => {
      const id = sessionStorage.getItem(storageKey); assert(id, 'No verification take is waiting. Run the main checks first.');
      const original = await loadTake(id, { context, track: 'raw' });
      const processed = await loadTake(id, { context, track: 'processed' });
      const signature = JSON.parse(sessionStorage.getItem(signatureKey));
      assert(original.buffer.length === 12000 && processed.buffer.length === 12000, 'Reload lost saved frames.');
      near(original.buffer.getChannelData(0)[1000], signature.rawLeft, 1e-7, 'Reloaded original');
      near(processed.buffer.getChannelData(1)[1000], signature.processedRight, 1e-7, 'Reloaded processed right channel');
      await deleteTake(id); sessionStorage.removeItem(storageKey); sessionStorage.removeItem(signatureKey);
      return { frames: original.buffer.length, testTakeRemoved: true };
    });
  } finally { await context.close(); context = null; status.textContent = 'Persistence check finished. Results are shown below.'; }
});

runButton.disabled = false;
reloadButton.disabled = !sessionStorage.getItem(storageKey);
status.textContent = 'Ready. Press Run checks. All audio is generated locally; no microphone permission is needed.';
