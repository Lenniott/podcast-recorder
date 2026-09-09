# Podcast Recorder

A room where a host and a guest each record their own mic locally to a WAV
file, share notes/video, and (new) get live research help grounded in what's
actually being said.

## Language

**Research Assistant**:
The live lookup help during a recording: **Ask**, typed in the right-side
panel, plus any **Custom Prompt** triggered from a highlighted selection
on Notes text or a Transcript Turn (see ADR-0008 — this replaced Turn
Actions on the old Transcript Tab). Results are room-shared **Annotation**s.
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

**Turn Action** _(retired — see ADR-0008; replaced by **Custom Prompt**)_:
Was a one-click lookup on a **Focus Turn** — hover that Turn, then press
Definition, Facts, or Answer (icons on the Turn, not in the panel). The
clicked Turn was the subject; **Grounding** was a fixed neighbor window.
_Avoid_: quick action (for transcript jobs), highlight button, chunk action

**Focus Turn** _(retired — see ADR-0008)_:
Was the one Turn a participant invoked a Turn Action on — the subject of
that lookup, never Grounding. Superseded by `{selection}`: any Custom
Prompt can reference the highlighted excerpt directly, on Notes text or a
Turn alike.
_Avoid_: highlight, selected chunk, section, the time in the text

**Grounding** _(retired — see ADR-0008)_:
Was the two Turns immediately before the Focus Turn, plus the one Turn
after it if that Turn already exists — a fixed context window baked into
every Turn Action. Superseded: a Custom Prompt's author decides what
context (if any) it references via **Placeholders** — there is no more
single hardcoded grounding rule for every show.
_Avoid_: context (alone — overloaded with tab text and prompt "context")

**Definition** _(retired — see ADR-0008)_:
Was a Turn Action that explained an obscure word, name, or reference in
the Focus Turn. Retired because giving it real Grounding made it
interpret meaning it had no business interpreting (see ADR-0008); a show
wanting this today writes its own Custom Prompt.
_Avoid_: define (the old whole-tab Quick Action)

**Facts** _(retired — see ADR-0008)_:
Was a Turn Action that surfaced general background about what the Focus
Turn was talking about. See **Definition**.
_Avoid_: fact-check, key facts, Fact-check (those meant verify-or-extract
against a whole tab)

**Answer** _(retired — see ADR-0008)_:
Was a Turn Action that replied to a question asked in the Focus Turn
itself. See **Definition**.
_Avoid_: research (the old mode name), Research recent conversation

