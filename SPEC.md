# WebMicrophone — product and engineering specification

Status: implementation specification. The acceptance criteria in these documents are requirements, not claims that a test has passed. Test results and release limitations must be reported separately.

## Purpose

Build a Circuit Drift Labs browser workbench for capturing a microphone, listening to and seeing the effect of processing, and re-rendering existing audio. Users can improve a street interview, preserve birdcalls in wind, emphasize weather details, inspect a microphone, tune an instrument, or shape audio with a full parametric EQ. The application runs as static files on GitHub Pages. Audio processing and recording remain on the user's device.

The initial product performs signal filtering and speech enhancement. It does not claim perfect isolation of arbitrary sounds, identification of a particular speaker, restoration of information lost to clipping, or physical microphone calibration.

## Core commitments

1. Keep the source separate from processed audio. Imported source files and captured browser-delivered samples must not be overwritten by rendering or preset changes.
2. Start with monitoring muted on every load. Microphone access and listening are separate explicit actions. Emergency mute must remain reachable during recording and rendering.
3. Offer live input and file processing through the same settings model. A render starts from the preserved source, never the previous processed export.
4. Use real processors and real measurements. Do not label EQ curves as separated sound stems, dBFS as sound-pressure level, polarity as arbitrary phase rotation, or microphone-type presets as calibration.
5. Keep controls keyboard accessible. Before/after visualizations supplement numeric controls and accessible status messages.
6. Ship a usable baseline without a GPU, server, account, API key, or audio upload. Enable optional speech processing only when its local assets and runtime are available.
7. Match the shared Circuit Drift Labs visual system and link the tool and lab homepage in both directions.

## Capability map

| Module | Specification | Responsibility | Depends on |
| --- | --- | --- | --- |
| capture-monitoring | [01](docs/specs/01-capture-monitoring.md) | Input devices, capture, listening, mute, original and processed recording | state |
| parametric-eq | [02](docs/specs/02-parametric-eq.md) | Ten bands, response display, drag and keyboard editing, solo | state, audio engine |
| cleanup-scenes | [03](docs/specs/03-cleanup-scenes.md) | Noise profile, RNNoise, scene and microphone presets | audio engine, presets |
| visual-analysis | [04](docs/specs/04-visual-analysis.md) | Before/after waveform, spectrum, spectrogram, meters, noise floor | audio engine |
| render-export | [05](docs/specs/05-render-export.md) | Import, immutable source, offline render, formats and rates | audio engine, recording |
| phase-stereo | [06](docs/specs/06-phase-stereo.md) | Polarity, all-pass phase, channel delay, correlation | audio engine |
| presets | [07](docs/specs/07-presets.md) | Local presets and validated portable settings | state |
| chromatic-tuner | [08](docs/specs/08-chromatic-tuner.md) | Pitch, note and cents with signal-quality gating | analysis |
| recording-tools | [09](docs/specs/09-recording-tools.md) | Countdown, timed recording, trimming and loop audition | capture, render-export |
| lab-experience | [10](docs/specs/10-lab-experience.md) | Theme, responsive accessible UI, navigation and Pages integration | UI modules |
| verification | [11](docs/specs/11-verification.md) | Repeatable functional and audio correctness gates | all shipped modules |
| semantic-extraction | [12](docs/specs/12-semantic-extraction-research.md) | Future described-sound or exemplar separation | separate research gate |
| compact-clip-editor | [13](docs/specs/13-compact-clip-editor.md) | Sidebar edits, clipboard/history, waveform seeking, speed/stretch/pitch and matching exports | recording, render-export |

Build order: shared state and DSP contracts; capture and rendering; processing and analysis; preset/editor integration; verification; Pages publication and lab links. The research module is not a dependency of the baseline product.

## Proposed source layout

| Path | Responsibility |
| --- | --- |
| `src/state.js` | Canonical default settings, validation, preset schema and normalization |
| `src/` | UI, audio engine, analysis and recording modules; ownership can be split by feature |
| `public/` | Locally served worklets, WASM/model assets and static assets as needed |
| `tests/` | Pure DSP, state, WAV and recording logic tests |
| `tests/e2e/` | Browser interaction and synthetic-audio verification |
| `docs/specs/` | Feature specifications and verification requirements |

Use Vite and vanilla JavaScript ES modules. The following commands are the repository contract to implement in `package.json`: `npm install`, `npm run dev`, `npm run build`, `npm test`, `npm run test:e2e`. Lock dependency versions in the package lock. Build a static Pages artifact with its repository base path; do not assume deployment at `/`.

## State and processing boundary

`src/state.js` owns the normalized, versioned settings structure. UI controls, preset import, the live graph and offline renderer consume the same normalized values. Processors must reject or clamp non-finite values and unsupported settings. The UI must not have a second independent set of DSP defaults.

Use explicit units in interfaces: hertz, decibels, seconds or milliseconds, unitless Q, normalized wet mix, and sample frames. Store processing parameters separately from session controls such as permission state, monitoring enablement and selected device IDs. Loading a preset cannot start a microphone, enable monitoring, or overwrite an audio source.

For a simple synchronous processor, keep state outside its sample loop and document reset and flush behavior:

```js
export function processBlock(input, output, processorState, settings) {
  for (let frame = 0; frame < input.length; frame += 1) {
    output[frame] = processSample(input[frame], processorState, settings);
  }
}
```

The example is a style contract, not the required architecture for every processor. Audio callbacks must remain bounded; loading, encoding, persistence and large analysis belong outside the real-time path.

## Scope boundaries

Always preserve source audio, honor mute, validate imported settings, bound memory use, and report unavailable capabilities. Record actual sample rates and browser-supported capture settings.

Do not add server processing, upload audio, fabricate measurement precision, advertise unimplemented codecs, or imply that a preset guarantees separation. A third-party model's code and weights both need documented redistribution terms before bundling.

## Completion evidence

A release must identify its commit and include build, automated test and browser-check outcomes. No checkbox in this specification is evidence by itself. Browser-dependent encoders, mobile recording lifetime, microphone hardware behavior and separation quality must be described in terms of tested conditions.

## Primary technical references

- [Web Audio API](https://www.w3.org/TR/webaudio/)
- [Media capture and streams](https://www.w3.org/TR/mediacapture-streams/)
- [MediaStream Recording](https://www.w3.org/TR/mediastream-recording/)
- [RNNoise source](https://github.com/xiph/rnnoise) and [author's browser demonstration](https://jmvalin.ca/demo/rnnoise/)
- [Audacity noise-reduction limitations](https://manual.audacityteam.org/man/noise_reduction.html)
- [GitHub Pages overview](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

Runtime provenance and redistribution notices are recorded in [Third-party runtime notices](docs/specs/THIRD_PARTY_NOTICES.md). Keep the notice document with the deployed assets when distributing the selected RNNoise binary.

