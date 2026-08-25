# Live transcription + AI podcast-researcher — research & proposed design

**Status:** research only, no tickets cut yet, no code changed.

## The tension this sits on top of

`AGENTS.md`'s one rule is *"never let the UI claim things are fine when they
might not be"* and its concrete form today: **your audio never touches the
server.** Every WS message the server currently relays is either presence,
sync timing, or plain text (`tab_text`, notes) — never audio. Transcription
and a research agent both want to read what was *said*, which means somewhere
between "raw mic audio" and "an AI call," speech has to become text. Two
honestly different places that can happen, and they have very different
privacy/cost/quality shapes. Both are laid out below — the pick is a product
call for whoever owns the "audio never touches server" promise, not something
to default silently.

One thing that's true either way and worth noting up front: **speaker
separation is already free here.** Host and guest each run their own
`getUserMedia` stream in their own browser (see `capture-writer.js`), so
whichever transcription path you choose, you transcribe each person's stream
independently and tag it with `peer.name` from `ws-rooms.js` — no diarization
step needed, unlike a single-mixed-feed podcast setup.

---

## Part 1 — Transcription: on-device vs. cloud

### Path A — On-device (audio never leaves the browser)

Run STT inside each participant's own browser, on their own mic stream.
Nothing audio-shaped crosses the network; only the resulting *text* does
(same trust boundary the app already has for `tab_text`).

- **`transformers.js` (Xenova) running Whisper `tiny`/`base` via WASM/WebGPU.**
  Genuinely local — no network call for STT at all, $0 marginal cost. Real
  browsers hosting Whisper-web demos for years now; WebGPU (Chrome/Edge —
  which the app already requires) gets `base`-size models running at
  faster-than-realtime chunked inference on a normal laptop CPU/GPU.
  Trade-offs: rolling-chunk latency (models transcribe a buffered window, so
  expect ~3–8s lag on a chunk, not word-by-word streaming), noticeably lower
  accuracy than a large cloud model — especially on cross-talk, accents, or
  jargon — and it burns the participant's own CPU/battery for the whole
  episode. For a research *trigger* (not a transcript people read back), that
  accuracy bar is probably fine — you don't need verbatim, you need "did the
  last 15 seconds contain something worth looking up."
- **Browser `SpeechRecognition` (Web Speech API).** Free, built into Chrome
  already (the app is Chrome/Edge-only per the README), zero setup. **Not
  actually on-device** for the default engine — Chrome's implementation
  streams audio to Google's speech servers under the hood, so this doesn't
  preserve the "audio never leaves the device" property even though it feels
  local. Worth ruling out explicitly rather than reaching for it by
  reflex — it looks like the free local option and isn't one.

### Path B — Cloud streaming STT (audio does leave the device, for this feature)

Each browser streams its own mic audio to a cheap real-time STT vendor —
either proxied through our WS server, or directly browser→vendor using a
short-lived scoped token our server mints (same shape as a signed upload URL;
avoids piping audio bytes through our own process at all).

- **Deepgram (Nova-3), streaming websocket.** ~$0.0043–0.0059/min. True
  low-latency partial+final streaming, good accuracy, handles cross-talk
  fine per-stream since each person is already isolated. For a 60-minute
  two-person episode: ~120 person-minutes ≈ **$0.50–0.70/episode.**
- **Groq-hosted Whisper (`large-v3-turbo`), batch endpoint.** Extremely
  cheap (~$0.04/hour of audio) and extremely fast inference, but it's a
  batch call, not a streaming socket — "live" would mean submitting rolling
  ~5–10s clips, which is a usable near-real-time hack but adds a bit of
  request overhead and jitter vs. a real streaming API.
- **AssemblyAI / OpenAI (`gpt-4o-mini-transcribe`) streaming** — comparable
  shape and cost band to Deepgram, worth a bake-off if Deepgram's docs or
  limits don't fit.

Cloud STT is the one place this proposal would need new consent UI and a
rewrite of the "your audio never touches the server" claim in the README —
even scoped as "only while transcription is enabled, only for the research
feature, opt-in per room." That's a real product decision, not a technical
detail.

### What doesn't change between the two paths

