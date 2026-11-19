# Recording and export verification scenarios

These scenarios are requirements to run and record, not claims of completed checks.

1. With monitoring muted, feed a known stereo signal into the app. Record original and a substantially filtered result. Stop and reload. Both tracks must load and retain left/right channel identity. The stored original samples are unchanged; the processed take is aligned to them using the engine's documented fixed delay. Stop and pause must drain that delay before completion, including the final captured impulse.
2. Choose a three-second timed take. Verify its original PCM frame count equals three times the actual context sample rate, rather than relying on a UI timer's tick count.
3. Pause/resume a take. Verify the paused time is not silently represented as continuous capture; the take metadata records a pause marker.
4. During recording, close the tab without pressing stop. Reopen and load the recovered committed prefix. It must be marked interrupted and contain no unexplained joined gaps.
5. Deny IndexedDB or use a browser environment where it fails. The recorder must report session-only storage and enforce the 64 MiB total fallback. Download and remove the existing fallback take before another recording.
6. Remove the microphone, suspend the audio context, and stop while writes are pending. Stop must await acknowledged writes or report a recovered interruption; it must not claim that a missing final worklet buffer was saved.
7. Import mono/stereo PCM16, PCM24 and float32 WAV, then a supported compressed file. Original-file download must return the original bytes; the working buffer's sample rate must be shown separately.
8. Render the same preserved source twice using identical settings. Compare results with numerical tolerance and verify EQ/gain processing does not accumulate.
9. Export all WAV formats. Independently decode each, inspect duration/channel count, and verify a test tone maintains pitch when exported at 44.1, 48 and 96 kHz.
10. Trim a source and normalize its sample peak. Check output frame count and approximately −1 dBFS sample peak; verify the source samples remain unchanged.
11. Export each advertised compressed format at two supported bitrate requests. Verify actual MIME, filename extension, decoding and the reported requested/encoder bitrate. Compressed export plays only into a recording destination, not the speakers, and runs in real time.
12. Cancel offline rendering, WAV encoding and compressed export. The previous source and completed output remain usable. A native offline render may finish internally, but its cancelled result must never replace the current result.
