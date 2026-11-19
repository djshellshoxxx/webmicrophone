import './styles.css';
import {defaultSettings, validateSettings, MICROPHONES} from './state.js';
import {bindSettings} from './settings-ui.js';
import {SessionUI} from './session-ui.js';
import {EqEditor} from './ui/eq-editor.js';
import {SignalVisualizer} from './ui/visualizer.js';
import {createProcessingGraph, PROCESSING_SAMPLE_RATE} from './audio/engine.js';
import {TakeRecorder, loadTake} from './recording/recorder.js';
import {detectPitch, formatDb, formatTime, toDb} from './analysis.js';

const byId = id => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const gainFromDb = value => 10 ** (value / 20);
const abortError = () => new DOMException('Cancelled.', 'AbortError');

// The session UI and every processor share this one settings/context boundary.
const state = {
  settings: defaultSettings(), context: null, graph: null,
  auditionDry: null, auditionWet: null, auditionMaster: null,
  monitorDelay: null, monitorGain: null, silentSink: null,
  stream: null, sourceNode: null, demoNode: null, sourceKind: 'idle',
  inputChannelCount: null, recordingBusy: false, recordStage: 'idle',
  sessionBusy: false, monitorOn: false, recorder: null,
  sourceGeneration: 0, recordToken: 0, sourceConnecting: false,
  profileNeedsReview: false, pendingSourceNotice: false,
};

let settingsUI, eq, visualizer, session;
let audioPromise = null, recorderStartup = null, completionPromise = null;
let countdownCancel = null, completedTakeId = null;
let requestedRecordStopReason = 'manual';
let noiseLearning = false, noiseLearnToken = 0, noiseMeasurement = null;
let pausePending = false;
let measuredNoiseDb = null, guardStarted = null, lastAdviceAt = 0, lastTunerAt = 0;
let clippingObserved = false, lastClipKey = null, audioFault = false;
const peakHold = {input: -Infinity, output: -Infinity};
let selectedVisualChannel = 'left', currentView = 'waveform';
let tunerDisplay = null;

function notify(message, error = false) {
  let text = String(message || '');
  if (state.pendingSourceNotice && !error) {
    text += ' Noise profile retained from the previous source; relearn for this recording.';
    state.pendingSourceNotice = false;
  }
  byId('status-message').textContent = text;
  byId('status').classList.toggle('error', Boolean(error));
  syncControls();
}

async function run(action) {
  try { return await action(); }
  catch (error) {
    if (error?.name !== 'AbortError') notify(error?.message || String(error), true);
    syncControls();
    return null;
  }
}

function setStage(stage) {
  state.recordStage = stage;
  state.recordingBusy = stage !== 'idle';
  syncControls();
}

function liveSourceActive() { return Boolean(state.stream || state.demoNode); }
function anySourceActive() { return liveSourceActive() || Boolean(session?.playback); }

function syncControls() {
  const busy = state.recordingBusy;
  const sessionBusy = Boolean(state.sessionBusy || session?.abortController);
  for (const id of ['open-audio', 'audio-file', 'demo', 'device', 'microphone-profile', 'refresh-takes']) {
    const element = byId(id);
    if (element) element.disabled = busy || state.sourceConnecting || sessionBusy;
  }
  byId('connect-mic').disabled = busy || state.sourceConnecting || sessionBusy || Boolean(state.stream);
  byId('connect-mic').textContent = state.sourceConnecting ? 'Connecting…' : state.stream ? 'Microphone enabled' : 'Enable microphone';
  byId('stop-mic').disabled = busy || !liveSourceActive();
  byId('stop-mic').textContent = state.demoNode ? 'Stop test signal' : 'Disconnect microphone';
  byId('record').disabled = busy || state.sourceConnecting || sessionBusy;
  byId('record').classList.toggle('recording', state.recordStage === 'recording');
  byId('pause').disabled = pausePending || !['recording', 'paused'].includes(state.recordStage);
  byId('pause').textContent = state.recordStage === 'paused' ? 'Resume' : 'Pause';
  byId('stop').disabled = !busy;
  byId('countdown').disabled = byId('duration').disabled = busy;
  byId('monitor').disabled = !liveSourceActive() || state.sourceConnecting;
  byId('monitor').setAttribute('aria-pressed', String(state.monitorOn));
  byId('monitor').textContent = state.monitorOn ? 'Monitoring on · click to mute' : 'Monitoring off';
  byId('learn-noise').disabled = noiseLearning || !anySourceActive();
  byId('clear-noise').disabled = !noiseLearning && !state.settings.noiseProfile;
  byId('measure-noise').disabled = !noiseMeasurement && !anySourceActive();
  for (const button of document.querySelectorAll('.take-select, .delete-take')) button.disabled = busy || sessionBusy || state.sourceConnecting;
  if (session) {
    for (const id of ['trim-start', 'trim-end', 'loop', 'audition-mode']) byId(id).disabled = busy || sessionBusy || state.sourceConnecting || !session.editor?.hasAudio;
    byId('play-clip').disabled = busy || sessionBusy || !session.editor?.hasAudio || Boolean(session.playback);
    byId('stop-playback').disabled = !session.playback;
    byId('export-audio').disabled = busy || sessionBusy || !session.editor?.hasAudio;
    byId('download-original').disabled = busy || sessionBusy || !session.buffer;
    session.editor?.update({fields: false});
  }
}

function profileSourceChanged() {
  if (!state.settings.noiseProfile) return;
  state.profileNeedsReview = true;
  state.pendingSourceNotice = true;
  syncNoiseStatus();
}

