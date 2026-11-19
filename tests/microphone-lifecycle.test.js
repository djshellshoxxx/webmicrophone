import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Execute the actual app lifecycle functions, with only the browser boundary
// supplied by this harness. Multiple overlapping calls exercise cancellation and
// late device events without requiring microphone hardware or a browser process.
const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
function appFunction(name, following) {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  const end = appSource.indexOf(`\n${following}`, start);
  assert.ok(start >= 0 && end > start, `Cannot locate ${name} in the application.`);
  return appSource.slice(start, end);
}
const lifecycleSource = [
  appFunction('run', 'function setStage('),
  appFunction('setStage', 'function liveSourceActive('),
  appFunction('liveSourceActive', 'function anySourceActive('),
  appFunction('disconnectSources', 'async function stopLive('),
  appFunction('connectMicrophone', 'async function loadDemo('),
  appFunction('beginRecording', 'async function stopRecording('),
  appFunction('stopRecording', 'async function finishTake('),
  appFunction('interruptInput', 'async function learnNoise('),
].join('\n');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function fakeStream({ended = false} = {}) {
  const track = new EventTarget();
  Object.assign(track, {
    kind: 'audio', label: 'Test microphone', readyState: ended ? 'ended' : 'live', stopped: 0,
    getSettings: () => ({channelCount: 2, sampleRate: 48000}),
    stop() { this.readyState = 'ended'; this.stopped++; },
  });
  const stream = {getTracks: () => [track], getAudioTracks: () => [track]};
  return {track, stream};
}

function createHarness({capture, enumerate = async () => {}, Recorder} = {}) {
  const state = {
    settings: {microphoneProfile: 'default'}, graph: {input: {}},
    stream: null, sourceNode: null, demoNode: null, sourceKind: 'idle',
    sourceGeneration: 0, recordToken: 0, sourceConnecting: false,
    recordingBusy: false, recordStage: 'idle', sessionBusy: false,
    monitorOn: false, recorder: null,
  };
  const messages = [];
  const elements = new Map();
  const context = {createMediaStreamSource: () => ({connect() {}, disconnect() {}})};
  const scope = {
    state, DOMException, Error, Number, Boolean,
    navigator: {mediaDevices: {getUserMedia: capture || (async () => fakeStream().stream)}},
    session: {buffer: null, stopPlayback() {}},
    byId(id) { if (!elements.has(id)) elements.set(id, {value: '', textContent: ''}); return elements.get(id); },
    abortError: () => new DOMException('Cancelled.', 'AbortError'),
    MICROPHONES: [{id: 'default', channels: 2}], PROCESSING_SAMPLE_RATE: 48000,
    ensureAudio: async () => context,
    enumerateDevices: enumerate,
    captureDescription: track => track.label,
    resetMeasurements() {}, profileSourceChanged() {}, syncNoiseStatus() {}, syncControls() {},
    sourceChanged(kind) { state.sourceKind = kind; },
    setMonitor(value) { state.monitorOn = value; },
    notify(message, error = false) { messages.push({message, error}); },
    noiseLearning: false, noiseLearnToken: 0,
    audioFault: false, recorderStatus() {},
    TakeRecorder: Recorder || class {
      constructor(context) { this.context = context; this.state = 'idle'; }
      async start() { this.state = 'recording'; this.metadata = {id: 'capture'}; }
    },
    requestedRecordStopReason: 'manual', recorderStartup: null, completionPromise: null, countdownCancel: null,
  };
  vm.runInNewContext(`${lifecycleSource}\nglobalThis.api = {connectMicrophone, beginRecording, stopRecording, interruptInput, run};`, scope);
  return {state, messages, context, ...scope.api};
}

test('cancelled microphone rejection cannot replace a successful newer connection', async () => {
  const pending = deferred(), entered = deferred();
  const current = fakeStream();
  let calls = 0;
  const app = createHarness({capture: () => {
    if (++calls === 1) { entered.resolve(); return pending.promise; }
    return Promise.resolve(current.stream);
  }});
  app.state.recordingBusy = true;
  app.state.recordStage = 'arming';
  app.state.recordToken = 1;
  const cancelled = app.run(() => app.connectMicrophone({forRecord: true, token: 1}));
  await entered.promise;
  await app.stopRecording();
  await app.run(() => app.connectMicrophone());
  const connectedMessage = app.messages.at(-1);
  pending.reject(new DOMException('A previous request was denied.', 'NotAllowedError'));
  await cancelled;
  assert.equal(app.state.stream, current.stream);
  assert.equal(current.track.readyState, 'live');
  assert.deepEqual(app.messages.at(-1), connectedMessage, 'A stale permission result replaced the successful retry notice.');
});

test('already ended track cannot be published as a connected microphone', async () => {
  const input = fakeStream({ended: true});
  const app = createHarness({capture: async () => input.stream});
  await assert.rejects(app.connectMicrophone(), /ended|disconnected|unavailable|active audio/i);
  assert.equal(app.state.stream, null);
  assert.equal(app.state.sourceConnecting, false);
  assert.equal(app.state.sourceKind, 'idle');
});

