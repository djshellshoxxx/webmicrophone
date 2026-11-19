/** Non-destructive, frame-based edits. This module owns no source PCM. */
export const CLIP_EDIT_LIMITS = Object.freeze({
  history: 32,
  segments: 256,
  seconds: 600,
  bytes: 256 * 1024 * 1024,
  envelopesPerSegment: 64,
  fadeSeconds: 0.01,
});

const EMPTY = Object.freeze([]);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function frame(value, length, name = 'Frame') {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
  return Math.round(clamp(value, 0, length));
}

function range(start, end, length) {
  const left = frame(start, length, 'Selection start');
  const right = frame(end, length, 'Selection end');
  return { start: Math.min(left, right), end: Math.max(left, right) };
}

function piece(sourceStart, length, step = 1, envelopes = EMPTY, silent = false) {
  return Object.freeze({ sourceStart, length, step, envelopes, silent });
}

function silence(length) { return piece(0, length, 1, EMPTY, true); }

function envelope(offset, step, duration, count = 1) {
  return Object.freeze({ offset, step, duration, count });
}

function simplify(part) {
  if (part.silent || !part.envelopes.length) return part;
  const kept = [];
  for (const gain of part.envelopes) {
    const last = gain.offset + gain.step * (part.length - 1);
    if (Math.max(gain.offset, last) <= 0) return silence(part.length);
    if (Math.min(gain.offset, last) >= Math.max(1, gain.duration - 1)) continue;
    kept.push(gain);
  }
  return piece(part.sourceStart, part.length, part.step, Object.freeze(kept));
}

function slicePiece(part, start, end) {
  if (start === 0 && end === part.length) return part;
  if (part.silent) return silence(end - start);
  const gains = part.envelopes.map(gain => envelope(gain.offset + gain.step * start, gain.step, gain.duration, gain.count));
  return simplify(piece(part.sourceStart + part.step * start, end - start, part.step, Object.freeze(gains)));
}

function slicePieces(parts, start, end) {
  if (end <= start) return [];
  const result = [];
  let position = 0;
  for (const part of parts) {
    const next = position + part.length;
    if (position >= end) break;
    if (next > start) result.push(slicePiece(part, Math.max(0, start - position), Math.min(part.length, end - position)));
    position = next;
  }
  return result;
}

function reversed(part) {
  if (part.silent) return part;
  return simplify(piece(part.sourceStart + part.step * (part.length - 1), part.length, -part.step,
    Object.freeze(part.envelopes.map(gain => envelope(gain.offset + gain.step * (part.length - 1), -gain.step, gain.duration, gain.count)))));
}

function faded(part, offset, step, duration) {
  if (part.silent) return part;
  const gains = part.envelopes.slice();
  const existing = gains.findIndex(gain => gain.offset === offset && gain.step === step && gain.duration === duration);
  if (existing >= 0) {
    const count = gains[existing].count + 1;
    if (!Number.isSafeInteger(count)) throw new RangeError('This fade has reached its edit limit.');
    gains[existing] = envelope(offset, step, duration, count);
  } else {
    gains.push(envelope(offset, step, duration));
  }
  const result = simplify(piece(part.sourceStart, part.length, part.step, Object.freeze(gains)));
  if (result.envelopes.length > CLIP_EDIT_LIMITS.envelopesPerSegment) {
    throw new RangeError('Too many overlapping fades in one clip section. Undo an edit or start from a rendered copy.');
  }
  return result;
}

function canJoin(left, right) {
  if (left.silent || right.silent) return left.silent && right.silent;
  if (left.step !== right.step || left.sourceStart + left.step * left.length !== right.sourceStart
    || left.envelopes.length !== right.envelopes.length) return false;
  return left.envelopes.every((gain, index) => {
    const next = right.envelopes[index];
    return gain.offset + gain.step * left.length === next.offset && gain.step === next.step
      && gain.duration === next.duration && gain.count === next.count;
  });
}

function samePieces(left, right) {
  return left.length === right.length && left.every((part, index) => {
    const other = right[index];
    return part.sourceStart === other.sourceStart && part.length === other.length && part.step === other.step
      && part.silent === other.silent && part.envelopes.length === other.envelopes.length
      && part.envelopes.every((gain, gainIndex) => {
        const value = other.envelopes[gainIndex];
        return gain.offset === value.offset && gain.step === value.step && gain.duration === value.duration && gain.count === value.count;
      });
  });
}

function normalizedParts(parts, markers) {
  // Explicit split markers are real segment boundaries, even for contiguous references.
  const split = [];
  let position = 0, markerIndex = 0;
  for (const part of parts) {
    if (!part.length) continue;
    const end = position + part.length;
    while (markerIndex < markers.length && markers[markerIndex] <= position) markerIndex += 1;
    let start = 0;
    while (markerIndex < markers.length && markers[markerIndex] < end) {
      const boundary = markers[markerIndex] - position;
      split.push(slicePiece(part, start, boundary));
      start = boundary;
      markerIndex += 1;
    }
    split.push(slicePiece(part, start, part.length));
    position = end;
  }
  const result = [], boundaries = new Set(markers);
  position = 0;
  for (const part of split) {
    const previous = result.at(-1);
    if (previous && !boundaries.has(position) && canJoin(previous, part)) {
      result[result.length - 1] = previous.silent ? silence(previous.length + part.length)
        : piece(previous.sourceStart, previous.length + part.length, previous.step, previous.envelopes);
    } else result.push(part);
    position += part.length;
  }
  return Object.freeze(result);
}