function syncNoiseStatus() {
  if (noiseLearning) {
    byId('noise-status').textContent = 'Sampling 2 seconds of background audio…';
    return;
  }
  byId('noise-status').textContent = state.settings.noiseProfile ?
    state.profileNeedsReview ? 'Profile retained from another source. Relearn for this recording.' : 'Noise profile ready · fixed 1,024-point spectrum' :
    'No learned profile. Reduction passes through.';
}

function setSettings(next) {
  const validated = validateSettings(next);
  state.graph?.update(validated);
  state.settings = validated;
  if (!validated.noiseProfile) state.profileNeedsReview = state.pendingSourceNotice = false;
  settingsUI?.sync();
  eq?.refresh();
  syncNoiseStatus();
  syncControls();
}

function setMonitor(on, message = '') {
  state.monitorOn = Boolean(on && liveSourceActive() && state.context?.state === 'running');
  if (state.monitorGain && state.context) {
    const now = state.context.currentTime;
    state.monitorGain.gain.cancelScheduledValues(now);
    if (state.monitorOn) state.monitorGain.gain.setTargetAtTime(gainFromDb(Number(byId('monitor-level').value)), now, 0.015);
    else state.monitorGain.gain.setValueAtTime(0, now);
  }
  guardStarted = null;
  syncControls();
  if (message) notify(message);
}

function panic(showMessage = true) {
  setMonitor(false);
  if (state.auditionMaster && state.context) {
    state.auditionMaster.gain.cancelScheduledValues(state.context.currentTime);
    state.auditionMaster.gain.setValueAtTime(0, state.context.currentTime);
  }
  session?.stopPlayback();
  if (!liveSourceActive()) sourceChanged(session?.buffer ? 'clip' : 'idle');
  if (showMessage) notify(state.recordingBusy ? 'All listening is muted. Original and processed recording continues.' : 'All playback and live monitoring muted.');
}

function resetMeasurements({preservePeaks = false} = {}) {
  if (!preservePeaks) resetPeaks();
  measuredNoiseDb = null;
  noiseMeasurement = null;
  byId('noise-floor').textContent = '—';
  byId('suggest-gate').disabled = true;
  byId('measure-noise').textContent = 'Measure noise floor · 3 s';
  resetTuner();
}

function resetPeaks() {
  peakHold.input = peakHold.output = -Infinity;
  clippingObserved = false;
  const inputHold = byId('input-hold'), outputHold = byId('output-hold');
  if (inputHold) inputHold.textContent = '−∞ dBFS';
  if (outputHold) outputHold.textContent = '−∞ dBFS';
  byId('clip-status').textContent = 'No clipping detected';
  byId('clip-status').classList.remove('clipped');
}

function sourceChanged(kind) {
  // Selecting the just-completed take need not disconnect an armed microphone.
  if (kind === 'clip' && liveSourceActive()) {
    syncControls();
    return;
  }
  state.sourceKind = kind;
  if (kind === 'idle') byId('source-details').textContent = 'Microphone not connected';
  const active = kind === 'playback' || kind === 'microphone' || kind === 'demo';
  byId('signal-state').textContent = kind === 'microphone' ? 'MICROPHONE' : kind === 'demo' ? 'TEST SIGNAL' : kind === 'playback' ? 'FILE PLAYBACK' : kind === 'clip' ? 'CLIP READY' : 'NO INPUT';
  if (kind === 'clip') {
    const clipKey = session?.activeTake?.id || session?.activeTake?.label || 'clip';
    if (clipKey !== lastClipKey) {
      lastClipKey = clipKey;
      profileSourceChanged();
      resetMeasurements({preservePeaks: true});
    }
    if (session?.buffer) byId('source-details').textContent = `${session.activeTake?.label || 'Local audio'} · ${session.buffer.numberOfChannels} channel${session.buffer.numberOfChannels === 1 ? '' : 's'} · ${session.buffer.sampleRate.toLocaleString()} Hz working audio`;
  }
  if (!active) {
    clearCurrentMeters();
    cancelNoiseMeasurement();
    resetTuner();
  }
  const displayGraph = active && state.context?.state === 'running' ? state.graph : null;
  if (visualizer && visualizer.graph !== displayGraph) visualizer.setGraph(displayGraph);
  syncControls();
}

