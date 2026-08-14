# Exploration: opportunistic guest-audio upload alongside local recording

Status: **exploration only** — no code changes. This document exists to capture the idea,
the constraints it has to respect, and the design options, so a future session can pick
one up and implement it deliberately.

## The ask

Today, when a guest hits **Start Recording**, their browser writes lossless WAV straight
to their own disk via the File System Access API (`src/routes/rec/[slug]/+page.svelte`).
Nothing else happens to that audio — it's the guest's job to send the file to the host
afterward (Dropbox, WeTransfer, whatever).

The idea: **while the local recording is happening, also opportunistically send a copy of
the same audio out over the network whenever a connection is available** — so that by the
time the session ends, the host already has the guest's file without the guest doing
anything. If the connection is spotty or drops entirely, that's fine — it should pick back
up, not restart from zero, and it must never affect the local recording.

## Hard constraint: don't touch the local recording path

This is the non-negotiable part, worth restating because it drives every design choice
below:

- The local write (`fileWritable.write(...)` in `startRecording`/`initAudio`, around
  `src/routes/rec/[slug]/+page.svelte:376-393`) stays exactly as it is — same worklet,
  same file handle, same silence-backfill-on-gap logic.
- The whole point of local-first recording is that it survives total internet loss: if the
  connection drops, host and guest can keep talking over a phone call and the audio just
  keeps recording. **Any network-upload feature must be a side effect that can fail, stall,
  or fall arbitrarily far behind without ever blocking, slowing, or risking the local
  write.** It's a bonus copy, not a dependency.
- Concretely: the upload path reads from a separate in-memory buffer fed by the same PCM
  chunks the worklet already produces, never from the file on disk, and never awaits
  anything before the next local write happens.

## What "Chrome only" and "resumable download" hinted at

There's no browser API for a resumable *download* in the sense of "let the far end pull
bytes over time" — File System Access API is a local-disk API, not a network one. But the
instinct maps well onto **resumable/chunked upload**, which is a well-trodden pattern:
buffer audio in fixed-size chunks, send each chunk with a sequence number, let the
receiving end acknowledge how much it has, and on reconnect resume from the last
acknowledged point instead of starting over. The closest off-the-shelf building block is
the [tus protocol](https://tus.io/) (`tus-js-client` on the browser side), or an equivalent
small custom protocol — see below.

Chrome-only is already the app's baseline (File System Access API), so this doesn't add a
new browser constraint.

## The fork this needs a decision on: does audio touch the server?

The README currently states, as a headline feature: *"No audio ever goes to the server."*
Any design that lands the guest's copy somewhere the host can reliably pick it up without
their tab being open has to reckon with that claim. Two shapes:

### Option A — chunked upload to the self-hosted server (recommended starting point)

The guest's browser periodically POSTs buffered PCM chunks to a new endpoint on the same
Node server that already hosts this app (the user's own home server via Docker/Umbrel —
not a third party). The server appends chunks to a per-room, per-participant file on disk.
When the guest stops recording (or the last chunk is acknowledged), the host can download
the finished file from the server whenever they check — no need for their tab to have
stayed open or connected for the whole session.

- **Resumability**: client keeps a small ring buffer of not-yet-acknowledged chunks
  (bounded — old chunks can be dropped from the *upload* buffer without any data loss,
  because the local file already has them durably). Each chunk carries a monotonic
  sequence number / byte offset. Server responds with the highest offset it has durably
  written. On reconnect (WS drop, laptop sleep, wifi blip), client asks "what have you
  got?" and resumes from there instead of resending everything.
- **Cadence**: something like every 3–10s of audio, or every ~250–500KB, whichever comes
  first — frequent enough that a mid-call drop only loses a few seconds of the *redundant*
  copy (the local file is unaffected either way).
- **Format/bandwidth**: raw 16-bit/48kHz mono PCM is ~96 KB/s ≈ 0.77 Mbps — comfortably
  inside typical home upload bandwidth, so there's no real need to lossy-compress it and
  compromise the "lossless" positioning. A lossless codec (FLAC via a small WASM encoder)
  could cut that in half if bandwidth turns out to matter in practice, but it's an
  optimization, not a requirement to start.
- **Auth**: reuse the room's existing password/session auth (already gates `/rec/[slug]`
  and the WS connection) rather than inventing a new scheme.
