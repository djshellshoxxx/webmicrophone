# 08 — Chromatic tuner

## User outcome

Read the dominant stable pitch of a single musical note as frequency, note name and cents from the reference pitch.

## Requirements

- Estimate pitch from a bounded analysis window using an appropriate periodicity method. Keep this work outside the audio callback where practical.
- Show note name, octave, frequency and cents deviation; expose a reference pitch setting or clearly state the chosen reference, initially A4 = 440 Hz.
- Gate low-level, unpitched and insufficiently periodic signals. Display “No stable pitch” rather than a confident arbitrary note.
- Smooth the display without concealing large, sustained pitch changes.
- Let the user understand whether the tuner follows the original or processed signal, and label that source. The initial tuner follows the original left channel, before the processing chain.
- Keep the tuner available with live monitoring muted.

## Acceptance

1. Stable generated tones at representative notes resolve to the correct note and a documented cents tolerance over the declared frequency range.
2. Silence and broad-band noise do not produce a stable confident note.
3. Changing the reference pitch changes cents/note interpretation correctly without altering the audio.
4. A note transition settles within a documented analysis/display interval.
5. Very low or high frequencies outside the supported range produce a useful unavailable state.

## Limits

This is a monophonic chromatic tuner. It does not transcribe chords, identify multiple overlapping instruments, or guarantee correct fundamentals in every noisy or overtone-heavy recording.

The initial estimator searches approximately 55–1,500 Hz at the 48 kHz working rate and uses a periodicity/level gate. This is the intended operating range, not proof that an out-of-range or strongly harmonic signal can never produce an octave error. Release evidence must identify the tones and cents tolerance actually tested.