async function ensureAudio() {
  if (state.context?.state !== 'closed' && state.context && state.graph && !audioFault) {
    if (state.context.state !== 'running') await state.context.resume();
    return state.context;
  }
  if (audioPromise) return audioPromise;
  audioPromise = (async () => {
    const Constructor = window.AudioContext || window.webkitAudioContext;
    if (!Constructor) throw new Error('This browser does not support Web Audio. Use a current browser with AudioWorklet support.');
    if (audioFault && state.context) {
      if (liveSourceActive()) disconnectSources();
      state.graph?.dispose();
      await state.context.close().catch(() => {});
      state.context = state.graph = null;
    }
    const context = new Constructor({sampleRate: PROCESSING_SAMPLE_RATE, latencyHint: 'interactive'});
    state.context = context;
    try {
      await context.resume();
      const graph = await createProcessingGraph(context, state.settings, {
        onError(error) {
          notify(error.message, true);
          if (/stopped processing/.test(error.message)) {
            audioFault = true;
            setMonitor(false);
            if (state.recordingBusy) void run(() => stopRecording({reason: 'processor-error'}));
          }
        },
      });
      state.graph = graph;
      graph.update(state.settings);
      state.silentSink = context.createGain();
      state.silentSink.gain.value = 0;
      graph.output.connect(state.silentSink).connect(context.destination);

      state.monitorDelay = context.createDelay(4);
      state.monitorDelay.delayTime.value = Number(byId('monitor-delay').value);
      state.monitorGain = context.createGain();
      state.monitorGain.gain.value = 0;
      graph.output.connect(state.monitorDelay).connect(state.monitorGain).connect(context.destination);

      state.auditionDry = context.createGain();
      state.auditionWet = context.createGain();
      state.auditionMaster = context.createGain();
      state.auditionDry.gain.value = 0;
      state.auditionWet.gain.value = 1;
      state.auditionMaster.gain.value = 0;
      graph.alignedRawOutput.connect(state.auditionDry).connect(state.auditionMaster);
      graph.output.connect(state.auditionWet).connect(state.auditionMaster);
      state.auditionMaster.connect(context.destination);
      // A larger source window supports stable low-note estimation and sampled
      // background measurement; the aligned display analyzers remain unchanged.
      graph.inputAnalyser.fftSize = 8192;
      if (graph.inputLeftAnalyser) graph.inputLeftAnalyser.fftSize = 8192;
      if (graph.inputRightAnalyser) graph.inputRightAnalyser.fftSize = 8192;
      eq.setGraph(graph);
      visualizer.setGraph(anySourceActive() ? graph : null);
      state.monitorOn = false;
      audioFault = false;
      byId('context-info').textContent = '48 kHz · ' + Math.round(graph.latencySeconds * 1000) + ' ms processing';
      const speechControl = document.querySelector('[data-setting="speech"]');
      speechControl.disabled = !graph.speechAvailable;
      speechControl.title = graph.speechAvailable ? 'Local RNNoise speech enhancement' : 'The local speech engine is unavailable; other processing remains usable.';
      if (!graph.speechAvailable) notify('The local speech engine could not load. Recording, EQ and general cleanup remain available.', true);
      context.addEventListener('statechange', () => {
        if (context !== state.context) return;
        if (context.state === 'running') { sourceChanged(state.sourceKind); return; }
        setMonitor(false);
        byId('signal-state').textContent = 'AUDIO PAUSED';
        cancelNoiseMeasurement();
        visualizer.setGraph(null);
        clearCurrentMeters();
        resetTuner();
        if (['starting', 'recording', 'paused'].includes(state.recordStage)) {
          void run(() => interruptInput('The browser interrupted audio. Recovering the recorded portion.', 'context-interrupted'));
        } else if (liveSourceActive()) notify('The browser paused audio. Press Record or Monitoring to resume from a user action.', true);
      });
      syncControls();
      return context;
    } catch (error) {
      state.graph?.dispose();
      await context.close().catch(() => {});
      if (state.context === context) state.context = state.graph = null;
      visualizer?.setGraph(null);
      eq?.setGraph(null);
      throw error;
    }
  })();
  try { return await audioPromise; }
  finally { audioPromise = null; }
}

function disconnectSources() {
  state.sourceGeneration++;
  setMonitor(false);
  if (state.sourceNode) { try { state.sourceNode.disconnect(); } catch {} state.sourceNode = null; }
  if (state.demoNode) {
    const node = state.demoNode;
    state.demoNode = null;
    node.onended = null;
    try { node.stop(); } catch {}
    node.disconnect();
  }
  const stream = state.stream;
  state.stream = null;
  stream?.getTracks().forEach(track => track.stop());
  state.inputChannelCount = null;
  state.sourceConnecting = false;
  if (noiseLearning) {
    noiseLearnToken++;
    noiseLearning = false;
    state.graph?.setNoiseProfile(state.settings.noiseProfile);
    syncNoiseStatus();
  }
  sourceChanged(session?.buffer ? 'clip' : 'idle');
  if (!session?.buffer) byId('source-details').textContent = 'Microphone not connected';
}

async function stopLive() {
  if (state.recordingBusy) throw new Error('Stop or cancel the recording before changing the source. Your captured audio will be kept.');
  disconnectSources();
}

async function enumerateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const select = byId('device'), selected = select.value;
  select.replaceChildren(new Option('System default', ''));
  let count = 0;
  for (const device of devices) {
    if (device.kind !== 'audioinput' || device.deviceId === 'default') continue;
    count++;
    select.add(new Option(device.label || `Microphone ${count}`, device.deviceId));
  }
  if (Array.from(select.options).some(option => option.value === selected)) select.value = selected;
}

function captureDescription(track) {
  const actual = track.getSettings?.() || {};
  const processing = [['echoCancellation', 'Echo'], ['noiseSuppression', 'Noise suppression'], ['autoGainControl', 'Auto gain']]
    .map(([key, label]) => `${label}: ${typeof actual[key] === 'boolean' ? actual[key] ? 'on' : 'off' : 'not reported'}`).join(' · ');
  const sampleRate = actual.sampleRate ? `${actual.sampleRate.toLocaleString()} Hz input` : 'Input rate not reported';
  const channels = actual.channelCount ? `${actual.channelCount} ch` : 'Channels not reported';
  return `${track.label || 'Microphone'} · ${sampleRate} · ${channels}. ${processing}.`;
}

