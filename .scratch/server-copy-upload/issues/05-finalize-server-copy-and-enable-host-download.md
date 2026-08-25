# 05: Finalize server copy and enable host download

**What to build:** When recording stops and all uploaded audio for a participant has reached the server, the server finalizes that participant's server copy as a WAV and lets the host download it while the room is active.

**Blocked by:** 04: Upload confirmed local recording to server copy.

**Status:** ready-for-agent

**Architectural context:** A server copy is useful only if the host can retrieve it before the room expires. Finalization should be based on the explicit completed local recording length, not on the connection closing or a timer. Incomplete server copies are not recordings and must not be downloadable as if they are complete.

- [ ] The server writes a valid WAV for a completed server copy.
- [ ] A server copy is marked complete only after the final local recording length has been received and finalized.
- [ ] The host can download completed participant WAV files before the room expires.
- [ ] Downloads are unavailable for incomplete, expired, or deleted room copies.
- [ ] Downloaded server-copy WAV duration and sample count match the uploaded confirmed local audio.
- [ ] Tests cover successful finalization, incomplete-copy refusal, and host download authorization.
