# 02 — Friend login creates AI-off rooms; Friends can't reach the dashboard

**Read first:** this folder's README (locked decisions), ticket 01's
password-token helper. Glossary to add to CONTEXT.md: **Friend**, **Friend
room**.

**What to build:** A new `FRIEND_PASSWORD` env var gates a second, separate
login on the same entry page the Host password gates today. Someone who
only knows the Friend password reaches the create-room page as a Friend —
distinct from a Host session, not a weaker view of it — and can create a
room. A room created by a Friend session is a **Friend room**: Research
Assistant/AI is unconditionally off for it (no checkbox shown, and no way
to turn it on even by tampering with the form — the server decides this
from the session's role, not from a posted field). A Friend session cannot
load or post to the Usage Dashboard or Custom Prompt management — those
routes/actions treat a Friend session the same as an unauthenticated one.

Everything else in a Friend room — recording, notes, video, and especially
**Transcript** — must work exactly as it does in a Host room today. This
ticket must not touch that path; if a change here would affect it, that's a
sign the role check landed in the wrong place.

The Host is unaffected end to end: same password, same cookie, same
dashboard, same per-room AI checkbox on Host-created rooms. From the
dashboard, the Host can tell which rooms are Friend-created (Host rooms and
Friend rooms are visually distinguishable in the existing room list).

**Where to look:** ticket 01's password-token module; `hooks.server.js`'s
site gate (a request now needs to pass with *either* a valid Host cookie or
a valid Friend cookie); `+page.server.js`'s `load`/`create` actions and the
`isSiteAuthed`-gated Custom Prompt actions; `db.js`'s `rooms` table and
`createRoom` (needs to record which role created a room — reuse the
existing `ALTER TABLE ... ADD COLUMN` + ignore-duplicate-column pattern
already used for `password_plain`/`guest_ai_allowed`); wherever the AI
checkbox and Usage Dashboard are gated today.

**TDD seams:**

1. Role resolution: a single, small function/module answers "what role (if
   any) does this request/session have" (none / host / friend) from
   cookies — every route above calls *that*, none of them re-derive it from
   raw cookie parsing.
2. Friend room creation: server ignores/rejects a posted AI-on field for a
   Friend session; the created room is unconditionally AI-off regardless of
   what was submitted.
3. Dashboard/Custom-Prompt gating: a Friend session gets the same
   not-authorised outcome as no session at all; a Host session is
   unaffected.
4. Cross-role isolation: a Friend cookie doesn't satisfy the Host gate and
   vice versa; wrong/garbage/expired token on either cookie is rejected the
   same way the existing site-password one is.

**Blocked by:** 01 — shared password-gate helper.

**Status:** ready-for-agent

- [ ] `FRIEND_PASSWORD` documented (README/CONTEXT.md/`.env.example`), same
      "leave blank to disable" shape as other optional env vars here.
- [ ] Friend login works with only `FRIEND_PASSWORD`; Host login is
      unchanged and still requires `SITE_PASSWORD`.
- [ ] A Friend-created room has AI permanently off; posting an AI-on field
      as a Friend does not turn it on.
- [ ] A Host-created room's AI checkbox behaves exactly as before.
- [ ] Friend session cannot load the Usage Dashboard or invoke any Custom
      Prompt CRUD action (same failure mode as unauthenticated).
- [ ] Host session's dashboard access, Custom Prompt CRUD, and room list are
      unaffected; dashboard visually distinguishes Friend rooms from Host
      rooms.
- [ ] Transcript, recording, notes, and video work identically in a Friend
      room and a Host room — covered by a test that exercises at least one
      of these end to end in a Friend room.
- [ ] One role-resolution interface; no route re-derives role from cookies
      independently (grep for role/cookie logic outside it as a check).
- [ ] TDD on the seams above.
- [ ] Coverage: role × dashboard access, role × AI toggle (including a
      tampered "AI on" post from a Friend), missing/garbage/wrong-role
      cookie on each gate.
- [ ] E2E: log in as Friend, create a room, confirm no AI UI and Transcript
      still works; log in as Host, confirm dashboard shows the Friend room
      distinguishably and Host's own AI toggle still works.
