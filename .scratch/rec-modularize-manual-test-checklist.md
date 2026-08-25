# Manual test checklist — rec/ monolith modularization

Branch: `claude/rec-monolith-modularize-jwkzuu`. Pure refactor — behavior on
`main` should be unchanged. Automated coverage: 172 unit tests, `svelte-check`,
`npm run build`, and the full Playwright suite (fake mic/device) all green.
What Playwright's `--use-fake-device-for-media-stream` can't reach is real
hardware timing and real device-switch behavior — that's what this checks,
on a real mic, before merging.

Two of the four extracted modules have no unit test (inherently
`AudioContext`/`getUserMedia`-bound, same as the inline code they replaced):
`src/lib/audio-engine.js` and `src/lib/waveform-renderer.js`. Priority below
follows that — items 1–2 are the ones actually worth blocking on.

## 1. Real recording, start to finish (must-do)
- [ ] Start a recording with a real mic, talk for a few minutes, stop.
- [ ] File opens and sounds right; no dead air, no chopped fragments.
- [ ] File duration/size look consistent with how long you recorded.

## 2. Mic dropout / device switch mid-recording (must-do)
This is the path that moved into `audio-engine.js` — `connectMicWithFallback`,
the gap measurement, `notifyDeviceGap`. It's also the exact shape of the
original 50-minute-recording bug, so it's the one to not skip.
- [ ] Start recording, then unplug/disable the mic (or let the laptop sleep
      briefly if that's your usual trigger).
- [ ] Recording keeps going — it doesn't stop or error out.
- [ ] The app falls back to another input (or built-in) automatically.
- [ ] Play back the file after: the gap where the mic dropped is short and
      matches the real dropout, not a long stretch of fabricated silence.

## 3. Waveform reflects the saved file, not just the live mic
- [ ] While recording, watch the waveform — it should track actual signal,
      not go stale/flat while you're still talking.
- [ ] Right after a mic switch (from #2), confirm the waveform doesn't sit
      frozen showing "healthy" while nothing is really being captured.

## 4. Record-start listen-back check
- [ ] Hit Start, read the sentence out loud, hit Listen.
- [ ] Hear back the real take — not silence, not stale audio, not the wrong
      sentence's audio.

## 5. Clap sync (two browsers/tabs)
- [ ] Host and guest in the same room, hit Clap from either side.
- [ ] Tone lands audibly in sync on both sides (exercises `clock-sync.js`'s
      offset estimate over a real network RTT instead of Playwright's fake
      timers).

## Nice-to-have, lower risk
- [ ] Collapse/expand the sidebar while recording — waveform canvas resizes
      cleanly, no stretch/blank frame.
- [ ] Adjust the gain slider mid-recording — meter and file level respond.
- [ ] Manually switch mic from the dropdown (not an auto-fallback) — new
      device takes over cleanly.

If 1–2 come out clean, that covers the two paths automated coverage
couldn't fully reach (recording integrity, the silence-gap invariant). 3–5
are quick sanity checks on the other two extracted modules.
