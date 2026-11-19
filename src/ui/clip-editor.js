let editorSequence = 0;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const seconds = value => `${Math.max(0, finite(value)).toFixed(2)} s`;
const SELECTION_ACTIONS = new Set(['cut', 'copy', 'keep', 'reverse', 'duplicate', 'silence', 'fade-in', 'fade-out']);
const TRANSFORMS = {
  speed: {label: 'Speed', unit: '×', min: 0.5, max: 2, step: 0.01, default: 1, scale: 1, hint: 'Tape speed · pitch and duration change together.'},
  stretch: {label: 'Stretch', unit: '%', min: 50, max: 200, step: 1, default: 1, scale: 100, hint: 'Duration · keeps the pitch.'},
  pitchSemitones: {label: 'Pitch', unit: 'st', min: -12, max: 12, step: 0.1, default: 0, scale: 1, hint: 'Semitones · keeps the duration.'},
};

/**
 * Presentation-only clip editor. The caller owns every audio/edit/transport state.
 * update(snapshot) accepts the contract in docs/specs/13-compact-clip-editor.md.
 * duration, selectionStart/End, cursor and markers are displayed timeline seconds;
 * transforms.stretch is a duration ratio (0.5–2), displayed here as 50–200%.
 * peaks.minimum/maximum are read-only, uniformly spaced min/max bins. No waveform
 * is synthesized when bins are absent. Callbacks receive requested actions only.
 * Drag emits onSelection(start,end); click/arrow keys emit onSeek(seconds).
 * Range changes commit on release; number fields commit on change. destroy()
 * detaches listeners and cancels queued drawing without touching caller audio.
 */
