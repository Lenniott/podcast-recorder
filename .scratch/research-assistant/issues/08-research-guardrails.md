# 08 — Research Mode guardrails: duplication, false claims, no score visibility

**Status:** open, blocking trust in the feature. Filed from a live repro,
not a hypothesis — see the transcript below.

## Repro

Transcript fed in (paraphrased from the live session):

```
Ben: the quick brown fox jumps over the lazy dog
Ben: the quick brown fox jumps over the lazy dog
Ben: so let me get this straight Jack White marries his sister
Ben: and they're in the middle of the divorce when they first release their first album
Ben: oh I see okay now so they weren't sisters brother and sister they were husband wife
      but then to make sure that the public focused on their music they pretended to be
Ben: brother and sister
Ben: I see yeah okay that makes sense
Ben: you know I was thinking about dolly parton and her song jolene right
Ben: apparently the White Stripes did a cover of it
Ben: I was wondering if anyone's done a cover that's ... from the man's perspective
      looking at ... Jolene
```

Two buttons pressed on this same window: **Key facts** and **Fact-check**.

**Key facts** returned:
> The White Stripes covered Dolly Parton's "Jolene." ... reinterpreted the
> song from a unique perspective.

**Fact-check** returned:
> Jack White married Meg White, who he claimed was his sister. ... This
> deception was meant to shift public focus to their music instead of
> their relationship.

## What's wrong, concretely

1. **Both buttons answered the wrong, already-closed claim.** The live,
   still-open ask is the very last line — is there a Jolene cover sung
   from the man's perspective. The Jack/Meg White marriage claim was
   explicitly resolved four lines earlier ("I see yeah okay that makes
   sense"). This is `research-eval.js`'s existing `jolene-male-pov` gold
   case, verbatim — it exists specifically because this failure mode was
   anticipated, and it reproduced anyway.

2. **Duplication across modes.** Key facts and Fact-check are independent
   requests (see `research-card.js`'s `MODE_RULES`), but nothing stops
   them converging on the identical underlying claim when the model's
   "most salient claim" judgment misfires the same way twice. There's no
   per-window "don't repeat what another mode just surfaced" memory —
   arguably out of scope for this ticket, but the duplication here is a
   symptom of #1, not a separate root cause worth solving independently
   yet.

3. **Fabricated fact.** "Reinterpreted the song from a unique perspective"
   is false — the White Stripes' Jolene cover is a straight cover, not
   sung from a different narrative perspective. This is exactly the
   findings doc's flagged, explicitly-untested risk: *"research mode's
   actual answers ... produced plausible-sounding facts with no real web
   search behind them"* — reproduced here even with the web-search plugin
   enabled and citations attached (the citations don't actually support
   the specific claim made; nobody checks that they do).

4. **PROVEN_IN_TRANSCRIPT guard did not catch #1.** The Jack/White claim
   was about as resolved-in-transcript as a claim can be — restated,
   corrected, and explicitly acknowledged by the speaker one line before
   the ask. `shouldSuppress` (`src/lib/research-card.js`) exists
   specifically to catch this via the model's own `PROVEN IN TRANSCRIPT`
   score, but the model didn't score it high enough for the threshold
   (80) to fire — or scored it accurately but selected the wrong claim in
   the first place, which the score field can't fix after the fact.

5. **No visibility into the scores at all.** `PROVEN IN TRANSCRIPT` /
   `UBIQUITOUS KNOWLEDGE` are computed and used for suppression
   (`shouldSuppress` in research-card.js) but never surfaced anywhere a
   human can see them — not in the rendered card, not in logs. Debugging
   #4 above required guessing; there's no way today to see "the model
   said 15/100 proven, threshold is 80" versus "the model never considered
   this claim resolved at all."

## Why the existing guards didn't help here

The two guards shipped in ticket 08's predecessor work
(`shouldSuppress`/`matchesMode` in `research-card.js`) both operate on the
model's own self-reported fields *after* it has already picked a claim.
Neither guard can fix a bad claim *selection* — they can only suppress or
discard a well-selected claim that scores badly. This repro is a selection
failure (picked the wrong, closed claim over the actually-open one), which
is a different failure mode than either guard was built for.

## Directions worth trying (not yet decided — needs your judgment)

- **Log every score, every time**, even when a card renders — not just a
  threshold pass/fail. Cheapest fix, doesn't touch the model contract, and
  turns "which guard should have fired" from a guess into a fact.
- **Surface the scores in a dev/debug affordance** (e.g. a `?debug=1` flag
  in ResearchPanel, or a tooltip) — "0/100 proven, 20/100 ubiquitous" next
  to a card — so a repro like this one is diagnosable from the UI alone,
  not from re-reading raw OpenRouter logs.
- **Tighten claim selection, not just scoring.** The prompt's selection
  step ("select only the single most salient checkable claim") has no
  instruction to weigh recency near PRESS_TIME over earlier material once
  something's been explicitly closed. Consider: explicitly telling the
  model to treat a speaker's own acknowledgment ("that makes sense", "oh I
  see") as closing a claim outright, not just as a data point for the
  PROVEN score.
- **Consider a stronger model.** The findings doc already flagged Haiku /
  GPT-5.5-light as stand-ins, untested on the real target model. This
  repro is a plausible instance of "small model instruction-following
  under a genuinely ambiguous, multi-topic window" — rerunning this exact
  case (`node --env-file=.env scripts/research-eval.js jolene-male-pov`)
  against a stronger model is the cheapest way to learn whether this is a
  prompt problem or a model-capability problem.
- **Citation-claim binding.** Nothing today checks that a citation
  actually supports the specific sentence in MAIN TAKEAWAY. Even a cheap
  heuristic (does the citation's title/URL share meaningful terms with the
  takeaway?) would have flagged #3 as suspicious before it ever rendered.

## Suggested next session's first step

Run `node --env-file=.env scripts/research-eval.js jolene-male-pov` a
handful of times against whatever `OPENROUTER_MODEL` is currently
configured, and eyeball how often it reproduces this exact failure vs.
correctly landing on the open ask. That number decides whether this is
"add a debug view and move on" or "this mode needs a different model
before it ships."