async function connectMicrophone({forRecord = false, token = null} = {}) {
  if (state.recordingBusy && !forRecord) throw new Error('Stop the recording before reconnecting a microphone.');
  if (state.sourceConnecting) throw new Error('Another input is still connecting. Wait for it to finish.');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires a supported browser and a secure HTTPS page. File processing remains available.');
  if (state.sessionBusy || session?.abortController) throw new Error('Finish the current file operation before connecting a microphone.');
  session?.stopPlayback();
  disconnectSources();
  const generation = ++state.sourceGeneration;
  state.sourceConnecting = true;
  syncControls();
  const stillWanted = () => generation === state.sourceGeneration && (token === null || token === state.recordToken);
  let stream, sourceNode;
  try {
    const context = await ensureAudio();
    if (!stillWanted()) throw abortError();
    const profile = MICROPHONES.find(item => item.id === state.settings.microphoneProfile) || MICROPHONES[0];
    const deviceId = byId('device').value;
    const constraints = {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      channelCount: {ideal: profile.channels}, sampleRate: {ideal: PROCESSING_SAMPLE_RATE},
    };
    if (deviceId) constraints.deviceId = {exact: deviceId};
    stream = await navigator.mediaDevices.getUserMedia({audio: constraints, video: false});
    if (!stillWanted()) { stream.getTracks().forEach(track => track.stop()); throw abortError(); }
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('The selected device did not provide an audio track.');
    if (track.readyState === 'ended') throw new Error('The microphone disconnected before it was ready. Reconnect it and try again.');
    sourceNode = context.createMediaStreamSource(stream);
    sourceNode.connect(state.graph.input);
    state.sourceNode = sourceNode;
    state.stream = stream;
    const channels = track.getSettings?.().channelCount;
    state.inputChannelCount = channels === 1 || channels === 2 ? channels : null;
    state.sourceConnecting = false;
    resetMeasurements();
    sourceChanged('microphone');
    byId('source-details').textContent = captureDescription(track);
    profileSourceChanged();
    setMonitor(false);
    track.addEventListener('ended', () => {
      if (state.stream === stream) void run(() => interruptInput('Microphone disconnected. Recovering the captured audio.', 'device-ended'));
    });
    track.addEventListener('mute', () => {
      if (state.stream === stream && state.recordingBusy) void run(() => interruptInput('The input stopped delivering audio. Recovering the recorded portion.', 'input-muted'));
    });
    await enumerateDevices().catch(() => {});
    // A cancellation or device event can run while device labels are loading.
    // Its result belongs to that newer state, not to this connection attempt.
    if (!stillWanted()) throw abortError();
    if (state.stream !== stream || track.readyState === 'ended') throw new Error('The microphone disconnected before it was ready. Reconnect it and try again.');
    notify('Microphone connected. Monitoring is off; you can record without listening live.');
    return stream;
  } catch (error) {
    const wanted = stillWanted();
    if (stream && state.stream === stream) disconnectSources();
    else {
      stream?.getTracks().forEach(track => track.stop());
      try { sourceNode?.disconnect(); } catch { /* Already disconnected. */ }
    }
    if (generation === state.sourceGeneration) state.sourceConnecting = false;
    syncControls();
    if (!wanted) throw abortError();
    if (error.name === 'NotAllowedError') throw new Error('Microphone permission was not granted. Allow it in the browser and try again, or open an audio file.');
    if (error.name === 'NotFoundError') throw new Error('No microphone was found. Connect one or open an audio file.');
    if (error.name === 'NotReadableError') throw new Error('The microphone could not be opened. Check whether another application is using it, then try again.');
    if (error.name === 'OverconstrainedError') throw new Error('The selected microphone settings are unavailable. Choose System default and reconnect.');
    if (error.name === 'AbortError') throw new Error('The browser interrupted microphone startup. Check the device and try again, or open an audio file.');
    throw error;
  }
}

async function loadDemo() {
  if (state.recordingBusy || state.sessionBusy || state.sourceConnecting || session.abortController) throw new Error('Finish the current recording, connection or file operation before changing the source.');
  await stopLive();
  session.stopPlayback();
  const generation = ++state.sourceGeneration;
  state.sourceConnecting = true;
  syncControls();
  try {
  const context = await ensureAudio();
  if (generation !== state.sourceGeneration) throw abortError();
  const duration = 6, frames = context.sampleRate * duration;
  const buffer = context.createBuffer(2, frames, context.sampleRate);
  let random = 0x13579bdf;
  for (let i = 0; i < frames; i++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    const noise = ((random >>> 0) / 0xffffffff * 2 - 1) * 0.025;
    const t = i / context.sampleRate;
    const fade = Math.min(1, i / 480, (frames - 1 - i) / 480);
    const tone = Math.sin(2 * Math.PI * 440 * t) * 0.2;
    buffer.getChannelData(0)[i] = (tone + Math.sin(2 * Math.PI * 3000 * t) * 0.045 + noise) * fade;
    buffer.getChannelData(1)[i] = (tone + Math.sin(2 * Math.PI * 2200 * t) * 0.035 + noise) * fade;
  }
  const node = context.createBufferSource();
  node.buffer = buffer; node.loop = true;
  node.connect(state.graph.input);
  state.demoNode = node;
  state.inputChannelCount = 2;
  session.setClip(buffer, {label: 'Generated test · tones and noise', sourceKind: 'generated', channels: 2,
    sampleRate: context.sampleRate, duration, processedAvailable: false, rawAvailable: true});
  node.start();
  resetMeasurements();
  sourceChanged('demo');
  byId('source-details').textContent = 'Generated test signal · 440 Hz plus upper tones and noise · 2 ch · 48,000 Hz. This is actual audio passing through the processing graph.';
  profileSourceChanged();
  setMonitor(false);
  notify('Test signal running through the audio engine. Monitoring is off; enable it to listen, or inspect and record the signal.');
  } finally {
    if (generation === state.sourceGeneration) state.sourceConnecting = false;
    syncControls();
  }
}

