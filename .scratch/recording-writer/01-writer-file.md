# Writer file plan

Scope is `src/lib/recording/capture-writer.js` and `tests/unit/capture-writer.test.js` only. Stop behavior, silent chunks, user warnings, and the server copy stay in [02-beyond-writer.md](02-beyond-writer.md).

No timestamp metadata on chunks. Sample offset already is the timeline: 8,192 samples is 8,192 / 48,000 seconds, and the byte count is twice the sample count. The existing offset test locks that.

## Tests to delete

Both live in `tests/unit/capture-writer.test.js`. They repeat a stronger test or check almost nothing.

- `backlog from a slow disk never turns into gapSamples math at all` — the test above it already proves a slow disk adds no silence.
- `is optional — omitting it changes nothing else about behavior` — only checks that `stop()` returns a value.

## Tests to keep

Leave these as they are. They already match the rules we settled.

- Slow disk writes only the real chunks (`writes only real audio, never silence...`).
- `onWritten` fires after the save resolves, with offsets `0, 100, 200`, including silence chunks.
- `notifyDeviceGap` writes exactly `seconds × sampleRate` zeros, ignores `0` / negative / missing, and sits between real chunks in call order. This function stays. The second plan stops the page from calling it once the microphone loop emits its own silence.
- Call order under a randomly slow disk (`writes real chunks in exact call order...`). Feeding 3, 1, 2 is not a new case: call order is the only order this file has.
- `stop()` waits for the queue, then rejects later `writeChunk` and `notifyDeviceGap`. `drain()` includes a chunk queued while a drain is already running.
- Every upload-mirror test. Each one blocks a different way a side observer can wreck the file: it throws, its promise rejects, or it never finishes.
- `pending` goes 0 → 2 → 1 → 0.

## Tests to add that pass immediately

These branches already behave correctly and nothing calls them. Adding the test does not change the writer.

- `writeChunk(null)`, `writeChunk(undefined)`, and `writeChunk(new Int16Array(0))` return `0` and leave the file empty.
- `createCaptureWriter({ sampleRate: 0, write })` and a missing `write` function throw.
- `notifyDeviceGap` with a duration that rounds to 0 samples (a tiny fraction of one sample) writes nothing.
- `writeChunk` of 100 samples returns `200` (the byte length it will add once the save finishes).

## Code change: a failed save must not drop the chunks after it

Today `enqueue` chains with `tail.then(fn)`. If `write()` rejects, `tail` rejects, and the next `then` skips its function. Every later chunk is discarded. `drain` only avoids hanging; it does not save those chunks. Nothing in the suite calls a `write` that rejects.

Rule: the failed chunk is not confirmed (`samplesWritten` stays unchanged for it, `onWritten` does not fire for it). Every chunk queued after it is still written, in order. `stop()` still resolves.

Order of work:

1. Add the test first, against the current writer. Run it and confirm it fails.
2. Then change `enqueue` so a previous rejection cannot skip the next save.
3. Re-run and confirm the new test passes and the kept tests still pass.

No retry loop. A chunk the disk refused is not secretly rewritten forever, and `stop()` must not wait on it. Warning the user, and sending that chunk to the server anyway, are the second plan.

## Functions after this plan

Public surface: `writeChunk`, `notifyDeviceGap`, `drain`, `stop`, `samplesWritten`, `dataByteCount`, `pending`.

- `writeChunk` happy path, closed writer, and the new empty-input and failed-`write` cases are covered.
- `notifyDeviceGap` happy path, bad durations, closed writer, and the new round-to-zero case are covered.
- `drain` and `stop` are covered, including drain-while-queueing and stop-then-reject.
- `samplesWritten`, `dataByteCount`, and `pending` are covered.
- Internal `enqueue` is covered by the failed-`write` test (the hole is here).
- Internal `notify` / `confirmWritten` are covered by the `onWritten` and mirror tests.
- Constructor guards are covered by the new throw tests.

Nothing inside this file is left uncalled. What this file still does not do, on purpose: flush a half-built microphone chunk, invent silence when the mic is missing, warn a person, or upload to the server.