Regardless of where STT happens, the *text* transcript still needs to reach
the server, because the research agent needs to combine it with the tab's
`[script]`/`[notes]` content and with the other participant's transcript —
that assembly has to happen somewhere both peers' state is visible, which
today is the WS server (see `ws-rooms.js`'s `tabRooms`). So "on-device STT"
buys you "raw audio stays local," not "transcript stays local" — the AI
research call the user is asking for inherently means transcript text goes
to a third-party LLM either way. That's the real scope of the privacy
decision: it's about the *audio*, not about whether text leaves the room.

---

## Part 2 — The research agent

### Provider: a multi-model gateway, not a single vendor lock-in

What you're describing — "an api key approach... connects loads of different
[models] under one key" — is **OpenRouter** (openrouter.ai). One API key,
one OpenAI-compatible endpoint, and the model is just a string
(`openai/gpt-4o-mini`, `perplexity/sonar`, `anthropic/claude-...`,
`google/gemini-2.5-flash`, etc.) — so cheap/fast models and
search-capable models can be swapped per call, and swapped later via config
with no code change. This fits the "control its overall prompt" ask well
too: model choice, system prompt, and per-call parameters all live in one
place server-side, same pattern as `SECRET`/`SITE_PASSWORD` in `.env` —
the key never ships to the browser, the server makes the call.

### Two-stage funnel (keeps it cheap)

Calling a websearch-capable model on every sentence would be neither cheap
nor useful — most sentences aren't "I wonder what that means" moments. Two
stages:

1. **Cheap classifier, runs on every new final transcript chunk.** A small,
   fast model (e.g. `openai/gpt-4o-mini` or similar via OpenRouter,
   fractions of a cent per call) sees a short rolling window of transcript
   and answers "is there a specific, lookup-worthy claim/name/term here, and
   if so what's the query?" Cheap enough to run continuously.
   Lightweight local heuristics (regex for "I wonder", "what does that
   mean", "no idea what that is", "is that true", "who's that") can gate
   *even calling the classifier*, if you want a third, free tier before any
   API call happens at all.
2. **Search-capable model, only on a hit.** A model with real web access
   (OpenRouter's `perplexity/sonar` or `sonar-pro`, or a `:online` /
   web-search-tool variant of a bigger model) takes the query plus the
   guardrail system prompt and produces one short "did you know" card:
   title + 2–3 sentence body + optionally a source. This is the pricier
   call (search + generation), but it's rare — maybe 10–20 per episode.

Rough episode cost: classifier calls ≈ pennies total; ~15 research cards at
roughly $0.02–0.05 each ≈ $0.30–0.75. Combined with cloud STT, a full
hour-long two-person episode lands somewhere in the **$0.30 (on-device STT)
to ~$1.50 (cloud STT + research) per episode** range — genuinely cheap for
what it's replacing (a human researcher scrolling Wikipedia mid-show).

3. **Manual override, always available.** A "🔍 look this up" button next
   to the transcript/notes lets either person force a card without waiting
   on the classifier — good fallback when the auto-trigger misses something
   or someone just wants an answer right now.

### Where results show up

The user's own framing — "present little 'did you know' sections below the
text area" — maps directly onto the tab model that already exists. Each tab
already carries `video` and `text`; add a third piece of per-tab state,
`research: [{id, title, body, query, createdAt}]`, broadcast the same way
`tab_text` is today (server holds it in `tabRooms`, relays to both peers,
replayed to late joiners). No new sync mechanism needed — this is squarely
inside the pattern `ws-rooms.js` already has for shared, ephemeral,
per-tab state that dies with the room.

---

## Part 3 — Prompt control

Two distinct things the ask calls for, and they map onto two different
scopes:

### 1. The overall system prompt ("the rules"), one per room

A single system prompt, editable by the host (alongside the existing room
settings in `RoomDetailsPanel.svelte`), prepended to **every** AI call for
that room — both the automatic classifier→research flow and any manually
activated prompt below. This is the actual enforcement point for "no
spoilers": the host writes it once per episode (e.g. *"This is a recap
podcast for [show]. Don't reveal or confirm plot details past episode 4.
Keep answers to 2–3 sentences. If a lookup risks a spoiler, decline and say
so instead of guessing."*), and because it's prepended unconditionally, no
per-prompt template or ad-hoc host action can route around it — there's one
place the rule lives, not one per template.

Storage: one column on `rooms` (or a new `room_settings` table if this
grows), same shape as the existing `password_hash`/`name` columns in
`db.js`.

### 2. Host-activatable prompt library, with `[script]`/`[notes]` placeholders

A per-room, host-managed list of saved prompt templates — e.g. "Fact-check
the last claim," "Give background on this guest," "Find a counter-argument."
Each template is free text with two placeholders the host can drop in
anywhere:

- `[script]` → substituted with the content of whichever tab is the
  "script" tab (or a designated tab) at run time
- `[notes]` → substituted with the shared notes text for the active tab

Clicking a template assembles: **room system prompt + template body (with
placeholders filled from live tab state) + a recent transcript window**, and
sends that as one call — result comes back as another `research` card, same
delivery path as the automatic ones. This is naturally a small CRUD surface
(create/edit/delete/reorder templates) plus a "run" button per template,
host-only (mirrors the existing host/guest role split already in
`ws-rooms.js`'s `recomputeRoles`).

Storage: a `prompt_templates` table (`id`, room slug, `name`, `body`,
`created_at`, maybe a `pinned`/order column) — small, standard CRUD, fits
`better-sqlite3` fine.

### New WS protocol surface (sketch, not final)

Following the existing style/comment block at the top of `ws-rooms.js`:

```
Client → server:
  { type: 'transcript_chunk', text, isFinal }        — from the sender's own STT (path-dependent on Part 1)
  { type: 'prompt_run', tabId, templateId | adhocBody } — host runs a template or manual lookup
  { type: 'research_dismiss', tabId, cardId }

Server → client:
  { type: 'transcript_chunk', tabId?, speaker, text, isFinal }  — relayed/tagged, replayed to late joiners
  { type: 'research_card', tabId, id, title, body, query, createdAt } — broadcast to room, replayed to late joiners
  { type: 'research_dismiss', tabId, cardId }
```

Transcript and research-card state would live in-memory per room, in the
same `tabRooms`-shaped structure — not a new DB table — since everything
else about a room (tabs, video state, notes) is already treated as ephemeral
and dies with the room's expiry. No reason for the transcript to outlive
that when nothing else does.

---

## Open decision for whoever's driving this next

The one fork this doc deliberately didn't resolve: **on-device STT (Path A)
vs. cloud STT (Path B)** in Part 1. Recommend on-device (`transformers.js` +
Whisper `base` via WebGPU) as the default if keeping the "audio never
touches the server" claim intact matters more than transcript accuracy —
it's the only path that doesn't require new consent UI or a README rewrite.
Cloud STT (Deepgram) is the better product if accuracy/latency matters more
than that specific promise, and it's still cheap (~$0.50–0.70/episode) — it
just isn't free of the privacy trade-off. Worth prototyping both against a
real 10-minute recording before committing, since "good enough for a
curiosity trigger" is an accuracy bar that's easy to guess wrong on paper.
