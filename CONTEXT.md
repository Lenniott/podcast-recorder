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
— the question is the whole request otherwise. The room WebSocket server
owns the lookup from pending entry through completion, and Ask always returns
structured **Block**s (with the usual flattened-text fallback). It remains
`ask`, not `custom`, in usage and eval records. Its unanchored research entry
appears in the same newest-first panel feed as **Annotation**s; it does not
become an Annotation because there is no frozen quote.
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

`{#if name}...{/if}` (bare Placeholder name, no braces inside) wraps a span
of a prompt's own text and keeps it only when that Placeholder resolved to
something non-blank — dropping the markers and the text alike otherwise.
One level only, no `{:else}` — a name used only inside a condition still
counts as referenced, so it isn't withheld from the request before the
condition can ever see it.
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
One saved `{title, prompt text}` pair a participant can trigger — replaces
Definition/Facts/Answer and the old singular Research Prompt/Custom
(ADR-0008). Written using **Placeholders**. A selection-based Custom Prompt
shares the highlight popup's always-visible composer with **Annotate**: it
can run from the highlighted excerpt alone, or append the participant's
optional typed context to this invocation. That addendum is not a
Placeholder and is preserved on the resulting **Card** so readers can see
what shaped the answer. A panel-based Custom Prompt still fires directly
from its saved prompt text.
Same scope as the old Research Prompt: a deployment-wide list, not
per-room, set on the create-room page by whoever holds the site password
(see **Usage Dashboard**), never edited by a room's Host mid-show. Gated
by **Guest Research Access** exactly like Ask, no special-case host-only
rule of its own. Also carries a per-prompt reply format, "Freeform text"
(default) or "Structured blocks" — the latter asks for typed **Block**s
instead of prose; see the reply-shape Block entry below for what that
constrains and, just as importantly, what it does not.

