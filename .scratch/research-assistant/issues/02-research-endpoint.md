# 02 — Research Assistant Client (deep module) + trigger detection + endpoint

**What to build:** a server- and pure-logic-only slice, no UI.

The centerpiece is the **Research Assistant Client** — one small, deep
module, its own thing, unrelated to the Room State Store (ticket 00): that
module owns *where a room's content lives*, this one owns *how a lookup
request becomes an answer*. Its public interface is a single entry point —
call it `askResearchAssistant(request)` — that takes a small, typed
request (either "voice lookup: topic and/or recent conversation, plus the
active tab's notes" or "quick action: which of the five, plus the active
tab's text") and returns `{ answer, citations }`, or throws one of a few
clear, named error kinds (not configured, timed out, upstream failure,
empty answer). Everything else lives *inside* it, invisible to callers:
which OpenRouter model to call (from an env var, documented in
`.env.example`, defaulting to a cheap model), turning the request into the
actual prompt text for each of the two kinds (see `CONTEXT.md`'s Voice
Trigger / Quick Action entries), whether the web-search plugin is enabled
(it should be, per the "web search grounded" decision), retry/timeout
handling, and parsing the raw API response into that clean return shape.
The OpenRouter API key must never reach the browser.

Separate from that, a small **trigger detection** module — a different job
entirely (recognizing a Voice Trigger phrase inside a piece of finalized
speech and extracting whatever topic follows it, per `CONTEXT.md`'s agreed
phrase list). It doesn't know or call the Research Assistant Client; it's
what ticket 06's voice wiring uses to decide *whether* to call it at all.

Finally, the authenticated `POST /rec/[slug]/research` endpoint the
browser actually calls — gated by the same per-room session cookie the
rest of `/rec/[slug]` already uses (`src/lib/server/auth.js`'s
`verifySessionToken`; see `src/lib/server/server-copy-session.js` for the
existing shape of an authorization gate like this). With the Research
Assistant Client doing the real work, this route should end up almost
trivial: check auth, check the incoming request looks like a valid ask,
call `askResearchAssistant`, map its result or typed error to an HTTP
response.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

This ticket deliberately has no UI — verify it with unit tests plus a
manual authenticated request (e.g. `curl` with a real session cookie
against a dev server). Tickets 04/05/06 are the only ones that call this
endpoint from the browser.

**Confirmed test seams (`/tdd`) — test only at these:**
1. `detectResearchTrigger` — pure function, direct tests.
2. `askResearchAssistant(request)` — the Client's one public entry point —
   tested directly with an injected fetch (never real network), covering
   both request kinds, model/web-search selection, response shaping into
   `{ answer, citations }`, and every named error case.
3. The `POST /rec/[slug]/research` route — tested directly (construct a
   request/cookies, and — matching SvelteKit's own convention — pass a
   `fetch` via the request event rather than relying on the global one),
   verifying auth gating, request validation, and error-mapping, with the
   Research Assistant Client stubbed at this seam. Route tests should not
   re-prove prompt content or OpenRouter request shape — that's seam 2's
   job.

- [ ] Given a finalized utterance, trigger detection correctly identifies
      whether it contains one of the agreed Voice Trigger phrases,
      case-insensitively, and extracts the topic text following the phrase
      when there is one — returning nothing usable when there isn't (e.g.
      "let's look that up" with no named topic), so the caller knows to
      fall back to conversation context.
- [ ] `askResearchAssistant` produces a well-formed request to OpenRouter
      for both kinds: a voice-triggered lookup (with and without an
      explicit topic) and each of the five Quick Actions (Define, Key
      facts, Fact-check, Find examples, Analyze).
- [ ] Every request enables the web-search plugin, reads the model from an
      env var, and — on a successful response — returns any source links
      the search grounding returns rather than discarding them.
- [ ] The OpenRouter API key is read only from a server-side env var and
      never appears in any response sent to the browser, in a
      client-visible bundle, or in a client-side network request.
- [ ] `askResearchAssistant` throws a distinguishable error for: no API
      key configured, a request timeout, an upstream non-2xx response, and
      an unusable/empty answer — a caller can tell these apart without
      parsing message strings.
- [ ] `POST /rec/[slug]/research` rejects a request without a valid room
      session cookie (401) and a request for an unknown/expired room
      (410), matching the existing auth pattern for other
      `/rec/[slug]/...` endpoints.
- [ ] The endpoint validates its request body (reasonable size/shape
      limits) and returns a clear, distinct error response for a malformed
      request vs. each of the Research Assistant Client's error kinds —
      without ever throwing an unhandled exception.
- [ ] `.env.example` gains the new variables this ticket introduces (API
      key, model, and anything else needed), documented the same way the
      existing variables are.
