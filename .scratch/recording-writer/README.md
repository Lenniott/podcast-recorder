# Recording contracts

- [Local writer](01-writer-file.md): ordered writes, exact samples, confirmed counts, and failure reporting.
- [Recording session](02-beyond-writer.md): continuous capture, explicit Stop, independent destinations, and console-only issues.

Mic discovery, signal assessment, disconnect detection, and candidate selection live in `src/lib/recording/microphones.js`. The audio engine applies switches and keeps the existing input until a replacement opens. A silent assessment is inconclusive; it is not a disconnect or proof of broken hardware. Rankings are logged through `onMicRanking`.

For behavior changes, add a test at the affected public boundary, confirm it fails, then implement the change.
