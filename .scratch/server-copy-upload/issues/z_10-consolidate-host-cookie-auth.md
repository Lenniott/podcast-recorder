# 10: Consolidate duplicated host-cookie-auth check

**What to build:** One shared helper for the "read the `pr_host_<slug>` cookie,
verify it with `verifyHostClaimToken`, confirm it matches the active room"
check, used everywhere host identity is currently established, instead of the
same few lines copy-pasted across three files.

**Blocked by:** None (can start immediately).

**Status:** done

**Architectural context:** Flagged independently by the agents that built
tickets 05, 06, and 07 of the server-copy-upload series: `+page.server.js`,
`src/lib/server/ws-rooms.js`, and `src/lib/server/server-copy-session.js`
(`authorizeServerCopyHostRequest`) each contain their own copy of the same
pattern — read the `pr_host_<slug>` cookie, call `verifyHostClaimToken`, check
it against `getActiveRoomBySlug`'s result. None of those tickets touched all
three files at once, so the duplication was left for a dedicated pass. This
ticket is that pass. Pure refactor — no behavior change.

- [x] A single shared function (e.g. `getHostClaim(slug, cookies, room)` or
      similar, placed wherever this codebase's conventions put shared
      server-side auth helpers — check for an existing `src/lib/server/auth.js`
      home for it) implements the cookie-read + token-verify + room-match
      check once.
- [x] `+page.server.js`, `ws-rooms.js`, and `server-copy-session.js` all call
      the shared helper instead of their own inline copies.
- [x] No behavior change: host-only routes/actions still authorize exactly the
      same requests they did before, and reject exactly the same ones.
- [x] Existing tests for all three call sites (host download, WS host actions,
      server-copy host authorization) still pass unmodified in intent — update
      only what's mechanically necessary for the refactor, not the assertions
      themselves.
- [x] Tests directly cover the shared helper's own logic (valid claim, missing
      cookie, invalid/forged token, token for a different/expired room).
