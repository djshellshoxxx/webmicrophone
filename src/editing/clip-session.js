import {ClipEditModel} from './edit-model.js';
import {transformAudioBuffer, normalizeTimePitchSettings, getTimePitchPlan} from './time-pitch.js';
import {waveformOverview} from './waveform-overview.js';
import {ClipEditor} from '../ui/clip-editor.js';

const defaults = () => ({speed: 1, stretch: 1, pitchSemitones: 0});
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const abortError = () => new DOMException('Playback preparation cancelled.', 'AbortError');
const channelViews = buffer => Array.from({length: buffer.numberOfChannels}, (_, i) => buffer.getChannelData(i));

// One owner for the sidebar editor and the existing lower selection/transport.
// The document references source frames; neither history nor clipboard copies PCM.
export class ClipSession {
  constructor(session) {
    this.session = session;
    this.transforms = defaults();
    this.paused = false;
    this.generation = 0;
    this.status = 'Select a recording, open audio, or try the test signal.';
    this.progress = null;
    this.ui = new ClipEditor(document.getElementById('compact-clip-editor'), {
      onAction: action => void session.run(() => this.action(action)),
      onSelection: (start, end) => void session.run(() => this.selectSeconds(start, end)),
      onSeek: seconds => void session.run(() => this.seekSeconds(seconds)),
      onTransform: values => void session.run(() => this.changeTransforms(values)),
      onLoop: value => void session.run(() => this.setLoop(value)),
    });
    this.update();
  }

  get factor() { return this.transforms.stretch / this.transforms.speed; }
  get duration() { return (this.model?.duration || 0) * this.factor; }
  get loaded() { return Boolean(this.model && this.source); }
  get hasAudio() { return Boolean(this.model?.length); }
  get playing() { return Boolean(this.session.playback); }
  get busy() {
    const state = this.session.state;
    return Boolean(state.recordingBusy || state.sessionBusy || state.sourceConnecting || this.session.abortController);
  }
  seconds(frame) { return frame / this.source.sampleRate * this.factor; }
  frame(seconds) { return Math.round(seconds / this.factor * this.source.sampleRate); }

  setSource(buffer, {metadata = null, originalFile = null} = {}) {
    // Construct first: a rejected source must leave the current document intact.
    const model = buffer ? new ClipEditModel({length: buffer.length, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels}) : null;
    this.stop({reset: false});
    this.source = buffer || null;
    this.model = model;
    this.session.buffer = buffer || null;
    this.session.activeTake = metadata;
    this.session.originalFile = originalFile;
    this.transforms = defaults();
    this.paused = false;
    this.status = buffer ? 'Click to seek · drag to select · double-click a chop.' : 'Select a recording, open audio, or try the test signal.';
    this.invalidate();
    this.update();
  }

  invalidate() {
    this.prepared = null;
    this.overviewRevision = -1;
    this.peaks = null;
  }

  overview() {
    if (!this.model || !this.source) return {minimum: new Float32Array(), maximum: new Float32Array()};
    if (this.overviewRevision !== this.model.revision || !this.peaks) {
      const channels = this.model.isEdited ? this.model.render(channelViews(this.source)) : channelViews(this.source);
      this.peaks = waveformOverview(channels);
      this.overviewRevision = this.model.revision;
    }
    return this.peaks;
  }

  selection() {
    if (!this.model) return {start: 0, end: 0};
    return {start: this.seconds(this.model.selection.start), end: this.seconds(this.model.selection.end)};
  }

