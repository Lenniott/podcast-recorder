# Live transcription + AI podcast-researcher — research & proposed design

**Status:** research only, no tickets cut yet, no code changed.

**Revision note:** an earlier draft of this doc framed "audio never touches
the server" as a hard privacy rule this feature had to route around. That was
wrong — per direct correction: the actual rule (`AGENTS.md`) is that a
recording must **save locally and keep recording even if the internet
drops**; it isn't a security boundary, and there's already a separate branch
that uploads guest audio to the server so the host can download it. Episodes
are public anyway. This revision drops the on-device-vs-cloud dilemma and
commits to the snappy option.

## Ground truth this design now runs on

- **Live, low-latency transcription > perfect privacy.** This is for
  in-the-moment "what does that mean?" answers while people are still
  talking, not a transcript-accuracy product.
- **Browser `SpeechRecognition` (the "Google speech recognition" you're
  thinking of) is fine to use.** It's free, built into Chrome/Edge (which
  the app already requires), and streams interim + final results with
  genuinely low latency — no batching, no chunk-and-wait.
- **The whole thing sits behind one env feature flag**, off by default,
  specifically so a self-hosted internal/company podcast can run this app
  with zero calls to Google or any AI vendor. On is "public podcast,
  send it"; off is "internal show, don't."
- **An AI API key is required too**, server-side only, for the research
  agent (Part 2).
- Speaker separation is still free: host and guest each run their own
  `getUserMedia` stream in their own browser (`capture-writer.js`), so each
  person's `SpeechRecognition` instance is inherently single-speaker —
  tag results with `peer.name` from `ws-rooms.js`, no diarization needed.

---

## Part 1 — Transcription: browser `SpeechRecognition`, per person

Each browser runs its own `webkitSpeechRecognition`/`SpeechRecognition`
instance (`continuous: true, interimResults: true`) alongside its existing
mic capture graph. It's a separate, independent API call from the audio
recording path — it does **not** touch `capture-writer.js`, the WAV write
path, or anything covered by the "never corrupt a recording" rule. If
`SpeechRecognition` errors, restarts, or drops, that's a transcription/UX
issue only; the actual recording is untouched.

- **Cost:** $0 marginal — this is the point of using it.
- **Latency:** genuinely live — interim results stream in as someone talks,
  finals settle a beat later. This is what makes "answers while people are
  still talking" actually feasible, unlike a chunk-and-submit model.
- **Quality:** good enough for a lookup trigger; not word-perfect, doesn't
  need to be — the transcript here drives "should we look something up,"
  not a published transcript.
- **Real caveat to prototype early: device targeting.** `MicPanel.svelte`
  lets a participant explicitly pick which input device gets recorded
  (`selectedDeviceId`), and `capture-writer.js` records from exactly that
  device. `SpeechRecognition` has no equivalent "use this deviceId" option
  in Chrome — it listens to whatever the browser/OS currently treats as the
  default input, which can silently diverge from the device actually being
  recorded (e.g. someone recording on a USB mic but the OS default is still
  a laptop mic). Worth confirming behavior on a real machine with two
  input devices before building UI around it — if it diverges, the fix is
  just "transcription mic ≠ recording mic, and that's an accepted
  limitation," not a blocker.
- **Restart handling:** `SpeechRecognition` sessions can time out or drop on
  silence/network hiccups; needs an auto-restart loop (same shape as
  `room-connection.js`'s reconnect-with-backoff, just for a much shorter,
  more frequent cycle) so a dropped recognition session doesn't just go
  quiet for the rest of the episode.

### Where the flag lives

Follow the existing config pattern exactly — `env.SECRET`/`env.SITE_PASSWORD`
are read server-side via `$env/dynamic/private` in `+page.server.js`'s
`load()` and handed down as page data (see `roomPassword`, `isHostClaim`).
Do the same here rather than reaching for a build-time `PUBLIC_` var, since
this app is a single Docker image configured per-deployment at runtime, not
per-build:

```
# .env.example additions
RESEARCH_ASSISTANT_ENABLED=false   # master switch: transcription UI + all AI calls
AI_API_KEY=                        # see Part 2 — required if enabled
```

`+page.server.js` reads `env.RESEARCH_ASSISTANT_ENABLED === 'true'` and
returns it as `researchEnabled` in `load()`'s return value, same as every
other piece of server config this app already threads through to the page.
When off: no `SpeechRecognition` instance is started, no transcript UI
renders, and the server-side AI-call code path never runs — a company
running this for internal podcasts sees literally the same app as today.

---

## Part 2 — The research agent

### Provider: a multi-model gateway, not a single vendor lock-in

What you described — "an api key approach... connects loads of different
[models] under one key" — is **OpenRouter** (openrouter.ai). One API key,
one OpenAI-compatible endpoint, model chosen per-call by a plain string
(`openai/gpt-4o-mini`, `perplexity/sonar`, `anthropic/claude-...`,
`google/gemini-2.5-flash`, etc.). Good fit here: cheap/fast models and
search-capable models can be swapped independently, and swapped later via
config with no code change. `AI_API_KEY` stays server-side only — the
server makes the call, same as every other secret in this app's `.env`.

### Two-stage funnel (keeps it cheap without sacrificing snappiness)

Running a websearch-capable model on every sentence would be neither cheap
nor fast enough to feel live. Two stages:

