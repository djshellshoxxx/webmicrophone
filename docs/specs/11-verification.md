# 11 — Verification and release evidence

## Principle

Specifications describe expected behavior. A release report must separately state which checks ran, their outcomes, and remaining platform limitations. Do not convert a checklist into an unsupported claim of audio quality.

## Automated test layers

| Layer | Meaningful checks |
| --- | --- |
| State and presets | Defaults, schema round trip, malformed data, finite/range validation, monitoring excluded |
| DSP | EQ response, neutral bypass, channel independence, polarity, delay, all-pass magnitude, processor continuity |
| Analysis | Peak/RMS, clipping, correlation, silence behavior, tuner fixtures |
| Export | WAV16/24/float headers and samples, duration, sample-rate conversion, trim frame counts |
| Browser | Page load, local import, EQ interaction, keyboard controls, presets, rendering and downloads |
| Live capture | Synthetic media where supported, permission/error states, source/processed separation, muted startup |

Use Node's built-in test runner for deterministic pure-code tests. Browser assertions live in the visible browser harness and may be driven by Playwright where execution is available or by the managed browser. Record which route actually ran. Hardware capture and mobile suspension require explicitly reported manual checks; a synthetic source does not prove every microphone works.

## Audio fixtures

Use generated tones, impulses, silence, stereo inversions and deterministic noise for numerical checks. Where perceptual fixtures are added, record their origin and redistribution rights. Test speech with steady and changing traffic, low and high birdcalls, rain/hail impacts, thunder tails and music. Use reference stems where available to assess desired-sound damage separately from interference reduction.

## Operational scenarios

- Microphone denial, no microphone, disconnection and repeated connect/disconnect.
- Recording with monitoring muted; emergency mute while recording.
- Repeated imports/renders, cancellation, invalid preset, unavailable storage and unavailable encoder.
- Low sample rate, mono/stereo, empty/corrupt files and large inputs near the declared capacity limit.
- Antiphase stereo at substantial per-channel level, verifying that the numeric peak/RMS meters do not cancel the channels into silence.
- Rapid parameter changes, preset changes, sustained playback and final-tail handling.
- Network observation confirming no audio or filenames are transmitted.

## Release gate

1. Production build succeeds with correct Pages paths.
2. All automated tests pass, or a release is explicitly blocked on a named failure.
3. Browser verification exercises the actual built app and a real decoded/exported audio result.
4. Test evidence records commit, browser/runtime and relevant device conditions.
5. User-visible feature claims match implemented and tested behavior.
6. Optional model/encoder failures leave recording, EQ and WAV export usable.

## Performance reporting

Measure live stability, peak memory, render time and model initialization on named reference devices. Report measurements as observed results, not universal guarantees. The initial product may impose explicit duration/file-size limits; it must communicate them before losing a recording. A delayed monitor is not a zero-latency system.

