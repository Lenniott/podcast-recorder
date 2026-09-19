# 01: Join flow — explainer, choose save location once, then mic

**Read first:** this folder's README ("What this line is" + "Locked
product decisions"). Glossary to add: **Local Copy** (the resilience
recording; see README's framing — it is not "the backup" in the sense of
something the guest must deliver).

**What to build:** Joining a room currently goes straight into
mic/device setup with no explanation, and the native save-file picker
only appears later, inside `startRecording()`, interrupting the person
mid-action. Change the join sequence to: (1) a short explainer screen —
your audio records to this device too, as insurance if our end drops out;
you will not normally need to send us this file — (2) the native
save-location picker, fired directly from this screen's own button click
(that click is the required user gesture for `showSaveFilePicker`; it
cannot be deferred to later without a fresh gesture), (3) the existing mic
selection step, now happening after the above rather than being the first
thing a joiner sees. This applies to both host and guest.

**Where to look:** `src/routes/rec/[slug]/+page.svelte` — `startRecording()`
(~line 631) currently calls `window.showSaveFilePicker` (~line 642-660)
per take; that call moves out of `startRecording()` and into this new join
step, firing once. `DisplayNameGate.svelte` is the existing pre-room gate
component this likely sits alongside/after. `MicPanel.svelte` and the
existing device-selection UI in `RoomSidebar.svelte` are the mic step
being resequenced, not rebuilt. `initAudioEngine()` (~line 459,
`audioEngine.init()`) already runs mic permission at `onMount` — this
ticket doesn't change when mic permission itself is requested, only when
the *save location* is chosen relative to it.

**Out of scope:** the file handle must persist and be reused across
retakes within the same room visit — the multi-take filename scheme
(`take2.wav`, etc.) is ticket 05, not this ticket. This ticket only needs
to prove the handle survives from join through at least one
`startRecording()` call without prompting again.

**TDD seams:**

1. Unit: a new join-step module/function that wraps `showSaveFilePicker`
   and returns a handle, called once per room visit, independent of
   `startRecording()`. Test it's not re-invoked on a second call without
   an explicit "choose again" action.
2. Unit: `startRecording()` (or its refactored equivalent) accepts an
   already-chosen handle and does not itself call
   `showSaveFilePicker` — assert the picker function is never called from
   inside the recording-start path.
3. Component: the explainer copy renders before the mic step; the mic
   step is unreachable without having passed through (or explicitly
   skipped, if `showSaveFilePicker` is unsupported — reuse the existing
   `browserSupported` check ~line 170).
4. E2E: join a room, see the explainer, pick a save location once, pick a
   mic, enter the room; press Start Recording — no second file dialog
   appears.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Explainer screen shown at join, before mic selection, stating the
      local-copy/insurance framing from the README (not "this is your
      only backup," not silent about the server copy).
- [ ] Save-location picker fires from this screen's own click, once.
- [ ] Chosen handle is available to (and reused by) the recording-start
      path for the rest of the room visit; `startRecording()` no longer
      calls `showSaveFilePicker`.
- [ ] Mic selection happens after the above, using existing device-list
      UI, unchanged in behaviour.
- [ ] Unsupported-browser path (`browserSupported` false) still surfaces
      the existing warning, just relocated sensibly in the new sequence.
- [ ] TDD on the seams above; coverage on the moved picker call site.
- [ ] E2E: full join → explainer → save → mic → room, single dialog only.
- [ ] Docs: `CONTEXT.md` gets the **Local Copy** framing; `AGENTS.md`
      updated wherever it currently implies the picker lives inside
      `startRecording()`.
