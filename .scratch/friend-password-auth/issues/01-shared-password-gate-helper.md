# 01 — Shared password-gate helper (prefactor, no behaviour change)

**Read first:** this folder's README (locked decisions), especially "Deep
modules, thin interface".

**What to build:** `hooks.server.js` and `+page.server.js` each currently
define their own copy of `makeSiteToken`/`verifySiteToken` (an HMAC of a
purpose string + password, keyed by `SECRET`, checked with
`timingSafeEqual`). Pull that into one small, purpose-parameterized module
(e.g. something like `makePasswordToken(purpose, password)` /
`verifyPasswordToken(purpose, password, token)`, living alongside the
existing `hashPassword`/`makeSessionToken` helpers) so both call sites use
it, and so ticket 02's Friend gate is a second *caller* of this module, not
a third hand-copied implementation.

This ticket changes no observable behaviour. The Host login flow, the
site-password redirect in `hooks.server.js`, and existing tests must all
still pass unchanged.

**Where to look:** `src/hooks.server.js` (`verifySiteToken`), and
`src/routes/+page.server.js` (`makeSiteToken`/`verifySiteToken` — the exact
duplicate). Whatever server auth module already holds
`hashPassword`/`generateSlug`/`makeSessionToken`/`makeHostClaimToken` is the
natural home for the new helper.

**TDD seams:**

1. Token round-trip: `verifyPasswordToken(purpose, password, makePasswordToken(purpose, password))` is true; wrong password, wrong purpose, wrong/garbage token, and empty token are all false.
2. Constant-time comparison is preserved (still uses `timingSafeEqual`, still doesn't throw on a malformed/short token — catches and returns false).
3. "No password configured" keeps whatever the current site-password behaviour is (open access) — encode that as a caller-level decision, not inside the token helper itself, so a future purpose that *shouldn't* have an open-access bypass isn't forced into one.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] One helper module owns password-token creation/verification; both
      `hooks.server.js` and `+page.server.js` call it — no duplicate HMAC
      logic remains for the site password.
- [ ] Helper's exposed interface is small (make/verify, given a purpose
      string and password) — no caller reaches into its internals (secret
      handling, HMAC details) directly.
- [ ] All existing site-password tests (unit + e2e) pass unchanged; no new
      env vars or cookies introduced by this ticket.
- [ ] TDD on the seams above, including the constant-time/garbage-token
      cases.
