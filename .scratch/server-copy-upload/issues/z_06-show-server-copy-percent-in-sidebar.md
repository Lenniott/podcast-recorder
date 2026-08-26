# 06: Show server-copy percent in sidebar

**What to build:** Host and guest can see each participant's local recording status separately from that participant's server-copy upload status. The sidebar shows server-copy percentage, not megabytes, and does not imply that upload is the primary recording.

**Blocked by:** 04: Upload confirmed local recording to server copy.

**Status:** done

**Architectural context:** The sidebar should make local recording and server-copy upload visibly separate. Progress is a percentage of confirmed local recording audio acknowledged by the server; do not display megabytes. The UI should never imply that server upload is required for the recording to be safe.

- [x] Each participant row distinguishes local recording state from server-copy state.
- [x] Server-copy progress is shown as a percentage of confirmed local audio.
- [x] Fast uploads can show 100% during recording without special casing.
- [x] Incomplete, complete, unavailable, and failed server-copy states are visually distinct.
- [x] Both peers see the same server-copy status for each participant.
- [x] UI tests or component tests cover the main status combinations.
