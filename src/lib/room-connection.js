/**
 * Browser-room WebSocket client: connect, send, reconnect with backoff,
 * and a resync registry for client-owned flags after every handshake.
 *
 * createSocket is injected so tests can drive a fake; the page will pass
 * `() => new WebSocket(...)`.
 */

const RECONNECT_BASE_MS = 1000
const RECONNECT_CAP_MS = 15000
const WS_CONNECTING = 0
const WS_OPEN = 1

/**
 * Exponential backoff with equal jitter.
 * nextDelay(attempt) = min(cap, base * 2^attempt) * (0.5 + random * 0.5)
 */
export function nextReconnectDelay(attempt) {
  const exp = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt)
  return exp * (0.5 + Math.random() * 0.5)
}

export function createRoomConnection({
  createSocket,
  onOpen,
  onMessage,
  onStatusChange
} = {}) {
  let socket = null
  let status = 'disconnected'
  let attempt = 0
  let reconnectTimer = null
  let closedByUs = false
  const resyncFns = []

  function clearReconnectTimer() {
    if (reconnectTimer == null) return
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  function setStatus(next) {
    status = next
    onStatusChange?.(next)
  }

  function isLive() {
    const rs = socket?.readyState
    return rs === WS_CONNECTING || rs === WS_OPEN || status === 'connecting' || status === 'connected'
  }

  function connect() {
    if (isLive()) return

    closedByUs = false
    clearReconnectTimer()
    setStatus('connecting')
    const sock = createSocket()
    socket = sock

    sock.onopen = () => {
      if (socket !== sock) return
      attempt = 0
      setStatus('connected')
      onOpen?.()
      for (const fn of resyncFns) {
        try { fn() } catch {}
      }
    }

    sock.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      onMessage?.(msg)
    }

    sock.onclose = () => {
      if (socket !== sock) return
      setStatus('disconnected')
      if (closedByUs) return
      const delay = nextReconnectDelay(attempt)
      attempt += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    sock.onerror = () => {
      if (socket !== sock) return
      setStatus('disconnected')
    }
  }

  function send(payload) {
    if (!socket || socket.readyState !== WS_OPEN) return
    socket.send(JSON.stringify(payload))
  }

  function registerResync(fn) {
    resyncFns.push(fn)
  }

  function disconnect() {
    closedByUs = true
    clearReconnectTimer()
    // isLive() partly trusts `status`, and the real WebSocket.close() only
    // updates readyState synchronously (to CLOSING) — its onclose, which is
    // where status normally flips to 'disconnected', fires later, async.
    // Without this, connect() called right after disconnect() would see a
    // stale status still reading 'connected'/'connecting' and silently
    // no-op, leaving nothing to ever reconnect.
    setStatus('disconnected')
    socket?.close?.()
  }

  return { connect, send, registerResync, disconnect }
}
