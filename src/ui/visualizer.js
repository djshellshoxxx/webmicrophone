import {correlation} from '../analysis.js';
import {measureStereoChannels} from './channel-metrics.js';
import {clamp, formatFrequency} from './eq-response.js';

const COLORS = {grid: '#26303b', text: '#9ca5b2', raw: '#4fb6c4', processed: '#e8532a', background: '#0e1116'};
const FLOOR_DB = -110;
const PLOT = {left: 42, right: 18, top: 28, bottom: 28};

function prepareCanvas(canvas) {
  if (!canvas) return null;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width < 2 || bounds.height < 2) return null;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = bounds.width, height = bounds.height;
  const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);
  ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace';
  ctx.textBaseline = 'middle';
  return {ctx, width, height, plotWidth: width - PLOT.left - PLOT.right, plotHeight: height - PLOT.top - PLOT.bottom};
}

function frequencyTicks(width, maxFrequency) {
  return (width < 500 ? [20, 100, 1000, 10000, 20000] : [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000])
    .filter(value => value <= maxFrequency);
}

function interpolatedDb(data, frequency, sampleRate, fftSize) {
  const bin = frequency * fftSize / sampleRate;
  const lower = Math.min(data.length - 1, Math.floor(bin)), upper = Math.min(data.length - 1, lower + 1);
  const low = Number.isFinite(data[lower]) ? data[lower] : FLOOR_DB;
  const high = Number.isFinite(data[upper]) ? data[upper] : FLOOR_DB;
  return clamp(low + (high - low) * (bin - lower), FLOOR_DB, 0);
}

function makePalette() {
  const stops = [[0, [14, 17, 22]], [0.24, [24, 43, 58]], [0.5, [44, 114, 132]],
    [0.73, [79, 182, 196]], [0.88, [232, 83, 42]], [1, [242, 193, 78]]];
  const palette = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const value = i / 255;
    const upper = Math.max(1, stops.findIndex(stop => stop[0] >= value));
    const [lowAt, low] = stops[upper - 1], [highAt, high] = stops[upper];
    const blend = (value - lowAt) / (highAt - lowAt);
    for (let c = 0; c < 3; c++) palette[i * 3 + c] = Math.round(low[c] + (high[c] - low[c]) * blend);
  }
  return palette;
}

/** Live visuals only: no fabricated waveforms when an analyzer is unavailable.
 * Samples passed to onMetrics are reused transient arrays; copy if retaining.
 */
