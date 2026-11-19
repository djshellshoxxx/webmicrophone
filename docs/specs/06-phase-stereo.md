# 06 — Polarity, phase and stereo tools

## User outcome

Inspect and adjust channel relationships without confusing polarity inversion, frequency-dependent phase rotation and time delay.

## Requirements

- Provide independent left/right polarity controls where the source has those channels. Polarity inversion multiplies the selected channel by −1; it is not an arbitrary frequency-independent phase angle control.
- Provide a frequency-dependent all-pass phase processor with clearly labelled frequency/Q or equivalent documented parameters. Explain that its phase response varies with frequency while its ideal magnitude response remains flat.
- Provide per-channel delay with explicit units and bounded values. Include delay in live monitoring latency and rendered output alignment/tail handling.
- Display stereo correlation and identify mono inputs. Correlation is an observation over a defined recent window, not a universal quality score.
- Provide a neutral reset and ensure preset import cannot apply non-finite or excessive delay values.
- Preserve separate channel state for filters and delay lines. Do not unintentionally share one channel's delay history with another.
- Include phase/delay effects in before/after comparisons; where paths are deliberately delayed, do not claim a raw unaligned subtraction is a clean noise residual.

## Acceptance

1. Left-only polarity inversion negates left samples and leaves right samples unchanged.
2. A known channel impulse emerges at the configured delay within the implementation's sample-resolution tolerance.
3. All-pass processing has approximately unity magnitude across the usable band within documented numerical tolerance while changing phase.
4. Identical stereo channels measure close to +1 correlation; inverted channels close to −1; silence has an explicit undefined/quiet state rather than a misleading score.
5. Neutral phase and delay settings preserve samples within documented numerical tolerance.
6. Offline processing retains expected delayed tails or makes an explicit, documented trim choice.

## Implementation mapping

The all-pass stage affects the right channel. The relative delay control spans −20 to +20 ms: positive values delay right, negative values delay left, and zero leaves both undelayed. Polarity controls remain independent. Mono sum is an explicit averaging operation after the channel effects and can therefore expose their cancellation.

The fixed 1,984-frame processing delay is compensated separately from these intentional effects. Fresh UI renders start processing at the selected region's beginning and keep its exact selected duration; an intentional delay or filter decay extending beyond the selection is cropped by that default policy. The lower-level renderer can request an additional tail, but the UI does not advertise a tail-length control. A mono imported source is promoted to two processed channels when asymmetric effects require it; downloading its original file preserves the original channel layout.

