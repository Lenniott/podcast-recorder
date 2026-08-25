# 01: Protect active local recording from exit

**What to build:** When a participant is actively recording locally, the app warns or blocks them before tab close, refresh, external URL navigation, or in-app navigation can interrupt the local WAV finalization. If no recording is active and no server-copy upload is pending, leaving the room behaves normally.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Architectural context:** The local WAV is the recording of record. Any exit guard must protect local recording/finalization first and must not make server upload part of the recording safety path. Server-copy upload is a later convenience feature and should only affect exit behavior when there is a real incomplete upload state.

- [ ] Closing, refreshing, changing URL, or navigating in-app while local recording is active triggers a leave warning.
- [ ] Leaving while recording is idle and no upload is pending does not show a warning.
- [ ] The warning copy treats the local recording as the primary artifact and does not mention server upload unless upload is pending.
- [ ] Existing local recording behavior and WAV finalization remain unchanged.
- [ ] Svelte diagnostics and production build pass.
