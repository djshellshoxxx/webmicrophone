# Recording contract

`TakeRecorder` stores browser-delivered original PCM and processed PCM independently in one capture worklet. A take is mono or stereo. The caller supplies actual channel count and the processing graph's fixed `latencyFrames`.

## Alignment and boundaries

The worklet delays original samples and a capture-active mask by `latencyFrames`. A pair is written only when the delayed mask is active. This preserves the exact original samples while matching the corresponding processed samples. Starting does not save the processed path's initial delay as leading silence. Pausing and stopping disable new capture, drain the existing mask/delay, flush the partial chunk, and only then acknowledge completion. Resume creates another active region; the paused interval is omitted and recorded as a pause marker.

Keep the source graph connected and the audio context running until `await recorder.pause()` or `await recorder.stop()` resolves. A stop generally waits for the fixed processing delay plus pending storage writes. A timed duration counts accepted original frames, excluding pauses and the drain period.

Metadata includes `latencyFrames`, `latencyCompensated: true`, the input and stored channel counts, settings snapshot, pause markers, and the exact committed frame count. `loadTake(id,{track:'processed',context})` already returns aligned PCM. Do not apply another latency crop. Older data lacking the compensation flag must not be described as aligned automatically.

`stop({reason:'device-ended'|'context-interrupted'|'page-hidden'|'manual'})` allows the UI to record why capture ended. Non-manual interruption reasons remain truthful even if all available chunks were saved. If suspension prevents the final worklet message, a timeout returns the committed prefix with interrupted status. An interruption does not discard pending valid writes; a failed storage write stops further persistence without joining a gap.

## Storage and limits

IndexedDB stores chunks and their metadata checkpoint in the same transaction. Buffers are returned to the worklet only after the transaction completes. Exhausting the fixed buffer pool stops capture instead of overwriting unsaved data. Reload exposes unfinished takes as recovered interruptions.

Capture is capped at ten minutes or 256 MiB of original float PCM, whichever is smaller. The corresponding processed track can require the same storage again. The bounded session-only fallback holds at most 64 MiB total, is clearly identified, and requires exporting/removing a prior fallback recording before another capture. Browser storage can be evicted; a download is the user's persistent copy.

Imported files retain their original bytes separately from the decoded working PCM. Native compressed decoding requires a complete file; imports are preflighted for finite duration, size and mono/stereo layout and capped at ten minutes/256 MiB working source. Large streaming compressed import is not implemented.

## Checks

`node --test tests/recorder.test.js tests/export.test.js` verifies stored track separation, PCM headers and samples, capacity rules, and the actual worklet with varying render block sizes, first/last impulses, pause/resume boundaries, and buffer exhaustion.

`npm run test:e2e` launches the visible browser harness through a real button click. It exercises native AudioWorklet, IndexedDB/reload, local processing, all WAV depths, resampling, trimming, original-byte preservation and the available compressed encoders. Generated-audio checks do not substitute for physical microphone and mobile suspension testing.
