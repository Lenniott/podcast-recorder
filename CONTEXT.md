# Podcast Recorder

A room where a host and a guest each record their own mic locally to a WAV
file, share notes/video, and (new) get live research help grounded in what's
actually being said.

## Language

**Research Assistant**:
The live lookup help during a recording: **Turn Actions** on the Transcript
Tab, plus **Ask** and **Custom** in the right-side panel. Results are
room-shared and scoped per Tab.
_Avoid_: AI panel, sidebar bot

**Voice Trigger** _(superseded by Research Mode — see ADR-0004; kept here
because `research-trigger.js`'s phrase list predates the change)_:
A short phrase spoken by either participant (e.g. "let's look that up",
"define") that the Research Assistant treats as a request to look
something up, detected from that participant's own local speech
recognition.
_Avoid_: wake word, hotword

**Research Mode** _(designed in ADR-0004; not in the button-only MVP)_:
The passive, always-on way the Research Assistant would surface things
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

**Quick Action** _(superseded by Turn Action for transcript jobs; panel
chips against whole-tab text are being replaced)_:
A one-click prompt run against the *whole* text of the currently active
Tab. Never a text selection.
_Avoid_: prompt button, canned prompt

**Turn Action**:
A one-click lookup on a **Focus Turn** — hover that Turn, then press
Definition, Facts, or Answer (icons on the Turn, not in the panel). The
clicked Turn is the subject; **Grounding** is a fixed neighbor window.
_Avoid_: quick action (for transcript jobs), highlight button, chunk action

**Focus Turn**:
The one Turn a participant invoked a Turn Action on. It is the subject of
that lookup, never Grounding.
_Avoid_: highlight, selected chunk, section, the time in the text

**Grounding**:
The two Turns immediately before the Focus Turn, plus the one Turn after
it if that Turn already exists. Included so the model can resolve
references. Grounding is never what the answer is *about*.
_Avoid_: context (alone — overloaded with tab text and prompt "context")

**Definition**:
A Turn Action that explains an obscure word, name, or reference in the
Focus Turn (including a plausible mishear when the transcript likely
garbled it).
_Avoid_: define (the old whole-tab Quick Action)

**Facts**:
A Turn Action that surfaces general background about what the Focus Turn
is talking about. Not a verdict on whether a speaker was right.
_Avoid_: fact-check, key facts, Fact-check (those meant verify-or-extract
against a whole tab)

**Answer**:
A Turn Action that replies to a question asked in the Focus Turn itself.
If that Turn is not a question, there is nothing to Answer.
_Avoid_: research (the old mode name), Research recent conversation

**Ask**:
A one-off typed question in the Research Assistant panel. Carries no
Transcript and no tab text unless the asker opts in with a **Placeholder**
— the question is the whole request otherwise.
_Avoid_: custom (that's a saved instruction, not a one-off question)

**Placeholder**:
`{current_tab}` or `{transcript}`, written inline in free text handed to
the Research Assistant (an Ask question, or the **Research Prompt**) and
substituted with the live active Tab (YouTube title if loaded, then notes)
/ room Transcript right before the request is sent. Substitution happens
in one place — the Research Assistant Client — so it never matters which
free-text field it came from.
_Avoid_: prop (collides with Svelte component props, used constantly
elsewhere in this codebase), token, variable

**Research Prompt**:
The one instruction text the **Custom** action sends as its whole request,
written using **Placeholders** for whatever live content it wants. Global
to the deployment, not per-room, and not written by a room's Host — it's
set on the create-room page by whoever holds the site password (see
**Usage Dashboard**), before any room exists, then simply available for
Custom to use inside every room afterward. Custom is disabled (button off)
whenever the Research Prompt or the **Research Prompt Title** is empty.
_Avoid_: Custom prompt, Interpretation Mode, custom instruction, host-set
(ambiguous with room Host)

**Research Prompt Title**:
The label of the **Custom** button in every room, set alongside the
**Research Prompt** on the create-room page. Same deployment-wide scope as
the prompt itself. Custom stays off until both title and prompt have text.
_Avoid_: Interpret (historical button copy; the lookup is still Custom)

**Custom**:
The panel action that runs the **Research Prompt** against the active
notes Tab's text and the room Transcript. Gated by **Guest Research
Access** exactly like Ask and Turn Actions — no special-case host-only
rule of its own. Distinct from the Research Prompt itself: Custom is the
button/call, the Research Prompt is the text it sends, and the Research
Prompt Title is what the button shows.
_Avoid_: Ask, Quick Action, Interpret (the button label is the Research
Prompt Title — the lookup is Custom), host-only (that carve-out is gone —
see Guest Research Access)
_Avoid_: Ask, Quick Action, Interpret (the button label is the Research
Prompt Title — the lookup is Custom), Interpretation Mode (the old
two-stage structure this replaced)

**Guest Research Access**:
A per-room, host-set-at-creation checkbox letting every guest in that room
use every Research Assistant action — Ask, Turn Actions, and Custom alike
— not just the Host. One flag, no per-action carve-outs. Off by default.
Set once, at room creation, on the create-room form — not editable
afterward from inside the room.
_Avoid_: RESEARCH_GUEST_CAN_ASK (the retired deployment-wide env var this replaced)

**Usage Dashboard**:
The section of the create-room page (visible once past the site password,
same as the create form) showing Research Assistant cost/usage across every
room — running totals plus a per-room breakdown — and the Research Prompt
editor. Not a separate page or route.
_Avoid_: admin panel, token dashboard (ambiguous with session/auth tokens),
usage page

**Research Eval Log**:
An append-only, gitignored record of live Research Assistant calls
(prompt, Focus Turn, Grounding, raw reply, parsed card, suppress,
latency), written only when enabled. Rooms still expire; the log is what
survives for prompt work after a show.
_Avoid_: keeping rooms, immortal rooms, eval-runs as the only corpus (that's canned)

**Research Card**:
The glanceable result of a lookup: a short takeaway meant to be skimmed
during conversation, not read in a focus state. Newest cards sit at the
top of the panel. Only a successful lookup stays as a visible card; a
job miss or suppressed lookup is written to the Research Eval Log and
does not leave a "nothing to add" row. While a lookup is in flight, a
processing block occupies that same top slot so it is obvious something
is happening.
_Avoid_: Nothing new to add (as a standing history item)

**Block**:
One unit of text in a tab surface: optional label, the text, hover actions.
On the Transcript Tab each Block is a **Turn** and is read-only. Notes tabs
stay a single shared textarea until they are rebuilt as editable Blocks.
_Avoid_: chunk, section, transcript line (say Turn), textarea row

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
with who said it. On the Transcript Tab, a Turn is one read-only **Block**.

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
