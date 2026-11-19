# 02 — Ten-band parametric EQ

## User outcome

Shape microphone or imported audio with ten independently configurable bands and understand each band's contribution visually and audibly.

## Requirements

- Provide exactly ten persistent bands, each with enablement, filter type, center/cutoff frequency, gain where applicable, and Q where applicable.
- Support peaking and shelf filters plus high-pass, low-pass and notch filters. Hide or disable controls that do not apply to a selected filter type.
- Draw the combined frequency response on a logarithmic frequency axis. Plot the response at the actual processing sample rate and keep selected frequencies below Nyquist.
- Drag a band horizontally to change frequency and vertically to change gain for gain-bearing filters. Expose Q through a visible numeric/range control and an explained modifier or wheel gesture.
- Provide keyboard equivalents and editable numeric inputs for all drag operations. A keyboard user must be able to select a band, enable it, adjust frequency/gain/Q, and solo it.
- Solo a band's frequency region for audition without changing or deleting its stored settings. Distinguish audition solo from destructive rendering; render the intended settings rather than accidentally baking an audition state.
- Include band reset, all-band reset, EQ bypass and a neutral starting preset.
- Smooth coefficient or parameter changes to avoid abrupt control-induced clicks. Avoid allocating work repeatedly inside the sample loop.
- Validate frequency, Q and gain as finite bounded values. Render and live processing use the same filter definitions.

## Acceptance

1. All ten bands independently affect the combined response; resetting one leaves the other nine unchanged.
2. Numeric and drag edits agree and persist through a preset round trip.
3. A sine sweep confirms expected pass, stop, notch, shelf and peaking behavior within a documented tolerance.
4. Neutral or bypassed EQ does not change level or channel layout beyond documented numerical tolerance.
5. A low sample-rate import is explicitly converted to the working rate, and no EQ band reaches or exceeds the working context's Nyquist frequency. Conversion does not restore frequency detail absent from the source.
6. Keyboard-only operation can edit and solo every band, and focus remains visible.
7. Live preview and file rendering use equivalent EQ settings.

## Truthful limits

Frequency filtering attenuates every source in the affected band. Selecting a voice-frequency band is not equivalent to separating speech from overlapping traffic.

## Implementation mapping

The EQ plot combines the ten EQ bands; it does not claim to plot the nonlinear noise reducer, compressor, limiter or every other stage. High/low-pass Q is a conventional resonance ratio in saved settings and is mapped to Web Audio's decibel-valued Q parameter for those filter types. Other supported Q-bearing filter types use linear Q.

Audition solo is excluded from fresh offline renders. A saved live processed track represents the processing active during capture, including an audition solo if the user left it enabled; the source track remains available for a fresh render. Live parameter changes are smoothed, but changing filter type or switching an entire preset is not guaranteed to be inaudible.

