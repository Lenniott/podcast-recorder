# 02: Tie server copies to room lifetime

**What to build:** Server-side audio copies live and die with their room. A server copy can only be uploaded or downloaded while the room is still active, and expired or manually deleted rooms remove their server-copy files as well as their room metadata.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Architectural context:** Rooms already expire by comparing the current time to the room creation timestamp and the configured room max age. Server-copy files must follow that same lifetime rather than introducing a separate retention clock. Expiry currently prevents access; this ticket should make cleanup explicit so uploaded audio does not outlive the room.

- [x] Room expiry is based on the existing room-created-at lifetime configured by the environment.
- [x] Upload and download requests for expired or deleted rooms are rejected.
- [x] Expired-room cleanup removes room metadata and any server-copy files for that room.
- [x] Manual room deletion also removes any server-copy files for that room.
- [x] Production configuration exposes the room lifetime setting used by the app.
- [x] Tests cover expiry/deletion cleanup without requiring a real recording.
