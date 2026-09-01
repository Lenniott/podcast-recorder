# Research Buttons — Testing Findings & Implementation Notes

Summary for the agent builder: prompt-level behavior (format discipline, claim selection, scoring) has been validated across two small models (Claude Haiku, GPT 5.5 light) via manual copy-paste testing. Two real bugs were found and fixed at the prompt level. Two items remain that can't be validated without real tool access and need to be built, not just prompted.

---

## Current state: three buttons, one shared schema

`fact_check`, `define`, `research` — same output schema, same suppression logic. The button just sets `MODE`; everything else is identical. This was a deliberate simplification so a future auto-trigger model only has to pick a mode, not learn three separate formats.

## Final system prompt

```
You are a research assistant. You receive: (1) the last 10 minutes of transcript as your PRIMARY FOCUS, and (2) earlier transcript as GROUNDING ONLY — use it to resolve references but never as the subject of your answer unless the focus window explicitly returns to it.

PRESS_TIME: {timestamp}
FOCUS WINDOW: transcript from PRESS_TIME minus 10 min to PRESS_TIME
MODE: {fact_check | define | research}

Before answering, identify every discrete factual claim in the focus window relevant to the mode. From what remains, select only the single most salient checkable claim (the most recent, or the one most load-bearing to what's being discussed).

Mode-specific selection rules:
- fact_check: select a claim that was actually asserted as fact by a speaker.
- define: select a term, concept, or reference named but not explained.
- research: the question asked IS the claim to resolve. Look up and state the actual answer. Never substitute a meta-claim about what a speaker said, knows, or doesn't know — that is transcription, not research. If you cannot determine the real answer, output nothing rather than answering a different, easier question.

Output exactly these fields, in this order, nothing else:

PROVEN IN TRANSCRIPT: 0-100. How directly this claim has already been confirmed, corrected, or settled earlier in the transcript (grounding included). 0 = never touched on, 100 = already fully resolved on the record.
UBIQUITOUS KNOWLEDGE: 0-100. How well a reasonably informed adult would already know this. 0 = genuinely obscure, 100 = common knowledge.
OUTPUT TYPE: write the mode name you were given above (fact_check, define, or research). Never substitute a different mode, and never leave this as a placeholder — write the actual word.
CONTEXT SUMMARY: max 12 words. The specific claim selected, not the whole sentence.
MAIN TAKEAWAY: max 35 words. One paragraph. Stated as fact. No hedging.
SOURCES: names only, max 2, from: Wikipedia, Reddit. Omit line if unused.

Hard rules:
- No preamble, no restating the question, no closing remarks.
- One paragraph per field.
- If no claim survives selection, output nothing.
```

`{timestamp}` and `{fact_check | define | research}` are placeholder notation for whoever assembles the prompt — **replace both with literal values before sending to the model.** Do not send the curly-brace notation itself (see Bug 2 below).

---

## App-side logic required (not solvable by prompting alone)

### 1. Score-threshold suppression
The model is not asked to self-censor — it always returns full output, and the app decides whether to render it.

```
if PROVEN_IN_TRANSCRIPT > 80 or UBIQUITOUS_KNOWLEDGE > 80:
    do not render
```

Keep this as a tunable client-side constant (currently 80), not baked into the prompt, so the threshold can be adjusted without a prompt change.

### 2. Mode-match verification
Testing showed the model can silently swap `OUTPUT TYPE` to a different mode than requested when it can't fulfil the real request (see Bug 1). The prompt now instructs against this, but **should not be trusted to hold under pressure** — treat as best-effort, not guaranteed. Recommend a hard app-side check:

```
if returned OUTPUT_TYPE != requested MODE:
    discard response, do not render
```

This is the same defensive pattern as the score threshold: don't rely on the model to police itself for something the app can verify directly.

---

## Bugs found during testing (both fixed at prompt level)

**Bug 1 — mode substitution under pressure.** In `research` mode, when the small model (Haiku, no search tool) couldn't answer the actual question, it silently switched to fact-checking an easier meta-claim instead (e.g. "the host doesn't know the answer") rather than the real question, and returned `OUTPUT TYPE: fact_check` despite being asked for `research`. Fixed by adding explicit mode-specific selection rules, including "if you cannot determine the real answer, output nothing rather than answering a different, easier question." Confirmed fixed in re-test, but see app-side check above — this was an instruction-following failure under real pressure, worth a hard backstop rather than trusting the fix alone.

**Bug 2 — placeholder echo.** `OUTPUT TYPE: {mode}` in the original prompt used curly braces both as a "fill this in" placeholder (intended for whoever assembles the prompt) and, one line above, as instructional shorthand for the model itself (`MODE: {fact_check | define | research}`). One model copied the literal `{mode}` text into its output instead of substituting the value. Fixed by rewording the OUTPUT TYPE line in plain language ("write the mode name you were given above... never leave this as a placeholder") and by flagging that `{timestamp}` and the mode menu must be replaced with real values before the prompt is ever sent — not sent as literal template syntax.

---

## Explicitly untested — needs real tool access before trusting

- **`research` mode's actual answers.** Both test models produced plausible-sounding facts (e.g. Union Jack adoption date) with no real web search behind them — `SOURCES: Wikipedia` was asserted, not verified. This is decorative until the model has real retrieval. Format/behavior is validated; factual accuracy is not.
- **`fact_check` on claims the model doesn't already know from training.** Same issue — without search, it can only fact-check things it happens to know.
- **Whatever production model actually ships** (this was tested on Claude Haiku and GPT 5.5 light as stand-ins) — re-confirm mode-matching and placeholder behavior on the real target model, since instruction-following quality varies model to model.

## Open decision, not yet resolved
`MAIN TAKEAWAY` — should it answer strictly the question asked, or is closely-related context acceptable as long as it's within the 35-word cap? GPT 5.5 light volunteered adjacent facts (earlier flag history) beyond the specific question; Haiku stuck to just the asked-for fact. Prompt doesn't currently specify either way — worth a decision before this goes further, since it'll affect consistency across models.