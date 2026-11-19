import test from 'node:test';
import assert from 'node:assert/strict';
import { ClipEditModel, CLIP_EDIT_LIMITS } from '../src/editing/edit-model.js';

const fixture = (length = 8) => [Float32Array.from({ length }, (_, index) => index + 1), Float32Array.from({ length }, (_, index) => -10 * (index + 1))];
const arrays = channels => channels.map(channel => Array.from(channel));
const make = (length = 8, sampleRate = 1000, channels = 2) => new ClipEditModel({ length, sampleRate, channels });
const close = (actual, expected, tolerance = 1e-6) => {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) assert.ok(Math.abs(actual[index] - expected[index]) < tolerance, `frame ${index}: ${actual[index]} != ${expected[index]}`);
};

test('clip model preserves source metadata, exact identity and immutable navigation snapshots', () => {
  const source = fixture(), model = make();
  assert.equal(model.length, 8);
  assert.equal(model.duration, 0.008);
  assert.equal(model.sampleRate, 1000);
  assert.equal(model.channels, 2);
  assert.equal(model.sourceLength, 8);
  assert.deepEqual(model.selection, { start: 0, end: 8 });
  assert.equal(model.cursor, 0);
  assert.equal(model.isEdited, false);
  assert.equal(model.canUndo, false);
  assert.equal(model.canPaste, false);
  const rendered = model.render(source);
  assert.deepEqual(arrays(rendered), arrays(source));
  assert.notEqual(rendered[0], source[0]);
  rendered[0][0] = 100;
  assert.equal(source[0][0], 1);
  model.select(6.7, 1.1);
  const selection = model.selection;
  assert.deepEqual(selection, { start: 1, end: 7 });
  selection.start = 5;
  assert.equal(model.selection.start, 1);
  assert.equal(model.cursor, 1);
  model.seek(999);
  assert.equal(model.cursor, 8);
  model.seek(-100);
  assert.equal(model.cursor, 0);
  assert.equal(model.revision, 0);
  assert.equal(model.isEdited, false);
  assert.deepEqual(arrays(model.render(source, { start: 2, end: 5 })), [[3, 4, 5], [-30, -40, -50]]);
});

test('split adds a stable editable boundary without removing or duplicating samples', () => {
  const source = fixture(), model = make();
  assert.equal(model.action('split'), false);
  model.seek(3);
  assert.equal(model.action('split'), true);
  assert.deepEqual(model.markers, [3]);
  assert.equal(model.isEdited, true);
  assert.equal(model.revision, 1);
  const points = model.markers;
  points.push(5);
  assert.deepEqual(model.markers, [3]);
  assert.equal(model.action('split'), false);
  model.seek(8);
  assert.equal(model.action('split'), false);
  assert.deepEqual(arrays(model.render(source)), arrays(source));
  model.action('undo');
  assert.deepEqual(model.markers, []);
  assert.equal(model.isEdited, false);
  model.action('redo');
  assert.deepEqual(model.markers, [3]);
});

test('cut copies first, paste inserts at the cursor, and stereo frame order is retained', () => {
  const source = fixture(), before = arrays(source), model = make();
  model.select(2, 5);
  assert.equal(model.action('cut'), true);
  assert.deepEqual(model.selection, { start: 2, end: 2 });
  assert.equal(model.cursor, 2);
  assert.equal(model.canPaste, true);
  assert.deepEqual(arrays(model.render(source)), [[1, 2, 6, 7, 8], [-10, -20, -60, -70, -80]]);
  model.seek(1);
  model.action('paste');
  assert.deepEqual(model.selection, { start: 1, end: 4 });
  assert.equal(model.cursor, 4);
  assert.deepEqual(arrays(model.render(source)), [[1, 3, 4, 5, 2, 6, 7, 8], [-10, -30, -40, -50, -20, -60, -70, -80]]);
  assert.deepEqual(arrays(source), before);
  model.action('undo');
  assert.equal(model.length, 5);
  model.action('undo');
  assert.deepEqual(arrays(model.render(source)), before);
  assert.deepEqual(model.selection, { start: 2, end: 5 });
  assert.equal(model.canPaste, true);
});