export class ClipEditor {
  constructor(host, {onAction = () => {}, onSelection = () => {}, onSeek = () => {}, onTransform = () => {}, onLoop = () => {}} = {}) {
    this.host = host;
    this.callbacks = {onAction, onSelection, onSeek, onTransform, onLoop};
    this.snapshot = {};
    this.listeners = [];
    this.drag = null;
    this.frame = 0;
    this.seekTimer = 0;
    this.pendingSeek = null;
    this.destroyed = false;
    const id = `compact-clip-${++editorSequence}`;
    const button = (action, label, title = '') => `<button type="button" data-clip-action="${action}"${title ? ` title="${title}"` : ''}>${label}</button>`;
    host.innerHTML = `<div class="clip-editor-ui">
      <div class="clip-editor-heading"><h2><span>04</span> Clip editor</h2><span class="clip-editor-state" data-clip-state>NO CLIP</span></div>
      <p class="clip-editor-label" data-clip-label>No clip selected</p>
      <div class="clip-editor-wave"><canvas tabindex="0" role="slider" aria-label="Clip cursor in seconds" aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-describedby="${id}-wave-help"></canvas><span class="clip-editor-wave-empty" data-clip-empty>Open audio or select a take</span></div>
      <div class="clip-editor-timebar"><output data-clip-cursor>0.00 s</output><span>/</span><output data-clip-duration>0.00 s</output><span data-clip-selection-duration>0.00 s selected</span></div>
      <div class="clip-editor-transport">${button('play', 'Play')}${button('pause', 'Pause')}${button('stop', 'Stop')}</div>
      <div class="clip-editor-options"><label><input type="checkbox" data-clip-loop> Loop selection</label><span>EDITED AUDIO</span></div>
      <div class="clip-editor-fields">
        <label class="clip-editor-field">Selection start / s<input type="number" min="0" step="0.01" value="0" data-clip-input="start" aria-label="Editor selection start in seconds"></label>
        <label class="clip-editor-field">Selection end / s<input type="number" min="0" step="0.01" value="0" data-clip-input="end" aria-label="Editor selection end in seconds"></label>
        <label class="clip-editor-field">Cursor / s<input type="number" min="0" step="0.01" value="0" data-clip-input="cursor" aria-label="Editor cursor in seconds"></label>
        ${button('select-all', 'Select all')}
      </div>
      <div class="clip-editor-tabs" role="tablist" aria-label="Clip editing tools"><button type="button" role="tab" id="${id}-edit-tab" aria-selected="true" aria-controls="${id}-edit" data-clip-tab="edit">Edit</button><button type="button" role="tab" id="${id}-time-tab" aria-selected="false" tabindex="-1" aria-controls="${id}-time" data-clip-tab="time">Time / pitch</button></div>
      <div id="${id}-edit" role="tabpanel" aria-labelledby="${id}-edit-tab" data-clip-panel="edit">
        <div class="clip-editor-actions">${button('split', 'Split', 'Create a boundary at the cursor')}${button('cut', 'Cut')}${button('copy', 'Copy')}${button('paste', 'Paste', 'Insert copied audio at the cursor')}${button('keep', 'Keep', 'Keep only the selection')}${button('reverse', 'Reverse', 'Reverse selected audio')}</div>
        <details class="clip-editor-more"><summary>More edits</summary><div class="clip-editor-actions">${button('duplicate', 'Duplicate')}${button('silence', 'Silence')}${button('fade-in', 'Fade in')}${button('fade-out', 'Fade out')}</div></details>
        <div class="clip-editor-actions clip-editor-history">${button('undo', 'Undo')}${button('redo', 'Redo')}${button('reset', 'Reset', 'Restore source audio; this can be undone')}</div>
      </div>
      <div id="${id}-time" role="tabpanel" aria-labelledby="${id}-time-tab" data-clip-panel="time" hidden>
        ${Object.entries(TRANSFORMS).map(([key, field]) => `<div class="clip-editor-transform"><label class="clip-editor-transform-head"><span>${field.label}</span><span class="clip-editor-value"><input type="number" data-clip-transform="${key}" min="${field.min}" max="${field.max}" step="${field.step}" value="${field.default * field.scale}" aria-label="Editor ${field.label.toLowerCase()} ${field.unit === '%' ? 'percent' : field.unit === 'st' ? 'in semitones' : 'multiplier'}">${field.unit}</span></label><input type="range" data-clip-range="${key}" min="${field.min}" max="${field.max}" step="${field.step}" value="${field.default * field.scale}" aria-label="${field.label} adjustment"><p>${field.hint}</p></div>`).join('')}
        ${button('reset-transform', 'Reset time / pitch')}
        <p class="clip-editor-hint">Timing changes may need a moment to prepare. Extreme settings can sound altered.</p>
      </div>
      <p class="clip-editor-hint" id="${id}-wave-help">Click to seek. Drag to select. Double-click a split region. Arrow keys seek 0.1 s; Shift seeks 0.01 s.</p>
      <progress max="1" data-clip-progress hidden aria-label="Preparing edited audio"></progress>
      <p class="clip-editor-status" data-clip-status role="status">Select a take or open audio to edit.</p>
    </div>`;
    this.canvas = host.querySelector('canvas');
    this.actions = Object.fromEntries([...host.querySelectorAll('[data-clip-action]')].map(node => [node.dataset.clipAction, node]));
    this.inputs = Object.fromEntries([...host.querySelectorAll('[data-clip-input]')].map(node => [node.dataset.clipInput, node]));
    this.transformInputs = Object.fromEntries([...host.querySelectorAll('[data-clip-transform]')].map(node => [node.dataset.clipTransform, node]));
    this.transformRanges = Object.fromEntries([...host.querySelectorAll('[data-clip-range]')].map(node => [node.dataset.clipRange, node]));
    this.loopInput = host.querySelector('[data-clip-loop]');
    this._bind();
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._scheduleDraw()) : null;
    this.resizeObserver?.observe(this.canvas);
    this.update({});
  }

  _listen(node, type, handler, options) {
    node.addEventListener(type, handler, options);
    this.listeners.push(() => node.removeEventListener(type, handler, options));
  }

  _bind() {
    for (const [action, node] of Object.entries(this.actions)) this._listen(node, 'click', () => {
      const pending = this.pendingSeek;
      this._cancelPendingSeek();
      if (node.disabled) return;
      // A quick seek then Paste/Split should use the clicked position when idle.
      // Pause/stop cancel it, and playing edits must not queue a
      // second asynchronous preparation before the requested action.
      if (pending !== null && !this.snapshot.playing && !['pause', 'stop'].includes(action) && this._interactive()) this.callbacks.onSeek(pending);
      this.callbacks.onAction(action);
    });
    this._listen(document, 'pointerdown', event => {
      if (event.target === this.canvas) return;
      if (event.target instanceof Element && this.host.contains(event.target) && event.target.closest('[data-clip-action]')) return;
      this._cancelPendingSeek();
    }, true);
    this._listen(document, 'keydown', event => {
      if (event.key === 'Escape' || event.target !== this.canvas) this._cancelPendingSeek();
    }, true);
    for (const [name, input] of Object.entries(this.inputs)) {
      this._listen(input, 'input', () => { this._cancelPendingSeek(); input.setCustomValidity(''); });
      this._listen(input, 'change', () => {
        this._cancelPendingSeek();
        if (!this._interactive()) return;
        const value = this._readNumber(input, 0, this.snapshot.duration);
        if (value === null) return;
        if (name === 'cursor') this.callbacks.onSeek(value);
        else {
          const start = name === 'start' ? value : this.snapshot.selectionStart;
          const end = name === 'end' ? value : this.snapshot.selectionEnd;
          const first = Math.min(start, end), last = Math.max(start, end);
          this.inputs.start.value = first.toFixed(3); this.inputs.end.value = last.toFixed(3);
          this.callbacks.onSelection(first, last);
        }
      });
    }
    for (const [key, field] of Object.entries(TRANSFORMS)) {
      const input = this.transformInputs[key], range = this.transformRanges[key];
      this._listen(input, 'input', () => { this._cancelPendingSeek(); input.setCustomValidity(''); });
      this._listen(range, 'input', () => { this._cancelPendingSeek(); input.value = range.value; });
      for (const control of [input, range]) this._listen(control, 'change', () => {
        this._cancelPendingSeek();
        if (!this._interactive()) return;
        const value = this._readNumber(control, field.min, field.max);
        if (value === null) return;
        input.value = range.value = String(value);
        this.callbacks.onTransform({...this.snapshot.transforms, [key]: value / field.scale});
      });
    }
    this._listen(this.loopInput, 'change', () => {
      this._cancelPendingSeek();
      if (this._interactive()) this.callbacks.onLoop(this.loopInput.checked);
    });
    const tabs = [...this.host.querySelectorAll('[data-clip-tab]')];
    for (const tab of tabs) {
      this._listen(tab, 'click', () => this._selectTab(tab.dataset.clipTab));
      this._listen(tab, 'keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(tabs.indexOf(tab) + 1) % tabs.length];
        this._selectTab(next.dataset.clipTab); next.focus();
      });
    }
    this._listen(this.canvas, 'pointerdown', event => {
      this._cancelPendingSeek();
      if (event.button !== 0 || !this._interactive()) return;
      event.preventDefault();
      this.canvas.focus({preventScroll: true});
      this.canvas.setPointerCapture(event.pointerId);
      const time = this._timeAt(event.clientX);
      this.drag = {pointerId: event.pointerId, startX: event.clientX, start: time, end: time, moved: false};
      this._scheduleDraw();
    });
    this._listen(this.canvas, 'pointermove', event => {
      if (this.drag?.pointerId !== event.pointerId) return;
      this.drag.end = this._timeAt(event.clientX);
      this.drag.moved ||= Math.abs(event.clientX - this.drag.startX) > 3;
      this._scheduleDraw();
    });
    this._listen(this.canvas, 'pointerup', event => {
      if (this.drag?.pointerId !== event.pointerId) return;
      const drag = this.drag; this.drag = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (this._interactive()) {
        if (drag.moved) this.callbacks.onSelection(Math.min(drag.start, drag.end), Math.max(drag.start, drag.end));
        else this._deferSeek(this._timeAt(event.clientX));
      }
      this._scheduleDraw();
    });
    for (const type of ['pointercancel', 'lostpointercapture']) this._listen(this.canvas, type, () => { this.drag = null; this._scheduleDraw(); });
    this._listen(this.canvas, 'dblclick', event => {
      this._cancelPendingSeek();
      if (!this._interactive()) return;
      event.preventDefault();
      const time = this._timeAt(event.clientX);
      const boundaries = [0, ...this.snapshot.markers, this.snapshot.duration].sort((a, b) => a - b);
      const endIndex = boundaries.findIndex((boundary, index) => index > 0 && boundary > time);
      const index = endIndex < 0 ? boundaries.length - 1 : endIndex;
      this.callbacks.onSelection(boundaries[index - 1], boundaries[index]);
    });
    this._listen(this.canvas, 'keydown', event => this._key(event));
  }

  _readNumber(input, minimum, maximum) {
    if (input.value.trim() === '' || !Number.isFinite(Number(input.value))) {
      input.setCustomValidity('Enter a finite number.'); input.reportValidity(); return null;
    }
    input.setCustomValidity('');
    const value = clamp(Number(input.value), minimum, maximum);
    input.value = String(value); return value;
  }

  _interactive() { return this.snapshot.loaded && !this.snapshot.busy && !this.snapshot.preparing && this.snapshot.duration > 0; }

  _cancelPendingSeek() {
    clearTimeout(this.seekTimer);
    this.seekTimer = 0; this.pendingSeek = null;
  }

  _deferSeek(seconds) {
    this._cancelPendingSeek();
    this.pendingSeek = seconds;
    this.seekTimer = setTimeout(() => {
      this._cancelPendingSeek();
      if (!this.destroyed && this._interactive()) this.callbacks.onSeek(seconds);
    }, 220);
  }

  _timeAt(clientX) {
    const bounds = this.canvas.getBoundingClientRect();
    return clamp((clientX - bounds.left - 6) / Math.max(1, bounds.width - 12), 0, 1) * this.snapshot.duration;
  }

  _key(event) {
    const pending = this.pendingSeek;
    this._cancelPendingSeek();
    if (event.key === ' ' || event.key === 'Enter') {
      const action = this.snapshot.playing ? 'pause' : 'play';
      if (!this.actions[action].disabled) {
        event.preventDefault();
        if (action === 'play' && pending !== null && this._interactive()) this.callbacks.onSeek(pending);
        this.callbacks.onAction(action);
      }
      return;
    }
    if (!this._interactive()) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault(); this.callbacks.onAction('select-all'); return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.01 : 0.1;
    const cursor = event.key === 'Home' ? 0 : event.key === 'End' ? this.snapshot.duration
      : (pending ?? this.snapshot.cursor) + (event.key === 'ArrowLeft' ? -step : step);
    this.callbacks.onSeek(clamp(cursor, 0, this.snapshot.duration));
  }

  _selectTab(name) {
    this._cancelPendingSeek();
    for (const tab of this.host.querySelectorAll('[data-clip-tab]')) {
      const selected = tab.dataset.clipTab === name;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of this.host.querySelectorAll('[data-clip-panel]')) panel.hidden = panel.dataset.clipPanel !== name;
  }

  update(snapshot = {}) {
    if (this.destroyed) return;
    const duration = Math.max(0, finite(snapshot.duration));
    const transforms = Object.fromEntries(Object.entries(TRANSFORMS).map(([key, field]) => [key,
      clamp(finite(snapshot.transforms?.[key], field.default), field.min / field.scale, field.max / field.scale)]));
    const start = clamp(finite(snapshot.selectionStart), 0, duration), end = clamp(finite(snapshot.selectionEnd, duration), 0, duration);
    const previous = this.snapshot;
    if (this.pendingSeek !== null && (snapshot.busy || snapshot.preparing || !snapshot.loaded || duration !== previous.duration
      || snapshot.label !== previous.label || Boolean(snapshot.playing) !== Boolean(previous.playing)
      || Boolean(snapshot.paused) !== Boolean(previous.paused) || snapshot.status !== previous.status
      || start !== previous.selectionStart || end !== previous.selectionEnd)) this._cancelPendingSeek();
    this.snapshot = {...snapshot, duration, transforms, selectionStart: Math.min(start, end), selectionEnd: Math.max(start, end),
      cursor: clamp(finite(snapshot.cursor), 0, duration), markers: Array.from(snapshot.markers || []).filter(value => Number.isFinite(value) && value > 0 && value < duration),
      hasSelection: snapshot.hasSelection === undefined ? end > start : Boolean(snapshot.hasSelection)};
    const state = this.snapshot;
    const blocked = !state.loaded || state.busy || state.preparing;
    const playable = !blocked && duration > 0;
    this.host.setAttribute('aria-busy', String(Boolean(state.busy || state.preparing)));
    this.host.querySelector('[data-clip-label]').textContent = state.loaded ? String(state.label || 'Edited clip') : 'No clip selected';
    this.host.querySelector('[data-clip-label]').title = state.loaded ? String(state.label || 'Edited clip') : '';
    const stateLabel = this.host.querySelector('[data-clip-state]');
    stateLabel.textContent = state.preparing ? 'PREPARING' : state.playing ? 'PLAYING' : state.paused ? 'PAUSED' : state.loaded ? 'READY' : 'NO CLIP';
    stateLabel.dataset.active = String(Boolean(state.playing));
    const empty = this.host.querySelector('[data-clip-empty]');
    const bins = Math.min(state.peaks?.minimum?.length || 0, state.peaks?.maximum?.length || 0);
    empty.hidden = Boolean(state.loaded && duration > 0 && bins);
    empty.textContent = !state.loaded ? 'Open audio or select a take' : duration <= 0 ? 'Empty timeline · paste or undo' : state.preparing ? 'Preparing waveform…' : 'Waveform not available';
    this.host.querySelector('[data-clip-cursor]').textContent = seconds(state.cursor);
    this.host.querySelector('[data-clip-duration]').textContent = seconds(duration);
    this.host.querySelector('[data-clip-selection-duration]').textContent = `${seconds(state.selectionEnd - state.selectionStart)} selected`;
    for (const [action, button] of Object.entries(this.actions)) {
      let enabled = !blocked;
      if (SELECTION_ACTIONS.has(action)) enabled = enabled && state.hasSelection && duration > 0;
      if (action === 'play') enabled = playable && !state.playing;
      if (action === 'pause') enabled = playable && state.playing;
      if (action === 'stop') enabled = state.playing || state.paused || state.preparing;
      if (action === 'undo') enabled = enabled && state.canUndo;
      if (action === 'redo') enabled = enabled && state.canRedo;
      if (action === 'paste') enabled = enabled && state.canPaste;
      if (action === 'split') enabled = playable && state.cursor > 0 && state.cursor < duration;
      if (action === 'select-all') enabled = playable;
      if (action === 'reset-transform') enabled = enabled && (transforms.speed !== 1 || transforms.stretch !== 1 || transforms.pitchSemitones !== 0);
      button.disabled = !enabled;
    }
    this.actions.play.textContent = state.paused ? 'Resume' : 'Play';
    this.actions.play.classList.add('clip-editor-primary');
    this.actions.stop.textContent = state.preparing ? 'Cancel' : 'Stop';
    for (const [name, input] of Object.entries(this.inputs)) {
      const value = name === 'start' ? state.selectionStart : name === 'end' ? state.selectionEnd : state.cursor;
      input.disabled = !playable; input.max = String(duration);
      if (document.activeElement !== input) input.value = value.toFixed(3);
    }
    for (const [key, field] of Object.entries(TRANSFORMS)) {
      const input = this.transformInputs[key], range = this.transformRanges[key];
      input.disabled = range.disabled = !playable;
      if (document.activeElement !== input && document.activeElement !== range) input.value = range.value = String(Number((transforms[key] * field.scale).toFixed(3)));
    }
    this.loopInput.disabled = !playable; this.loopInput.checked = Boolean(state.loop);
    this.canvas.setAttribute('aria-disabled', String(!playable));
    this.canvas.setAttribute('aria-valuemax', String(duration));
    this.canvas.setAttribute('aria-valuenow', String(state.cursor));
    this.canvas.setAttribute('aria-valuetext', `${seconds(state.cursor)} of ${seconds(duration)}; selection ${seconds(state.selectionStart)} to ${seconds(state.selectionEnd)}`);
    const progress = this.host.querySelector('[data-clip-progress]');
    progress.hidden = !state.preparing;
    if (Number.isFinite(state.progress)) progress.value = clamp(state.progress, 0, 1); else progress.removeAttribute('value');
    const status = state.status || (state.preparing ? 'Preparing edited audio…' : state.busy ? 'Editor unavailable during the current operation.' : state.loaded ? 'Edits stay in this session. Export to keep them.' : 'Select a take or open audio to edit.');
    const statusNode = this.host.querySelector('[data-clip-status]');
    if (statusNode.textContent !== status) statusNode.textContent = status;
    if (blocked && this.drag) this.drag = null;
    this._scheduleDraw();
  }

  _scheduleDraw() {
    if (this.destroyed || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this._draw(); });
  }

  _draw() {
    const bounds = this.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = bounds.width, height = bounds.height;
    const pixelWidth = Math.round(width * pixelRatio), pixelHeight = Math.round(height * pixelRatio);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) { this.canvas.width = pixelWidth; this.canvas.height = pixelHeight; }
    const context = this.canvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0); context.clearRect(0, 0, width, height);
    const state = this.snapshot, left = 6, right = width - 6, top = 7, bottom = height - 19;
    const middle = (top + bottom) / 2, amplitude = (bottom - top) / 2;
    const xAt = time => left + (state.duration ? time / state.duration : 0) * (right - left);
    context.strokeStyle = '#2a303a'; context.lineWidth = 1; context.beginPath();
    context.moveTo(left, middle); context.lineTo(right, middle);
    for (let index = 0; index <= 4; index++) { const x = left + (right - left) * index / 4; context.moveTo(x, top); context.lineTo(x, bottom); }
    context.stroke();
    if (!state.loaded || state.duration <= 0) return;
    const selectionStart = this.drag?.moved ? Math.min(this.drag.start, this.drag.end) : state.selectionStart;
    const selectionEnd = this.drag?.moved ? Math.max(this.drag.start, this.drag.end) : state.selectionEnd;
    if (selectionEnd > selectionStart) { context.fillStyle = '#4fb6c41a'; context.fillRect(xAt(selectionStart), top, xAt(selectionEnd) - xAt(selectionStart), bottom - top); }
    const minimum = state.peaks?.minimum || [], maximum = state.peaks?.maximum || [], count = Math.min(minimum.length, maximum.length);
    context.strokeStyle = '#4fb6c4'; context.lineWidth = 1; context.beginPath();
    const columns = Math.max(1, Math.floor(right - left));
    for (let column = 0; column < columns && count; column++) {
      const first = Math.floor(column / columns * count), last = Math.min(count, Math.max(first + 1, Math.ceil((column + 1) / columns * count)));
      let low = 1, high = -1;
      for (let bin = first; bin < last; bin++) { low = Math.min(low, finite(minimum[bin])); high = Math.max(high, finite(maximum[bin])); }
      const x = left + column + 0.5;
      context.moveTo(x, middle - clamp(high, -1, 1) * amplitude); context.lineTo(x, middle - clamp(low, -1, 1) * amplitude);
    }
    context.stroke();
    context.strokeStyle = '#9ca5b2'; context.setLineDash([2, 3]); context.beginPath();
    for (const marker of state.markers) { const x = xAt(marker); context.moveTo(x, top); context.lineTo(x, bottom); }
    context.stroke(); context.setLineDash([]);
    if (selectionEnd > selectionStart) {
      context.strokeStyle = '#4fb6c4'; context.beginPath();
      for (const time of [selectionStart, selectionEnd]) { const x = xAt(time); context.moveTo(x, top); context.lineTo(x, bottom); }
      context.stroke();
    }
    const cursor = this.drag ? this.drag.moved ? selectionStart : this.drag.start : state.cursor;
    const cursorX = xAt(cursor);
    context.strokeStyle = '#e8532a'; context.lineWidth = 1.5; context.beginPath(); context.moveTo(cursorX, top); context.lineTo(cursorX, bottom); context.stroke();
    context.fillStyle = '#e8532a'; context.beginPath(); context.moveTo(cursorX - 3, top); context.lineTo(cursorX + 3, top); context.lineTo(cursorX, top + 5); context.fill();
    context.fillStyle = '#9ca5b2'; context.font = '9px monospace'; context.textBaseline = 'bottom';
    context.textAlign = 'left'; context.fillText('0 s', left, height - 3);
    context.textAlign = 'center'; context.fillText(seconds(state.duration / 2), (left + right) / 2, height - 3);
    context.textAlign = 'right'; context.fillText(seconds(state.duration), right, height - 3);
  }

  destroy() {
    this.destroyed = true;
    this._cancelPendingSeek();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.listeners.forEach(remove => remove()); this.listeners = [];
    this.drag = null;
  }
}
