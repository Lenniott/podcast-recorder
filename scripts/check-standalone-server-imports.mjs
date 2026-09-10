#!/usr/bin/env node
/**
 * Guards against ws-rooms.js (or anything it imports) picking up a
 * SvelteKit/Vite-only virtual module ($env/*, $app/*, and the like).
 * server.js and server-ws-dev.js both load ws-rooms.js directly under
 * plain Node — outside Vite/SvelteKit's module graph entirely — so
 * anything in its import tree that needs Vite to resolve breaks real
 * startup outright with ERR_MODULE_NOT_FOUND.
 *
 * This exact regression happened once (ADR-0008 ticket 05 added
 * ws-rooms.js -> research-assistant.js -> `$env/dynamic/private`,
 * fixed by reading `process.env` directly instead, same pattern
 * auth.js's getSecret() already used) and was invisible to the rest of
 * the test suite, because vitest itself runs everything through Vite,
 * where `$env/dynamic/private` always resolves regardless of whether
 * this bug exists. Only actually starting the server the way a real
 * `npm run dev`/`npm start` does — plain Node, no Vite — catches it.
 */
try {
  await import('../src/lib/server/ws-rooms.js')
  console.log('✓ ws-rooms.js loads under plain Node (no SvelteKit/Vite-only imports in its graph)')
} catch (err) {
  console.error('✗ ws-rooms.js failed to load under plain Node — server.js/server-ws-dev.js would crash on startup:')
  console.error(err)
  process.exit(1)
}
