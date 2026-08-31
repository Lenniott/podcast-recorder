# Podcast Recorder

A room where a host and a guest each record their own mic locally to a WAV
file, share notes/video, and (new) get live research help grounded in what's
actually being said.

## Language

**Research Assistant**:
The right-side panel that answers lookups during a recording — either
spoken ("let's look that up") or clicked (a quick action run on a tab's
text). Its results are room-shared and scoped per Tab, same as the Tab's
other content.
_Avoid_: AI panel, sidebar bot

**Voice Trigger** _(superseded by Research Mode — see ADR-0004; kept here
because `research-trigger.js`'s phrase list predates the change)_:
A short phrase spoken by either participant (e.g. "let's look that up",
"define") that the Research Assistant treats as a request to look
something up, detected from that participant's own local speech
recognition.
_Avoid_: wake word, hotword

**Research Mode**:
The passive, always-on way the Research Assistant now surfaces things
during a recording, replacing Voice Trigger — nobody has to say anything
special. It runs a **Gate Check** every 2 seconds against the last 10
seconds of the Transcript (a cheap, fast, no-search yes/no model call:
"is there something here worth researching?"), and only when that says yes
does it run a **Deep Check** (the existing web-search-grounded Research
Assistant Client) against the last 10 minutes of the Transcript. A Deep
Check's result is filed as an entry under the Transcript Tab automatically
— the server creates and resolves it itself, the same way a person's own
ask or Quick Action does, just without a person asking. Listening starts
and stops with a participant's own local recording, same consent boundary
as Voice Trigger had (ADR-0003) — Research Mode has nothing to watch when
nobody's transcript is growing.
_Avoid_: fact-checker, co-host, auto-search

**Gate Check** / **Deep Check**:
The two stages of one Research Mode tick. A Gate Check is cheap, fast, and
answers only yes/no — it never itself produces something shown to anyone.
A Deep Check is the real, sourced answer, and only ever runs after a Gate
Check said yes.
_Avoid_: pre-check, filter pass (for Gate Check); the research call (for
Deep Check — ambiguous with Quick Action/manual-ask calls, which are also
"the research call" but never gated)

**Quick Action**:
A one-click prompt (Define, Key facts, Fact-check, Find examples, Analyze)
run by the Research Assistant against the *whole* text of the currently
active Tab. Never a text selection — there's no selection-tracking in this
app to hook into (v1 scope; may grow selection support later).
_Avoid_: prompt button, canned prompt

**Transcript Tab**:
The one permanent, uncloseable Tab every room has (alongside its normal
first Tab), populated automatically with the live, speaker-labeled
transcript of both participants as they talk. Read-only — nobody can type
into it by hand. It's the "central place" the Research Assistant reads
both participants' conversation from, and it's what "accurate turns" means:
correctly ordered, correctly attributed, never dropped, even when both
people are talking near-simultaneously.
_Avoid_: live captions tab, notes tab

**Turn**:
One transcript line: a single participant's finalized utterance, labeled
with who said it. The unit the Transcript Tab is built out of.

**Transcript Activity**:
A room-shared "something's coming" pulse on the Transcript Tab pill, true
while any participant's speech recognizer has an interim (not-yet-finalized)
result in flight. Deliberately not the interim words themselves — no live
streaming of unfinalized text between participants, just a heads-up that a
Turn is likely about to land. Separate from a participant's own local
transcription status (their recognizer's health, e.g. "retrying"): Activity
is about the room, status is about one browser.
_Avoid_: live captions, interim transcript, typing indicator (in the
chat-app sense — this carries no text, just a boolean)