  snapshot() {
    const selection = this.selection();
    return {
      loaded: this.loaded, busy: this.busy, preparing: Boolean(this.prepareAbort),
      playing: this.playing, paused: this.paused,
      label: this.session.activeTake?.label || 'No clip selected',
      duration: this.duration, sourceDuration: this.source?.duration || 0,
      selectionStart: selection.start, selectionEnd: selection.end,
      cursor: this.model ? this.seconds(this.model.cursor) : 0,
      canUndo: Boolean(this.model?.canUndo), canRedo: Boolean(this.model?.canRedo), canPaste: Boolean(this.model?.canPaste),
      hasSelection: Boolean(this.model && this.model.selection.end > this.model.selection.start),
      transforms: {...this.transforms}, loop: this.session.id('loop').checked,
      peaks: this.overview(), markers: this.model?.markers.map(frame => this.seconds(frame)) || [],
      status: this.status, progress: this.progress,
    };
  }

  update({fields = true} = {}) {
    const snapshot = this.snapshot();
    if (fields) {
      for (const [id, value] of [['trim-start', snapshot.selectionStart], ['trim-end', snapshot.selectionEnd]]) {
        const input = this.session.id(id);
        if (document.activeElement !== input) input.value = String(value);
        input.max = String(snapshot.duration);
      }
    }
    this.ui.update(snapshot);
    this.session.drawClip?.();
  }

  readLegacySelection() {
    if (!this.model) return;
    const start = Number(this.session.id('trim-start').value), end = Number(this.session.id('trim-end').value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > this.duration + 0.002) {
      throw new Error('Choose a non-empty selection inside the edited recording.');
    }
    // A collapsed selection after a cut is a cursor, not an empty project.
    // Play continues through the edited timeline; export includes that timeline.
    if (end === start && this.hasAudio) {
      const cursor = this.frame(start);
      this.model.select(0, this.model.length);
      this.model.seek(cursor);
      this.prepared = null;
      this.update();
      return;
    }
    const first = this.frame(start), last = Math.min(this.model.length, this.frame(end));
    if (last <= first) throw new Error('Select at least one sample of audio.');
    if (first !== this.model.selection.start || last !== this.model.selection.end) {
      this.model.select(first, last);
      this.model.seek(first);
      this.prepared = null;
    }
  }

  async selectSeconds(start, end) {
    this.session.requireIdle();
    if (!this.model) return;
    if (![start, end].every(Number.isFinite) || start < 0 || end < start || end > this.duration + 0.002) throw new Error('Selection must stay inside the edited recording.');
    const resume = this.playing;
    this.stop({reset: false});
    this.model.select(this.frame(start), this.frame(Math.min(end, this.duration)));
    this.model.seek(this.model.selection.start);
    this.prepared = null;
    this.update();
    if (resume && this.model.selection.end > this.model.selection.start) await this.play();
  }

  async seekSeconds(seconds) {
    this.session.requireIdle();
    if (!this.model || !Number.isFinite(seconds)) return;
    const resume = this.playing;
    this.stop({reset: false});
    const frame = clamp(this.frame(seconds), 0, this.model.length);
    if (frame < this.model.selection.start || frame >= this.model.selection.end) {
      this.model.select(0, this.model.length);
      this.prepared = null;
    }
    this.model.seek(frame);
    this.update();
    if (resume && this.hasAudio) await this.play();
  }

  async changeTransforms(values) {
    this.session.requireIdle();
    const next = normalizeTimePitchSettings(values);
    if (this.hasAudio) getTimePitchPlan({length: this.model.selection.end - this.model.selection.start || this.model.length,
      sampleRate: this.source.sampleRate, numberOfChannels: this.source.numberOfChannels}, next);
    const resume = this.playing;
    this.captureCursor();
    this.stop({reset: false});
    this.transforms = next;
    this.prepared = null;
    this.status = 'Timing applies to playback and rendered audio. Original download stays unchanged.';
    this.update();
    if (resume && this.hasAudio) await this.play();
  }

  async setLoop(value) {
    this.session.requireIdle();
    const resume = this.playing;
    this.captureCursor();
    this.stop({reset: false});
    this.session.id('loop').checked = Boolean(value);
    this.update();
    if (resume) await this.play();
  }

