# 03 — Cleanup, scene presets and microphone profiles

## User outcome

Begin with a useful preset for the recording situation, then control cleanup strength while preserving the wanted sound.

## Processor requirements

- Offer lightweight local RNNoise speech enhancement when its WASM/model assets initialize successfully. Use its required 48 kHz processing rate, explicitly resampling a source when necessary rather than relabelling its samples. Show loading and availability explicitly; do not silently substitute a differently labelled processor.
- Keep RNNoise off for wildlife, weather and music presets. A speech model is intended to retain speech and may suppress non-speech sounds the user wants.
- Implement general spectral noise-profile reduction suitable for stationary background noise. Capture a user-selected or explicitly sampled background-only interval; store enough profile metadata to validate its sample rate and FFT interpretation.
- Expose noise-reduction strength and a conservative default. Provide a reset/clear-profile action and make the absence of a usable profile visible.
- Use overlapping windows and stateful reconstruction to avoid chunk boundaries. Preserve continuous processor state during live use and flush the final file-render tail.
- Do not label a frequency filter as AI or present suppression controls as independent sound stems.
- Offer the source for immediate comparison. If a difference audition is available, align paths and define it as a processing difference rather than a guaranteed noise stem.

## Scene catalogue

| Scene | Intended processing | Preservation rule |
| --- | --- | --- |
| Street interview | Speech enhancement and restrained low-frequency reduction | Other voices may remain; one speaker is not selected |
| Indoor voice / fan | Speech enhancement or a stationary-noise profile | Avoid excessive stacked denoising |
| Voice in wind | Speech enhancement and conservative low-band filtering | Clipped gusts are not restored exactly |
| Birdsong in wind | Gentle general cleanup and adjustable low-band attenuation | Speech enhancement and hard gates off |
| Birds near traffic | Rumble reduction and optional sampled background | Low calls and passing vehicles may overlap |
| Insects / dawn chorus | Minimal broad-band cleanup | Preserve faint continuous textures |
| Hail / impact detail | Conservative background reduction, transient-preserving settings | No de-clicking; hard rain may be inseparable |
| Thunder / low ambience | Preserve bass and decay | No automatic high-pass or aggressive gate |
| Rain / environmental texture | Light cleanup and neutral spatial treatment | Preserve sustained texture |
| Music / acoustic detail | Gentle rumble reduction; noise-profile/hum filtering remains an explicit choice | Speech enhancement off; stereo preserved |
| Electrical hum | Explicit 50/60 Hz fundamental notch; additional notches can be set in the EQ | Do not assume harmonics are always noise |
| Custom / neutral | User-selected processors | No hidden cleanup |

Presets are starting settings, not measured guarantees. If a particular control is not implemented, its preset description must not imply that it is active.

## Current control semantics

The low-cut setting at 20 Hz is bypass, and the high-cut setting at 20,000 Hz or above is bypass. These neutral endpoints preserve an uncolored signal instead of silently applying the edge filters. The mains selector applies the selected fundamental only; it does not automatically cut harmonics.

Noise profiles contain a 1,024-point square-root-Hann FFT power estimate with 513 bins at 48 kHz, sampled explicitly from background audio. They contain spectral statistics, not a recording or a semantic classification. Powers are referred to the original input so changing software input trim scales the profile consistently. A stored profile may be inappropriate for a different source or environment; presets do not establish that the profile is still representative.

The speech and spectral stages retain the same fixed buffering in bypass. Turning speech enhancement off preserves the sound type being recorded, although the small speech model remains initialized for smooth switching. The complete graph reports 1,984 samples of fixed buffering at 48 kHz, separate from device/browser latency.

## Microphone-type profiles

Provide descriptive starting points for built-in laptop/phone microphones, headset microphones, USB/dynamic microphones, condenser microphones, and field/stereo inputs where supported. Each profile states which software controls it changes. These are not manufacturer-specific correction curves, microphone sensitivity measurements or physical SPL calibration. A neutral profile is always available.

## Acceptance

1. Speech presets can enable RNNoise; non-speech presets leave it off.
2. An unavailable speech runtime produces a visible availability message while basic recording and EQ continue to work.
3. A noise-only fixture is attenuated with a learned profile; a neutral strength setting preserves the source.
4. A speech/bird/hail fixture confirms that no preset enables a conflicting processor such as speech suppression for birds or de-clicking for hail.
5. Profile capture and clearing update both UI and saved state consistently.
6. Preset names and descriptions match actual processor settings.

## Deferred capability

Semantic extraction such as “only this bird” or “hail without rain” belongs to [the research specification](12-semantic-extraction-research.md). It is not a claim of the initial noise-profile engine.

