# 09 — Countdown, timed recording, trimming and loop audition

## User outcome

Start a recording after a visible countdown, stop it at a chosen duration, and audition or export a selected region without damaging the source.

## Requirements

- Offer configurable countdown and optional maximum recording duration with explicit units and bounds.
- A countdown is cancellable. Permission prompts and device initialization must finish before its timing is treated as armed recording time.
- Display armed, countdown, recording, stopped and interrupted states distinctly. Prevent overlapping start actions.
- Schedule recording duration from the recording timeline rather than accumulating UI timer callbacks alone.
- Provide trim start/end selection in seconds with validation against the source duration. Keep edits non-destructive and offer reset to the full source.
- Provide loop audition of the selected region. The loop state affects playback; it does not duplicate audio in an export unless a separate explicit feature exists.
- Allow recording without live monitoring, followed by playback of the saved source or processed result.
- On stop or timed completion, flush data, make the completed region available, and do not leave the microphone output unexpectedly audible.

## Acceptance

1. Cancelling a countdown starts no recording and creates no false successful clip.
2. Timed capture stops within a documented audio-buffer/timer tolerance on the tested environment.
3. Trim bounds cannot be negative, reversed or beyond source duration.
4. Exporting a trimmed clip produces the expected frame count within resampling rounding tolerance, while resetting trim restores the full source.
5. Loop audition repeats only the selected interval and stopping it leaves the source unchanged.
6. Rapid start/stop actions cannot create concurrent recorders or lose the finalized clip.

## Selection and loop semantics

Changing the loop toggle during playback restarts the selected region with the new mode. This avoids retaining a previously scheduled one-shot stop after the user enables looping. Turning looping off plays the selection once from its beginning.

For an export with current settings, the selected original region is copied before processing. The graph starts with fresh processing history at that region's beginning, and export does not trim the shortened result a second time. Reselecting a saved take restores its full-source selection; the source samples are never edited by trimming.

