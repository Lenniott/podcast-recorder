# Recording beyond the writer

Depends on [01-writer-file.md](01-writer-file.md). That plan leaves `src/lib/recording/capture-writer.js` able to save later chunks after one disk write fails. This plan is every agreed behavior that cannot live in that file alone.

Each slice is the same order: write the test, watch it fail, then change the code.

## 1. Stop finishes the open chunk and starts no new one

What the code does now, in `src/routes/rec/[slug]/+page.svelte` `stopRecording`: it waits 300ms and still accepts every chunk that arrives. 300ms of audio is about 14,400 samples, more than one 8,192-sample chunk, so a new chunk can begin after Stop. The worklet in `static/worklet/recorder-processor.js` only posts when the buffer reaches 8,192, and it has no flush message, so a short tail is thrown away.

Rule: Stop posts a flush. The worklet emits whatever samples it already holds, even when that is shorter than 8,192, then buffers nothing else. The page accepts that one flushed chunk and then calls `captureWriter.stop()`. The 300ms wait goes away.

The worklet class is a poor place to test this. Pull the buffer into a plain function (push samples, flush, closed-after-flush) that the worklet calls. Tests target that function.

Failing test, then code:

- Push 100 samples, flush, get one 100-sample chunk.
- Push more samples after flush, get nothing.
- Push 8,192 samples before flush, get one full chunk, and flush of an empty buffer adds no extra chunk.

## 2. Missing input is silent chunks, not a timer

In the worklet, `process` returns immediately when there is no channel data, so the file stops growing while the clock keeps going. `src/lib/recording/audio-engine.js` times that hole and the page calls `notifyDeviceGap`, which writes the silence afterward. A quiet room and a missing mic are both zeros, so silence must not be what triggers a reconnect.

Rule: while the audio clock is running and a quantum arrives with no samples, the buffer fills with that many zeros and emits normal-sized chunks. Reconnect stays on `track.onended` inside the audio engine. The page stops calling `notifyDeviceGap`, or the same hole is written twice. `notifyDeviceGap` itself stays in the writer; its unit tests stay with it.

Failing tests, then code:

- No channel data for a full chunk's worth of quanta produces one all-zero chunk of the normal size.
- A connected stream of real samples produces no extra zeros.
- The page path that handles a gap does not call `notifyDeviceGap` once this slice is in.

## 3. Warnings

Two warnings, both with the threshold passed in from outside. Production values stay long. Tests pass a short stand-in.

- Connected mic, saved chunks are zeros for 10 minutes: show a warning. The test uses 2 seconds. Zeros from a missing device do not take this path.
- Device ended: keep the current reconnect attempts in `connectMicWithFallback`. When that pass still has no mic, show a warning. The test uses a fake `getUserMedia` that fails.

Slow disk: the page's `write` function times the save. A chunk that takes longer than 1 second sets a visible warning. The test uses a fake clock or an injected threshold so it does not wait a real second. A save under the threshold sets no warning. This does not change the writer. The writer plan already makes a rejected save continue with later chunks; this slice only adds the message.

Failing helper tests first, then the warning state. The helper should be a plain function (consecutive silent duration, slow-write boolean) so the test does not need the Svelte page.

## 4. Server copy does not wait for the disk

`src/lib/server-copy/server-copy-upload.js` `handleWritten` is documented as the writer's `onWritten` hook, so it runs only after that chunk's disk save resolves. A disk that never finishes means the server never gets the chunk either.

Rule: the moment a chunk is handed to `writeChunk`, the same samples are handed to the server upload, and that call is not awaited. `onWritten` stays the feed for the waveform and listen-back, which must keep reflecting confirmed disk bytes. The server must not be fed twice.

Failing test, then code:

- Disk `write` that never resolves: the server upload has still been given the chunk.
- A server upload that hangs does not delay `stop()`.
- One chunk produces one server send, not two.
