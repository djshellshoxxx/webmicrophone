# 05 — Import, re-render and export

## User outcome

Open an existing recording, preview processing, render a new result from the unchanged source, and choose useful output quality and file size.

## Requirements

- Accept local audio files supported by the active decoder. Report unsupported or malformed input without losing the previous project.
- Display actual source duration, channel count and decoded sample rate. Retain the original source separately from every processed render.
- Render from the source and normalized settings snapshot. A second render must not process the first render again unless the user explicitly imports it as a new source.
- Keep the UI responsive and show rendering status and cancellation. On cancellation, preserve the source and previous successful outputs.
- Provide WAV export at 16-bit PCM, 24-bit PCM and 32-bit IEEE floating point. Encode format identifiers, byte rate, block alignment and data length correctly.
- Offer selectable export sample rates with real resampling. Changing the file header alone is not sample-rate conversion. Output duration and pitch must remain correct.
- Offer compressed export only for an encoder actually available in the current environment. Show its container, codec and requested bitrate in kbps. If the browser selects or reports a different bitrate, show that fact where measurable.
- If MP3 is bundled, use a documented locally executed encoder and test real MP3 output. Do not rename a WebM, MP4 or WAV file to `.mp3`.
- Do not promise exact compressed file size or universally supported browser encoders. Feature detection and a WAV fallback are mandatory.
- Warn through an actionable capacity message before exceeding tested import/render memory limits. Whole-file decoding can expand far beyond the compressed input's size. The initial declared working bound is ten minutes and a 256 MiB decoded-audio budget, with additional headroom for source/processed copies and rendering. Reject inputs exceeding the enforced bound and explain the usable limit; streaming arbitrary compressed files is not an initial requirement.
- Preserve channel layout unless a selected processor or explicit output option requires a documented conversion.
- A captured filtered take must align with its original samples. Delay original samples and the capture-active mask by the engine's declared fixed latency, then save the aligned original/processed pair. Pause, timed stop and manual stop stop accepting new original samples and drain the pending processing tail before acknowledging completion. Metadata retains `latencyFrames` as provenance and sets `latencyCompensated: true`; callers must not crop the saved processed track again.
- If a suspended context or device failure prevents the tail from being delivered, finalize the committed paired prefix as interrupted. Preserve already queued writes and report that only the saved portion is available.
- Offline output uses the same engine and removes its fixed startup latency. The UI first copies the selected original region, then creates a fresh processing graph and returns that selection's exact duration. Processing starts at the selection boundary without pre-roll; output omits any effect decay beyond the selected duration. The UI identifies these semantics. The lower-level render API has an explicit additional-tail option for callers that need post-selection decay.
- Downloading an imported original returns the original file bytes. Exporting decoded original audio as WAV represents the decoded working PCM and any explicitly chosen trim/resampling; it is not a bit-identical copy of the imported container.
- Mono sources retain mono output unless independent polarity, channel delay or phase processing requires stereo. An explicit mono-sum setting may return mono. Original imported file bytes remain unchanged in all cases.

## Acceptance

1. Independent WAV parsing validates PCM16, PCM24 and float32 headers and known positive/negative sample values.
2. A test tone exported at another sample rate retains its duration and frequency within defined resampling tolerance.
3. Repeated rendering with identical source/settings does not accumulate EQ or gain changes.
4. Cancelling a render leaves the original and prior result available.
5. Compressed output has a matching MIME type, extension and decodable container; unavailable encoders are disabled with a useful explanation.
6. The requested bitrate is passed to the selected encoder and is not represented as guaranteed exact output bitrate.
7. Trimming and tails do not silently omit expected samples.
8. First/last impulse fixtures and a paused/resumed fixture retain every captured original sample and match the saved processed track's frame boundaries after fixed-latency alignment.

## Implementation boundaries

WAV is the reliable baseline. Browser-compressed encoding may run in real time and may differ by platform. Faster-than-real-time rendering and exact file sizes are features to measure, not assumptions.


Compressed bitrate controls are encoder targets rather than promises of a constant file-average bitrate. The selected sample rate prepares the input to the encoder; a browser codec can choose a different final encoded rate. Compressed filenames identify their format rather than asserting that the requested input rate is the final encoded rate. WAV exports write the selected sample rate explicitly.
