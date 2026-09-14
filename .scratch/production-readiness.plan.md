---
name: Production readiness — unified AI Cards and Docker
overview: Unify every AI-generated panel result visually, then prove the self-hosted Docker release path starts with the full runtime module graph and receives its Research Assistant configuration.
todos:
  - id: shared-ai-card
    content: Render Ask, panel Custom Prompt, and selection Custom Prompt results through one shared AI Card module while keeping human Comments neutral
    status: completed
  - id: citation-output
    content: Keep citation links in the shared citation UI instead of raw Markdown-like Block text
    status: completed
  - id: docker-runtime
    content: Copy the complete runtime lib graph into the production image and pass documented production environment variables through Compose
    status: completed
  - id: release-gates
    content: Pass unit, standalone import, browser, production build, Docker startup, and HTTP health checks
    status: completed
isProject: false
---

# Production readiness

## 1. Shared AI Card

The feed's visual language follows authorship, not storage:

- Typed **Ask**, panel-only **Custom Prompt**, and selection-based **Custom
  Prompt** results use one shared AI Card module and the same border,
  background, spacing, AI badge, status states, Blocks, citations, and remove
  control.
- The header content varies without changing the shell: Ask shows its typed
  question; a panel Custom Prompt shows its title; a selection Custom Prompt
  shows its frozen quote and optional participant context.
- Human **Comment** Annotations retain the neutral Annotation row.

TDD seam: Playwright observes one Ask, one panel Custom Prompt result, one
selection Custom Prompt Card, and one Comment. The three AI results expose the
same card treatment and AI identity; the Comment does not.

Structured Block text remains plain text. Provider instructions/schema copy
must keep Markdown links and citation URLs out of Block prose because citations
already render through the Card's citation UI.

## 2. Production container

The production image must contain every module reachable from `server.js` and
`src/lib/server/ws-rooms.js`. Copy the complete `src/lib` runtime tree rather
than maintaining an incomplete list of sibling directories that can drift when
imports move.

`docker-compose.yml` must pass through every documented runtime setting needed
by the shipped feature, including `OPENROUTER_API_KEY` and
`OPENROUTER_MODEL`. Optional Research Eval Log configuration must point inside
the persisted `/app/data` volume when enabled.

TDD seam: build the real Docker image, start it with isolated throwaway data
and non-secret test configuration, confirm the server remains running, and
receive HTTP 200 from its health surface. Inspect the effective Compose config
for variable presence without printing secret values.

## 3. Release gates

- `npm test` (includes standalone WebSocket import check).
- Targeted Playwright coverage for Ask, panel Custom Prompts, selection Custom
  Prompts, Comments, deletion, and highlights.
- `npm run build`.
- Research eval harness `--list` smoke check.
- Production Docker image startup and HTTP health check.
- `git diff --check` and a final stale-reference scan.

Pushing `main`, running the production server's `update.sh`, and spending a
real OpenRouter request are external release actions. Report them as the final
ship checklist; perform them only with explicit authorization.