test('cut-all yields a recoverable empty timeline and reset remains undoable', () => {
  const source = fixture(), model = make();
  model.action('cut');
  assert.equal(model.length, 0);
  assert.equal(model.duration, 0);
  assert.deepEqual(model.selection, { start: 0, end: 0 });
  assert.deepEqual(arrays(model.render(source)), [[], []]);
  assert.equal(model.canPaste, true);
  for (const command of ['copy', 'cut', 'keep', 'duplicate', 'reverse', 'silence', 'fade-in', 'fade-out', 'split']) {
    assert.equal(model.action(command), false, `${command} on empty timeline`);
  }
  model.action('paste');
  assert.deepEqual(arrays(model.render(source)), arrays(source));
  assert.equal(model.isEdited, false);
  model.select(1, 4);
  model.action('reverse');
  const edited = arrays(model.render(source));
  assert.equal(model.action('reset'), true);
  assert.deepEqual(arrays(model.render(source)), arrays(source));
  assert.equal(model.isEdited, false);
  model.action('undo');
  assert.deepEqual(arrays(model.render(source)), edited);
  assert.equal(model.canPaste, true);
  model.action('redo');
  assert.equal(model.isEdited, false);
});

test('keep, duplicate and source-independent edits retain channel alignment', () => {
  const source = fixture(), model = make();
  model.seek(4); model.action('split');
  model.select(2, 6); model.action('keep');
  assert.deepEqual(model.markers, [2]);
  assert.deepEqual(model.selection, { start: 0, end: 4 });
  assert.deepEqual(arrays(model.render(source)), [[3, 4, 5, 6], [-30, -40, -50, -60]]);
  model.select(1, 3); model.action('duplicate');
  assert.equal(model.canPaste, false, 'duplicate must not replace the clipboard');
  assert.deepEqual(model.selection, { start: 3, end: 5 });
  assert.deepEqual(model.markers, [2, 4]);
  assert.deepEqual(arrays(model.render(source)), [[3, 4, 5, 4, 5, 6], [-30, -40, -50, -40, -50, -60]]);
  const alternate = source.map(channel => Float32Array.from(channel, value => value * 2));
  assert.deepEqual(arrays(model.render(alternate)), [[6, 8, 10, 8, 10, 12], [-60, -80, -100, -80, -100, -120]]);
  assert.deepEqual(arrays(source), arrays(fixture()));
});

test('reverse rebases split markers and silence only affects the selection', () => {
  const source = fixture(10), model = make(10);
  model.seek(3); model.action('split');
  model.seek(6); model.action('split');
  model.select(2, 9); model.seek(4); model.action('reverse');
  assert.deepEqual(model.markers, [5, 8]);
  assert.equal(model.cursor, 4);
  assert.deepEqual(arrays(model.render(source))[0], [1, 2, 9, 8, 7, 6, 5, 4, 3, 10]);
  model.select(3, 7); model.action('silence');
  assert.deepEqual(arrays(model.render(source)), [[1, 2, 9, 0, 0, 0, 0, 4, 3, 10], [-10, -20, -90, 0, 0, 0, 0, -40, -30, -100]]);
  assert.deepEqual(model.markers, [5, 8]);
  assert.equal(model.action('silence'), false, 'repeated identical silence is a no-op');
  model.action('undo');
  assert.deepEqual(arrays(model.render(source))[0], [1, 2, 9, 8, 7, 6, 5, 4, 3, 10]);
});

test('short fades keep offsets through partial copying, splitting and reversal', () => {
  const source = [new Float32Array(20).fill(1), new Float32Array(20).fill(-2)], model = make(20);
  model.action('fade-in');
  const expected = Array.from({ length: 20 }, (_, index) => Math.min(1, index / 9));
  close(model.render(source)[0], expected);
  close(model.render(source)[1], expected.map(value => -2 * value));
  model.seek(4); model.action('split');
  close(model.render(source)[0], expected);
  model.select(2, 8); model.action('copy');
  model.seek(20); model.action('paste');
  close(model.render(source)[0], [...expected, ...expected.slice(2, 8)]);
  model.action('reverse');
  close(model.render(source)[0], [...expected, ...expected.slice(2, 8).reverse()]);
  model.action('undo');
  model.action('undo');
  model.action('select-all');
  model.action('fade-out');
  const both = expected.map((value, index) => value * Math.min(1, (19 - index) / 9));
  close(model.render(source)[0], both);
  model.action('reverse');
  close(model.render(source)[0], both.slice().reverse());
  assert.deepEqual(arrays(source), [Array(20).fill(1), Array(20).fill(-2)]);
});

test('single-frame fades and repeated fades stay finite without PCM history', () => {
  const source = [Float32Array.from([2, 4, 6])], model = make(3, 1000, 1);
  model.select(1, 2);
  assert.equal(model.action('reverse'), false);
  model.action('fade-in');
  assert.deepEqual(arrays(model.render(source)), [[2, 0, 6]]);
  model.action('undo');
  model.action('select-all');
  for (let index = 0; index < 100; index += 1) model.action('fade-in');
  const result = model.render(source)[0];
  assert.equal(result[0], 0);
  assert.equal(result[2], 6);
  assert.ok(result.every(Number.isFinite));
  assert.ok(result[1] < 1e-20);
});

