# 04: Guest lock after long recording and inactivity

**Read first:** ticket 03 (join helper, host vs guest, Unlock), this
folder's README. Env defaults: **10 minutes** of that guest's
server-known recording, **2 hours** without accessing **that room**.

**What to build:** A **guest** who has a server-known recording longer
than the recording threshold, and who has not accessed that room within
the inactivity window, is **locked out** even if the time-lock clock is
still fresh. Other guests in the same room are decided independently.
The **Host** is never locked by this rule. **Unlock** (already in ticket
03) must also clear this lock (treat every guest as accessed now, or
equivalent — one behaviour, tested).

**Access** means authenticated room page load or successful WS join —
not "any hit on the create-room page." Persist last access per guest
identity the server already uses for server copies (`clientId`), updated
on those events.

**Recording length** is what the server can measure (that guest's server
copies). A local-only WAV does not arm this lock. Prior to a qualifying
recording, this rule does not lock them (ticket 03's "prior to a
recording" time-lock exception stays).

Thresholds are environment variables, injectable in tests like other
lifetime env.

**Where to look:** ticket 03 join helper; server-copy duration already
used by the Usage Dashboard; WS join / room enter. Do not invent a
second join gate.

**TDD seams:**

1. Last-access persistence: enter/join as guest writes a timestamp;
   reading it back is what the join helper uses.
2. Join helper additions: guest + recording longer than threshold +
   last access older than inactivity → refused; same guest with fresh
   access → allowed; recording shorter than threshold + stale access →
   allowed; host with stale access and a long recording → allowed;
   a second guest without a long recording → allowed while the first
   is locked.
3. Unlock from ticket 03 lets the locked guest in again.
4. Dashboard status: if any guest is inactivity-locked or the time lock
   applies, the row must not read as "open to guests." Honest combined
   status is enough — do not build a per-guest admin roster unless the
   join tests already require it.

**Blocked by:** 03 — Guest time lock and dashboard Unlock

**Hands off:** Do not add bulk here. Do not change what Delete removes.

**Status:** ready-for-agent

- [ ] Env vars for recording threshold and inactivity window documented;
      tests use literals.
- [ ] Guest with long server copy + stale room access cannot join; room
      remains; host can enter.
- [ ] Guest with no / short server copy can still join when only
      inactivity would have applied.
- [ ] Two guests: only the one who meets both conditions is refused.
- [ ] Unlock clears the inactivity lock for guests who were locked.
- [ ] Last access updates on enter and WS join so an active guest is
      not locked mid-session by the inactivity window.
- [ ] Same join helper as ticket 03; WS cannot bypass.
- [ ] TDD on the seams above.
- [ ] Coverage: threshold boundaries (just under / just over duration
      and inactivity), host exemption, unlock after inactivity lock,
      missing last-access treated honestly (specify: no access recorded
      counts as stale **or** as never-armed — pick one, document, test).
- [ ] E2E: create room, participate as guest with a forced long server
      copy and forced stale last access, guest cannot enter, host can;
      Unlock; guest can enter. A parallel path: short recording + stale
      access, guest can still enter.
- [ ] Docs: CONTEXT.md **Guest lock** lists both rules and the identity
      (clientId + server copy) they use.
