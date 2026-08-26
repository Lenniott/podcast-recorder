# 04: Upload confirmed local recording to server copy

**What to build:** While a participant records locally, the app sends a server-copy upload from audio that has already been confirmed written to the local recording. Upload progress is measured only as a percentage of confirmed local audio, so the server copy may stay at 100% on a fast connection without changing the local recording path.

**Blocked by:** 02: Tie server copies to room lifetime; 03: Lock local recording regression guards before upload.

**Status:** done

**Architectural context:** Upload is separate from recording. The app must first write the local recording, then use confirmed-written audio as the source for the server copy. Do not use live mic signal, elapsed time, or WebRTC media as the archival source. If upload is slow or fails, local recording continues and the UI should treat the server copy as convenience-only.

- [x] Upload starts only after local recording has started and a server-copy session has been accepted for the active room.
- [x] Audio chunks are queued for upload only after the local writer confirms they were written.
- [x] Server acknowledgements advance upload progress by byte or sample offset, not by wall-clock time.
- [x] Upload failure or slowness never blocks, delays, corrupts, or fabricates local recording audio.
- [x] The client can report server-copy percentage as acknowledged server audio divided by confirmed local audio.
- [x] Tests prove local recording still proceeds when server-copy upload is slow or rejected.
