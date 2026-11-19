# Release verification

**Report date: November 18, 2026 (client local date).**

This report records the verified release baseline at commit [`8be0fabe4143e9e4d1207ed8664dfb880ec19524`](https://github.com/djshellshoxxx/webmicrophone/commit/8be0fabe4143e9e4d1207ed8664dfb880ec19524). Build and deployment evidence is available in [GitHub Actions run 44459114662](https://github.com/djshellshoxxx/webmicrophone/actions/runs/44459114662).

The results below apply to that commit. Later documentation or interface refinements require their own CI result; they are not retroactively covered by this baseline.

## Verified results

| Verification | Baseline result |
| --- | --- |
| Node test suite | 40 tests passed. |
| Playwright browser suite | 4 tests passed. |
| Native browser audio harness | 12 checks passed, plus persistence verification after a page reload. |
| Production build | Passed. |
| GitHub Pages deployment | Succeeded. |

Browser verification used native **Chromium 159 in headless mode**, on **Ubuntu 26.04.1**, with **Node 24**. The browser tests exercised actual browser audio processing and application flows using synthetic audio inputs. The persistence check verified browser-local saved audio across a reload in that test environment.

The deployed application is [WebMicrophone on GitHub Pages](https://djshellshoxxx.github.io/webmicrophone/).

## What these results establish

The automated suites and audio harness provide a repeatable baseline for the implemented processing, recording, export, persistence and interface behavior covered by their assertions. Synthetic tones, noise and other generated audio make those checks controlled and reproducible. They are real audio samples processed by the application, but they are not recordings from a physical microphone.

These results do **not** establish physical microphone compatibility, acoustic feedback behavior, real street/bird/weather cleanup quality, or performance on mobile hardware. Physical-device capture, mobile interruption and suspension behavior, and other browsers still require separately reported validation. Passing this baseline also does not imply that every acceptance requirement in the [feature specifications](../SPEC.md) has been tested on every device.

## Current operating limits

- The declared working-session limit is **10 minutes or a 256 MiB decoded-audio budget**, whichever is reached first. Temporary processing copies and browser memory constraints can impose additional practical limits; a small compressed input can decode into much more audio data.
- Speech enhancement is intended for speech. Bird and weather presets use general filtering and noise-profile reduction; the application does **not** provide semantic isolation of an animal call, hail, rain or another selected environmental source. Overlapping sounds can remain, and aggressive cleanup can remove desired sound.
- Monitoring delay changes audition timing. It is **not feedback cancellation**. Monitoring starts muted and must be enabled explicitly.
- “Original” audio means the samples delivered by the browser. The microphone, operating system or browser may already have applied processing before those samples reach the application.
- Browser-local persistence depends on available storage. Generated clips and memory/session fallbacks must be downloaded before leaving if they have not been saved as a persistent take.
- Compressed exports depend on the browser's available encoder. Selected bitrate is a target; the codec can choose the final encoded rate. WAV exports provide explicit sample-rate and bit-depth choices.

For reproducible checks and the remaining manual validation requirements, see [Verification and acceptance](specs/11-verification.md) and [the recording manual checklist](../tests/recording-manual.md).
