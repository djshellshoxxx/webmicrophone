# 13 — Compact clip editor

## Objective and location

Add basic editing and playback tools for a selected microphone take, imported file, or generated test clip. All new interactive controls belong in the existing left-column gap below Listen live, alongside the EQ and processing panels, as marked in the user's screenshot. Do not add a new full-width editor, move the main EQ, or place another toolbar in Recordings & files. On desktop the panel fills only the remaining rack height and scrolls internally; on narrow screens it stays directly below the source/monitoring rack with a bounded height.

The original captured or imported audio remains immutable. Edits are local to the current session; download an edited render to keep it. Loading another take starts a fresh edit document. Existing processing presets remain signal-chain presets and do not contain audio edits.

## Modules and build order

| Module | Responsibility | Depends on |
| --- | --- | --- |
| clip-edit-model | Frame-based non-destructive cuts, clipboard, fades, reversal and history | Source PCM |
| clip-time-pitch | Real varispeed, pitch-preserving stretch, independent pitch; cancellable local processing | PCM and a pinned local DSP implementation |
| compact-clip-ui | Bounded panel, waveform selection/seeking, transport and controls | Model snapshots |
| session-integration | Same edited result in audition and export; original download stays untouched | All three modules and existing SessionUI |

Build the model and transform processor independently, then integrate the compact UI with SessionUI and verify browser behavior before Pages deployment.

## Editing and transport

- A real waveform shows the current edited timeline, selection, cursor and split boundaries. Click to seek, drag to select, and provide numeric selection fields and keyboard seeking. Double-clicking between split markers selects that region.
- Provide play/pause/resume, stop, loop, select all, split at the cursor, cut, copy, paste at the cursor, keep selection, duplicate selection, reverse selection, silence selection, and short fade-in/fade-out actions.
- Split creates an editable boundary without adding or removing samples. Cut stores the selection in the local clipboard before removing it. Paste and duplicate insert material rather than overwriting another region.
- Undo/redo stores bounded edit-description history rather than full-length PCM copies. A reset restores the source and can be undone. Clipboard and edits cannot modify the preserved source.
- Editing applies equally to both channels. Keep channel count, sample rate, exact frame order and stereo alignment.
- Empty timelines, zero-length selections, split-at-edge, invalid numbers and over-capacity edits have explicit usable states. Never create NaNs or attempt a zero-length AudioBuffer playback.
- Changing an edit or timing control while playing stops the old preview, prepares the new version if needed, and resumes from the corresponding cursor. Stop, Escape mute and cancellation must prevent a stale asynchronous result from starting playback.

## Time and pitch

- Speed: 0.5–2.0× varispeed (changes pitch and duration together).
- Stretch: 50–200% duration at preserved pitch.
- Pitch: −12 to +12 semitones independent of duration.
- Combined expected duration is `editedDuration × stretch / speed`; combined expected tonal pitch is `sourcePitch × speed × 2^(semitones/12)`.
- Use real local DSP, not a renamed playbackRate control for pitch-preserving stretch. Package the selected implementation with the static app, pin its version, and include its actual redistribution notices.
- Preview and export share the same transform implementation and normalized settings. Show preparation progress and allow cancellation. Heavy preparation belongs in a worker rather than the microphone audio callback.
- Reuse a prepared preview until source edits or transform settings change. Use bounded allocations and enforce the existing ten-minute / 256 MiB output bound before allocating expanded audio.
- Capacity is checked against the selected output region. A long virtual timeline can still be auditioned and exported in smaller selections. A collapsed selection is a cursor: Play and export use the remaining edited document rather than constructing an empty buffer.
- Waveform labels, selection and seek positions must map consistently to the displayed playback duration. Time stretching is an estimated signal transformation and may produce audible artifacts at extreme settings; it is not formant-preserving voice reconstruction.

## Session and export integration

The order is structural edits → selected region → speed/stretch/pitch → existing processing → export resampling/encoding. Filtered-as-recorded export applies the same edit description to the aligned recorded filtered source, then applies timing controls. Export modes must identify whether filters are applied; Download original bypasses all editing and timing.

The existing lower trim fields and play/stop/loop controls refer to the same selection and transport. Do not create a second independent playback state. Playback disconnects live capture as before, and all editor mutations are blocked during recording or another protected file operation. Editing never alters live microphone capture settings.

## Interface contract

The UI consumes a snapshot containing loaded/busy/playing/paused flags, label, duration, selection start/end, cursor, undo/redo/clipboard availability, transforms, loop, waveform min/max bins, split markers, progress and status. UI callbacks request an action, seek, selection change, transform change or loop change. SessionUI owns document, transport and render state.

## Commands and verification

Use the repository's vanilla JavaScript ES-module conventions. New pure editing logic lives in `src/editing/`, the compact component in `src/ui/`, integration in `src/session-ui.js`, and focused checks in `tests/` and `tests/e2e/`.

Commands: `npm test`, `npm run test:e2e`, `npm run build`.

Acceptance includes:

1. Stereo fixtures verify cut/copy/paste/keep/split/duplicate/reverse/silence/fades and undo/redo without changing original arrays.
2. Synthetic tones verify independent duration and pitch, combined settings, finite output, retained tails and channel alignment. Identity processing is exact.
3. Browser tests edit a real selected clip, seek/loop/pause, change timing, export a decodable WAV of the expected duration, and confirm original download remains unchanged.
4. A cancelled or stopped preparation cannot start later. Returning to the source or another clip invalidates cached renders.
5. At desktop widths the panel stays inside the marked left column and does not extend the existing rack or overlap its neighbors. At narrow widths it remains contained with keyboard-accessible controls and no document overflow.

Authorization is the user's explicit request to implement these tools in this repository and publish the updated Pages app. Preserve unrelated work and existing functionality; do not change the main lab homepage for this feature.

## Implementation notes

The shipped transform uses pinned `@soundtouchjs/core@2.1.1` WSOLA stretching with a local band-limited resampler, packaged as a same-origin worker. An estimated boundary treatment retains short final transients while meeting the requested output length; extreme timing and pitch changes can introduce artifacts. The runtime's MPL-2.0 notices and immutable source provenance are included in the app's existing third-party notice documents.

Editing stores a source-referencing document with 32 undo states and at most 256 segments. It supports the empty timeline after cutting everything, with clipboard paste or undo recovery. Reloading or selecting another clip discards this unsaved document; exporting keeps the edited result. The original file and original take samples are unchanged.
