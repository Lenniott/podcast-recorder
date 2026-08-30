# 11: Bind server-copy clientId to its owner

**What to build:** The server-copy session/chunks/finalize endpoints must only
accept requests for a `clientId` the requester actually owns — not any
`clientId` in the room. Fixes a broken-object-level-authorization bug found in
security review: `authorizeServerCopyRequest` currently checks only the room's
shared session cookie (identical for every participant), never that the
caller is the participant who owns the `clientId` in the request. `clientId`
is client-generated (`Math.random()`, not a secret) and is broadcast to every
room participant as normal presence data — so today, any authenticated
participant in a room can call these endpoints using another participant's
`clientId` to read their upload offset, inject forged audio into their server
copy, desync their real offset (permanently rejecting their legitimate
chunks), or finalize forged content that the host later downloads believing
it's that participant's genuine audio.

**Blocked by:** None (can start immediately).

**Status:** done

**Architectural context:** The WebSocket connection (`src/lib/server/ws-rooms.js`)
is where a participant's `clientId` is first established server-side — the
`'join'` message (`{ type: 'join', name, clientId }`) is handled per-connection,
and the server can reply directly on that same connection
(`send(ws, {...})`, see the `'tabs_state'`/`'yt_duck'` replies for the
pattern) without broadcasting to other peers. That's the one channel that is
provably exclusive to the browser tab claiming a given `clientId` — HTTP
requests to the server-copy routes only carry the shared room cookie, which
proves room membership, not per-participant identity.

Design: when a WS connection's `'join'` is handled and a `clientId` is
accepted for that connection, have the server mint a short capability token
scoped to `(slug, clientId)` — e.g. `HMAC(secret, slug + ':' + clientId)`,
verifiable statelessly (no new server-side session store, consistent with how
`verifySessionToken`/`getHostClaim` already work in `src/lib/server/auth.js`)
— and send it back **only on that connection** (never broadcast). The client
(`src/routes/rec/[slug]/+page.svelte`) captures it when its own `join` is
acknowledged and passes it into `createServerCopyUpload({..., token})`
(`src/lib/server-copy-upload.js`), which must include it on every
session/chunks/finalize request (header or body — pick whichever fits the
existing request shapes least awkwardly). `authorizeServerCopyRequest`
(`src/lib/server/server-copy-session.js`) verifies the token matches the
`clientId` in the request, in addition to the existing room-active +
room-cookie checks, before authorizing.

Constraints:
- No behavior change for a legitimate participant acting on their own
  `clientId` — same accept/reject outcomes as today for that case.
- A request for a `clientId` other than the one the token was minted for must
  be rejected (401/403, consistent with the existing error shape).
- Don't invent a new in-memory session store on the server — the token must
  be verifiable statelessly, the same way the rest of this codebase's
  claim/session tokens work.
- The upload module (`server-copy-upload.js`) must still work exactly as
  before for a client that never has network trouble getting its token
  quickly — don't introduce a race where `start()` can fire before the token
  has arrived from the WS `join` ack. If the token genuinely isn't available
  yet, `start()` should behave like any other rejected/not-yet-accepted
  session (existing fallback behavior), not throw or hang.
- The host-download route (`authorizeServerCopyHostRequest`) is unaffected —
  it already uses a separate, correct host-claim check; this ticket is scoped
  to the participant-facing session/chunks/finalize endpoints only.

- [x] The server issues a `clientId`-scoped capability token to the owning
      WS connection only, never broadcast to other peers.
- [x] `authorizeServerCopyRequest` verifies the token against the requested
      `clientId`, rejecting a mismatch.
- [x] A same-room participant can no longer read, write, or finalize another
      participant's server copy using only the shared room cookie.
- [x] A legitimate participant's own upload flow (session → chunks → finalize)
      is unaffected — same behavior as before this ticket.
- [x] `start()` degrades gracefully (does not throw/hang) if the token isn't
      yet available when called.
- [x] Tests cover: legitimate same-owner request succeeds; a request for
      someone else's `clientId` with a valid room cookie but no/wrong token
      is rejected at session, chunks, and finalize; a tampered/forged token
      is rejected.

**Resolution:** Implemented exactly as designed above. `src/lib/server/auth.js`
gained `makeServerCopyToken`/`verifyServerCopyToken` (`HMAC(secret,
'servercopy:' + slug + ':' + clientId)`, hex, `timingSafeEqual`-verified —
the same stateless shape as `makeSessionToken`/`makeHostClaimToken`, now
sharing a small `hmacHex`/`timingSafeEqualHex` helper to avoid a third
copy of that mechanics). `ws-rooms.js` mints and sends
`{ type: 'server_copy_token', clientId, token }` only to the connection
whose `'join'` just claimed that `clientId` (never on a name-only
subsequent join). `+page.svelte` captures it (guarded by
`msg.clientId === clientId`) and threads it into
`createServerCopyUpload({..., token})`, which sends it as `token` in the
session/finalize JSON bodies and as a `&token=` chunks query param —
omitted entirely (not `"undefined"`) when not yet available, so
`start()` just gets an ordinary 401 rejection rather than throwing or
hanging. `authorizeServerCopyRequest` now takes `clientId`/`token` and
verifies ownership after the existing room-active/room-cookie checks, so
route status-code precedence for pre-existing malformed-input cases is
unchanged. See `tests/unit/server-copy-routes.test.js`'s "security: a
same-room participant cannot act on another clientId" describe block for
the before/after vulnerability reproduction, `tests/unit/server-copy-session.test.js`
for the ownership/forged-token unit coverage, and
`tests/unit/ws-rooms.test.js`/`server-copy-upload.test.js` for the
exclusive-delivery and token-threading/degradation coverage.