  async action(action) {
    if (action === 'stop') { this.stop(); return; }
    if (action === 'pause') { this.pause(); return; }
    if (action === 'play') { if (this.playing) this.pause(); else await this.play(); return; }
    if (action === 'reset-transform') { await this.changeTransforms(defaults()); return; }
    this.session.requireIdle();
    if (!this.model) throw new Error('Choose a recording first.');
    const resume = this.playing;
    this.captureCursor();
    if (action !== 'copy') this.stop({reset: false});
    const revision = this.model.revision;
    const changed = this.model.action(action);
    if (this.model.revision !== revision) this.invalidate();
    else if (action === 'select-all') this.prepared = null;
    if (changed) {
      const messages = {
        cut: 'Selection cut. Paste inserts it at the cursor.', copy: 'Selection copied. Click a destination, then Paste.',
        paste: 'Clipboard inserted at the cursor.', keep: 'Kept the selection.', split: 'Chop boundary added. Double-click a region to select it.',
        duplicate: 'Selection duplicated.', reverse: 'Selection reversed. Select all to reverse the whole clip.',
        silence: 'Selection silenced.', 'fade-in': 'Short fade-in applied to the selection.', 'fade-out': 'Short fade-out applied to the selection.',
        undo: 'Edit undone.', redo: 'Edit restored.', reset: 'Source audio restored. Timing controls are unchanged.', 'select-all': 'Whole edited clip selected.',
      };
      this.status = messages[action] || 'Edit applied.';
    }
    this.update();
    this.session.onBusyChange();
    if (resume && action !== 'copy' && this.hasAudio && this.model.selection.end > this.model.selection.start) await this.play();
  }

  cacheKey() {
    return JSON.stringify([this.model.revision, this.model.selection.start, this.model.selection.end, this.transforms]);
  }

  async renderSelection({source = this.source, signal, onProgress = () => {}} = {}) {
    if (!this.model || this.model.selection.end <= this.model.selection.start) throw new Error('Select some audio before playback or export.');
    if (signal?.aborted) throw abortError();
    getTimePitchPlan({length: this.model.selection.end - this.model.selection.start,
      sampleRate: source.sampleRate, numberOfChannels: source.numberOfChannels}, this.transforms);
    onProgress({phase: 'Preparing edited selection', progress: 0});
    const channels = this.model.render(channelViews(source), {start: this.model.selection.start, end: this.model.selection.end});
    const buffer = new AudioBuffer({numberOfChannels: channels.length, length: channels[0].length, sampleRate: source.sampleRate});
    channels.forEach((samples, index) => buffer.copyToChannel(samples, index));
    if (signal?.aborted) throw abortError();
    return transformAudioBuffer(buffer, this.transforms, {signal, onProgress});
  }

