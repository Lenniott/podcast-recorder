/**
 * Production server — SvelteKit handler + WebSocket on the same port.
 * Run after `npm run build`: node server.js
 */

import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { handler } from './build/handler.js'
import { setupWss } from './src/lib/server/ws-rooms.js'

const PORT = process.env.PORT || 3000

const server = createServer(handler)
const wss = new WebSocketServer({ server, path: '/ws' })

setupWss(wss)

server.listen(PORT, () => {
  console.log(`🎙️  Podcast Recorder running → http://localhost:${PORT}`)
})
