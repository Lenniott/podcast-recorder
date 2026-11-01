# Recording session contract

## Capture and Stop

The worklet emits ordered samples while recording. Missing input contributes zeros for the actual render quantum; there is no elapsed-time gap backfill. Live levels continue outside recording for gain adjustment.

Start clears the take buffer. Stop flushes its partial chunk and acknowledges that no further samples belong to that take. The engine waits for this acknowledgement instead of sleeping 300 ms. A missing acknowledgement reports that the tail may be lost; it cannot claim a complete capture.

## Independent destinations

`recording-session.js` offers each chunk to both the local writer and uploader. Waveform and listen-back still observe confirmed local writes. Upload is independent of those confirmations.

Once capture acknowledges Stop, local WAV finalization and server finalization run independently. Each destination reports its own result. A permanent failure in either destination requests an actual recording stop; the surviving destination receives the final chunk and finishes. Failed local writes are not retried. Server retries are bounded, and individual requests (including response bodies) have timeouts.

No browser-storage layer or crash-recovery promise. Both destinations failing can lose audio.

## Issues, console only

The page consumes `onIssue({ code, severity, destination, message, error })` and logs it. Future warning UI can use the same callback. Duplicate issues are suppressed per take.

- `slow-write`: local write remains pending beyond one second; warning only.
- `no-signal`: a few seconds of input at or below the signal floor, and no other microphone is sending audio; warning only. The recording continues. Another microphone with signal is selected instead of reporting this.
- `mic-disconnected`: reconnect attempts failed; warning only.
- `audio-suspended` / `processor-failed`: capture processing is interrupted; warning only.
- `capture-stop-failed`: Stop was not acknowledged; final tail is uncertain.
- `save-failed`: permanent local or server failure; stop capture and finish the surviving destination.

Local success requires the WAV header and close to succeed. Server success requires finalization acknowledgement. Neither copy is called saved simply because chunks were queued.
