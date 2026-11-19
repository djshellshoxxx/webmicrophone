# 04 — Before/after visualization and measurement

## User outcome

See how processing changes the signal and identify levels, clipping, frequency content, background noise and stereo behavior while the microphone is active or a file plays.

## Requirements

- Provide live original and processed waveforms and frequency spectra with explicit labels and comparable axes. Let the user choose left or right, defaulting to left, rather than allowing an unnoticed stereo downmix to cancel antiphase signals.
- Provide a scrolling spectrogram with frequency and time orientation. Its display is a measurement of the signal, not a semantic sound classifier.
- Refresh displays at a bounded rate, independent of audio rendering, and stop unnecessary animation when no signal is active.
- Measure sample peak, RMS and clipping/overload observations. Stereo peak is the larger per-channel peak; stereo RMS is the square root of mean channel power. Measure before channel summing so opposite-polarity channels do not appear silent. Label values in dBFS. Silence displays as silence or negative infinity, not an arbitrary finite measurement.
- Keep peak-hold and reset behavior consistent. Meter styling follows the lab palette, with a clear overload state.
- Provide a timed noise-floor measurement that instructs the user to leave only background sound present. Report the measured RMS/peak and interval, not an inferred microphone self-noise or calibrated environmental SPL.
- Keep source and processed analyzers connected even when monitoring is muted.
- Use explicit channel interpretation and show stereo correlation where applicable. A mono source must not be presented as an independently measured stereo field.
- Respect display size changes and reduced-motion preferences. Numeric values and control labels remain usable without relying on color or canvas detail.

## Acceptance

1. A known sine tone appears near its expected frequency; doubling its amplitude changes the measured amplitude by approximately 6.02 dB within documented windowing tolerance.
2. Silence, full-scale samples and deliberate over-range floating-point fixtures are handled without NaNs or stuck meters.
3. A processing change appears in the processed visualization while the original remains unchanged.
4. Noise-floor measurement reports the actual selected duration and measured signal, and can be cancelled/reset.
5. Monitoring mute does not freeze input meters or stop recording.
6. Display work does not cause audio buffer growth or run on the audio sample loop.

## Interpretation limits

FFT windowing, smoothing and display resolution affect plotted peaks. Digital peak/RMS/noise-floor values do not establish acoustic loudness in dB SPL without separately calibrated hardware and reference measurements.

The meters report sample levels, not integrated LUFS loudness or reconstructed true peaks. The output limiter clamps samples to ±0.98; the export normalization option targets a −1 dBFS sample peak. Neither operation is a loudness-normalization target.

Current analyzer displays inspect bounded recent windows at a limited UI refresh rate. A displayed clipping observation is not a full-duration, every-sample event log and cannot rule out analogue clipping earlier in the capture chain. Waveform/spectrum/spectrogram traces show the chosen **left or right** channel for both original and processed signals, while numeric level meters always consider both channels. Changing the display channel clears the spectrogram history so two channels are not presented as one continuous measurement. The tuner continues to follow the original left channel. Raw and processed waveforms compensate fixed graph buffering; intended EQ/phase/channel-delay effects remain visible.

