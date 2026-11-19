# 12 — Semantic target extraction research

Status: future research, not a shipped capability or dependency of the initial release.

## Goal

Explore whether a browser-local model can isolate a described or exemplified sound, such as a particular birdcall, hail impacts or a selected speaker, beyond what frequency filtering and stationary-noise reduction can provide.

## Qualification requirements

- Identify an actual model and obtain its code, weights, model card and redistribution terms. Check code and weight licences separately.
- Demonstrate inference in the deployed browser runtime, not only in Python or on a remote GPU.
- Measure download size, initialization time, memory, processing speed, supported browsers and failure behavior.
- Evaluate target preservation and interfering-sound rejection on representative recordings, including overlapping events, unfamiliar sounds and absent targets.
- Treat text/exemplar prompts as requests, not proof that a requested source exists or has been correctly isolated.
- Preserve the original and disclose that separated output is an estimate.
- Keep remote processing out of the local baseline. Any future server option would need its own explicit product and data-flow design.

## Candidate research directions

RNNoise establishes speech enhancement, not general target extraction. DeepFilterNet is another speech-enhancement research/porting candidate. AudioSep and SAM Audio demonstrate broader prompted separation approaches, but their existence is not evidence that their models fit this application's browser, memory, download or redistribution requirements.

## Promotion gate

Only add a public semantic control after its deployed implementation passes the qualification requirements and a supported-device policy is documented. Until then, the UI must describe the available operations as cleanup, speech enhancement and signal filtering.

## References

- [RNNoise](https://github.com/xiph/rnnoise)
- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet)
- [AudioSep](https://github.com/Audio-AGI/AudioSep)
- [SAM Audio](https://github.com/facebookresearch/sam-audio)

