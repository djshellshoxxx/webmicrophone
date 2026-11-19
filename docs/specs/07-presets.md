# 07 — Local and portable presets

## User outcome

Save a useful setup in the browser, export it as JSON, and safely load it on another machine without changing capture permissions or destroying audio.

## Requirements

- Centralize defaults and validation in `src/state.js`; UI, live processing and rendering consume the normalized form.
- Include a schema version and descriptive name in exported settings. Store processing parameters with explicit units and stable field meanings.
- Support save, load, rename and delete for user presets, while bundled scene and microphone presets remain recoverable.
- Persist user presets locally and handle unavailable/full browser storage without breaking the audio session.
- Import JSON only through a strict schema/allowlist. Reject malformed, oversized or incompatible documents. Clamp or reject out-of-range values consistently, with feedback.
- Reject non-finite numeric values after parsing/normalization, unsupported filter types and unreasonable array lengths. Never use imported strings as executable code or unsanitized HTML.
- Do not include audio samples, microphone identifiers, permission state, monitoring enablement or unrelated browser data in a portable preset. A learned noise profile's bounded spectral statistics are processing settings and may be included explicitly.
- Loading a preset leaves monitoring muted if it was muted, cannot request a microphone, and cannot overwrite the source recording.
- Distinguish bundled defaults, modified settings and saved user presets.

## Acceptance

1. Every implemented processing control survives export/import with the same normalized value.
2. Invalid JSON, unsupported schema versions, dangerous object keys and unexpected nested structures fail safely without partially mutating the current settings.
3. Missing optional values resolve to documented defaults.
4. A preset cannot turn monitoring on, initiate recording or change the input device.
5. Browser storage failure produces a usable download/export path and preserves the current in-memory settings.
6. Reset returns the processing engine and UI to the same canonical defaults.

