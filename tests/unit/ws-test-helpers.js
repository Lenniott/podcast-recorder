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
    // `authed` defaults to true — nearly every test in this suite is about
    // what happens once inside a room, not about the room-password gate
    // itself, so callers get a valid session cookie for free unless they
    // explicitly opt out (see the "rejects a connection without a valid
    // room session" tests).
    connect(ws, slug, { asHost = false, authed = true } = {}) {
      const cookies = []
      if (authed) cookies.push(`pr_auth_${slug}=valid-session-token`)
      if (asHost) cookies.push(`pr_host_${slug}=valid-host-token`)
      const headers = cookies.length ? { cookie: cookies.join('; ') } : {}
      const req = { url: `/ws?slug=${slug}`, headers }
      handlers.connection?.(ws, req)
    },
    // Escape hatch for a test that needs an exact, non-standard cookie
    // header (e.g. a session token that fails verification rather than one
    // simply absent) — bypasses connect()'s cookie-building above.
    connectWithCookie(ws, slug, cookieHeader) {
      const req = { url: `/ws?slug=${slug}`, headers: { cookie: cookieHeader } }
      handlers.connection?.(ws, req)
    }
  }
}

export function join(ws, name = 'Host', clientId = 'client-1') {
  ws.emit('message', JSON.stringify({ type: 'join', name, clientId }))
}