function waitForCountdown(seconds, token) {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + seconds * 1000;
    let timer;
    countdownCancel = () => { clearTimeout(timer); countdownCancel = null; reject(abortError()); };
    const tick = () => {
      if (token !== state.recordToken) { countdownCancel?.(); return; }
      const remaining = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
      byId('record-time').textContent = remaining ? `${remaining}…` : '00:00';
      byId('record-state').textContent = remaining ? `Count-in · starts in ${remaining} seconds` : 'Starting recording…';
      if (!remaining) { countdownCancel = null; resolve(); }
      else timer = setTimeout(tick, 100);
    };
    tick();
  });
}

function recorderStatus(status) {
  byId('record-time').textContent = formatTime(status.duration);
  byId('storage-status').textContent = status.storageMode === 'memory' ? 'Session-only storage' : 'Local browser storage';
  if (['starting', 'recording', 'paused', 'stopping'].includes(status.state)) setStage(status.state);
  const labels = {starting: 'Preparing original + processed capture…', recording: 'Recording original + processed', paused: 'Paused · paused time is omitted', stopping: 'Finishing saved audio…', stopped: 'Original + processed take saved'};
  byId('record-state').textContent = labels[status.state] || 'Records original + processed';
  if (status.message) notify(status.message, status.state === 'stopped' && state.recorder?.metadata?.status === 'interrupted');
  if (status.state === 'stopped' && state.recorder?.metadata) void run(() => finishTake(state.recorder.metadata));
}

async function beginRecording() {
  if (state.recordingBusy || state.sessionBusy || state.sourceConnecting || session.abortController) throw new Error('A recording, connection or file operation is already active.');
  if (audioFault) disconnectSources();
  const token = ++state.recordToken;
  requestedRecordStopReason = 'manual';
  setStage('arming');
  byId('record-state').textContent = 'Preparing the input…';
  byId('record-time').textContent = '00:00';
  session.stopPlayback();
  let startup;
  try {
    if (!liveSourceActive()) await connectMicrophone({forRecord: true, token});
    const context = await ensureAudio();
    if (token !== state.recordToken || !liveSourceActive()) throw abortError();
    const seconds = Number(byId('countdown').value);
    if (seconds > 0) {
      setStage('countdown');
      notify(`Input is ready. Recording begins after a ${seconds}-second count-in.`);
      await waitForCountdown(seconds, token);
    }
    if (token !== state.recordToken) throw abortError();
    if (!state.recorder || state.recorder.context !== context) state.recorder = new TakeRecorder(context, {
      onStatus: recorderStatus,
      onError(error) { notify(error.message, true); },
    });
    setStage('starting');
    const generated = Boolean(state.demoNode);
    const label = `${generated ? 'Test signal' : 'Microphone'} · ${new Date().toLocaleString()}`;
    startup = state.recorder.start({rawNode: state.graph.originalOutput, processedNode: state.graph.output,
      channels: 2, inputChannelCount: state.inputChannelCount, label,
      settingsSnapshot: state.settings, latencyFrames: state.graph.latencySamples,
      durationSeconds: Number(byId('duration').value)});
    recorderStartup = startup;
    await startup;
    if (generated && state.recorder.metadata) {
      state.recorder.metadata.sourceKind = 'generated';
      state.recorder.metadata.captureNote = 'Locally generated test signal; track alignment is described by the latency metadata.';
    }
    if (token !== state.recordToken) {
      const result = await state.recorder.stop({reason: requestedRecordStopReason});
      if (result) await finishTake(result);
      return;
    }
    setStage('recording');
  } catch (error) {
    if (token === state.recordToken && !['recording', 'paused', 'stopping'].includes(state.recorder?.state)) {
      setStage('idle');
      byId('record-state').textContent = 'Records original + processed';
    }
    throw error;
  } finally { if (startup && recorderStartup === startup) recorderStartup = null; }
}

async function stopRecording({reason = 'manual'} = {}) {
  const stage = state.recordStage;
  if (reason !== 'manual' || requestedRecordStopReason === 'manual') requestedRecordStopReason = reason;
  state.recordToken++;
  if (stage === 'arming') {
    // Permission may already have returned while device enumeration is pending.
    // Release that provisional source before a new recording can adopt it.
    disconnectSources();
    setStage('idle');
    byId('record-state').textContent = 'Recording cancelled before capture';
    notify('Recording cancelled. Any later microphone permission response will not start a take.');
    return null;
  }
  if (stage === 'countdown') {
    countdownCancel?.();
    setStage('idle');
    byId('record-time').textContent = '00:00';
    byId('record-state').textContent = 'Count-in cancelled · input remains ready';
    notify('Count-in cancelled. No recording was started.');
    return null;
  }
  if (!state.recorder || ['idle', 'stopped'].includes(state.recorder.state)) {
    if (completionPromise) return completionPromise;
    setStage('idle');
    return null;
  }
  setStage('stopping');
  let startupFailed = false;
  if (recorderStartup) await recorderStartup.catch(() => { startupFailed = true; });
  if (startupFailed && state.recorder.state === 'idle') {
    setStage('idle');
    await session.refresh();
    byId('record-state').textContent = 'Capture did not start';
    return null;
  }
  const metadata = await state.recorder.stop({reason: requestedRecordStopReason});
  if (metadata) await finishTake(metadata);
  else setStage('idle');
  return metadata;
}