- **Storage/retention**: needs the same lifecycle thinking as rooms already get (there's
  already `npm run rooms:delete` for room cleanup) — decide how long uploaded copies stick
  around on the server disk and whether the host has to explicitly download/clear them.
- **UX**: something like a small "syncing guest copy — 82%" indicator, and a "still
  finishing upload" state after Stop Recording is pressed, since the backlog can keep
  draining in the background after the button is clicked. The host needs a way to know the
  copy is complete and where to get it (a "Download guest recording" link once the server
  has it all).
- **Trade-off**: this is the one that walks back "no audio ever goes to the server." It's
  the user's own server, not a third party, so the privacy story is different from a SaaS
  upload — but it's still a real change to what the README promises today, and worth
  deciding on explicitly rather than drifting into.

### Option B — WebRTC DataChannel, peer-to-peer to the host's browser tab

Extend the existing WebSocket signaling (already used for presence/clap/Watch Together) to
negotiate an `RTCPeerConnection` between guest and host, and ship the same raw PCM chunks
over a DataChannel instead of an audio track (a real WebRTC *media* track would transcode
through Opus, which is lossy — worth avoiding given the app's whole pitch is lossless).
The host's tab receives chunks and writes them to a second local file, reusing the same
worklet-write machinery it already uses for its own mic.

- **Pros**: keeps the server as thin signaling only, closer to the current "no audio to
  the server" claim (though a TURN relay, if one is needed for NAT traversal, would still
  pass encrypted bytes through *some* piece of infrastructure — blind-relayed, not stored
  or readable, but not literally zero infrastructure involvement either).
- **Cons**: this reintroduces exactly the dependency the phone-call fallback is designed to
  avoid — the host's tab needs to be open and connected for the copy to land at all. If the
  host's laptop sleeps or their tab dies mid-session (the scenario where they'd fall back to
  a phone call), Option B silently stops collecting the copy, whereas Option A (server-side)
  keeps collecting as long as the guest has any connection, independent of what the host is
  doing. Given the stated goal — "once we stop recording, I already have their audio file"
  — that's a meaningful reliability gap.
- Needs STUN at minimum, likely TURN for restrictive home NATs, which is more moving parts
  to stand up and keep running than a plain upload endpoint.

**Recommendation for further exploration: Option A.** It matches "it just saves it" more
literally — the host doesn't need to be present or connected for the copy to arrive — and
it reuses infrastructure (server, auth, room lifecycle) that already exists. Option B is
worth keeping in mind as a later enhancement (e.g., "also mirror live to the host's tab if
it happens to be connected") layered on top of A, not a replacement for it.

## Open questions before this becomes a plan

1. **Is walking back "No audio ever goes to the server" acceptable?** Even self-hosted,
   this is a positioning change worth being deliberate about (README, and any privacy
   expectations already set with guests).
2. **Retention**: how long does an uploaded guest copy live on the server disk, and who
   clears it — auto-expire, or the host deletes explicitly after grabbing it?
3. **Guest consent/visibility**: should the guest see that a copy is being sent off their
   machine (a toggle, a status line), or is it silently on-by-default given the host set
   up the room?
4. **Multi-guest future-proofing**: today rooms cap at 2 peers (`MAX_PEERS` in
   `ws-rooms.js`) — fine for now, but worth noting if that ever changes.
5. **Disk headroom on the server**: an hour of mono 48kHz/16-bit PCM is ~330MB; the home
   server needs enough free space for concurrent rooms' guest copies.

## Non-goal for this document

No code was written. This is scoping only, to be turned into an actual implementation plan
once the questions above are answered.