1. **Cheap classifier, runs on every new final transcript chunk.** A small,
   fast model (e.g. `openai/gpt-4o-mini` or similar via OpenRouter,
   fractions of a cent and well under a second) sees a short rolling window
   of transcript and answers "is there a specific, lookup-worthy
   claim/name/term here, and if so what's the query?" Cheap and fast enough
   to run continuously without adding perceptible lag.
   Lightweight local heuristics (regex for "I wonder", "what does that
   mean", "no idea what that is", "is that true", "who's that") can gate
   *even calling the classifier*, if you want a free tier before any API
   call happens at all.
2. **Search-capable model, only on a hit.** A model with real web access
   (OpenRouter's `perplexity/sonar`/`sonar-pro`, or a `:online` /
   web-search-tool variant) takes the query plus the room's guardrail
   system prompt and produces one short "did you know" card: title + 2–3
   sentence body + optionally a source. Pricier call (search + generation),
   but rare — maybe 10–20 per episode, not per sentence.
3. **Manual override, always available.** A "🔍 look this up" button next
   to the transcript/notes lets either person force a card without waiting
   on the classifier — good fallback when auto-trigger misses something or
   someone just wants an answer right now.

Rough episode cost, now that transcription itself is free: classifier calls
≈ pennies total across an episode; ~15 research cards at roughly
$0.02–0.05 each ≈ **$0.30–0.75/episode** — genuinely cheap for what it's
replacing (a human researcher scrolling Wikipedia mid-show).

### Where results show up

The framing — "present little 'did you know' sections below the text area"
— maps directly onto the tab model that already exists. Each tab already
carries `video` and `text`; add a third piece of per-tab state,
`research: [{id, title, body, query, createdAt}]`, broadcast the same way
`tab_text` is today (server holds it in `tabRooms`, relays to both peers,
replayed to late joiners). No new sync mechanism needed — this slots
directly into the pattern `ws-rooms.js` already has for shared, ephemeral,
per-tab state.

---

## Part 3 — Prompt control

Two distinct things the ask calls for, mapping onto two different scopes:

### 1. The overall system prompt ("the rules"), one per room

A single system prompt, editable by the host (alongside the existing room
settings in `RoomDetailsPanel.svelte`), prepended to **every** AI call for
that room — both the automatic classifier→research flow and any manually
activated prompt below. This is the actual enforcement point for "no
spoilers": the host writes it once per episode (e.g. *"This is a recap
podcast for [show]. Don't reveal or confirm plot details past episode 4.
Keep answers to 2–3 sentences. If a lookup risks a spoiler, decline and say
so instead of guessing."*). Because it's prepended unconditionally, no
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
placeholders filled from live tab state) + a recent transcript window**,
sent as one call — result comes back as another `research` card, same
delivery path as the automatic ones. Small CRUD surface (create/edit/
delete/reorder templates) plus a "run" button per template, host-only
(mirrors the existing host/guest role split already in `ws-rooms.js`'s
`recomputeRoles`).

Storage: a `prompt_templates` table (`id`, room slug, `name`, `body`,
`created_at`, maybe a `pinned`/order column) — small, standard CRUD, fits
`better-sqlite3` fine.

### New WS protocol surface (sketch, not final)

Following the existing style/comment block at the top of `ws-rooms.js`:

```
Client → server:
  { type: 'transcript_chunk', text, isFinal }          — from the sender's own SpeechRecognition
  { type: 'prompt_run', tabId, templateId | adhocBody } — host runs a template or manual lookup
  { type: 'research_dismiss', tabId, cardId }

Server → client:
  { type: 'transcript_chunk', tabId?, speaker, text, isFinal }  — relayed/tagged, replayed to late joiners
  { type: 'research_card', tabId, id, title, body, query, createdAt } — broadcast to room, replayed to late joiners
  { type: 'research_dismiss', tabId, cardId }
```

All of this is gated server-side by `RESEARCH_ASSISTANT_ENABLED` — with the
flag off, these message types are simply never processed (or rejected),
same as any other feature-flagged server behavior.

Transcript and research-card state live in-memory per room, in the same
`tabRooms`-shaped structure — not a new DB table — since everything else
about a room (tabs, video state, notes) is already ephemeral and dies with
the room's expiry. No reason for the transcript to outlive that when
nothing else does. (`prompt_templates` is the one exception worth
persisting in SQLite — a host's saved prompt library is worth keeping
across episodes, unlike the live transcript.)

---

## Suggested build order (for whoever cuts tickets next)

1. `RESEARCH_ASSISTANT_ENABLED` + `AI_API_KEY` env plumbing, threaded down
   to the client exactly like `roomPassword` is today — ships as a no-op
   with the flag off.
2. Per-browser `SpeechRecognition` wrapper with auto-restart, wired to
   `transcript_chunk` over the existing WS connection — no AI calls yet,
   just prove live transcript flows both directions and survives a dropped
   recognition session.
3. Room-level system prompt: DB column + host settings UI.
4. Two-stage funnel (classifier → research call) wired to real transcript
   chunks, cards rendered under the tab's text area via `research_card`.
5. Host prompt-template library (CRUD + `[script]`/`[notes]` substitution +
   run button) — layered on top of the same `prompt_run` → `research_card`
   path step 4 already built.
