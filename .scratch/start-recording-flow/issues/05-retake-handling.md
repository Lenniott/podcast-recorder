# 05: Retake handling — new filename per attempt, never overwrite

**Read first:** this folder's README; ticket 01 (the persisted save
handle) and ticket 04 (what "the take" means / where it starts).

**What to build:** When a check is rejected ("Something's wrong") and the
sequence restarts, the retry must write to a **new filename** against the
**same** save-location handle chosen once at join (ticket 01) — never
reopen the same file and overwrite it, and never re-prompt for a save
location. Since nothing meaningful is written before ticket 04's marker,
a rejected attempt has nothing worth keeping, but the file it *would*
have become must not collide with the next attempt's file, or with a
previous successful take from the same room visit.

**Where to look:** `src/routes/rec/[slug]/+page.svelte` — the existing
per-take reset block right after file creation (~line 671-679: resets
`lastSentServerCopy`, `serverCopyTakeId`, `serverCopyUploadState`, etc.
"fresh take, fresh server-copy session") already treats each take as a
distinct unit server-copy-side; the filename scheme needs the equivalent
treatment locally. The existing filename template
(`${safeParticipant}-${safeName}-${date}.wav`, ~line 653) needs a take
suffix. `rejectRecordingCheck()` (~line 623-629) currently calls
`stopRecording()` on reject — this ticket's retry path replaces/extends
that so it re-enters ticket 03's sequence with a fresh filename rather
than fully exiting to idle.

**Out of scope:** deciding *when* a retry re-enters the sequence (which
turn it restarts at) is ticket 03's sequencing logic — this ticket only
owns the filename/handle mechanics for whatever attempt number results.

**TDD seams:**

1. Unit: filename generation includes an attempt/take number, derived
   from how many attempts have used the join-time handle this room
   visit, not from wall-clock time alone (two attempts in the same
   second must still get distinct names).
2. Unit: a rejected attempt's partial file (if the underlying File
   System Access write created one) is left alone — not deleted, not
   reused, not silently overwritten by the next attempt.
3. Unit: the join-time handle from ticket 01 is never re-prompted for
   across multiple attempts in one room visit.
4. E2E: trigger a reject mid-check-sequence; verify the retry produces a
   second file distinct from the first, both present in the chosen save
   location, first one untouched.

**Blocked by:** 01 — Join flow (save handle), 04 — Take marker (defines
what counts as "the take" that might need retaking).

**Status:** ready-for-agent

- [ ] Retake writes a new file (`take2`, `take3`, ...) against the same
      join-time save location.
- [ ] No previous attempt's file is ever overwritten or deleted.
- [ ] No new save-location picker appears on retry.
- [ ] Server-copy take-session reset (existing ~line 671-679 pattern)
      stays correctly scoped per attempt, consistent with the local
      filename change.
- [ ] TDD on the seams above.
- [ ] Coverage: single attempt / two attempts in the same second /
      attempt after a successful prior take in the same room visit.
- [ ] E2E: reject → retry → two distinct files on disk.
- [ ] Docs: `CONTEXT.md` note on the take-numbering scheme, since
      `ServerCopyFilesModal` already labels entries "Take N" server-side
      — keep the two numbering schemes consistent or explicitly document
      why they differ.
