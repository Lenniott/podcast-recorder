# 03 — Voice capture wired to the Record button

**What to build:** a participant's own recording produces live,
speaker-labeled lines in the room's Transcript tab (ticket 01) while
they're recording, using their browser's own built-in speech recognition
(see `docs/adr/0001-web-speech-api-not-google-cloud-stt.md` for why this
and not a Google Cloud credential). Recognition starts the moment that
participant's local recording starts and stops the moment it stops — no
separate button, no separate consent step
(`docs/adr/0003-voice-trigger-consent-tied-to-recording.md`). In a browser
without speech-recognition support, recording still works exactly as it
does today; nothing about this feature should degrade or interrupt the
recording itself — that is this codebase's one hard rule
(`AGENTS.md`).

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Pressing Start Recording begins that participant's own speech
      recognition; pressing Stop Recording (or the recording otherwise
      ending) stops it — verified without a live microphone in tests
      (inject/fake the recognition source).
- [ ] Finalized recognized utterances are sent as new transcript lines
      (ticket 01's mechanism), labeled with that participant's own name,
      in the order they were spoken.
- [ ] Interim (non-final) recognition results are never sent as transcript
      lines.
- [ ] In a browser without SpeechRecognition support, starting/stopping a
      recording behaves exactly as it does today — no error surfaced to
      the user, no interruption to the recording itself.
- [ ] If speech recognition stops itself unexpectedly while a recording is
      still in progress (normal browser behavior after a stretch of
      silence), it recovers automatically without the person having to do
      anything.
- [ ] A network/mic issue in the speech-recognition path never affects
      `capture-writer.js`'s local WAV recording — verify nothing this
      ticket adds can touch, block, or slow that write path.
- [ ] Unit tests cover the recognition wrapper's start/stop/restart
      behavior with an injected fake recognizer (see
      `tests/unit/audio-engine.test.js` for this repo's convention of
      testing a browser-API wrapper via dependency injection).