test('history retains 32 edits, restores navigation, and clears redo on a new edit', () => {
  const model = make(100);
  for (let value = 1; value <= 40; value += 1) { model.seek(value); model.action('split'); }
  assert.equal(model.revision, 40);
  let count = 0;
  while (model.action('undo')) count += 1;
  assert.equal(count, CLIP_EDIT_LIMITS.history);
  assert.deepEqual(model.markers, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(model.cursor, 9);
  assert.equal(model.revision, 72);
  model.select(0, 2); model.action('copy');
  assert.equal(model.canRedo, true);
  model.action('redo');
  assert.equal(model.markers.length, 9);
  model.select(0, 2); model.action('silence');
  assert.equal(model.canRedo, false);
  assert.equal(model.canPaste, true);
});

test('invalid values and incompatible sources fail without modifying document state', () => {
  for (const options of [
    { length: -1, sampleRate: 48000, channels: 1 },
    { length: 1.5, sampleRate: 48000, channels: 1 },
    { length: 1, sampleRate: NaN, channels: 1 },
    { length: 1, sampleRate: 0, channels: 1 },
    { length: 1, sampleRate: 48000, channels: 3 },
  ]) assert.throws(() => new ClipEditModel(options), RangeError);
  const model = make(), originalSelection = model.selection;
  for (const value of [NaN, Infinity, -Infinity, '2', null, undefined]) {
    assert.throws(() => model.select(value, 3), TypeError);
    assert.throws(() => model.seek(value), TypeError);
  }
  assert.deepEqual(model.selection, originalSelection);
  assert.equal(model.revision, 0);
  assert.throws(() => model.action('unknown'), /Unknown clip edit action/);
  assert.throws(() => model.render([new Float32Array(8)]), TypeError);
  assert.throws(() => model.render([new Float32Array(8), new Float32Array(9)]), TypeError);
  assert.throws(() => model.render([Array(8).fill(1), Array(8).fill(1)]), TypeError);
  const invalidSource = fixture();
  invalidSource[0][1] = NaN;
  invalidSource[1][5] = Infinity;
  const result = model.render(invalidSource);
  assert.equal(result[0][1], 0);
  assert.equal(result[1][5], 0);
  assert.ok(result.every(channel => channel.every(Number.isFinite)));
  assert.ok(Number.isNaN(invalidSource[0][1]));
  assert.equal(invalidSource[1][5], Infinity);
});

test('duration, memory and segment capacity failures are atomic and require no PCM allocation', () => {
  assert.throws(() => make(600 * 48000 + 1, 48000, 1), /ten-minute or 256 MiB/);
  assert.throws(() => make(Math.floor(CLIP_EDIT_LIMITS.bytes / 8) + 1, 96000, 2), /ten-minute or 256 MiB/);
  const model = make(600, 1, 1);
  model.select(0, 1); model.action('copy'); model.seek(600);
  const before = { revision: model.revision, selection: model.selection, cursor: model.cursor, markers: model.markers };
  assert.throws(() => model.action('paste'), /ten-minute or 256 MiB/);
  assert.equal(model.length, 600);
  assert.equal(model.canUndo, false);
  assert.equal(model.canPaste, true);
  assert.deepEqual({ revision: model.revision, selection: model.selection, cursor: model.cursor, markers: model.markers }, before);
  for (let value = 1; value < CLIP_EDIT_LIMITS.segments; value += 1) { model.seek(value); model.action('split'); }
  const priorRevision = model.revision, priorMarkers = model.markers;
  model.seek(CLIP_EDIT_LIMITS.segments);
  assert.throws(() => model.action('split'), /256-segment/);
  assert.deepEqual(model.markers, priorMarkers);
  assert.equal(model.revision, priorRevision);
  assert.equal(model.length, 600);
  model.select(0, 300); model.action('cut');
  assert.ok(model.length < 600);
  model.action('undo');
  assert.deepEqual(model.markers, priorMarkers);
});

test('zero-frame sources have a safe empty render and no unavailable edits', () => {
  const model = make(0, 48000, 1);
  assert.deepEqual(arrays(model.render([new Float32Array()])), [[]]);
  assert.equal(model.action('paste'), false);
  assert.equal(model.action('undo'), false);
  assert.equal(model.action('redo'), false);
  assert.equal(model.action('reset'), false);
  assert.equal(model.isEdited, false);
  model.select(-2, 100); model.seek(100);
  assert.deepEqual(model.selection, { start: 0, end: 0 });
  assert.equal(model.cursor, 0);
});