test('device end during enumeration cannot be followed by a false connected notice', async () => {
  const input = fakeStream(), enumeration = deferred(), entered = deferred();
  const app = createHarness({capture: async () => input.stream, enumerate: () => {
    entered.resolve();
    return enumeration.promise;
  }});
  const connecting = app.run(() => app.connectMicrophone());
  await entered.promise;
  input.track.stop();
  input.track.dispatchEvent(new Event('ended'));
  assert.equal(app.state.stream, null);
  assert.match(app.messages.at(-1).message, /Microphone disconnected/);
  enumeration.resolve();
  await connecting;
  assert.match(app.messages.at(-1).message, /Microphone disconnected/, 'Late enumeration claimed the disconnected microphone was connected.');
  assert.equal(app.messages.at(-1).error, true);
});

test('cancelled late grant releases only its own tracks while a newer microphone stays active', async () => {
  const pending = deferred(), entered = deferred();
  const stale = fakeStream(), current = fakeStream();
  let calls = 0;
  const app = createHarness({capture: () => {
    if (++calls === 1) { entered.resolve(); return pending.promise; }
    return Promise.resolve(current.stream);
  }});
  app.state.recordingBusy = true;
  app.state.recordStage = 'arming';
  app.state.recordToken = 1;
  const cancelled = app.run(() => app.connectMicrophone({forRecord: true, token: 1}));
  await entered.promise;
  await app.stopRecording();
  await app.run(() => app.connectMicrophone());
  pending.resolve(stale.stream);
  await cancelled;
  assert.equal(stale.track.readyState, 'ended');
  assert.equal(current.track.readyState, 'live');
  assert.equal(app.state.stream, current.stream);
  assert.equal(app.state.sourceKind, 'microphone');
  assert.equal(app.state.sourceConnecting, false);
});

for (const [name, expected] of [
  ['NotAllowedError', /permission was not granted/],
  ['NotFoundError', /No microphone was found/],
  ['NotReadableError', /another application is using it/],
  ['OverconstrainedError', /System default/],
  ['AbortError', /could not|interrupted|try again|retry/i],
]) {
  test(`${name} is reported and a later microphone retry succeeds`, async () => {
    const input = fakeStream();
    let calls = 0;
    const app = createHarness({capture: async () => {
      if (++calls === 1) throw new DOMException('Device acquisition failed.', name);
      return input.stream;
    }});
    await app.run(() => app.connectMicrophone());
    assert.match(app.messages.at(-1)?.message || '', expected);
    assert.equal(app.messages.at(-1).error, true);
    assert.equal(app.state.stream, null);
    assert.equal(app.state.sourceConnecting, false);
    await app.run(() => app.connectMicrophone());
    assert.equal(app.state.stream, input.stream);
    assert.equal(app.state.monitorOn, false);
    assert.equal(app.state.sourceKind, 'microphone');
    assert.equal(app.state.sourceConnecting, false);
  });
}

test('failure creating the audio source stops the newly acquired microphone', async () => {
  const input = fakeStream();
  const app = createHarness({capture: async () => input.stream});
  app.context.createMediaStreamSource = () => { throw new Error('Audio source failed.'); };
  await app.run(() => app.connectMicrophone());
  assert.equal(input.track.readyState, 'ended');
  assert.equal(app.state.stream, null);
  assert.equal(app.state.sourceConnecting, false);
  assert.match(app.messages.at(-1).message, /Audio source failed/);
});

test('a cancelled arming request cannot disconnect a recording started during delayed enumeration', async () => {
  const firstEnumeration = deferred(), entered = deferred();
  let enumerations = 0;
  const app = createHarness({enumerate: () => {
    if (++enumerations === 1) { entered.resolve(); return firstEnumeration.promise; }
    return Promise.resolve();
  }});
  const cancelled = app.run(() => app.beginRecording());
  await entered.promise;
  assert.equal(app.state.recordStage, 'arming');
  await app.stopRecording();
  await app.run(() => app.beginRecording());
  assert.equal(app.state.recordStage, 'recording');
  const currentStream = app.state.stream;
  assert.ok(currentStream);
  firstEnumeration.resolve();
  await cancelled;
  assert.equal(app.state.recordStage, 'recording');
  assert.equal(app.state.stream, currentStream, 'Obsolete connection cleanup disconnected the active recording.');
  assert.equal(currentStream.getAudioTracks()[0].readyState, 'live');
});

test('late completion of a cancelled request cannot clear a newer recording startup promise', async () => {
  const oldPermission = deferred(), requested = deferred(), captureReady = deferred(), starting = deferred();
  const input = fakeStream();
  const stopCalls = [];
  let captures = 0;
  class DelayedRecorder {
    constructor(context) { this.context = context; this.state = 'idle'; }
    async start() {
      this.state = 'starting';
      starting.resolve();
      await captureReady.promise;
      this.state = 'recording';
    }
    async stop() { stopCalls.push(this.state); this.state = 'stopped'; return null; }
  }
  const app = createHarness({Recorder: DelayedRecorder, capture: () => {
    if (++captures === 1) { requested.resolve(); return oldPermission.promise; }
    return Promise.resolve(input.stream);
  }});
  const cancelled = app.run(() => app.beginRecording());
  await requested.promise;
  await app.stopRecording();
  const retry = app.run(() => app.beginRecording());
  await starting.promise;
  oldPermission.reject(new DOMException('Obsolete permission result.', 'NotAllowedError'));
  await cancelled;
  const stopping = app.stopRecording();
  try {
    assert.deepEqual(stopCalls, [], 'Stop bypassed the active startup after an obsolete request cleared its promise.');
    assert.equal(app.state.recordStage, 'stopping');
  } finally {
    captureReady.resolve();
    await Promise.all([retry, stopping]);
  }
  assert.equal(app.state.recordStage, 'idle');
});