export class SignalVisualizer {
  constructor({waveform, spectrum, spectrogram, onMetrics = () => {}}) {
    this.canvases = {waveform, spectrum, spectrogram};
    this.onMetrics = onMetrics;
    this.mode = 'all';
    this.channel = 'left';
    this.graph = null;
    this.frame = 0;
    this.lastDraw = 0;
    this.lastMetrics = 0;
    this.destroyed = false;
    this.palette = makePalette();
    this.history = document.createElement('canvas');
    this.column = document.createElement('canvas');
    this.historySeconds = 12;
    this.lastSpectrogram = 0;
    this.spectrogramFraction = 0;
    this.mediaQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.reducedMotion = Boolean(this.mediaQuery?.matches);
    this.onMotionChange = event => { this.reducedMotion = event.matches; };
    this.mediaQuery?.addEventListener?.('change', this.onMotionChange);
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      if (!this.graph) this._drawIdle();
    }) : null;
    for (const canvas of Object.values(this.canvases)) if (canvas) this.resizeObserver?.observe(canvas);
    this._drawIdle();
  }

  setGraph(graph) {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.graph = graph;
    this.lastDraw = this.lastMetrics = this.lastSpectrogram = 0;
    this.spectrogramFraction = 0;
    this.history.width = this.history.height = 0;
    this.inputSamples = this.inputRightSamples = this.rawSamples = this.processedSamples = null;
    this.rawFrequency = this.processedFrequency = this.leftSamples = this.rightSamples = null;
    if (!graph?.rawAnalyser || !graph?.processedAnalyser) { this._drawIdle(); return; }
    this._allocate();
    this.frame = requestAnimationFrame(now => this._tick(now));
  }

  setMode(mode = 'all') {
    if (!['all', 'waveform', 'spectrum', 'spectrogram'].includes(mode)) return;
    this.mode = mode;
    if (!this.graph) this._drawIdle();
  }

  setChannel(channel = 'left') {
    if (!['left', 'right'].includes(channel) || channel === this.channel) return;
    this.channel = channel;
    // Never splice two channel histories into one apparent spectrogram.
    this.history.width = this.history.height = 0;
    this.lastSpectrogram = 0;
    this.spectrogramFraction = 0;
    if (this.graph) this._allocate();
    else this._drawIdle();
  }

  _allocate() {
    const graph = this.graph;
    const input = graph.inputLeftAnalyser || graph.inputAnalyser || graph.rawAnalyser;
    this.rawDisplayAnalyser = this.channel === 'right' ? (graph.rawRightAnalyser || graph.rawAnalyser) : graph.rawAnalyser;
    this.processedDisplayAnalyser = this.channel === 'right' ? (graph.rightAnalyser || graph.processedAnalyser) : graph.processedAnalyser;
    if (!this.inputSamples || this.inputSamples.length !== input.fftSize) this.inputSamples = new Float32Array(input.fftSize);
    if (graph.inputRightAnalyser && (!this.inputRightSamples || this.inputRightSamples.length !== graph.inputRightAnalyser.fftSize)) this.inputRightSamples = new Float32Array(graph.inputRightAnalyser.fftSize);
    if (!this.rawSamples || this.rawSamples.length !== this.rawDisplayAnalyser.fftSize) this.rawSamples = new Float32Array(this.rawDisplayAnalyser.fftSize);
    if (!this.processedSamples || this.processedSamples.length !== this.processedDisplayAnalyser.fftSize) this.processedSamples = new Float32Array(this.processedDisplayAnalyser.fftSize);
    if (!this.rawFrequency || this.rawFrequency.length !== this.rawDisplayAnalyser.frequencyBinCount) this.rawFrequency = new Float32Array(this.rawDisplayAnalyser.frequencyBinCount);
    if (!this.processedFrequency || this.processedFrequency.length !== this.processedDisplayAnalyser.frequencyBinCount) this.processedFrequency = new Float32Array(this.processedDisplayAnalyser.frequencyBinCount);
    if (graph.leftAnalyser && (!this.leftSamples || this.leftSamples.length !== graph.leftAnalyser.fftSize)) this.leftSamples = new Float32Array(graph.leftAnalyser.fftSize);
    if (graph.rightAnalyser && (!this.rightSamples || this.rightSamples.length !== graph.rightAnalyser.fftSize)) this.rightSamples = new Float32Array(graph.rightAnalyser.fftSize);
    this.sampleRate = input.context?.sampleRate || 48000;
    this.maxFrequency = Math.min(20000, this.sampleRate / 2);
  }

  _tick(now) {
    this.frame = 0;
    if (this.destroyed || !this.graph) return;
    this.frame = requestAnimationFrame(time => this._tick(time));
    const interval = document.hidden || this.reducedMotion ? 100 : 1000 / 30;
    if (now - this.lastDraw < interval) return;
    this.lastDraw = now;
    this._allocate();
    const graph = this.graph;
    try {
      (graph.inputLeftAnalyser || graph.inputAnalyser || graph.rawAnalyser).getFloatTimeDomainData(this.inputSamples);
      if (graph.inputRightAnalyser) graph.inputRightAnalyser.getFloatTimeDomainData(this.inputRightSamples);
      this.rawDisplayAnalyser.getFloatTimeDomainData(this.rawSamples);
      this.processedDisplayAnalyser.getFloatTimeDomainData(this.processedSamples);
      this.rawDisplayAnalyser.getFloatFrequencyData(this.rawFrequency);
      this.processedDisplayAnalyser.getFloatFrequencyData(this.processedFrequency);
      if (graph.leftAnalyser) graph.leftAnalyser.getFloatTimeDomainData(this.leftSamples);
      if (graph.rightAnalyser) graph.rightAnalyser.getFloatTimeDomainData(this.rightSamples);
    } catch {
      // A disconnect can happen between a UI action and the next animation frame.
      this.setGraph(null);
      return;
    }
    if (!document.hidden) {
      if (this.mode === 'all' || this.mode === 'waveform') this._drawWaveform();
      if (this.mode === 'all' || this.mode === 'spectrum') this._drawSpectrum();
      if (this.mode === 'all' || this.mode === 'spectrogram') this._drawSpectrogram(now);
    }
    if (now - this.lastMetrics >= 100) {
      this.lastMetrics = now;
      this.onMetrics({
        input: measureStereoChannels(this.inputSamples, this.inputRightSamples || this.inputSamples),
        processed: measureStereoChannels(this.leftSamples || this.processedSamples, this.rightSamples || this.processedSamples),
        rawSamples: this.inputSamples, processedSamples: this.processedSamples,
        displayChannel: this.channel,
        correlation: this.leftSamples && this.rightSamples ? correlation(this.leftSamples, this.rightSamples) : null,
        sampleRate: this.sampleRate,
      });
    }
  }

  _drawIdle() {
    for (const [name, canvas] of Object.entries(this.canvases)) {
      if (this.mode !== 'all' && this.mode !== name) continue;
      const chart = prepareCanvas(canvas);
      if (!chart) continue;
      const {ctx, width, height} = chart;
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      for (let x = PLOT.left; x < width - PLOT.right; x += 64) {
        ctx.beginPath(); ctx.moveTo(x, PLOT.top); ctx.lineTo(x, height - PLOT.bottom); ctx.stroke();
      }
      for (let y = PLOT.top; y < height - PLOT.bottom; y += 40) {
        ctx.beginPath(); ctx.moveTo(PLOT.left, y); ctx.lineTo(width - PLOT.right, y); ctx.stroke();
      }
      ctx.fillStyle = COLORS.text; ctx.textAlign = 'center';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Connect a microphone or open audio to see the signal.', width / 2, height / 2);
      ctx.font = '10px ui-monospace, monospace';
      const channel = this.channel.toUpperCase();
      ctx.textAlign = 'left'; ctx.fillText(name === 'spectrogram' ? `PROCESSED ${channel} · SPECTROGRAM` : `${channel} CHANNEL · ORIGINAL / PROCESSED`, PLOT.left, 12);
    }
  }

  _drawWaveform() {
    const chart = prepareCanvas(this.canvases.waveform);
    if (!chart) return;
    const {ctx, width, height, plotWidth, plotHeight} = chart;
    const laneHeight = plotHeight / 2;
    const durationMs = this.rawSamples.length / this.sampleRate * 1000;
    ctx.textAlign = 'left'; ctx.fillStyle = COLORS.raw;
    const channel = this.channel.toUpperCase();
    ctx.fillText(`ORIGINAL ${channel} · aligned`, PLOT.left, 12);
    ctx.fillStyle = COLORS.processed;
    ctx.fillText(`PROCESSED ${channel}`, Math.min(width - 110, PLOT.left + 190), 12);
    ctx.textAlign = 'right'; ctx.fillStyle = COLORS.text;
    if (width >= 500) ctx.fillText('amplitude', width - PLOT.right, 12);
    for (let tick = 0; tick <= 4; tick++) {
      const x = PLOT.left + tick / 4 * plotWidth;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath(); ctx.moveTo(x, PLOT.top); ctx.lineTo(x, height - PLOT.bottom); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = COLORS.text;
      ctx.fillText(`${(durationMs * tick / 4).toFixed(0)} ms`, x, height - 12);
    }
    const drawLane = (samples, lane, color) => {
      const center = PLOT.top + laneHeight * (lane + 0.5), amplitude = laneHeight * 0.4;
      ctx.strokeStyle = COLORS.grid;
      for (const value of [-1, 0, 1]) {
        const y = center - value * amplitude;
        ctx.beginPath(); ctx.moveTo(PLOT.left, y); ctx.lineTo(width - PLOT.right, y); ctx.stroke();
        ctx.fillStyle = COLORS.text; ctx.textAlign = 'right'; ctx.fillText(value > 0 ? '+1' : String(value), PLOT.left - 8, y);
      }
      ctx.save(); ctx.beginPath(); ctx.rect(PLOT.left, PLOT.top + lane * laneHeight, plotWidth, laneHeight); ctx.clip();
      ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.beginPath();
      const columns = Math.max(1, Math.floor(plotWidth));
      for (let column = 0; column < columns; column++) {
        const start = Math.floor(column * samples.length / columns);
        const end = Math.max(start + 1, Math.floor((column + 1) * samples.length / columns));
        let low = 1e10, high = -1e10;
        for (let frame = start; frame < end && frame < samples.length; frame++) {
          low = Math.min(low, samples[frame]); high = Math.max(high, samples[frame]);
        }
        const x = PLOT.left + column;
        ctx.moveTo(x, center - clamp(low, -1.3, 1.3) * amplitude);
        ctx.lineTo(x, center - clamp(high, -1.3, 1.3) * amplitude);
      }
      ctx.stroke(); ctx.restore();
    };
    drawLane(this.rawSamples, 0, COLORS.raw);
    drawLane(this.processedSamples, 1, COLORS.processed);
  }

  _drawSpectrum() {
    const chart = prepareCanvas(this.canvases.spectrum);
    if (!chart) return;
    const {ctx, width, height, plotWidth, plotHeight} = chart;
    const xAt = frequency => PLOT.left + Math.log(frequency / 20) / Math.log(this.maxFrequency / 20) * plotWidth;
    const yAt = db => PLOT.top + clamp(-db / -FLOOR_DB, 0, 1) * plotHeight;
    ctx.lineWidth = 1;
    for (const value of [0, -20, -40, -60, -80, -100]) {
      const y = yAt(value);
      ctx.strokeStyle = COLORS.grid; ctx.beginPath(); ctx.moveTo(PLOT.left, y); ctx.lineTo(width - PLOT.right, y); ctx.stroke();
      ctx.fillStyle = COLORS.text; ctx.textAlign = 'right'; ctx.fillText(String(value), PLOT.left - 8, y);
    }
    for (const frequency of frequencyTicks(width, this.maxFrequency)) {
      const x = xAt(frequency);
      ctx.strokeStyle = COLORS.grid; ctx.beginPath(); ctx.moveTo(x, PLOT.top); ctx.lineTo(x, height - PLOT.bottom); ctx.stroke();
      ctx.fillStyle = COLORS.text; ctx.textAlign = 'center'; ctx.fillText(formatFrequency(frequency), x, height - 12);
    }
    const count = Math.max(1, Math.min(900, Math.floor(plotWidth)));
    if (!this.spectrumRawY || this.spectrumRawY.length !== count) {
      this.spectrumRawY = new Float32Array(count);
      this.spectrumProcessedY = new Float32Array(count);
    }
    for (let i = 0; i < count; i++) {
      const frequency = 20 * (this.maxFrequency / 20) ** (i / Math.max(1, count - 1));
      this.spectrumRawY[i] = yAt(interpolatedDb(this.rawFrequency, frequency, this.sampleRate, this.rawDisplayAnalyser.fftSize));
      this.spectrumProcessedY[i] = yAt(interpolatedDb(this.processedFrequency, frequency, this.sampleRate, this.processedDisplayAnalyser.fftSize));
    }
    const px = i => PLOT.left + i / Math.max(1, count - 1) * plotWidth;
    // The filled region is the actual per-bin dB display difference. It is not
    // represented as a separately isolated sound/noise source.
    ctx.beginPath();
    for (let i = 0; i < count; i++) i === 0 ? ctx.moveTo(px(i), this.spectrumRawY[i]) : ctx.lineTo(px(i), this.spectrumRawY[i]);
    for (let i = count - 1; i >= 0; i--) ctx.lineTo(px(i), this.spectrumProcessedY[i]);
    ctx.closePath(); ctx.fillStyle = '#e8532a25'; ctx.fill();
    const line = (values, color) => {
      ctx.beginPath();
      for (let i = 0; i < count; i++) i === 0 ? ctx.moveTo(px(i), values[i]) : ctx.lineTo(px(i), values[i]);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    };
    line(this.spectrumRawY, COLORS.raw);
    line(this.spectrumProcessedY, COLORS.processed);
    const channel = this.channel.toUpperCase();
    ctx.textAlign = 'left'; ctx.fillStyle = COLORS.raw; ctx.fillText(`ORIGINAL ${channel}`, PLOT.left, 12);
    ctx.fillStyle = COLORS.processed; ctx.fillText(`PROCESSED ${channel}`, PLOT.left + 112, 12);
    if (width >= 420) { ctx.textAlign = 'right'; ctx.fillStyle = COLORS.text; ctx.fillText('FFT · dBFS', width - PLOT.right, 12); }
  }

  _drawSpectrogram(now) {
    const chart = prepareCanvas(this.canvases.spectrogram);
    if (!chart) return;
    const {ctx, width, height, plotWidth, plotHeight} = chart;
    const w = Math.max(1, Math.floor(plotWidth)), h = Math.max(1, Math.floor(plotHeight));
    if (this.history.width !== w || this.history.height !== h) {
      this.history.width = w; this.history.height = h;
      this.column.width = 1; this.column.height = h;
      this.columnImage = this.column.getContext('2d').createImageData(1, h);
      this.history.getContext('2d').fillStyle = COLORS.background;
      this.history.getContext('2d').fillRect(0, 0, w, h);
      this.lastSpectrogram = now;
      this.spectrogramFraction = 1;
    }
    const delta = this.lastSpectrogram ? now - this.lastSpectrogram : 0;
    this.lastSpectrogram = now;
    this.spectrogramFraction += delta / 1000 * w / this.historySeconds;
    const columns = Math.min(w, Math.floor(this.spectrogramFraction));
    if (columns > 0) {
      this.spectrogramFraction -= Math.floor(this.spectrogramFraction);
      const history = this.history.getContext('2d');
      history.drawImage(this.history, -columns, 0);
      history.fillStyle = COLORS.background; history.fillRect(w - columns, 0, columns, h);
      const data = this.columnImage.data;
      for (let row = 0; row < h; row++) {
        const frequency = 20 * (this.maxFrequency / 20) ** (1 - row / Math.max(1, h - 1));
        const db = interpolatedDb(this.processedFrequency, frequency, this.sampleRate, this.processedDisplayAnalyser.fftSize);
        const color = Math.round(clamp((db + 100) / 94, 0, 1) * 255) * 3;
        data[row * 4] = this.palette[color]; data[row * 4 + 1] = this.palette[color + 1];
        data[row * 4 + 2] = this.palette[color + 2]; data[row * 4 + 3] = 255;
      }
      this.column.getContext('2d').putImageData(this.columnImage, 0, 0);
      // Long gaps are left blank rather than painting invented past spectra.
      const paintedColumns = delta > 300 ? 1 : columns;
      history.drawImage(this.column, 0, 0, 1, h, w - paintedColumns, 0, paintedColumns, h);
    }
    ctx.drawImage(this.history, PLOT.left, PLOT.top, plotWidth, plotHeight);
    ctx.fillStyle = COLORS.text; ctx.textAlign = 'right';
    for (const frequency of [20, 100, 1000, 10000, 20000].filter(value => value <= this.maxFrequency)) {
      const y = PLOT.top + (1 - Math.log(frequency / 20) / Math.log(this.maxFrequency / 20)) * plotHeight;
      ctx.fillText(formatFrequency(frequency), PLOT.left - 8, y);
    }
    for (const seconds of [12, 9, 6, 3, 0]) {
      const x = PLOT.left + (1 - seconds / this.historySeconds) * plotWidth;
      ctx.textAlign = 'center'; ctx.fillText(seconds ? `−${seconds}s` : 'now', x, height - 12);
    }
    ctx.textAlign = 'left'; ctx.fillStyle = COLORS.processed; ctx.fillText(`PROCESSED ${this.channel.toUpperCase()} · SPECTROGRAM`, PLOT.left, 12);
    ctx.textAlign = 'right'; ctx.fillStyle = COLORS.text;
    if (width >= 500) ctx.fillText('−100 → −6 dBFS', width - PLOT.right, 12);
  }

  destroy() {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.graph = null;
    this.resizeObserver?.disconnect();
    this.mediaQuery?.removeEventListener?.('change', this.onMotionChange);
    this.inputSamples = this.inputRightSamples = this.rawSamples = this.processedSamples = null;
    this.rawFrequency = this.processedFrequency = this.leftSamples = this.rightSamples = null;
    this.history.width = this.history.height = 0;
  }
}
