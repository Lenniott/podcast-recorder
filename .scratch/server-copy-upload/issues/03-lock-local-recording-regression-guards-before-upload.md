# 03: Lock local recording regression guards before upload

**What to build:** Before adding server-copy upload, add focused regression coverage that proves the existing local recording/write path remains authoritative and cannot be delayed, corrupted, or failed by any future upload mirror. This ticket does not build upload behavior; it establishes the safety net that later tickets must keep green.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Architectural context:** The local WAV is the product's first-class recording. Server upload is convenience-only and must be downstream of confirmed local writes. Tests should make that dependency direction hard to accidentally reverse.

- [ ] Existing local writer invariants remain covered: ordered writes, no fabricated silence, `onWritten` after local write confirmation, and full drain on stop.
- [ ] A test harness or seam exists that can attach a fake future upload mirror to confirmed-written chunks without changing local write behavior.
- [ ] Tests prove a slow future upload mirror cannot delay local chunk writes or local finalization.
- [ ] Tests prove a throwing or rejected future upload mirror cannot prevent local WAV data from being written and finalized.
- [ ] Tests fail if upload work is accidentally awaited before local write confirmation.
- [ ] This ticket introduces no server-copy upload feature visible to users.