async function finishTake(metadata) {
  if (!metadata?.id || metadata.id === completedTakeId) return completionPromise;
  if (completionPromise) return completionPromise;
  completedTakeId = metadata.id;
  completionPromise = (async () => {
    setStage('stopping');
    try {
      await session.refresh();
      if (metadata.frameCount > 0) {
        const result = await loadTake(metadata.id, {track: 'raw', context: state.context});
        session.setClip(result.buffer, result.metadata);
        await session.refresh();
      }
      setStage('idle');
      const interrupted = metadata.status === 'interrupted';
      byId('record-state').textContent = metadata.frameCount === 0 ? 'No samples captured' : interrupted ? 'Interrupted take · saved portion retained' : 'Original + processed take saved';
      notify(metadata.frameCount === 0 ? 'This take contains no saved audio samples.' : metadata.message || (interrupted ? 'The saved portion of the interrupted take is available below.' : 'Take saved. Change the treatment and render again from its original audio.'), interrupted || metadata.frameCount === 0);
      if (byId('play-after').checked && metadata.frameCount > 0 && !interrupted && document.visibilityState !== 'hidden') {
        await stopLive();
        await session.play();
      }
    } finally {
      setStage('idle');
      completionPromise = null;
      syncControls();
    }
  })();
  return completionPromise;
}

async function interruptInput(message, reason) {
  setMonitor(false);
  try { if (state.recordingBusy) await stopRecording({reason}); }
  finally {
    disconnectSources();
    notify(message + ' Saved chunks remain in Your takes.', true);
  }
}

async function learnNoise() {
  if (!anySourceActive()) throw new Error('Connect the microphone, start the test signal, or play a background-only selection first.');
  if (noiseLearning) return;
  const graph = state.graph;
  if (!graph) return;
  const token = ++noiseLearnToken;
  noiseLearning = true;
  syncNoiseStatus(); syncControls();
  try {
    await state.context.resume();
    const profile = await graph.learnNoise(2);
    if (token !== noiseLearnToken || state.graph !== graph) return;
    state.profileNeedsReview = state.pendingSourceNotice = false;
    setSettings({...state.settings, noiseProfile: profile});
    notify('Background profile captured. Increase Noise reduction gradually and compare the original.');
  } catch (error) {
    if (token === noiseLearnToken) throw error;
  } finally {
    if (token === noiseLearnToken) { noiseLearning = false; syncNoiseStatus(); syncControls(); }
  }
}

function clearNoise() {
  noiseLearnToken++;
  noiseLearning = false;
  state.graph?.setNoiseProfile(null);
  state.profileNeedsReview = state.pendingSourceNotice = false;
  setSettings({...state.settings, noiseProfile: null});
  notify('Noise profile cleared. General noise reduction now passes through.');
}

function beginNoiseMeasurement() {
  if (noiseMeasurement) {
    cancelNoiseMeasurement();
    byId('gain-advice').textContent = measuredNoiseDb === null ? 'Measurement cancelled. No completed noise-floor estimate is available yet.' : 'Measurement cancelled. The last completed noise-floor estimate is retained.';
    syncControls();
    return;
  }
  if (!anySourceActive() || state.context?.state !== 'running') throw new Error('Start a microphone or audio playback before measuring the noise floor.');
  noiseMeasurement = {startedAt: performance.now(), sumSquares: 0, samples: 0, peak: 0};
  byId('noise-floor').textContent = '…';
  byId('measure-noise').textContent = 'Cancel measurement';
  byId('gain-advice').textContent = 'Keep the wanted source quiet for 3 seconds. Measuring the captured background in dBFS.';
  syncControls();
}

function cancelNoiseMeasurement() {
  if (!noiseMeasurement) return;
  noiseMeasurement = null;
  byId('noise-floor').textContent = measuredNoiseDb === null ? '—' : formatDb(measuredNoiseDb);
  byId('measure-noise').textContent = 'Measure noise floor · 3 s';
}

function resetTuner() {
  tunerDisplay = null;
  byId('tuner-note').textContent = '—';
  byId('tuner-hz').textContent = 'No stable pitch';
  byId('tuner-cents').textContent = 'Play one sustained note';
  byId('tuner-meter').value = 0;
}

function setMeterText(id, value, suffix = '') {
  const element = byId(id);
  const text = value + (suffix ? ` ${suffix}` : '') + ' ';
  if (element.firstChild?.nodeType === Node.TEXT_NODE) element.firstChild.nodeValue = text;
  else element.prepend(document.createTextNode(text));
}

function clearCurrentMeters() {
  for (const id of ['input-peak', 'output-peak', 'rms', 'level-change']) setMeterText(id, '—');
  byId('input-meter').value = byId('output-meter').value = -60;
  byId('signal-led').classList.remove('active', 'clip');
  byId('correlation-value').textContent = '—';
  byId('correlation-meter').value = 0;
}