  async play() {
    this.session.requireIdle();
    if (!this.hasAudio) throw new Error('Choose a recording with some audio first.');
    this.readLegacySelection();
    this.stop({reset: false});
    const token = this.generation;
    const controller = new AbortController();
    this.prepareAbort = controller;
    this.session.setBusy(true);
    try {
      await this.session.stopLive();
      const context = await this.session.ensureAudio();
      await context.resume();
      if (controller.signal.aborted || token !== this.generation) throw abortError();
      const key = this.cacheKey();
      const buffer = this.prepared?.key === key ? this.prepared.buffer : await this.renderSelection({signal: controller.signal, onProgress: ({phase, progress}) => {
        this.status = phase; this.progress = progress; this.update();
      }});
      if (controller.signal.aborted || token !== this.generation) throw abortError();
      this.prepared = {key, buffer};
      const selection = this.selection();
      let cursor = this.seconds(this.model.cursor);
      if (this.model.cursor < this.model.selection.start || this.model.cursor >= this.model.selection.end) cursor = selection.start;
      const offset = clamp(cursor - selection.start, 0, Math.max(0, buffer.duration - 1 / buffer.sampleRate));
      const source = context.createBufferSource();
      source.buffer = buffer; source.loop = this.session.id('loop').checked;
      source.loopStart = 0; source.loopEnd = buffer.duration;
      source.connect(this.session.state.graph.input);
      this.session.playback = source;
      this.startedAt = context.currentTime + 0.01;
      this.startedOffset = offset;
      this.playedDuration = buffer.duration;
      this.playedStartFrame = this.model.selection.start;
      this.playedFactor = this.factor;
      this.paused = false;
      this.session.setAudition();
      this.session.state.auditionMaster.gain.setTargetAtTime(0.8, context.currentTime, 0.01);
      source.onended = () => this.ended(source);
      if (source.loop) source.start(this.startedAt, offset);
      else source.start(this.startedAt, offset, buffer.duration - offset);
      this.status = source.loop ? 'Looping selection. Click the waveform to seek.' : 'Playing edited selection. Microphone capture is off.';
      this.session.onSourceChange('playback');
      this.tick();
    } catch (error) {
      if (error.name === 'AbortError') this.status = 'Playback preparation stopped.';
      else { this.status = error.message; throw error; }
    } finally {
      if (this.prepareAbort === controller) this.prepareAbort = null;
      this.progress = null;
      this.session.setBusy(false);
      this.update();
    }
  }

  captureCursor() {
    if (!this.playing || !this.model) return;
    const context = this.session.state.context;
    let position = this.startedOffset + Math.max(0, context.currentTime - this.startedAt);
    if (this.session.playback.loop && this.playedDuration > 0) position %= this.playedDuration;
    else position = Math.min(position, this.playedDuration);
    this.model.seek(this.playedStartFrame + Math.round(position / this.playedFactor * this.source.sampleRate));
  }

  tick() {
    cancelAnimationFrame(this.animationFrame);
    if (!this.playing) return;
    this.captureCursor();
    this.ui.update(this.snapshot());
    this.animationFrame = requestAnimationFrame(() => this.tick());
  }

  ended(source) {
    if (this.session.playback !== source) return;
    source.disconnect();
    this.model.seek(this.model.selection.end);
    this.update({fields: false});
    const state = this.session.state;
    this.endTimer = setTimeout(() => {
      if (this.session.playback !== source) return;
      this.session.playback = null;
      cancelAnimationFrame(this.animationFrame);
      state.auditionMaster.gain.setTargetAtTime(0, state.context.currentTime, 0.01);
      this.status = 'Selection finished. Play starts it again.';
      this.paused = false;
      this.session.onSourceChange('clip');
      this.session.onBusyChange();
      this.update();
    }, (state.graph.latencySamples / state.context.sampleRate + Math.abs(state.settings.channelDelayMs) / 1000 + 0.15) * 1000);
  }

  pause() {
    if (!this.playing) return;
    this.captureCursor();
    this.stop({reset: false});
    this.paused = true;
    this.status = 'Paused. Play resumes from the cursor.';
    this.update();
  }

  stop({reset = true} = {}) {
    this.generation++;
    this.prepareAbort?.abort();
    clearTimeout(this.endTimer);
    cancelAnimationFrame(this.animationFrame);
    const source = this.session.playback;
    this.session.playback = null;
    if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    const {auditionMaster, context} = this.session.state;
    if (auditionMaster && context) {
      auditionMaster.gain.cancelScheduledValues(context.currentTime);
      auditionMaster.gain.setValueAtTime(0, context.currentTime);
    }
    if (reset && this.model) this.model.seek(this.model.selection.start);
    this.paused = false;
    if (reset && this.model) this.status = 'Stopped. Original audio is preserved.';
    this.session.id('play-clip').disabled = !this.hasAudio;
    this.session.id('stop-playback').disabled = true;
    if (source) this.session.onSourceChange(this.loaded ? 'clip' : 'idle');
    this.update({fields: false});
  }
}
