/**
 * Production server — SvelteKit handler + WebSocket on the same port.
 * Run after `npm run build`: node server.js
 */

import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { handler } from './build/handler.js'
import { setupWss } from './src/lib/server/ws-rooms.js'

const PORT = process.env.PORT || 3000
const HOST = process.env.HOST || '0.0.0.0'

// ── Startup env diagnostics (values hidden, just presence) ──────────────────
console.log('[server] starting up')
console.log('[server] NODE_ENV   =', process.env.NODE_ENV)
console.log('[server] PORT       =', PORT)
console.log('[server] HOST       =', HOST)
console.log('[server] DB_PATH    =', process.env.DB_PATH)
console.log('[server] SECRET     =', process.env.SECRET     ? '✓ set' : '✗ MISSING')
console.log('[server] SITE_PASS  =', process.env.SITE_PASSWORD ? '✓ set' : '✗ not set (open access)')

const server = createServer(handler)
const wss = new WebSocketServer({ server, path: '/ws' })

setupWss(wss)

server.listen(PORT, HOST, () => {
  console.log(`[server] 🎙️  listening on http://${HOST}:${PORT}`)
})
