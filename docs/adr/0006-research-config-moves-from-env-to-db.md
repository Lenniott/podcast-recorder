# Research Assistant config moves from env vars to the DB, scoped per setting

`RESEARCH_CUSTOM_PROMPT` and the hardcoded `INTERPRETATION_MODE_PROMPT`
constant are retired in favor of one host-editable **Research Prompt**
row, and `RESEARCH_GUEST_CAN_ASK` is retired in favor of a per-room
**Guest Research Access** column on `rooms`. Both used to require a
deploy (env var + restart, or a code change) to alter; both are now
editable at runtime — the Research Prompt from the Usage Dashboard, Guest
Research Access from the create-room form, once, at creation.

The two settings deliberately land at different scopes rather than both
becoming per-room or both becoming global: the Research Prompt is a
prompt-engineering concern the deployment owner tunes over time and wants
consistent across every show, while Guest Research Access is a per-episode
call the host already makes at creation time for other reasons (episode
name, room code) and has no reason to be deployment-wide.

The Research Prompt also drops the hardcoded Stage 1 (blind read) / Stage
2 (score against Transcript) wrapper text that `research-assistant.js`
used to build around it — the stored value is now the *entire* request,
with `{current_tab}`/`{transcript}` **Placeholders** (see CONTEXT.md) the
host can use however they choose. Whatever staging the two-stage
Analyrical prompt wants now lives in the host's own prompt text, not in
code — so a future prompt with a different shape doesn't need a code
change either.
