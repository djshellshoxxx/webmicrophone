# Audio engine implementation notes

`createProcessingGraph(context, settings, options)` in `engine.js` is the common live, audition and offline graph. It validates the shared settings schema before changing the graph. The working context must be 48,000 Hz; import and export handle rate conversion separately.

## Signal paths and latency

The wet path applies input trim, learned spectral reduction, optional RNNoise speech enhancement, channel polarity/delay/right-channel all-pass, low/high cuts, the selected mains notch, ten EQ bands, optional audition solo, linked stereo gate/compressor, wet/dry mixing, output trim and a sample-peak limiter.

- The spectral overlap-add stage delays every path by 1,024 samples, including bypass.
- RNNoise's 480-sample analysis delay plus our 480-sample frame adapter add 960 samples. Speech bypass has the identical delay.
- Total fixed buffering is **1,984 samples / 41.333 ms**. This excludes the capture/output device and browser's own latency and any deliberate relative channel delay.
- The dry mixing path and `alignedRawOutput` have the matching bulk delay. `originalOutput` remains undelayed and precedes all effects. For live paired recording it preserves stereo inputs and duplicates a mono input identically into two channels.
- `differenceOutput` is aligned original minus final processed output. Gain, EQ, dynamics, phase and deliberate channel delay all contribute to this difference; it is not a separated noise stem.
- Offline rendering must append a tail, remove the first `latencySamples` frames, and then choose/document its final tail duration. `offline: true` disables audition solo so an accidental solo selection is not baked into an export.

## Analysis channels

`inputLeftAnalyser` and `inputRightAnalyser` inspect the original channels before processing; `inputAnalyser` is the left-channel compatibility alias. `rawAnalyser` and `rawRightAnalyser` inspect the corresponding originals after fixed-delay alignment. `processedAnalyser` and `leftAnalyser` inspect processed left, while `rightAnalyser` inspects processed right. The original analysis splitter explicitly duplicates a mono input into two identical channels.

The visualizer can display either channel. Numeric meters always use the maximum per-channel sample peak and the square root of mean channel power, avoiding cancellation when stereo channels have opposite polarity. Changing the display channel does not change the original-left tuner source, and resets the spectrogram history. These are recent-window measurements rather than a continuous record of every clipping sample.

All worklets initialize synchronously and acknowledge readiness before the graph resolves. The RNNoise model is compiled before node creation. This avoids racing an asynchronous model initialization against faster-than-real-time offline rendering.

## Learned noise profiles

Profiles have the portable schema `{version: 1, sampleRate: 48000, fftSize: 1024, power: number[513]}`. Each element is squared complex FFT magnitude divided by `1024²`, averaged over the two channels and the explicitly sampled frames, using a periodic square-root Hann window and a 256-sample hop. The values refer to the original input: learning divides out input gain squared, and processing scales the stored powers by the current gain squared.

No profile is learned implicitly. Strength zero or a missing profile is a delayed numerical bypass. Linked spectral gains preserve the channels' relative phase. Attenuation has a strength-dependent floor and smoothed frequency/time gains; sudden energy increases receive conservative preservation. These rules do not identify a bird, hailstone, speaker or other semantic sound source.

## Control semantics

- Low-cut 20 Hz and high-cut 20,000 Hz or above mean **off**, making the natural preset neutral.
- The mains notch affects the selected 50 or 60 Hz fundamental. It does not silently add harmonic notches.
- EQ high/low-pass Q values are conventional resonance ratios; they are converted to `20 * log10(Q)` for Web Audio's high/low-pass `Q` parameter. Other Q-bearing filter types receive linear Q.
- The phase processor is an all-pass filter on the right channel, with frequency-dependent phase. Positive channel delay delays right; negative values delay left.
- The compressor and gate are stereo linked and have no lookahead. The limiter is a **hard sample-peak clamp at ±0.98**, not a true-peak or reconstruction limiter.
- Parameter changes are smoothed in live mode. Changing a filter's type still changes its mathematical transfer function; the tool does not claim arbitrary preset transitions are inaudible.

## Optional speech runtime

The regular RNNoise WASM asset comes from the exact pinned `@sapphi-red/web-noise-suppressor` package. The custom adapter uses the binary's exported C ABI and maintains separate recurrent states per channel. The model stays warm in bypass to avoid restarting recurrent history when speech enhancement is enabled. The adapter does not upload audio or synthesize replacement speech. An unavailable model leaves the delayed baseline path intact and exposes `speechAvailable: false`; a requested speech render reports the failure.

See the bundled third-party notices for the package, WebAssembly build and underlying RNNoise licenses and provenance.

## Numerical verification

Run `node --test src/audio/audio.test.js`. These checks cover FFT inversion, overlap-add identity, variable block boundaries, channel independence, learned-noise attenuation with a strong retained tone, profile validation and gain scaling, the real pinned WASM binary, fixed delay, linked dynamics and the sample limiter. The visible browser harness additionally exercises the native Web Audio graph. Synthetic numerical results do not establish perceptual quality for every real-world recording or microphone.
