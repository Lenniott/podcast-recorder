# Always-on usage table backs the Usage Dashboard, not the Research Eval Log

The Research Eval Log (`research-eval-log.js`) is opt-in (`RESEARCH_EVAL_LOG`,
off by default), file-based, and gitignored — built for prompt-tuning work
during development, not as a durable record. The Usage Dashboard needs
cost/usage figures for every room, always, in production, so it gets its
own always-on `research_usage` table (one row per `askResearchAssistant`
call: room slug, mode, tokens, cost, timestamp) instead of reusing or
widening the Eval Log's scope.

Keeping them separate avoids overloading the Eval Log with a
production-facing responsibility it wasn't designed for (no rotation, no
size bound, full prompt/reply text meant for local debugging) and avoids
making the Usage Dashboard depend on an env flag being set. The two can
disagree in what they record — the Eval Log logs the full raw exchange for
debugging, the usage table logs only what a cost/volume dashboard needs.

Cost per call comes from OpenRouter directly via `usage: { include: true }`
on the request, rather than this app pricing each model itself from a
maintained table — one fewer thing to keep in sync with OpenRouter's own
pricing changes.
