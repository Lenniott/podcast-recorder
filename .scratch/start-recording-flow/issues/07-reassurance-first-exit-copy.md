# 07: Reassurance-first exit/leave copy

**Read first:** this folder's README's local-copy framing.

**What to build:** The only place this app currently tells a guest
anything about what happens to their local file is a reactive warning,
shown late, worded like a threat: "if you leave now, you'll need to send
the local file to the host another way." That's the *correct* message for
the actual edge case it guards (the automatic server-copy upload hasn't
caught up yet) but it's the guest's only information, and it reads as if
manual delivery were the normal expectation. Update this copy so the
normal case is reassurance ("this is backed up automatically, you don't
need to do anything"), and reserve the "you'll need to send it yourself"
wording specifically for when the server-copy upload genuinely hasn't
finished.

**Where to look:** `src/lib/recording/exit-guard.js` (~line 32) and the
leave-confirmation message in `src/routes/rec/[slug]/+page.svelte`
(~line 281) are the two places this wording currently lives. Both are
already conditioned on `hasIncompleteServerCopyUpload` /
`isIncompleteServerCopyUpload(serverCopyUploadState)` — this ticket is a
copy/condition-tightening change, not new plumbing: verify the reassuring
message shows when the upload *is* complete/not-in-progress, and the
existing warning still shows, unchanged in meaning, only when it's
genuinely incomplete.

**Out of scope:** this ticket doesn't touch upload logic, retry logic, or
`ServerCopyFilesModal` — copy only, and only in the two call sites named
above (plus wherever else a grep confirms the same wording is
duplicated).

**TDD seams:**

1. Unit/component: with `serverCopyUploadState` complete (or idle/no
   recording yet), the leave/exit message reads as reassurance, not a
   warning.
2. Unit/component: with an incomplete upload, the existing warning
   wording is preserved (don't regress the case it correctly protects).
3. E2E or component test: exercise both states through the actual guard/
   confirmation UI, not just the string constants.

**Blocked by:** None — fully independent, can ship in parallel with
everything else in this line.

**Status:** ready-for-agent

- [ ] Normal case (upload complete or not yet started/recording) shows
      reassurance copy: no manual send-it-yourself expected.
- [ ] Incomplete-upload case still shows the existing warning, unchanged
      in substance.
- [ ] Both `exit-guard.js` and the `+page.svelte` leave-confirmation are
      updated consistently; any other duplicate of this wording found by
      grep is updated too.
- [ ] TDD on the seams above.
- [ ] Coverage: complete / incomplete / no-recording-yet states.
- [ ] Docs: `CONTEXT.md`'s **Listen-back check** / server-copy glossary
      entries cross-reference this framing so it isn't re-litigated later.
