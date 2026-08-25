# 06: Show server-copy percent in sidebar

**What to build:** Host and guest can see each participant's local recording status separately from that participant's server-copy upload status. The sidebar shows server-copy percentage, not megabytes, and does not imply that upload is the primary recording.

**Blocked by:** 04: Upload confirmed local recording to server copy.

**Status:** ready-for-agent

**Architectural context:** The sidebar should make local recording and server-copy upload visibly separate. Progress is a percentage of confirmed local recording audio acknowledged by the server; do not display megabytes. The UI should never imply that server upload is required for the recording to be safe.

- [ ] Each participant row distinguishes local recording state from server-copy state.
- [ ] Server-copy progress is shown as a percentage of confirmed local audio.
- [ ] Fast uploads can show 100% during recording without special casing.
- [ ] Incomplete, complete, unavailable, and failed server-copy states are visually distinct.
- [ ] Both peers see the same server-copy status for each participant.
- [ ] UI tests or component tests cover the main status combinations.
