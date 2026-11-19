# 10 — Circuit Drift Labs experience and publication

## User outcome

Use a coherent, responsive audio workbench and move naturally between WebMicrophone, its source repository and the Circuit Drift Labs tool collection.

## Visual requirements

Use the canonical lab `theme.md` and `BRAND.md` as the visual reference: base `#0E1116`, panel `#171B22`, edge `#2A303A`, orange `#E8532A`, teal `#4FB6C4`, primary text `#E6E8EC`, muted text `#8A929E`, green signal and yellow near-clip states. Use local/system font fallbacks if font downloads are not bundled.

Follow the shared 8-pixel spacing system, restrained panels, numeric tabular readouts, compact controls, clear selected states and diagonal accent mark. Prefer one useful signal workspace to excessive nested cards. Adapt the compact plugin vocabulary to touch and browser accessibility; controls must remain comfortably operable.

## Interaction requirements

- Put source selection, record/stop and emergency mute where they remain easy to find.
- Group controls into input/monitor, cleanup, EQ, phase/stereo, analysis and export without hiding the basic workflow.
- Include concise contextual help for Q, polarity, all-pass phase, noise profile, dBFS and encoding bitrate.
- All essential controls have programmatic labels, visible focus and keyboard operation. Canvas-only operations require equivalent controls.
- Mobile layouts must avoid horizontal clipping and must keep transport and mute accessible.
- Status messages distinguish ready, processing, unavailable and failed states. Do not simulate a successful model or export while a capability is unavailable.
- Respect reduced-motion preferences and avoid animation unrelated to actual signal or state.

## Integration and deployment

- Tool URL: `https://djshellshoxxx.github.io/webmicrophone/`.
- Source URL: `https://github.com/djshellshoxxx/webmicrophone`.
- Lab URL: `https://djshellshoxxx.github.io/circuitdriftlabs/`.
- Add a clear lab backlink in the tool header/footer and source/specification links where appropriate.
- Add WebMicrophone to the lab's existing Tools dropdown, browser-tool cards and project index without removing existing entries.
- Build for the repository subpath, including workers, model/WASM assets and dynamic imports. Use relative or configured base paths consistently.
- Ship static files only. Keep all required runtime assets locally served where practical and do not add audio upload endpoints.

## Acceptance

1. The built application works at `/webmicrophone/`, not just the development server root.
2. Lab and source links resolve to their intended destinations; existing lab links remain unchanged.
3. Desktop and narrow-screen checks show no obscured primary controls or horizontal overflow.
4. Keyboard-only users can connect/import, adjust processing, record, mute, save a preset and export.
5. The UI makes unsupported capabilities visible and preserves a usable baseline.

