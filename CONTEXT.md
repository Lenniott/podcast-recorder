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

**Voice Trigger**:
A short phrase spoken by either participant (e.g. "let's look that up",
"define") that the Research Assistant treats as a request to look
something up, detected from that participant's own local speech
recognition. Listening for it starts and stops with that participant's own
local recording — pressing Record is what implies consent to be
transcribed; there is no separate opt-in toggle.
_Avoid_: wake word, hotword

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