function metricsChanged(metrics) {
  const now = performance.now();
  if (state.context?.state !== 'running') {
    clearCurrentMeters();
    resetTuner();
    return;
  }
  const {input, processed, rawSamples} = metrics;
  peakHold.input = Math.max(peakHold.input, input.peakDb);
  peakHold.output = Math.max(peakHold.output, processed.peakDb);
  if (byId('input-hold')) byId('input-hold').textContent = `${formatDb(peakHold.input)} dBFS`;
  if (byId('output-hold')) byId('output-hold').textContent = `${formatDb(peakHold.output)} dBFS`;
  setMeterText('input-peak', formatDb(input.peakDb));
  setMeterText('output-peak', formatDb(processed.peakDb));
  setMeterText('rms', formatDb(input.rmsDb));
  const change = input.rms > 1e-7 && processed.rms > 1e-7 ? processed.rmsDb - input.rmsDb : null;
  setMeterText('level-change', change === null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(1)}`);
  byId('input-meter').value = clamp(input.peakDb, -60, 0);
  byId('output-meter').value = clamp(processed.peakDb, -60, 0);
  if (input.clipped || processed.clipped) {
    clippingObserved = true;
    byId('clip-status').textContent = input.clipped ? 'Input clipping observed' : 'Processed clipping observed';
  } else if (!clippingObserved) byId('clip-status').textContent = 'No clipping detected';
  byId('clip-status').classList.toggle('clipped', clippingObserved);
  byId('signal-led').classList.toggle('active', input.peakDb > -65);
  byId('signal-led').classList.toggle('clip', Boolean(input.clipped || processed.clipped));
  const stereo = metrics.correlation;
  byId('correlation-value').textContent = stereo == null ? '—' : stereo.toFixed(2);
  byId('correlation-meter').value = stereo ?? 0;

  if (state.monitorOn && byId('peak-guard').checked && (input.rmsDb > -6 || input.peakDb > -0.5)) {
    guardStarted ??= now;
    if (now - guardStarted >= 900) setMonitor(false, 'Live monitoring auto-muted after a sustained high input level. Recording continues unchanged.');
  } else guardStarted = null;

  if (noiseMeasurement) {
    // Input RMS is channel-aware; rawSamples is the left-channel tuner trace.
    noiseMeasurement.sumSquares += input.rms * input.rms * rawSamples.length;
    noiseMeasurement.samples += rawSamples.length;
    noiseMeasurement.peak = Math.max(noiseMeasurement.peak, input.peak);
    const elapsed = (now - noiseMeasurement.startedAt) / 1000;
    if (elapsed >= 3) {
      const rms = Math.sqrt(noiseMeasurement.sumSquares / Math.max(1, noiseMeasurement.samples));
      measuredNoiseDb = toDb(rms);
      byId('noise-floor').textContent = formatDb(measuredNoiseDb);
      byId('suggest-gate').disabled = rms < 1e-9;
      const peakDb = toDb(noiseMeasurement.peak);
      byId('gain-advice').textContent = `Sampled background over ${elapsed.toFixed(1)} seconds: ${formatDb(measuredNoiseDb)} dBFS RMS; highest observed sample peak ${formatDb(peakDb)} dBFS. This includes both channels of the captured input, not calibrated sound pressure.`;
      byId('measure-noise').textContent = 'Measure noise floor · 3 s';
      noiseMeasurement = null;
      lastAdviceAt = now + 5000;
      syncControls();
    }
  } else if (anySourceActive() && now - lastAdviceAt >= 1200) {
    lastAdviceAt = now;
    byId('gain-advice').textContent = input.clipped ?
      'Input clipping is present. Reduce microphone/interface gain; software trim cannot restore clipped detail.' : input.peakDb > -6 ?
        'Input peaks are near full scale. Reduce hardware gain slightly to leave room for louder sounds.' : input.peakDb < -45 ?
          'The input is quiet. Check placement and hardware gain before raising software trim, which also raises captured noise.' :
          `Input peak: ${formatDb(input.peakDb)} dBFS. Keep room below 0 dBFS for louder moments.`;
  }

  if (byId('tuner-enabled').checked && anySourceActive() && now - lastTunerAt >= 180) {
    lastTunerAt = now;
    const reference = clamp(Number(byId('tuner-reference').value) || 440, 400, 480);
    const pitch = detectPitch(rawSamples, metrics.sampleRate || PROCESSING_SAMPLE_RATE, reference);
    if (!pitch) resetTuner();
    else {
      const sameNote = tunerDisplay?.note === pitch.note && tunerDisplay.reference === reference;
      const cents = sameNote && Math.abs(pitch.cents - tunerDisplay.cents) < 25 ? tunerDisplay.cents * 0.65 + pitch.cents * 0.35 : pitch.cents;
      tunerDisplay = {note: pitch.note, reference, cents};
      byId('tuner-note').textContent = pitch.note;
      byId('tuner-hz').textContent = `${pitch.frequency.toFixed(1)} Hz`;
      byId('tuner-cents').textContent = `${cents >= 0 ? '+' : ''}${cents.toFixed(1)} cents · A4 ${reference} Hz`;
      byId('tuner-meter').value = clamp(cents, -50, 50);
    }
  }
}

function updateScopeCaption() {
  const channel = selectedVisualChannel;
  const captions = {
    waveform: `Original and processed ${channel}-channel traces use matched scales and a fixed alignment delay. Level meters account for both channels.`,
    spectrum: `${channel === 'left' ? 'Left' : 'Right'}-channel frequency spectra in dBFS. Shading shows the displayed difference, including gain and filtering; level meters account for both channels.`,
    spectrogram: `Processed ${channel}-channel audio over the last 12 seconds. Low frequencies are at the bottom; new audio enters at the right.`,
  };
  byId('scope-caption').textContent = captions[currentView];
}

function bindTabs() {
  const views = Array.from(document.querySelectorAll('[data-view]'));
  const chooseView = button => {
    for (const candidate of views) {
      const active = candidate === button;
      candidate.classList.toggle('active', active);
      candidate.setAttribute('aria-pressed', String(active));
      byId(candidate.dataset.view).hidden = !active;
    }
    visualizer.setMode(button.dataset.view);
    currentView = button.dataset.view;
    updateScopeCaption();
  };
  for (const button of views) button.addEventListener('click', () => chooseView(button));
  chooseView(views[0]);

  const tabs = Array.from(document.querySelectorAll('[data-panel]'));
  const chooseTab = button => {
    for (const candidate of tabs) {
      const active = candidate === button;
      candidate.setAttribute('aria-selected', String(active));
      candidate.tabIndex = active ? 0 : -1;
      byId(`${candidate.dataset.panel}-panel`).hidden = !active;
    }
  };
  for (const [index, button] of tabs.entries()) {
    button.addEventListener('click', () => chooseTab(button));
    button.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); chooseTab(tabs[next]); tabs[next].focus(); }
    });
  }
  chooseTab(tabs[0]);
}

eq = new EqEditor(byId('eq-editor'), {getSettings: () => state.settings, onChange: next => {
  try { setSettings(next); } catch (error) { notify(error.message, true); eq.refresh(true); }
}});
visualizer = new SignalVisualizer({waveform: byId('waveform'), spectrum: byId('spectrum'), spectrogram: byId('spectrogram'), onMetrics: metricsChanged});
settingsUI = bindSettings({getSettings: () => state.settings, onChange: setSettings, notify});
session = new SessionUI({state, ensureAudio, stopLive, notify, onSourceChange: sourceChanged, onBusyChange: syncControls});
state.onSessionBusyChange = syncControls;
bindTabs();

byId('connect-mic').addEventListener('click', () => void run(() => connectMicrophone()));
byId('stop-mic').addEventListener('click', () => void run(async () => { await stopLive(); notify('Microphone capture and live monitoring stopped.'); }));
byId('demo').addEventListener('click', () => void run(loadDemo));
byId('device').addEventListener('change', () => {
  if (state.stream) void run(() => connectMicrophone());
  else notify('Input device selected. It will be used when you enable the microphone.');
});
byId('monitor').addEventListener('click', () => void run(async () => {
  if (!liveSourceActive()) throw new Error('Connect a microphone or start the test signal before monitoring.');
  if (state.monitorOn) setMonitor(false, 'Live monitoring muted. Capture remains active.');
  else { await ensureAudio(); setMonitor(true, 'Live monitoring enabled. Use Mute or Escape to silence listening immediately.'); }
}));
byId('monitor-delay').addEventListener('input', () => {
  const seconds = Number(byId('monitor-delay').value);
  byId('monitor-delay-value').textContent = `${seconds.toFixed(2)} s`;
  if (state.monitorDelay) state.monitorDelay.delayTime.setTargetAtTime(seconds, state.context.currentTime, 0.03);
});
byId('monitor-level').addEventListener('input', () => {
  const db = Number(byId('monitor-level').value);
  byId('monitor-level-value').textContent = `${db} dB`;
  if (state.monitorOn) state.monitorGain.gain.setTargetAtTime(gainFromDb(db), state.context.currentTime, 0.015);
});
byId('panic').addEventListener('click', () => panic());
byId('reset-peaks')?.addEventListener('click', resetPeaks);
byId('visual-channel')?.addEventListener('change', () => {
  selectedVisualChannel = byId('visual-channel').value === 'right' ? 'right' : 'left';
  visualizer.setChannel(selectedVisualChannel);
  updateScopeCaption();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); panic(); } });
byId('record').addEventListener('click', () => void run(beginRecording));
byId('stop').addEventListener('click', () => void run(() => stopRecording()));
byId('pause').addEventListener('click', () => void run(async () => {
  if (pausePending) return;
  pausePending = true;
  syncControls();
  try {
    if (state.recorder?.state === 'paused') await state.recorder.resume();
    else if (state.recorder?.state === 'recording') await state.recorder.pause();
  } finally { pausePending = false; syncControls(); }
}));
byId('learn-noise').addEventListener('click', () => void run(learnNoise));
byId('clear-noise').addEventListener('click', () => void run(clearNoise));
byId('measure-noise').addEventListener('click', () => void run(beginNoiseMeasurement));
byId('suggest-gate').addEventListener('click', () => void run(() => {
  if (!Number.isFinite(measuredNoiseDb)) throw new Error('Measure a quiet background first.');
  const threshold = Math.round(clamp(measuredNoiseDb + 6, -90, -6));
  setSettings({...state.settings, gateEnabled: true, gateThresholdDb: threshold});
  notify(`Gate starting point set to ${threshold} dBFS, about 6 dB above the sampled background. Compare quiet wanted sounds before keeping it.`);
}));
byId('tuner-enabled').addEventListener('change', () => { if (!byId('tuner-enabled').checked) resetTuner(); });
byId('tuner-reference').addEventListener('change', () => {
  byId('tuner-reference').value = String(clamp(Number(byId('tuner-reference').value) || 440, 400, 480));
  lastTunerAt = 0;
});
byId('stop-playback').addEventListener('click', () => {
  if (!liveSourceActive()) sourceChanged(session.buffer ? 'clip' : 'idle');
});

new MutationObserver(syncControls).observe(byId('takes-list'), {childList: true});
navigator.mediaDevices?.addEventListener?.('devicechange', () => void enumerateDevices().catch(() => {}));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    setMonitor(false);
    if (state.recordingBusy) notify('Recording is in the background. Keep this page in the foreground; browser suspension can interrupt capture.');
  }
});
window.addEventListener('beforeunload', event => {
  if (state.recordingBusy || state.sessionBusy || session.abortController) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => {
  panic(false);
  if (state.recordingBusy) void stopRecording({reason: 'page-hidden'}).catch(() => {}).finally(disconnectSources);
  else disconnectSources();
});
syncControls();
syncNoiseStatus();

// Deliberately no eager microphone request or AudioContext startup on page load.
