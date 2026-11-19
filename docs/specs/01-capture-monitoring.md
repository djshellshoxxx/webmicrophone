# 01 — Microphone capture and monitoring

## User outcome

Choose an input device, observe its signal, record original and processed audio, and audition processing without accidentally enabling a loudspeaker monitoring path.

## Requirements

- Request microphone permission only after an explicit user action over a secure origin. Show permission denial, missing device and busy-device errors with a retry path.
- Enumerate available input devices when the browser permits it; keep device labels private to the local session.
- Request suppression, gain control and echo-cancellation settings appropriate to transparent capture; read back actual supported settings and display them. The stored original is the browser-delivered source, not a guarantee of hardware-raw samples.
- Separate input connection, recording, monitoring and playback controls. Monitoring begins muted after page load and input reconnection. Loading or importing a preset never enables monitoring and preserves an already muted state; processing settings do not contain the monitor-enable flag.
- Provide an explicit monitoring enable action, adjustable output gain and delay, and a persistent emergency mute control with keyboard access. Delay is an audition tool, not a claim of feedback prevention.
- Provide a record-then-play workflow that can be used with live monitoring entirely disabled.
- Record the source independently of the processing chain. Preserve processed audio as a separate result, or render it from the saved source with an identified settings snapshot.
- Stop tracks when disconnecting the microphone. On device loss, finalize recoverable recording data and display the interruption instead of implying uninterrupted capture.
- Meter activity must not depend on audible monitoring being enabled.
- Keep record buffers bounded, display duration and storage/memory limits, and stop cleanly before an allocation failure. The initial working-session cap is ten minutes or a 256 MiB decoded-audio budget, whichever is reached first; source and processed copies and temporary buffers must be included in capacity planning. Do not advertise unlimited recording.

## Acceptance

1. A fresh load is silent, and importing a preset while muted leaves the output silent until explicitly enabled.
2. Emergency mute silences the output path immediately without deleting captured audio or changing saved EQ settings.
3. A deterministic input fixture produces separate original and processed records; changing processing does not alter the original samples.
4. Disconnecting the input or ending its track moves the UI out of recording state and preserves the successfully captured portion.
5. Permission denial leaves the file-import workflow usable.
6. Input visualization and recording work with the monitoring gain at zero.

## Limits to communicate

Hardware, operating-system processing, browser capture settings, sample-rate conversion and background suspension can affect capture. The app must show actual conditions where available and must not promise continued mobile recording while the browser is suspended.

## Current capture representation

The preserved microphone source is the browser-delivered floating-point PCM at the working sample rate. It can already contain hardware, operating-system or browser processing; requesting disabled capture effects is not proof that every layer honored the request. A mono microphone can be duplicated identically into the two stored recording channels so right-channel processing remains available. This is a channel-layout conversion, not an independently recorded stereo field.

The paired recorder compensates the graph's fixed 1,984-frame buffering when saving source and processed samples, and drains pending paired data on pause/stop. Deliberate channel delay and phase changes remain part of the processed result. Imported-file byte preservation is a different operation, described in the export specification.

The optional monitor delay is downstream of the recording output. Increasing it changes what the listener hears and does not delay the saved take or prevent acoustic feedback. The sustained-level guard is an automatic mute based on measured level; it is not a proven feedback classifier.

