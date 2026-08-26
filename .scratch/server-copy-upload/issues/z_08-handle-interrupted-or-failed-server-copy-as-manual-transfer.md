# 08: Handle interrupted or failed server copy as manual transfer

**What to build:** If a participant leaves, disconnects, or the server-copy upload fails before completion, the app treats the server copy as incomplete and tells users to use the local WAV/manual transfer path. The system does not attempt resumable upload and does not imply any local recording loss.

**Blocked by:** 07: Block on upload finish after recording stops.

**Status:** done

**Architectural context:** Do not build resumability for this feature. If the participant leaves or upload cannot complete, the server copy is incomplete and the fallback is manual transfer of the local WAV. Failed server upload must be presented as loss of convenience, never loss of recording.

- [x] Leaving before server-copy completion leaves the server copy marked incomplete.
- [x] Rejoining the room does not pretend the previous incomplete upload can resume.
- [x] Host and guest see clear copy that the local WAV is the fallback and must be sent another way.
- [x] Incomplete server-copy files cannot be downloaded as if complete.
- [x] Expired-room cleanup removes incomplete server-copy files.
- [x] Tests cover interrupted upload, failed upload, and incomplete download refusal.
