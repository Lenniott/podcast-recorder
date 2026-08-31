# 02 — Research endpoint: trigger detection, prompt building, OpenRouter call

**What to build:** a server- and pure-logic-only slice, no UI. A small set
of pure, unit-tested modules: one that detects a Voice Trigger phrase
inside a piece of finalized text and extracts whatever topic follows it
(see `CONTEXT.md`'s Voice Trigger entry for the agreed phrase list), and
one that builds the actual prompt sent to the AI — both for a
voice-triggered lookup (topic, or recent conversation when no topic was
named, plus the active tab's notes) and for a Quick Action (one canned
instruction plus the active tab's text). Then a server-only client for
OpenRouter's chat-completions API with its web-search plugin enabled (per
the "web search grounded" decision), and the authenticated
`POST /rec/[slug]/research` endpoint the browser actually calls — gated by
the same per-room session cookie the rest of `/rec/[slug]` already uses
(`src/lib/server/auth.js`'s `verifySessionToken`; see
`src/lib/server/server-copy-session.js` for the existing shape of an
authorization gate like this). The OpenRouter API key must never reach the
browser.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

This ticket deliberately has no UI — verify it with unit tests plus a
manual authenticated request (e.g. `curl` with a real session cookie
against a dev server). Tickets 04/05/06 are the only ones that call this
endpoint from the browser.

- [ ] Given a finalized utterance, trigger detection correctly identifies
      whether it contains one of the agreed Voice Trigger phrases,
      case-insensitively, and extracts the topic text following the phrase
      when there is one — returning nothing usable when there isn't (e.g.
      "let's look that up" with no named topic), so the caller knows to
      fall back to conversation context.
- [ ] Prompt building produces a valid, well-formed messages array for
      both cases: a voice-triggered lookup (with and without an explicit
      topic) and each of the five Quick Actions (Define, Key facts,
      Fact-check, Find examples, Analyze).
- [ ] The OpenRouter client enables the web-search plugin on every
      request, reads the model from an env var (documented in
      `.env.example`) defaulting to a cheap model, and surfaces any source
      links the search grounding returns rather than discarding them.
- [ ] The OpenRouter API key is read only from a server-side env var and
      never appears in any response sent to the browser, in a
      client-visible bundle, or in a client-side network request.
- [ ] `POST /rec/[slug]/research` rejects a request without a valid room
      session cookie (401) and a request for an unknown/expired room
      (410), matching the existing auth pattern for other
      `/rec/[slug]/...` endpoints.
- [ ] The endpoint validates its request body (reasonable size/shape
      limits on the messages array) and returns a clear error shape on a
      malformed request, an upstream OpenRouter failure, or a missing API
      key — without ever throwing an unhandled exception.
- [ ] Unit tests cover the trigger detection and prompt-building modules
      directly as pure functions (no network). Integration tests cover the
      endpoint's auth gating and error handling with a faked OpenRouter
      response (see `tests/unit/server-copy-routes.test.js` for this
      repo's pattern of testing a route directly with faked cookies/db
      state).
- [ ] `.env.example` gains the new variables this ticket introduces (API
      key, model, and anything else needed), documented the same way the
      existing variables are.
