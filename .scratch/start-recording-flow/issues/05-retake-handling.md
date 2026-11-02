# 05: Retake handling — new file per attempt, same folder

**Status:** done

**Read first:** this folder's README. Then `src/lib/recording/join-step.js`
(the module you deepen) and `tests/unit/join-step.test.js` (the seam those
tests already use).

## Module

Deepen `createLocalCopyPicker` in `src/lib/recording/join-step.js`. One
interface owns the folder, the attempt count, and opening the next file.
The room page calls that interface. It does not format names, count
attempts, or hold a file handle across attempts.

`choose()` today returns one `FileSystemFileHandle` from
`showSaveFilePicker`. That handle names one file. `createWritable()` on it
writes that file again. A second attempt has to come from a
`FileSystemDirectoryHandle`: `showDirectoryPicker()` once, then
`directory.getFileHandle(name, { create: true })` per attempt. This ticket
changes the join picker from a file to a folder. The explainer button
stays the user gesture. The unsupported-browser check becomes
`'showDirectoryPicker' in window` (same Chromium-only API family as the
file picker).

## Interface

Keep `choose` / `chooseAgain`. Change what they store.

```js
createLocalCopyPicker({ showDirectoryPicker })

choose({ participantName, roomName, now })
  // Calls showDirectoryPicker once per visit. A later choose() returns
  // the same directory and does not call the picker.
  // Returns the directory handle.

chooseAgain(options)
  // Clears the directory and the attempt count, then prompts again.
  // The only path that may call the picker a second time.

openNext({ participantName, roomName, now })
  // Requires a prior choose(). Otherwise throws
  // 'Local Copy location has not been chosen' and does not touch the directory.
  // Asks the directory for a new file and returns:
  //   { attempt, name, fileHandle }
  // attempt is 1, then 2, then 3, for this visit.
  // name is `${participant}-${room}-${YYYY-MM-DD}-take-${attempt}.wav`
  // using the same sanitising suggestedLocalCopyName already uses
  // (non-alphanumerics become `-`, lowercased).
  // getFileHandle(name, { create: true }) is called with that exact name.
  // A name already returned this visit is never requested again.
  // Two openNext() calls with the same `now` still get take-1 and take-2.

openRecordingFile(fileHandle)
  // Unchanged: createWritable() on the handle openNext just returned.
  // Throws 'Local Copy location has not been chosen' when fileHandle is missing.
```

Worked example, fixed literal for tests:

```
participantName: 'Host'
roomName: 'Show'
now: 2026-09-30T12:00:00.000Z
first openNext  → host-show-2026-09-30-take-1.wav
second openNext → host-show-2026-09-30-take-2.wav
```

The page's `startRecording()` calls `openNext` and then
`openRecordingFile` on that result. It does not read `picker.handle` as
the file to write. `rejectRecordingCheck` finalizes the current file
(patch the WAV header, close the writable, leave the bytes on disk) and
then runs that same start path again, so the check sequence restarts on
the new file. The user does not click Start again, and the picker does
not open.

A synced reject restarts both browsers' files. Each browser does this on
its own when its Check Turn sequence restarts — the local `reject()` and
a remote turn change that moves the sequence back to the host's turn
(ticket 03's `applyRemote`). There is no filename message on the socket.
Attempt numbers are per browser visit. Host `take-2` and guest `take-2`
are each that browser's second file, not a shared room counter.

Server-copy "Take N" in `ServerCopyFilesModal` stays a display index over
files the server actually has (`Take ${all.length - index}`). It is a
different number from the local `-take-N` suffix: a missing upload would
make those labels agree about the wrong file. Leave `makeServerCopyTakeId()`
as the random id reset at the start of each `startRecording()`. Do not
encode the local attempt into it.

## Tracer bullets

One failing test, then the code that passes it, then the next test.
Tests call `createLocalCopyPicker` with a fake `showDirectoryPicker` that
returns an in-memory directory recording `getFileHandle(name, options)`
calls. Expected names are the literals above.

1. `openNext` before `choose` throws `Local Copy location has not been chosen` and the directory is never asked for a file.
2. `choose` calls `showDirectoryPicker` once. A second `choose` returns the same directory and does not call the picker.
3. The first `openNext` requests `host-show-2026-09-30-take-1.wav` with `{ create: true }` and returns that name and attempt `1`.
4. The second `openNext`, same `now`, requests `host-show-2026-09-30-take-2.wav` and does not request the first name again.
5. Update the existing join-step test that reads `startRecording` from `+page.svelte`: the recording-start path contains neither `showSaveFilePicker` nor `showDirectoryPicker`.
6. Update `tests/playwright/helpers.js`'s save-location stub from `showSaveFilePicker` to `showDirectoryPicker`, and record each `getFileHandle` name. Extend `tests/playwright/join_save_location.spec.js` so a reject mid-check produces a second name and the first name is not requested again. The explainer still appears before the mic step.

## Rejected shapes

A `nextTakeFilename(n)` helper the page calls, while `startRecording`
still does `openRecordingFile(localCopyPicker.handle)`, writes the same
file twice. A new `take-names.js` that only formats strings. Deleting or
truncating the rejected attempt. A second picker prompt on retry.

## Docs, when the behavior is green

Replace the **Local Copy** sentence in `CONTEXT.md` that says the handle
is reused with: the join click chooses one folder for the visit; each
attempt is a new file in that folder (`-take-1`, `-take-2`); a rejected
attempt's file stays on disk. Add that the server-copy modal's "Take N"
is a display index of files the server has, and is not this suffix.
`AGENTS.md`'s line about the picker living at join should name
`showDirectoryPicker` and `openNext`.

## Done when

- [x] Join chooses a folder once; `startRecording` never opens a picker.
- [x] Each attempt is a new file in that folder; the previous file is left as it was.
- [x] A reject restarts the check on the next file without a Start click and without a second prompt, on both peers when the session is synced.
- [x] Server-copy take ids stay per `startRecording()`; modal "Take N" is documented as a different number.
- [x] Tracer bullets 1–6 are green, in that order.
- [x] `CONTEXT.md` and `AGENTS.md` updated as above.