**Where a prompt's button appears is derived, never configured**: a
template that references `{selection}` can only ever mean something run
against a highlighted excerpt (on Notes text or a Transcript Turn), so it
appears in the highlight popup and nowhere else; a template that doesn't
has no excerpt to run against, so it gets a standalone button in the
Research panel instead. Never both, never neither — one plain fact
(`usesSelection`, computed server-side from the template, in
`db.js`'s `listCustomPromptSummaries`) decides which, using the same rule
`buildCustomPromptRequest` already uses to decide what a template is
handed. A panel-triggered prompt has no quote to anchor to, so its result
is a research entry (the same shape a typed Ask produces, filed under the
room's active tab), never an **Annotation** — see the entry below.
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
(the Custom Prompt or Ask question behind the call, the resolved
messages actually sent, raw reply, model/usage/latency), written only
when enabled. Rooms still expire; the log is what survives for prompt
work after a show. Every call is freeform now (ADR-0008) — there is no
more Focus Turn/Grounding split or suppress verdict to record.
_Avoid_: keeping rooms, immortal rooms, eval-runs as the only corpus (that's canned)

**Annotation** _(ADR-0008)_:
A note anchored to a highlighted span of content — Notes text or a
Transcript Turn — authored either by a person (a **Comment**) or by a
Custom Prompt (a **Card**). Room-shared, listed together with every other
Annotation in the panel regardless of which kind authored it or which
surface (Notes or Transcript) it's anchored to, interleaved newest-first
with the active Notes tab's unanchored Ask and panel-prompt research entries.
The two storage kinds remain distinct even though the panel presents one
feed. Anchored by a frozen quote of the original excerpt, not a live
position: the quote is the Annotation's permanent record, and re-finding
it in current Notes text to draw a highlight is best-effort only — if the
Annotation still exists with its quote, it just draws no highlight. Never
a persistent character-offset link, and never a highlight shown with
false confidence.
_Avoid_: highlight (that's the visual, not the note), block comment

**Comment**:
An Annotation authored by a person, not a Custom Prompt.
_Avoid_: note, margin note

**Listen-back check** / **test audio**:
The modal that opens the instant a participant starts recording. They read
a sentence; **Listen back** plays a short WAV built only from
confirmed-written chunks (same invariant as the live waveform). That clip
is also relayed to the **Host** (auto after a few seconds of written
audio, and again if they click Listen back) so it can be played from the
presence table without downloading a server copy or stopping the take.
The server forwards the PCM and forgets it. Not live monitoring. Not the
guest's "send the file" path either: leave/exit copy is reassurance-first
(see **Server copy**; Local Copy framing) unless that convenience upload
is still incomplete.
_Avoid_: talk, WebRTC, server copy download (that's a different file)

**Server copy**:
The convenience mirror of a participant's local WAV, uploaded to the
server so the host can collect takes from `ServerCopyFilesModal`. It is
not the recording itself (that's the Local Copy — a resilience file, not
guest homework). Guest-facing leave/exit copy is therefore
reassurance-first: backed up automatically, nothing to send — except
when the upload is still incomplete (`uploading` / `catching_up`), which
is the only leave warning that asks them to send the local file another
way. A permanent upload failure is a separate one-time alert, not that
leave warning and not reassurance.
_Avoid_: treating the local WAV as something the guest must deliver in
the normal case

**Local Copy**:
The WAV this browser writes to disk on this device — insurance if the
server or internet drops out, not "the backup" in the sense of something
the guest must personally deliver. The join click chooses one folder for
the visit (`showDirectoryPicker`). Each recording attempt is a new file in
that folder (`…-take-1.wav`, `…-take-2.wav`, numbered per browser visit,
never reusing a name already in the folder); a rejected Check Turn leaves
that attempt's file on disk as written and the check restarts on the next
file. In the normal case the host uses the automatic **server copy** upload
(`ServerCopyFilesModal`); the guest does not normally send this file
anywhere unless that upload failed. The server-copy modal's "Take N" is a
display index over files the server actually has — it is not this `-take-N`
suffix, and the two can disagree (a missing upload shifts the index).
_Avoid_: the backup (as busywork the guest must deliver), only copy, silent
about the server copy

**Synced Recording Session**:
Room-level start/stop of local recording, authored only by the host over
the room WebSocket (`recording_session`, phase `recording` | `idle`). Each
browser still writes its own Local Copy via the existing start/stop path;
the session message is coordination, not the recording. With the socket
down, each peer's own Start/Stop still writes a real file and does not
wait on the room. A guest Start while connected is local-only — it must
not start the host. The host re-announces this phase on reconnect via
`room.registerResync`. A connected host's Stop asks first
(`STOP_BOTH_CONFIRM`); nothing is sent until they confirm, and the phase
stays `recording` until the tail **Take Marker** closes the file. The
host's file still closes if the guest's browser is gone — the host never
waits on the guest — and the host is then told the other side may still
be recording (`OTHER_SIDE_UNCERTAIN`). A guest Stop stays local-only;
with the socket down, Stop closes the file immediately with no dialog.
_Avoid_: treating the room socket as required to record; folding this into
`recording_state` (that's one peer's own write flag, not the room session);
a `stopping` phase; waiting on a guest acknowledgement to stop

**Check Turn**:
Whose turn it currently is in the host-then-guest mic-check sequence after
a **Synced Recording Session** start (`idle` | `host` | `guest` | `passed`).
The host's existing single-person listen-back runs first; the guest sees
stay-quiet copy instead of their own modal, then the pair swaps after the
host confirms. Relayed on the existing `recording_check` WebSocket message
(`turn`) and presence `checkTurn`. Solo / offline Start still uses the
single-person check — there is no guest turn to wait on. Both turns
passing is the signal that fires the **Take Marker**; it is not itself
the take boundary.
_Avoid_: inferring stay-quiet from live mic level; opening both check
modals at once; treating both-turns-passed as "the take has started"

**Take Marker**:
The synced clap tone + countdown that flips a session from "checking" to
"the real take," used at take start (after **Check Turn** both-turns-passed)
and again at take stop. Same mechanism as the manual **Clap**
("Sync Tone Marker") and Watch Together: the server stamps `triggerAtMs`,
each browser corrects it with `clock-sync.js`'s `offset` into local time,
and `audioEngine.scheduleClapTone(delayMs)` lands the tone at one physical
instant. "Is this a real take yet" becomes true at that scheduled instant,
not when the WebSocket message arrives. Pre-marker audio stays on disk;
the boundary is a `startSample` offset (`captureWriter.samplesWritten` at
the instant) stored with the session, never a truncate/rewrite of confirmed
writes. Host sends `take_marker` once; guests schedule off the broadcast.
With no synced session (solo / offline), the marker is local and does not
wait on the room. The manual Clap button stays for its general-purpose use.
It is also the tail (`take_marker` with `edge: 'end'`): 2 seconds after the
host confirms Stop, both files close at that one instant, on the same
`triggerAtMs` path as the start marker. The tail never touches
`startSample` or "is this a real take."
_Avoid_: a second timing scheme; claiming the take has started on message
receipt; deleting bytes already written to make the take "start."

**Card** _(renamed from **Research Card** — see ADR-0008)_:
An Annotation authored by a Custom Prompt: the glanceable result of a
lookup, a short takeaway meant to be skimmed during conversation, not
read in a focus state. Newest Cards sit at the top of the panel. Only a
successful lookup stays as a visible Card; a job miss is written to the
Research Eval Log and does not leave a "nothing to add" row. While a
lookup is in flight, a processing block occupies that same top slot so
it is obvious something is happening. A Card produced by a
"Structured blocks"-format Custom Prompt also carries a **Block** array
alongside its flattened-text body — the text is always populated (so
anything reading only that keeps working), the Blocks are what a renderer
built for them shows instead.
_Avoid_: Research Card (old name — the concept is now a kind of
Annotation, not its own standalone thing), Nothing new to add (as a
standing history item)

**Block** _(reused — a second, unrelated concept also uses this name; see
the retired sense just below before assuming which one a mention means)_:
One typed, renderable container in a **Card**'s reply — `paragraph`,
`list`, or `stat` (`src/lib/research/research-blocks.js`) — used only
when the triggering Custom Prompt's reply format is "Structured blocks"
rather than the default freeform text. The model is asked for these via
provider-enforced JSON-schema mode (`strict: true`), not merely asked
nicely: a reply in this format cannot come back as anything else. Lives
entirely inside a Card's own content; has nothing to do with Notes'
structure, unlike the retired sense below.
_Avoid_: confusing this with the retired Notes-editor Block sense below —
same word, two different ADR-0008-era ideas that never overlapped in time

**Block (Notes-editor sense)** _(superseded — see ADR-0008)_:
Was meant as one unit of text in a tab surface: optional label, the text,
hover actions, with the Transcript's read-only **Turn**s as one example
and Notes tabs eventually "rebuilt as editable Blocks" as the other.
That second half never happened: ADR-0008 kept Notes as a single shared,
freeform text surface and anchored **Annotation**s to arbitrary
highlighted spans of it instead of restructuring Notes into an array of
Blocks. A Turn is still one read-only unit of Transcript content; just
don't call it a Block going forward. Unrelated to the reply-shape Block
sense above, which post-dates this one.
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
A room-shared "something's coming" pulse on the right panel's **Transcript**
facet button (it rode the Transcript Tab pill until that was retired — see
ADR-0008), true while any participant's speech recognizer has an interim
(not-yet-finalized) result in flight. It sits on the control that *opens*
the facet, not inside it, because its whole job is to reach a participant
who does not currently have the Transcript open — including one whose panel
is collapsed, where it moves to the collapse toggle. Deliberately not the
interim words themselves — no live streaming of unfinalized text between
participants, just a heads-up that a Turn is likely about to land. Separate
from a participant's own local transcription status (their recognizer's
health, e.g. "retrying"), which sits on the same button as its own distinct
dot: Activity is about the room, status is about one browser.
_Avoid_: live captions, interim transcript, typing indicator (in the
chat-app sense — this carries no text, just a boolean), Transcript Tab pill
(retired — there is no pill)
