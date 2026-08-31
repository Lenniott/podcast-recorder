# Live Transcript Agent — Intent & Architecture

## What this tool is
A tool for recording conversations (podcasts, interviews, panel discussions — any recorded talk) that runs two independent AI features against a live transcript feed:

1. **Research Mode** — a continuous, passive background agent that fact-checks the conversation as it happens.
2. **Custom Prompt Execution** — an on-demand, button-triggered feature that runs a user-supplied prompt against inputs the user chooses to provide (e.g. lyrics, a document, a dataset), independent of the live transcript.

These are two separate features. Research Mode is generic and always running. Custom Prompt Execution is a blank capability — the show/user supplies the prompt and the inputs; the tool just executes it on request. Analyrical (a podcast about interpreting song lyrics) is one example use of this tool, used below to illustrate both features — but neither feature should be built with any subject-specific logic hardcoded in.

---

## Feature 1: Research Mode

**Purpose:** live, low-friction fact-checking. It listens to the transcript and proactively surfaces useful, verifiable facts — nothing else.

**Trigger model:** passive and continuous. It watches the transcript stream in real time. It does not wait for an explicit invocation — it decides for itself when to speak up, based on the filter below.

**When it should surface something (all three must hold):**
- The claim/question is genuinely verifiable (not rhetorical, not filler, not banter).
- Surfacing the real answer adds more value than letting the speakers speculate or move past it.
- It hasn't already surfaced this or a near-duplicate fact recently in the same session.

**Two distinct triggers within that filter:**
- A factual claim is stated incorrectly, or a factual question is asked (directly or in passing) → look it up, correct/answer concisely.
- An obscure-but-real concept, term, work, or event is name-dropped without explanation, and the other participant(s) likely lack context → offer a short, read-aloud-able explainer.

**Hard constraints:**
- No interpretation. No opinion. No thematic analysis. No editorializing on what anything *means*.
- No injecting context outside the two triggers above — it's a fact-checker, not a narrator or co-host.
- Subject-agnostic by design — the base prompt has zero built-in knowledge of what kind of show this is.

**Per-show restricted-topic slot:** the tool should expose a separate, optional field where each show can load its own restricted-topic rule — a rule that tells Research Mode to withhold a specific category of fact even when it would otherwise qualify. This is not baked into the base prompt; it's an injectable, per-show configuration.

*Example (Analyrical):* the show's format depends on host/guest independently interpreting a song's lyrics without knowing the "official" or fan-consensus meaning beforehand. So Analyrical's injected rule tells Research Mode never to surface the song's intended meaning, origin story, or artist's stated intent — even if asked directly — unless an explicit override action is taken (see below). All other facts about the song remain fair game.

**Override mechanism (per-show rules only, not core to Research Mode itself):** a restricted-topic rule should support an explicit, deliberate unlock — e.g. a held button or checked box active at the moment a query is made — that suspends the restriction for that single query only, then automatically re-engages. This should never be satisfiable by a spoken request alone; it needs a real, deliberate UI action, so the restriction can't be leaked by accident.

**Output style:** short, plain, stated as fact where the fact is solid, flagged clearly where uncertain. Never frames things as "you got that wrong" — just supplies the correction.

---

## Feature 2: Custom Prompt Execution

**Purpose:** a generic "run this prompt against these inputs, on demand" capability. The tool provides the execution mechanism (a button, the ability to inject arbitrary text/files as input, and a slot for a custom system prompt); it has no awareness of what the prompt does or what show it belongs to.

**Trigger model:** explicit, one-shot, on demand. Nothing runs until the user presses the button.

**Inputs:** whatever the custom prompt needs — defined per-prompt, not by the tool. This can be a live transcript excerpt, an uploaded document, or nothing beyond static text (e.g. lyrics) — entirely up to what the specific prompt calls for.

**What the tool itself must support (generic, applies to any custom prompt, not just this example):**
- Ability to hold back part of the input from the model until a later stage of the same execution, if the prompt calls for staged/sequential processing.
- Ability to feed the transcript (or a portion of it) into a later stage of the same execution, if the prompt calls for it.

*Example (Analyrical's interpretation prompt):* one custom prompt loaded into this feature runs a two-stage process in a single button-press — first generating an independent reading from lyrics alone (withholding the live transcript from this stage so the AI's own read is genuinely blind to what the host/guest already said), then in a second stage bringing in the transcript to score that reading against a rubric. This is a property of *that specific prompt's* design, not something the tool enforces — the tool just needs to support staged input release within one execution so prompts like this are possible.

---

## Summary of what the agent builder needs to support
| Capability | Feature 1 (Research) | Feature 2 (Custom Prompt) |
|---|---|---|
| Runs continuously vs. on demand | Continuous | On demand (button) |
| Sees live transcript | Yes, always | Only if the specific prompt requests it |
| Subject-specific logic | None (base prompt agnostic) | Entirely defined by the loaded prompt |
| Per-show configuration | Restricted-topic rule (optional, injectable, overridable) | The custom prompt itself + whatever inputs it needs |
| Staged/sequential input release | Not needed | Must be supported, since some prompts (see example) require it |