/**
 * Sources use 1–2 Float32 channels of exactly the constructor's original length.
 * Ranges are half-open. Selection/navigation do not create history or revision changes.
 * A clipboard holds descriptions and survives undo/redo/reset. Rejected edits are atomic.
 */
export class ClipEditModel {
  #sourceLength;
  #sampleRate;
  #channels;
  #maxFrames;
  #state;
  #past = [];
  #future = [];
  #clipboard = null;
  #revision = 0;

  constructor({ length, sampleRate, channels }) {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('Source length must be a nonnegative integer frame count.');
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 1 || !Number.isSafeInteger(sampleRate * CLIP_EDIT_LIMITS.seconds)) {
      throw new RangeError('Sample rate must be a positive, safely representable integer.');
    }
    if (channels !== 1 && channels !== 2) throw new RangeError('Clip editing supports one or two channels.');
    this.#sourceLength = length;
    this.#sampleRate = sampleRate;
    this.#channels = channels;
    this.#maxFrames = Math.min(sampleRate * CLIP_EDIT_LIMITS.seconds, Math.floor(CLIP_EDIT_LIMITS.bytes / (channels * Float32Array.BYTES_PER_ELEMENT)));
    this.#state = this.#makeState(length ? [piece(0, length)] : [], [], { start: 0, end: length }, 0);
  }

  get length() { return this.#state.length; }
  get duration() { return this.length / this.#sampleRate; }
  get sampleRate() { return this.#sampleRate; }
  get channels() { return this.#channels; }
  get sourceLength() { return this.#sourceLength; }
  get selection() { return { ...this.#state.selection }; }
  get cursor() { return this.#state.cursor; }
  get markers() { return this.#state.markers.slice(); }
  get canUndo() { return this.#past.length > 0; }
  get canRedo() { return this.#future.length > 0; }
  get canPaste() { return Boolean(this.#clipboard?.length); }
  get revision() { return this.#revision; }
  get isEdited() {
    if (this.#state.markers.length) return true;
    if (!this.#sourceLength) return this.length !== 0;
    const only = this.#state.parts[0];
    return this.#state.parts.length !== 1 || only.silent || only.sourceStart !== 0 || only.step !== 1
      || only.length !== this.#sourceLength || only.envelopes.length !== 0;
  }

  select(startFrame, endFrame) {
    const selected = range(startFrame, endFrame, this.length);
    this.#state = Object.freeze({ ...this.#state, selection: Object.freeze(selected), cursor: selected.start });
    return this.selection;
  }

  seek(value) {
    const cursor = frame(value, this.length, 'Cursor');
    this.#state = Object.freeze({ ...this.#state, cursor });
    return cursor;
  }

  #makeState(parts, markers, selection, cursor) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    if (!Number.isSafeInteger(length) || length > this.#maxFrames) {
      throw new RangeError('This edit exceeds the ten-minute or 256 MiB clip limit. Shorten the clip before inserting more audio.');
    }
    const points = Object.freeze([...new Set(markers.filter(value => value > 0 && value < length))].sort((a, b) => a - b));
    const normalized = normalizedParts(parts, points);
    if (normalized.length > CLIP_EDIT_LIMITS.segments) {
      throw new RangeError(`This edit exceeds the ${CLIP_EDIT_LIMITS.segments}-segment limit. Undo an edit or start from a rendered copy.`);
    }
    return Object.freeze({ parts: normalized, markers: points, length, selection: Object.freeze(range(selection.start, selection.end, length)), cursor: frame(cursor, length, 'Cursor') });
  }

  #commit(next) {
    if (samePieces(this.#state.parts, next.parts) && this.#state.markers.length === next.markers.length
      && this.#state.markers.every((value, index) => value === next.markers[index])) return false;
    this.#past.push(this.#state);
    if (this.#past.length > CLIP_EDIT_LIMITS.history) this.#past.shift();
    this.#future = [];
    this.#state = next;
    this.#revision += 1;
    return true;
  }

  #clip(start, end) {
    return Object.freeze({
      parts: Object.freeze(slicePieces(this.#state.parts, start, end)),
      markers: Object.freeze(this.#state.markers.filter(value => value > start && value < end).map(value => value - start)),
      length: end - start,
    });
  }

  #insert(clip, at) {
    const parts = [...slicePieces(this.#state.parts, 0, at), ...clip.parts, ...slicePieces(this.#state.parts, at, this.length)];
    const markers = this.#state.markers.map(value => value >= at ? value + clip.length : value);
    markers.push(...clip.markers.map(value => value + at));
    return this.#makeState(parts, markers, { start: at, end: at + clip.length }, at + clip.length);
  }

  action(name) {
    const { start, end } = this.#state.selection;
    const selectedLength = end - start;
    switch (name) {
      case 'select-all':
        this.select(0, this.length);
        return true;
      case 'undo': {
        if (!this.canUndo) return false;
        this.#future.push(this.#state);
        this.#state = this.#past.pop();
        this.#revision += 1;
        return true;
      }
      case 'redo': {
        if (!this.canRedo) return false;
        this.#past.push(this.#state);
        if (this.#past.length > CLIP_EDIT_LIMITS.history) this.#past.shift();
        this.#state = this.#future.pop();
        this.#revision += 1;
        return true;
      }
      case 'reset': {
        const next = this.#makeState(this.#sourceLength ? [piece(0, this.#sourceLength)] : [], [], { start: 0, end: this.#sourceLength }, 0);
        if (!this.isEdited) { this.#state = next; return false; }
        return this.#commit(next);
      }
      case 'split': {
        if (this.cursor === 0 || this.cursor === this.length || this.#state.markers.includes(this.cursor)) return false;
        return this.#commit(this.#makeState(this.#state.parts, [...this.#state.markers, this.cursor], this.#state.selection, this.cursor));
      }
      case 'copy':
        if (!selectedLength) return false;
        this.#clipboard = this.#clip(start, end);
        return true;
      case 'paste':
        if (!this.canPaste) return false;
        return this.#commit(this.#insert(this.#clipboard, this.cursor));
      case 'cut': {
        if (!selectedLength) return false;
        const copied = this.#clip(start, end);
        const parts = [...slicePieces(this.#state.parts, 0, start), ...slicePieces(this.#state.parts, end, this.length)];
        const markers = this.#state.markers.filter(value => value <= start || value >= end)
          .map(value => value >= end ? value - selectedLength : value);
        const next = this.#makeState(parts, markers, { start, end: start }, start);
        const changed = this.#commit(next);
        this.#clipboard = copied;
        return changed;
      }
      case 'keep': {
        if (!selectedLength) return false;
        const kept = this.#clip(start, end);
        return this.#commit(this.#makeState(kept.parts, kept.markers, { start: 0, end: selectedLength }, 0));
      }
      case 'duplicate':
        if (!selectedLength) return false;
        return this.#commit(this.#insert(this.#clip(start, end), end));
      case 'reverse':
      case 'silence':
      case 'fade-in':
      case 'fade-out': {
        if (!selectedLength || (name === 'reverse' && selectedLength === 1)) return false;
        let selected = slicePieces(this.#state.parts, start, end);
        let markers = this.#state.markers;
        if (name === 'reverse') {
          selected = selected.reverse().map(reversed);
          markers = markers.map(value => value > start && value < end ? start + end - value : value);
        } else if (name === 'silence') selected = [silence(selectedLength)];
        else {
          const duration = Math.min(selectedLength, Math.max(1, Math.round(this.#sampleRate * CLIP_EDIT_LIMITS.fadeSeconds)));
          let position = 0;
          selected = selected.map(part => {
            const result = faded(part, name === 'fade-in' ? position : selectedLength - 1 - position, name === 'fade-in' ? 1 : -1, duration);
            position += part.length;
            return result;
          });
        }
        const parts = [...slicePieces(this.#state.parts, 0, start), ...selected, ...slicePieces(this.#state.parts, end, this.length)];
        return this.#commit(this.#makeState(parts, markers, this.#state.selection, this.cursor));
      }
      default:
        throw new RangeError(`Unknown clip edit action: ${String(name)}`);
    }
  }

  /** Render any corresponding original/aligned-processed source without changing it. */
  render(sourceChannels, { start = 0, end = this.length } = {}) {
    if (!Array.isArray(sourceChannels) || sourceChannels.length !== this.#channels
      || sourceChannels.some(channel => !(channel instanceof Float32Array) || channel.length !== this.#sourceLength)) {
      throw new TypeError(`Expected ${this.#channels} Float32 source channel(s), each ${this.#sourceLength} frames long.`);
    }
    const selected = range(start, end, this.length);
    const parts = slicePieces(this.#state.parts, selected.start, selected.end);
    const output = Array.from({ length: this.#channels }, () => new Float32Array(selected.end - selected.start));
    let position = 0;
    for (const part of parts) {
      if (!part.silent) {
        for (let index = 0; index < part.length; index += 1) {
          let gain = 1;
          for (const item of part.envelopes) {
            const level = clamp((item.offset + item.step * index) / Math.max(1, item.duration - 1), 0, 1);
            gain *= item.count === 1 ? level : level ** item.count;
          }
          const sourceIndex = part.sourceStart + part.step * index;
          for (let channel = 0; channel < this.#channels; channel += 1) {
            const value = sourceChannels[channel][sourceIndex];
            output[channel][position + index] = Number.isFinite(value) ? value * gain : 0;
          }
        }
      }
      position += part.length;
    }
    return output;
  }
}
