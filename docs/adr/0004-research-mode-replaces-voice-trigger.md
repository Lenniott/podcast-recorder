# Research Mode (passive, gated) replaces Voice Trigger (explicit phrase)

Voice Trigger (tickets 02/06 as originally scoped) required a participant
to say a specific phrase — "let's look that up," "define," and similar —
before the Research Assistant would do anything. We're replacing that
entirely with **Research Mode**: a passive process that watches the
Transcript continuously and decides for itself when something is worth
surfacing, with no phrase, button, or explicit action required.

The obvious naive version of "watch continuously" — run the full,
web-search-grounded Research Assistant Client against every new line of
conversation — would be both far too expensive (a paid, search-grounded
call on every utterance, for the entire length of every recording) and far
too noisy (surfacing something on nearly every exchange). We solve both
with two stages: a **Gate Check** every 2 seconds against just the last 10
seconds of Transcript, using a very cheap, very fast model with no search
grounding, that answers only "is there something here worth researching?"
A **Deep Check** — the existing, more expensive, web-search-grounded
Research Assistant Client — only ever runs when the Gate Check says yes,
and gets a much wider window (the last 10 minutes) so it has real
conversational context to work with. A tick is skipped entirely (not even
the cheap call) when the last 2 seconds had no new lines or fewer than 5
new words, so silence and short filler never cost anything.

Because the Transcript already lives authoritatively server-side (ticket
01), Research Mode runs entirely server-side too — a per-room timer, tied
to the same occupancy lifecycle the Room State Store's grace timer already
uses. A Deep Check's result is filed under the Transcript Tab and
broadcast through the exact same entry mechanism a person's own ask or
Quick Action already uses (ticket 04) — the server just creates and
resolves the entry itself, with no browser round trip and no new
client-side UI. A failed Gate or Deep Check stays silent (logged, retried
next tick) rather than surfacing an error — nobody asked, so nobody's
waiting on an answer to fail.

The per-show restricted-topic rule described alongside Research Mode
(withholding a specific category of fact, with an explicit override) is
deliberately not part of this — it needs its own per-room configuration
mechanism that doesn't exist yet in this app, and is tracked separately as
ticket 07.
