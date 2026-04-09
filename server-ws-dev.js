/**
 * Dev-only WebSocket server (default port 3001).
 * Vite proxies /ws → ws://localhost:${DEV_WS_PORT}/ws — keep DEV_WS_PORT in sync.
 * Run alongside `vite dev` via `npm run dev`
 */

import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { setupWss } from './src/lib/server/ws-rooms.js'

const port = Number.parseInt(String(process.env.DEV_WS_PORT || ''), 10)
const wsPort = Number.isFinite(port) && port > 0 ? port : 3001

const server = createServer((req, res) => {
  res.writeHead(200)
  res.end('WebSocket dev server')
})

const wss = new WebSocketServer({ server, path: '/ws' })
setupWss(wss)

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(
      `[server-ws-dev] Port ${wsPort} is already in use. Set DEV_WS_PORT in .env to a free port (e.g. 3002), or stop the other process.`
    )
  }
  throw err
})

server.listen(wsPort, () => {
  console.log(`🔌 WS dev server → ws://localhost:${wsPort}/ws`)
})
