# WebMicrophone

A Circuit Drift Labs browser workbench for microphone recording, audio cleanup, parametric EQ, live analysis and local re-rendering.

[Open WebMicrophone](https://djshellshoxxx.github.io/webmicrophone/) · [Circuit Drift Labs](https://djshellshoxxx.github.io/circuitdriftlabs/) · [Full specification](SPEC.md)

## Product scope

WebMicrophone is designed to capture a microphone or open a local recording, keep the source separate, and let you compare processing before exporting a new result. The feature specifications cover:

- Original and processed recording, explicit monitoring, delay and emergency mute.
- Ten-band parametric EQ with a draggable response editor, solo audition and keyboard controls.
- Before/after waveform and spectral displays, peak/RMS/clipping, noise-floor measurement and a chromatic tuner.
- Local speech enhancement, general noise-profile reduction, and scene/microphone starting presets.
- Left/right polarity, frequency-dependent all-pass phase, channel delay and stereo correlation.
- Saved browser presets and validated portable JSON.
- Local file import and re-rendering, WAV16/WAV24/float32 export, sample-rate selection and available compressed encoders.
- Countdown and timed recording, non-destructive trimming and loop audition.

The individual specifications define acceptance requirements. They do not claim that every target has been verified on every browser; implementation and release test evidence must identify the tested capabilities.

## Intended workflow

1. Connect a microphone or open a local audio file.
2. Choose a scene or start with neutral settings.
3. Adjust cleanup, EQ and stereo tools while comparing original and processed signals.
4. Record with monitoring muted, or explicitly enable monitoring when wanted.
5. Re-render from the preserved source and export a supported format.

Monitoring starts muted. A monitoring delay is an audition control, not feedback cancellation. Browser capture may include hardware or operating-system processing; “original” means the samples delivered to this application.

## Honest audio limits

Speech enhancement is intended for speech. Bird, weather and music presets keep speech-specific suppression off. A noise profile works best for reasonably steady background sound; it cannot guarantee separation of overlapping traffic, voices, rain and hail. Microphone-type presets are starting settings, not calibrated correction curves. Meters report digital dBFS, not physical sound-pressure level.

General prompted sound extraction is documented as [future research](docs/specs/12-semantic-extraction-research.md), not a baseline claim.

## Development

Runtime: Vite, vanilla JavaScript ES modules and the browser Web Audio/media APIs. The repository command contract is:

```sh
npm install
npm run dev
npm run build
npm test
npm run test:e2e
```

See [SPEC.md](SPEC.md) for the module map and [verification requirements](docs/specs/11-verification.md). The app must build for its `/webmicrophone/` Pages subpath and serve model/worklet assets correctly from that base.

## Privacy and availability

The product processes audio locally and does not require an account, API key or audio upload service. Browser permissions, file decoding, encoders, storage capacity and background behavior vary; unsupported features must be identified in the interface with a usable baseline fallback.

## Specifications

The [master index](SPEC.md#capability-map) links a specification for each feature, including testable acceptance criteria and limits. Keep these documents aligned with implementation changes and report test outcomes separately from requirements.

## Audio runtime credits

The selected local speech-enhancement asset is RNNoise, supplied by the pinned `@sapphi-red/web-noise-suppressor` package and Shiguredo's WebAssembly build. Full attribution, licence texts and the binary provenance record are in [Third-party runtime notices](docs/specs/THIRD_PARTY_NOTICES.md).
