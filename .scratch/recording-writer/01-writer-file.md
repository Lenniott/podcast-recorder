# Local writer contract

The earlier proposal to discard a failed chunk and write later chunks has been rejected.

`capture-writer.js` writes only submitted PCM samples, in order. It copies each submitted view so subarrays and later caller mutations cannot change the queued audio. Empty chunks add nothing; missing or invalid constructor inputs throw.

Only successful writes advance counters and notify `onWritten`. A failed or timed-out write records the error, reports a local save failure, and prevents later local writes. `drain()` and `stop()` reject on that failure. There is no retry on an errored browser file stream and no silence insertion in the writer.

A write still pending after one second reports a slow-write warning. After 20 seconds it reports failure. Thresholds are injectable for tests. Observer failures cannot block writing.

The session controller handles stopping capture, completing the server copy independently, and reporting finalization failures. See [02-beyond-writer.md](02-beyond-writer.md).
