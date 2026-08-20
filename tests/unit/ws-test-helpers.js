/**
 * Shared WebSocket-room test doubles, used by both ws-rooms.test.js and
 * ws-tabs.test.js so the two suites don't hand-roll their own copies of
 * the same mock ws/wss.
 */

export function mockWs() {
  const ws = {
    readyState: 1,  // OPEN
    sent: [],
    closed: false,
    closeCode: null,
    handlers: {},
    send(data) { this.sent.push(JSON.parse(data)) },
    close(code, reason) { this.closed = true; this.closeCode = code },
    on(event, fn) { this.handlers[event] = fn },
    emit(event, ...args) { this.handlers[event]?.(...args) }
  }
  return ws
}

export function mockWss() {
  const handlers = {}
  return {
    on(event, fn) { handlers[event] = fn },
    connect(ws, slug, { asHost = false } = {}) {
      const headers = asHost ? { cookie: `pr_host_${slug}=valid-host-token` } : {}
      const req = { url: `/ws?slug=${slug}`, headers }
      handlers.connection?.(ws, req)
    }
  }
}

export function join(ws, name = 'Host', clientId = 'client-1') {
  ws.emit('message', JSON.stringify({ type: 'join', name, clientId }))
}
