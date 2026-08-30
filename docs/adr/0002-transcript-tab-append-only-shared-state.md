# Transcript Tab is append-only room state, not another last-write-wins tab_text

Regular Tabs share their text via `tab_text`: each browser debounces its
edits and sends the *whole* textarea content, which replaces whatever was
there (last-write-wins). That's fine when only one person is typing at a
time, which is the normal case for hand-typed notes.

The Transcript Tab can't use that mechanism. Host and guest each run their
own local speech recognition (ADR-0001) and can produce a new line at any
moment, independently and continuously — both sides are "typing" at once,
all the time. A last-write-wins replace would mean whichever participant's
debounced send lands last silently overwrites the other's lines: not an
edge case here, the normal case. That would break the one thing the
Transcript Tab exists to guarantee — accurate, complete Turns for both
participants — and silently losing content that both people are relying on
for research context is exactly the class of bug this codebase treats as
unacceptable (see `AGENTS.md`'s recording-integrity rule; the same
principle applies here even though this isn't the audio path).

So the Transcript Tab uses a different, append-only protocol: each browser
sends only its own new line; the room server appends it to that room's
Transcript (the "central place" both participants' Turns land in) and
broadcasts the appended line to everyone, the same way late joiners get
replayed the rest of a Tab's state today. It is also, deliberately,
read-only — the only writer is this append mechanism, so a hand-edit can
never race with, or get overwritten by, an incoming line. Research
Assistant results are shared the same way (broadcast, scoped per Tab, kept
in server memory alongside the rest of a room's Tab state) rather than
staying private to whoever triggered them, since the whole point of
centralizing both participants' Turns was to make this a shared assistant
for the conversation, not a private per-browser tool.
