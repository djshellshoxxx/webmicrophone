import {EQ_FREQUENCIES} from '../state.js';
import {bandCoefficients, bandHasGain, bandHasQ, clamp, equalizerResponse,
  formatFrequency, frequencyToUnit, magnitudeAt, unitToFrequency} from './eq-response.js';
import './eq-editor.css';

let nextEditorId = 0;
const TYPES = [
  ['peaking', 'Bell'], ['lowshelf', 'Low shelf'], ['highshelf', 'High shelf'],
  ['notch', 'Notch'], ['highpass', 'High pass'], ['lowpass', 'Low pass'],
];
const PLOT = {left: 38, right: 18, top: 22, bottom: 28};

/** Editable ten-band EQ. The settings object belongs to the caller. */
export class EqEditor {
  constructor(container, {getSettings, onChange}) {
    this.container = container;
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.selected = 0;
    this.graph = null;
    this.frame = 0;
    this.destroyed = false;
    this.cleanups = [];
    this.drag = null;
    this.pendingSettings = null;
    this.emitFrame = 0;
    const id = `eq-editor-${++nextEditorId}`;
    container.classList.add('eq-workbench');
    container.innerHTML = `
      <div class="eq-toolbar"><div class="eq-toolbar-group">
        <button type="button" data-action="bypass" aria-pressed="true">EQ enabled</button>
        <span class="eq-summary">10 BANDS · ±18 dB · 20 Hz–20 kHz</span>
      </div><button type="button" data-action="reset-all">Reset EQ</button></div>
      <div class="eq-plot">
        <canvas aria-label="Equalizer frequency response" role="img"></canvas>
        <div class="eq-node-layer">${Array.from({length: 10}, (_, i) =>
          `<button type="button" class="eq-node" data-band="${i}" aria-describedby="${id}-help" aria-pressed="${i === 0}">${i + 1}</button>`).join('')}</div>
      </div>
      <p id="${id}-help" class="eq-plot-help">Drag a point for frequency and gain. Scroll over it for Q. Focus a point and use arrow keys; hold Shift for fine control. Every value is editable below.</p>
      <div class="eq-faders" aria-label="Ten EQ band gains">${Array.from({length: 10}, (_, i) => `
        <div class="eq-fader" data-fader="${i}">
          <button type="button" class="eq-band-select" data-select="${i}" aria-label="Select band ${i + 1}"></button>
          <input type="range" data-gain="${i}" min="-18" max="18" value="0" step="0.1" aria-label="Band ${i + 1} gain in decibels" aria-orientation="vertical">
          <output data-gain-value="${i}">0.0</output>
        </div>`).join('')}</div>
      <div class="eq-band-controls">
        <label class="eq-field">Band<select data-control="band" aria-label="Selected EQ band">${Array.from({length: 10}, (_, i) => `<option value="${i}">${i + 1}</option>`).join('')}</select></label>
        <label class="eq-field">Filter<select data-control="type" aria-label="Selected band filter type">${TYPES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
        <label class="eq-field">Frequency · Hz<input data-control="frequency" type="number" min="20" max="20000" step="1" value="1000" aria-label="Selected band frequency in hertz"></label>
        <label class="eq-field">Gain · dB<input data-control="gain" type="number" min="-18" max="18" step="0.1" value="0" aria-label="Selected band gain in decibels"></label>
        <label class="eq-field">Q<input data-control="q" type="number" min="0.1" max="20" step="0.05" value="1" aria-label="Selected band Q"></label>
      </div>
      <div class="eq-actions">
        <button type="button" data-action="enabled" aria-pressed="true">Band enabled</button>
        <button type="button" data-action="solo" aria-pressed="false">Solo band</button>
        <button type="button" data-action="reset-band">Reset band</button>
        <span class="eq-band-description"></span>
      </div>`;
    this.canvas = container.querySelector('canvas');
    this.plot = container.querySelector('.eq-plot');
    this.nodes = Array.from(container.querySelectorAll('.eq-node'));
    this.faders = Array.from(container.querySelectorAll('.eq-fader'));
    this.controls = Object.fromEntries(Array.from(container.querySelectorAll('[data-control]'))
      .map(element => [element.dataset.control, element]));
    this.actions = Object.fromEntries(Array.from(container.querySelectorAll('[data-action]'))
      .map(element => [element.dataset.action, element]));
    this.description = container.querySelector('.eq-band-description');
    this._bind();
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._scheduleDraw()) : null;
    this.resizeObserver?.observe(this.plot);
    this.refresh();
  }

  _listen(target, event, listener, options) {
    target.addEventListener(event, listener, options);
    this.cleanups.push(() => target.removeEventListener(event, listener, options));
  }

  _settings() { return this.pendingSettings || this.getSettings(); }
  _sampleRate() { return this.graph?.inputAnalyser?.context?.sampleRate || this.graph?.rawAnalyser?.context?.sampleRate || 48000; }
  _maxFrequency() { return Math.min(20000, this._sampleRate() * 0.49); }

  _bind() {
    this.nodes.forEach((node, index) => {
      this._listen(node, 'pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        this.selectBand(index);
        node.focus({preventScroll: true});
        node.setPointerCapture(event.pointerId);
        node.classList.add('dragging');
        this.drag = {index, pointerId: event.pointerId};
      });
      this._listen(node, 'pointermove', event => {
        if (!this.drag || this.drag.pointerId !== event.pointerId) return;
        const bounds = this.plot.getBoundingClientRect();
        const width = bounds.width - PLOT.left - PLOT.right;
        const height = bounds.height - PLOT.top - PLOT.bottom;
        const frequency = unitToFrequency((event.clientX - bounds.left - PLOT.left) / width, this._maxFrequency());
        const gain = clamp(18 - (event.clientY - bounds.top - PLOT.top) / height * 36, -18, 18);
        const patch = {frequency: Math.round(frequency * 10) / 10};
        if (bandHasGain(this._settings().eq[index].type)) patch.gain = Math.round(gain * 10) / 10;
        this._updateBand(index, patch, true);
      });
      const endDrag = () => {
        this.drag = null;
        node.classList.remove('dragging');
        this._flushPending();
      };
      this._listen(node, 'pointerup', endDrag);
      this._listen(node, 'pointercancel', endDrag);
      this._listen(node, 'lostpointercapture', endDrag);
      this._listen(node, 'click', () => this.selectBand(index));
      this._listen(node, 'focus', () => this.selectBand(index));
      this._listen(node, 'dblclick', () => this.resetBand(index));
      this._listen(node, 'wheel', event => {
        if (!bandHasQ(this._settings().eq[index].type)) return;
        event.preventDefault();
        this.selectBand(index);
        const q = this._settings().eq[index].q * Math.exp(-Math.sign(event.deltaY) * (event.shiftKey ? 0.025 : 0.12));
        this._updateBand(index, {q: Math.round(clamp(q, 0.1, 20) * 100) / 100}, true);
      }, {passive: false});
      this._listen(node, 'keydown', event => this._nodeKey(event, index));
    });
    this.faders.forEach((fader, index) => {
      const input = fader.querySelector('input');
      this._listen(fader.querySelector('button'), 'click', () => this.selectBand(index));
      this._listen(input, 'focus', () => this.selectBand(index));
      this._listen(input, 'input', () => this._updateBand(index, {gain: Number(input.value)}));
      this._listen(input, 'dblclick', () => this._updateBand(index, {gain: 0}));
    });
    this._listen(this.controls.band, 'change', () => this.selectBand(Number(this.controls.band.value)));
    this._listen(this.controls.type, 'change', () => {
      const type = this.controls.type.value;
      this._updateBand(this.selected, bandHasGain(type) ? {type} : {type, gain: 0});
    });
    for (const [name, min, max] of [['frequency', 20, 20000], ['gain', -18, 18], ['q', 0.1, 20]]) {
      const input = this.controls[name];
      this._listen(input, 'change', () => {
        const value = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(value)) { this.refresh(true); return; }
        this._updateBand(this.selected, {[name]: clamp(value, min, name === 'frequency' ? this._maxFrequency() : max)});
        this.refresh(true);
      });
      this._listen(input, 'blur', () => this.refresh(true));
    }
    this._listen(this.actions.bypass, 'click', () => this._update(settings => { settings.eqEnabled = !settings.eqEnabled; }));
    this._listen(this.actions.enabled, 'click', () => this._updateBand(this.selected, {enabled: !this._settings().eq[this.selected].enabled}));
    this._listen(this.actions.solo, 'click', () => this._update(settings => { settings.soloBand = settings.soloBand === this.selected ? -1 : this.selected; }));
    this._listen(this.actions['reset-band'], 'click', () => this.resetBand(this.selected));
    this._listen(this.actions['reset-all'], 'click', () => this._update(settings => {
      settings.eq = EQ_FREQUENCIES.map(frequency => ({frequency, gain: 0, q: 1, type: 'peaking', enabled: true}));
      settings.eqEnabled = true;
      settings.soloBand = -1;
    }));
  }

  _nodeKey(event, index) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '[', ']', 'Home'].includes(event.key)) return;
    event.preventDefault();
    this.selectBand(index);
    const band = this._settings().eq[index];
    if (event.key === 'Home') { this.resetBand(index); return; }
    const patch = {};
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const step = event.shiftKey ? 1 / 96 : 1 / 12;
      patch.frequency = Math.round(clamp(band.frequency * 2 ** (step * (event.key === 'ArrowRight' ? 1 : -1)), 20, this._maxFrequency()) * 10) / 10;
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && bandHasGain(band.type)) {
      patch.gain = Math.round(clamp(band.gain + (event.shiftKey ? 0.1 : 0.5) * (event.key === 'ArrowUp' ? 1 : -1), -18, 18) * 10) / 10;
    } else if ((event.key === '[' || event.key === ']') && bandHasQ(band.type)) {
      patch.q = Math.round(clamp(band.q * (event.key === ']' ? 1.1 : 1 / 1.1), 0.1, 20) * 100) / 100;
    }
    this._updateBand(index, patch);
  }

  _updateBand(index, patch, batched = false) {
    this._update(settings => Object.assign(settings.eq[index], patch), batched);
  }

  _update(edit, batched = false) {
    const next = structuredClone(this._settings());
    edit(next);
    next.scene = 'custom';
    this.pendingSettings = next;
    this.refresh();
    if (batched) {
      if (!this.emitFrame) this.emitFrame = requestAnimationFrame(() => this._flushPending());
    } else this._flushPending();
  }

  _flushPending() {
    if (this.emitFrame) cancelAnimationFrame(this.emitFrame);
    this.emitFrame = 0;
    if (!this.pendingSettings) return;
    const next = this.pendingSettings;
    this.pendingSettings = null;
    this.onChange(next);
    this.refresh();
  }

  selectBand(index) {
    this.selected = clamp(Math.round(index), 0, 9);
    this.refresh(true);
  }

  resetBand(index) {
    this._updateBand(index, {frequency: EQ_FREQUENCIES[index], gain: 0, q: 1, type: 'peaking', enabled: true});
  }

  refresh(force = false) {
    if (this.destroyed) return;
    const settings = this._settings(), selected = settings.eq[this.selected];
    this.controls.band.value = String(this.selected);
    this.controls.type.value = selected.type;
    for (const name of ['frequency', 'gain', 'q']) {
      const input = this.controls[name];
      if (force || document.activeElement !== input) input.value = String(Math.round(selected[name] * 100) / 100);
    }
    this.controls.frequency.max = String(this._maxFrequency());
    this.controls.gain.disabled = !bandHasGain(selected.type);
    this.controls.q.disabled = !bandHasQ(selected.type);
    this.actions.bypass.setAttribute('aria-pressed', String(settings.eqEnabled));
    this.actions.bypass.textContent = settings.eqEnabled ? 'EQ enabled' : 'EQ bypassed';
    this.actions.enabled.setAttribute('aria-pressed', String(selected.enabled));
    this.actions.enabled.textContent = selected.enabled ? 'Band enabled' : 'Band bypassed';
    this.actions.solo.setAttribute('aria-pressed', String(settings.soloBand === this.selected));
    this.actions.solo.textContent = settings.soloBand === this.selected ? 'Solo active' : 'Solo band';
    this.description.textContent = ['lowshelf', 'highshelf'].includes(selected.type) ? 'Shelf slope is fixed; Q is not used.' :
      !bandHasGain(selected.type) ? 'Cutoff / notch filter · gain is not used.' : 'Q: lower = wider, higher = narrower.';
    this.nodes.forEach((node, index) => {
      const band = settings.eq[index];
      node.setAttribute('aria-pressed', String(index === this.selected));
      node.dataset.enabled = String(band.enabled && settings.eqEnabled);
      node.setAttribute('aria-label', `Band ${index + 1}, ${band.type}, ${Math.round(band.frequency)} hertz${bandHasGain(band.type) ? `, ${band.gain.toFixed(1)} decibels` : ''}${bandHasQ(band.type) ? `, Q ${band.q.toFixed(2)}` : ''}${band.enabled ? '' : ', bypassed'}`);
      const fader = this.faders[index], input = fader.querySelector('input');
      fader.dataset.selected = String(index === this.selected);
      fader.querySelector('button').textContent = formatFrequency(band.frequency);
      input.value = String(band.gain);
      input.disabled = !bandHasGain(band.type);
      input.setAttribute('aria-valuetext', `${band.gain.toFixed(1)} decibels at ${Math.round(band.frequency)} hertz`);
      fader.querySelector('output').textContent = bandHasGain(band.type) ? `${band.gain > 0 ? '+' : ''}${band.gain.toFixed(1)}` : '—';
    });
    this._scheduleDraw();
  }

  setGraph(graph) {
    this.graph = graph;
    this.refresh();
  }

  _scheduleDraw() {
    if (this.destroyed) return;
    this.drawUntil = performance.now() + 160;
    if (!this.frame) this.frame = requestAnimationFrame(() => this._draw());
  }

  _draw() {
    this.frame = 0;
    if (this.destroyed) return;
    const rect = this.plot.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const width = rect.width, height = rect.height, ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const plotWidth = width - PLOT.left - PLOT.right, plotHeight = height - PLOT.top - PLOT.bottom;
    const max = this._maxFrequency(), settings = this._settings();
    const x = frequency => PLOT.left + frequencyToUnit(frequency, max) * plotWidth;
    const y = gain => PLOT.top + (18 - clamp(gain, -18, 18)) / 36 * plotHeight;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (const gain of [-18, -12, -6, 0, 6, 12, 18]) {
      const py = y(gain);
      ctx.strokeStyle = gain === 0 ? '#4b545f' : '#242b34';
      ctx.beginPath(); ctx.moveTo(PLOT.left, py); ctx.lineTo(width - PLOT.right, py); ctx.stroke();
      ctx.fillStyle = '#8a929e'; ctx.textAlign = 'right'; ctx.fillText(gain > 0 ? `+${gain}` : String(gain), PLOT.left - 8, py);
    }
    const ticks = width < 500 ? [20, 100, 1000, 10000, 20000] : [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    for (const frequency of ticks.filter(value => value <= max)) {
      const px = x(frequency);
      ctx.strokeStyle = '#242b34'; ctx.beginPath(); ctx.moveTo(px, PLOT.top); ctx.lineTo(px, height - PLOT.bottom); ctx.stroke();
      ctx.fillStyle = '#8a929e'; ctx.textAlign = 'center'; ctx.fillText(formatFrequency(frequency), px, height - 12);
    }
    const count = Math.max(128, Math.min(640, Math.round(plotWidth)));
    const frequencies = Float32Array.from({length: count}, (_, i) => unitToFrequency(i / (count - 1), max));
    let magnitude;
    if (this.graph?.getFrequencyResponse && !this.pendingSettings) {
      try { magnitude = this.graph.getFrequencyResponse(frequencies).magnitude; } catch { /* mathematical fallback remains available */ }
    }
    if (!magnitude || magnitude.length !== count) magnitude = equalizerResponse(settings, frequencies, this._sampleRate());
    const points = Array.from(magnitude, (value, i) => [PLOT.left + i / (count - 1) * plotWidth, y(20 * Math.log10(Math.max(1e-12, value)))]);
    ctx.save();
    ctx.beginPath(); ctx.rect(PLOT.left, PLOT.top, plotWidth, plotHeight); ctx.clip();
    ctx.beginPath(); ctx.moveTo(PLOT.left, y(0));
    for (const point of points) ctx.lineTo(...point);
    ctx.lineTo(width - PLOT.right, y(0)); ctx.closePath();
    ctx.fillStyle = settings.eqEnabled ? '#e8532a15' : '#8a929e0c'; ctx.fill();
    const selected = settings.eq[this.selected];
    if (settings.eqEnabled && selected.enabled) {
      const coefficients = bandCoefficients(selected, this._sampleRate());
      ctx.beginPath();
      frequencies.forEach((frequency, i) => {
        const px = PLOT.left + i / (count - 1) * plotWidth;
        const py = y(20 * Math.log10(Math.max(1e-12, magnitudeAt(coefficients, frequency, this._sampleRate()))));
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = '#4fb6c488'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.beginPath(); points.forEach((point, i) => i === 0 ? ctx.moveTo(...point) : ctx.lineTo(...point));
    ctx.strokeStyle = settings.eqEnabled ? '#e8532a' : '#8a929e'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#9ca5b2'; ctx.textAlign = 'left'; ctx.fillText('EQ RESPONSE', PLOT.left, 10);
    ctx.textAlign = 'right'; ctx.fillText(settings.soloBand >= 0 ? `SOLO ${settings.soloBand + 1} · audition` : 'gain · dB', width - PLOT.right, 10);
    this.nodes.forEach((node, index) => {
      const band = settings.eq[index];
      node.style.left = `${x(band.frequency)}px`;
      node.style.top = `${y(bandHasGain(band.type) ? band.gain : 0)}px`;
    });
    if (performance.now() < this.drawUntil) this.frame = requestAnimationFrame(() => this._draw());
  }

  destroy() {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.emitFrame) cancelAnimationFrame(this.emitFrame);
    this.resizeObserver?.disconnect();
    this.cleanups.forEach(cleanup => cleanup());
    this.pendingSettings = null;
    this.graph = null;
  }
}

