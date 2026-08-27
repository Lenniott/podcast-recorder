/**
 * Serial queue for async functions — runs at most one at a time, queuing
 * the rest so each one waits for every earlier call to finish (whether it
 * resolved or rejected) before it starts.
 *
 * Built for cases where two independent triggers can race to run the same
 * async operation concurrently and each partially "win" — e.g. a loose
 * external mic firing both `track.onended` and a `devicechange` event for
 * the same blip, each reconnecting and wiring its own MediaStreamSource
 * into the audio graph. Left concurrent, both attempts can complete and
 * both stay wired in, mixing two copies of the same mic together. Forcing
 * them through one queue means only one reconnect is ever in flight, and a
 * redundant second attempt just repeats the same work a moment later
 * instead of running alongside the first.
 */
export function createSerialQueue() {
  let tail = Promise.resolve()
  return function run(fn) {
    const result = tail.then(fn, fn)
    tail = result.catch(() => {}) // one failed attempt must never wedge the queue
    return result
  }
}