**Ask**:
A one-off typed question in the Research Assistant panel. Carries no
Transcript and no tab text unless the asker opts in with a **Placeholder**
— the question is the whole request otherwise.
_Avoid_: custom (that's a saved instruction, not a one-off question)

**Placeholder**:
Written inline in free text handed to the Research Assistant (an Ask
question, or a **Custom Prompt**) and substituted right before the
request is sent. Substitution happens in one place — the Research
Assistant Client — so it never matters which free-text field it came
from. The set (see ADR-0008 for the four added there):
- `{current_tab}` — video title (if loaded) then the tab's notes text.
- `{transcript}` — the room Transcript so far.
- `{selection}` — the excerpt a participant just highlighted to trigger
  the Custom Prompt. Empty when the prompt was triggered some other way.
- `{video_title}` — the active tab's video title alone, without notes.
- `{latest_transcript}` — the last ~700 words of the Transcript, a
  bounded recent window (contrast `{transcript}`, which is everything).
- `{current_time}` — wall-clock time at request time.
_Avoid_: prop (collides with Svelte component props, used constantly
elsewhere in this codebase), token, variable

**Research Prompt**, **Research Prompt Title**, **Custom** _(all retired
— see ADR-0008; replaced by **Custom Prompt**)_:
Were, respectively: the one instruction text a single global action sent
as its whole request; that action's button label; and the action itself
(ran the prompt against the active notes Tab's text and the room
Transcript). All three collapse into **Custom Prompt** below — there is
no more single global prompt, there's a list of them.
_Avoid_: Custom prompt as a synonym for the old singular Research Prompt
— that phrase is now the current, canonical plural term instead; a
reader hitting old references to "Custom prompt" meaning the one global
instruction should read **Custom Prompt** (capitalized as a term) below.

**Custom Prompt**:
One saved `{title, prompt text}` pair a participant can trigger from a
highlighted selection (on Notes text or a Transcript Turn) — replaces
Definition/Facts/Answer and the old singular Research Prompt/Custom
(ADR-0008). Written using **Placeholders**, fires immediately with no
extra input once triggered — the prompt's own text is the whole request.
Same scope as the old Research Prompt: a deployment-wide list, not
per-room, set on the create-room page by whoever holds the site password
(see **Usage Dashboard**), never edited by a room's Host mid-show. Gated
by **Guest Research Access** exactly like Ask, no special-case host-only
rule of its own.
_Avoid_: Turn Action, Definition/Facts/Answer, Quick Action, Interpret,
Interpretation Mode (all retired terms this replaces — see above)

**Guest Research Access**:
A per-room, host-set-at-creation checkbox letting every guest in that room
use every Research Assistant action — Ask and every Custom Prompt alike
— not just the Host. One flag, no per-action carve-outs. Off by default.
Set once, at room creation, on the create-room form — not editable
afterward from inside the room.
_Avoid_: RESEARCH_GUEST_CAN_ASK (the retired deployment-wide env var this replaced)

**Usage Dashboard**:
The section of the create-room page (visible once past the site password,
same as the create form) showing Research Assistant cost/usage across every
room — running totals plus a per-room breakdown — and the **Custom
Prompt** list editor. Not a separate page or route.
_Avoid_: admin panel, token dashboard (ambiguous with session/auth tokens),
usage page

**Research Eval Log**:
An append-only, gitignored record of live Research Assistant calls
(prompt, Focus Turn, Grounding, raw reply, parsed card, suppress,
latency), written only when enabled. Rooms still expire; the log is what
survives for prompt work after a show.
_Avoid_: keeping rooms, immortal rooms, eval-runs as the only corpus (that's canned)

**Annotation** _(ADR-0008)_:
A note anchored to a highlighted span of content — Notes text or a
Transcript Turn — authored either by a person (a **Comment**) or by a
Custom Prompt (a **Card**). Room-shared, listed together with every other
Annotation in the panel regardless of which kind authored it or which
surface (Notes or Transcript) it's anchored to. Anchored by a frozen
quote of the original excerpt, not a live position: the quote is the
Annotation's permanent record, and re-finding it in current Notes text to
draw a highlight is best-effort only — if the text was edited away, the
Annotation still exists with its quote, it just draws no highlight. Never
a persistent character-offset link, and never a highlight shown with
false confidence.
_Avoid_: highlight (that's the visual, not the note), block comment

**Comment**:
An Annotation authored by a person, not a Custom Prompt.
_Avoid_: note, margin note

**Card** _(renamed from **Research Card** — see ADR-0008)_:
An Annotation authored by a Custom Prompt: the glanceable result of a
lookup, a short takeaway meant to be skimmed during conversation, not
read in a focus state. Newest Cards sit at the top of the panel. Only a
successful lookup stays as a visible Card; a job miss is written to the
Research Eval Log and does not leave a "nothing to add" row. While a
lookup is in flight, a processing block occupies that same top slot so
it is obvious something is happening.
_Avoid_: Research Card (old name — the concept is now a kind of
Annotation, not its own standalone thing), Nothing new to add (as a
standing history item)

**Block** _(superseded — see ADR-0008)_:
Was meant as one unit of text in a tab surface: optional label, the text,
hover actions, with the Transcript's read-only **Turn**s as one example
and Notes tabs eventually "rebuilt as editable Blocks" as the other.
That second half never happened: ADR-0008 kept Notes as a single shared,
freeform text surface and anchored **Annotation**s to arbitrary
highlighted spans of it instead of restructuring Notes into an array of
Blocks. A Turn is still one read-only unit of Transcript content; just
don't call it a Block going forward.
_Avoid_: chunk, section, transcript line (say Turn), textarea row

**Transcript** _(was **Transcript Tab** — see ADR-0008)_:
The live, speaker-labeled record of both participants' conversation.
Populated automatically, read-only — nobody can type into it by hand.
It's the "central place" the Research Assistant reads the conversation
from, and it's what "accurate turns" means: correctly ordered, correctly
attributed, never dropped, even when both people are talking
near-simultaneously. No longer a Tab in the main tab strip: it's a
facet of the right panel, a reference surface a participant dips into to
browse or highlight a Turn, not a place they sit. Unlike the panel's
shared Annotation list, which facet of the panel a participant is
currently looking at (Transcript vs. the Annotation feed) is personal,
local to their own browser — nobody's screen jumps because their
co-host glanced at it.
_Avoid_: Transcript Tab (retired name — it isn't a Tab any more), live
captions tab, notes tab

**Turn**:
One transcript line: a single participant's finalized utterance, labeled
with who said it. Read-only; an **Annotation** can anchor to one directly.

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
