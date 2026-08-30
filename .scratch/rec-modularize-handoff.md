# Modularize the rec/ monolith — redo on this branch

Work on this branch (`claude/light-dark-mode-wf9x89`). Do not merge or
cherry-pick `claude/rec-monolith-modularize-jwkzuu` — that branch was built
from `main` before this branch's light/dark-mode + exit-warning + icon work
existed, and merging it in wholesale will conflict. This doc tells you how
to **redo the same modularization directly on this branch's current
`+page.svelte`**, which is nearly identical except for the deltas called
out below.

## Why this exists

`src/routes/rec/[slug]/+page.svelte`'s `<script>` block mixes five
independent concerns in one file: mic/device management, the WebAudio
graph + worklet wiring, canvas waveform drawing, the record-start
listen-back check, and clock-offset estimation for clap/Watch Together
sync. It was already split apart once, into four `src/lib/` factory
modules, on `claude/rec-monolith-modularize-jwkzuu` — but that branch can't
just be merged in. Redo the same split here.

**Reference only, do not merge:** `claude/rec-monolith-modularize-jwkzuu`,
commits `37d9c2e`, `6396016`, `11a5026`, `723b4a1` (one per module, in that
order) plus `8b99a88` (a manual-test-checklist doc, not code — skip it,
not applicable here since this branch's checklist would differ). You can
`git show <sha>` any of those for the exact shape of a finished module —
useful to compare your result against — but write the code fresh against
*this* branch's file, don't apply the patch.

## The one thing that's different here: waveform colors

The starting point (`93b975f`, i.e. `main`) that the reference branch
extracted from had a hardcoded-color `draw()` function. This branch added
theme-aware colors on top of that same function:

```js
let waveformBg = '#ffffff'
let waveformCenterLine = '#e0e0e5'
let waveformStroke = '#6b6b73'
let waveformStrokeRec = '#0a4e3f'
function refreshWaveformColors() {
  if (!browser) return
  const cs = getComputedStyle(document.documentElement)
  waveformBg = cs.getPropertyValue('--surface').trim() || waveformBg
  waveformCenterLine = cs.getPropertyValue('--border').trim() || waveformCenterLine
  waveformStroke = cs.getPropertyValue('--muted').trim() || waveformStroke
  waveformStrokeRec = cs.getPropertyValue('--accent').trim() || waveformStrokeRec
}
```
called once in `onMount` and again on a `window.addEventListener('themechange', refreshWaveformColors)`,
removed in `onDestroy`. `draw()` reads these four `let`s instead of the
hardcoded hex strings the reference branch had.

When you get to the `waveform-renderer.js` step (#3 below), extend its
factory to accept a `getColors` accessor instead of hardcoding colors:

```js
// waveform-renderer.js
export function createWaveformRenderer({ getCanvas, getAnalyserNode, getWrittenRing, isRecording, getColors }) {
  // ...
  function draw() {
    // ...
    const { bg, centerLine, stroke, strokeRec } = getColors()
    canvasCtx.fillStyle = bg
    // ...
    canvasCtx.strokeStyle = centerLine
    // ...
    canvasCtx.strokeStyle = isRecording() ? strokeRec : stroke
    // ...
  }
}
```

Page side: keep `waveformBg`/`waveformCenterLine`/`waveformStroke`/
`waveformStrokeRec`/`refreshWaveformColors`/the `onMount`/`onDestroy`
listener wiring exactly where they are — theme/CSS detection is page-level
concern, same reasoning as `debugReconnectMarker` staying in the page on
the reference branch. Just change the renderer construction to:

```js
const waveformRenderer = createWaveformRenderer({
  getCanvas: () => canvas,
  getAnalyserNode: () => analyserNode,   // or audioEngine.getAnalyserNode() once step 4 is done
  getWrittenRing: () => writtenRing,
  isRecording: () => recordingState === 'recording',
  getColors: () => ({ bg: waveformBg, centerLine: waveformCenterLine, stroke: waveformStroke, strokeRec: waveformStrokeRec })
})
```

Everything else in this branch's `+page.svelte` — `serverCopyUploadState`,
`hasBlockingExitWork`, `handleBeforeUnload`/`handleDocumentClick`/
`beforeNavigate` (exit-warning-on-navigate), the icon imports, `meter.js`'s
new `dbToMeterPct`/`METER_TICKS`/gradient helpers — none of it touches any
of the code being moved below. Leave all of it exactly where it is; don't
move it, don't reference it from the new modules.

## Method: same TDD loop as the reference branch, one module at a time

For each module below:
1. **Red.** Write the module's test file first (for the two unit-testable
   modules) so it fails on the missing import — that's the
   characterization test. For the two browser-API-bound modules, "red" is
   confirming the relevant Playwright spec passes *before* you touch
   anything, as the behavior baseline to protect.
2. **Move.** Cut the logic out of `+page.svelte` into the new file, import
   it back, wire callbacks to existing page state. No behavior changes —
   pure relocation (plus the one color-accessor adaptation above).
3. **Green.** Re-run `npx vitest run` and, for the two browser-bound
   modules, the targeted Playwright spec(s) again.
4. **Commit.** One commit per module before starting the next.

Order (easiest/safest first): **`clock-sync.js` → `recording-check.js` →
`waveform-renderer.js` → `audio-engine.js`**.

### 1. `src/lib/clock-sync.js`
Moves: `syncClock`, the `pong` handling in the room's `onMessage`,
`clockOffset`/`_clockSamples`/`_pingSeq`/`_pendingPings`.

```js
export function createClockSync({ send }) // → { syncClock(), handlePong(msg), get offset() }
```
`send` injected (page passes `(msg) => room.send(msg)`). Keep `clockOffset`
as a page-local `let`, plain-reassigned from `clockSync.offset` right after
`clockSync.handlePong(msg)` in the `pong` branch — **not** a `$:`
derivation (`clockSync.offset` is a getter on a plain object, invisible to
Svelte's reactivity unless something re-reads it on assignment).

Unit tests (`tests/unit/clock-sync.test.js`): offset stays 0 until 3 pongs
land; offset is the mean of the 3 round-trip samples; a stray/duplicate
`seq` is ignored; `syncClock()` sends 3 pings with distinct increasing
`seq`; a fresh `syncClock()` burst doesn't half-update the offset until all
3 new pongs land.

### 2. `src/lib/recording-check.js`
Moves: `CHECK_SENTENCES`, `CHECK_PREVIEW_MAX_SAMPLES`, the preview
buffer/collecting state machine (`startRecordingCheck`, the preview half of
`handleWritten`, `buildCheckPreview`, `confirmRecordingCheck`, the
state-clearing part of `rejectRecordingCheck`).

```js
export function createRecordingCheck({ maxPreviewSamples = 30 * 48000 } = {})
// → { start(), handleWritten(i16), buildPreview(sampleRate), confirm(), reject(), close(), get open(), get sentence() }
```
`confirm`/`reject`/`close` all do the same close-and-clear — three names
for three different call-site intents (confirm sounds fine, reject-and-stop,
Stop-button-pressed-while-still-open), same implementation.
`buildPreview(sampleRate)` delegates to the existing `buildWavBlob` from
`$lib/audio-utils.js`.

**Cap gates on the count *before* a chunk arrives — it does not slice a
chunk mid-way.** One in-flight chunk can push the total over
`maxPreviewSamples`; only the *next* chunk after that is dropped entirely.
Write your test to that real behavior, not slicing — this is the one thing
that tripped up the reference-branch pass too.

Keep `checkModalOpen`/`checkSentence` as page-local `let`s (same
plain-reassignment reasoning as `clockOffset`), mirrored from
`recordingCheck.open`/`.sentence` at each call site.

Unit tests (`tests/unit/recording-check.test.js`): starts closed; `start()`
opens with one of the five known sentences; `handleWritten` buffers before
the cap and drops entirely after; `confirm()`/`reject()` both close and
clear; a fresh `start()` after `confirm()`/`reject()` clears any stale
buffer.

### 3. `src/lib/waveform-renderer.js`
Moves: the `startWaveformLoop`/`draw()` `requestAnimationFrame` loop and
`resizeCanvas`. See the colors section above for the one adaptation vs. the
reference branch.

```js
export function createWaveformRenderer({ getCanvas, getAnalyserNode, getWrittenRing, isRecording, getColors })
// → { start(), stop(), resizeCanvas() }
```
No unit test — canvas/rAF-bound, same testability profile as the inline
code it replaces. Verify with `tests/playwright/sidebar_collapse.spec.js`
(exercises the resize path) before and after the move.

### 4. `src/lib/audio-engine.js`
The biggest, most invariant-sensitive piece. Moves: `initAudio`,
`ensureAudioRunning`, `connectMic`, `connectMicWithFallback`,
`resolveMicGap`, `updateGain`, `injectClap`'s worklet-postMessage half,
`injectReconnectMarker`'s worklet-postMessage half, and the
AudioContext/worklet/analyser/gain-node/silent-sink setup.

**Guardrail — read `AGENTS.md` before touching this one.** Silence is
written into a take only for a measured, real device gap, never inferred
from write latency. Keep the *measurement* (`micGapStartedAt`, tracked
against `audioCtx.currentTime`) inside the engine; keep the *decision* to
persist a resolved gap as silence (`captureWriter?.notifyDeviceGap(gapSec)`)
in the page's `onDeviceGapResolved` callback, right next to where
`captureWriter` already lives — don't bury that decision inside the new
module.

```js
export function createAudioEngine({
  onLevel,               // (rms, peak) — raw worklet level message, forwarded as-is
  onChunk,               // (float32Buffer) — raw worklet audio chunk, forwarded as-is
  onDeviceGapResolved,   // (gapSec)
  onMicConnected,        // () — fires after every successful connect/reconnect
  loadDevices,           // async () => void — the page's own existing loadDevices, reused
  getDevices,            // () => MediaDeviceInfo[]
  getSelectedDeviceId,
  setSelectedDeviceId,
  setMicFallback,
  setMicFallbackName,
  setMicPermissionDenied
})
// → { init(), changeMic(deviceId), connectMicWithFallback(), ensureRunning(),
//     setGain(value), scheduleClapTone(delayMs), postDebugMarker(),
//     getAnalyserNode(), clearPendingGap(), get sampleRate(), close() }
```

Device-list UI state (`devices`, `selectedDeviceId`, `micFallback`,
`micFallbackName`, `micPermission`) stays page-local (bound to
`RoomSidebar`'s mic picker) — the engine reads/writes it through the
injected accessors above, it doesn't own it.

Page-side changes to make alongside this:
- Add `let audioEngineReady = false`, set `true` once `audioEngine.init()`
  resolves. Replace every `!audioCtx`/`!workletNode` check (lazy-init
  guards in `changeMic`/`startRecording`, the pending-claps check in the
  `clap` WS handler) with `!audioEngineReady`.
- `recordingSampleRate = audioEngine.sampleRate` instead of reading
  `audioCtx.sampleRate` directly.
- `startRecording()` has a line resetting mic-gap tracking right before
  flipping to `'recording'` — that becomes `audioEngine.clearPendingGap()`.
  **Don't miss this one** — it's a `ReferenceError` at runtime, not a
  type error, so `svelte-check`/`npm run build` won't catch it; only
  actually clicking Start Recording (or `recording_status.spec.js`) will.
- `onMount`'s mic-init path and `onDestroy`'s
  `micStream?.getTracks().forEach(...)`/`silentSink?.disconnect()`/
  `audioCtx?.close()` become `audioEngine.close()` — leave this branch's
  other `onMount`/`onDestroy` additions (exit-warning listeners, theme
  listener) untouched, just fold your one line in alongside them.

No unit test — `AudioContext`/`getUserMedia`/`AudioWorkletNode`-bound.
Verify with `tests/playwright/recording_status.spec.js` and
`tests/playwright/clap.spec.js` before and after the move — those are also
the ones this branch extended with the exit-warning tests, so a broken
`startRecording()` will show up loudly.

## Final verification (after all four modules)

- `npx vitest run` — everything green, existing tests plus the new ones.
- `npx svelte-check` (run `npx svelte-kit sync` first if `.svelte-kit/` is
  missing).
- `npm run build`.
- Full `npx playwright test` — this branch has more specs than `main` did
  (the exit-warning ones), all of them should still pass since none of
  that logic moved. If Chromium's pinned revision doesn't match this
  sandbox, add `executablePath: '/opt/pw-browsers/chromium'` to
  `playwright.config.js`'s `launchOptions` for the run only — don't commit
  it.
- Read the final `+page.svelte` end to end: confirm the mic-gap →
  `notifyDeviceGap` wiring, the written-audio-ring/waveform wiring, and the
  theme-color wiring all read the same as before, just relocated.

Playwright needs a local `.env` with `SECRET` set (gitignored, not
committed) — `npm run dev` fails outright with `.env: not found` otherwise.
