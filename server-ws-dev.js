/**
 * Dev-only WebSocket server on port 3001.
 * Vite proxies /ws → ws://localhost:3001/ws
 * Run alongside `vite dev` via `npm run dev`
 */

import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { setupWss } from './src/lib/server/ws-rooms.js'

const server = createServer((req, res) => {
  res.writeHead(200)
  res.end('WebSocket dev server')
})

const wss = new WebSocketServer({ server, path: '/ws' })
setupWss(wss)

server.listen(3001, () => {
  console.log('🔌 WS dev server → ws://localhost:3001/ws')
})
