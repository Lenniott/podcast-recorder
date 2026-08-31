# 07 — Per-room restricted-topic rule for Research Mode (not yet scoped for dispatch)

**What this is:** Research Mode (ticket 06) can optionally be told to
never surface a specific category of fact, even when it would otherwise
qualify — the motivating example is a lyrics-interpretation show that
never wants Research Mode to reveal a song's "official" meaning before
the hosts have stated their own read. The rule needs an explicit,
deliberate override (e.g. a held button or checked box active at the
moment a query is made) that lifts the restriction for one query only,
then re-engages automatically — never satisfiable by a spoken request or
passive default alone.

**Why this isn't part of ticket 06:** this app has no per-room
configuration mechanism at all today beyond room name/password (see
`src/routes/+page.server.js`, `src/lib/server/db.js`'s `rooms` table) —
loading a rule "per show" needs deciding where that rule lives, who can
set it, and how the override control reaches the UI, none of which
exists yet. Bundling it into 06 would block the core passive fact-checking
behavior on building a whole settings surface first.

**Status:** not ready for agent dispatch — needs its own grilling pass on
where the rule is stored/set (is a "show" the same as a "room," or a new
concept above rooms?) and what the override control looks like in the UI,
before it's specified enough to hand to an agent. Revisit after ticket 06
ships and the team has used Research Mode for real.
