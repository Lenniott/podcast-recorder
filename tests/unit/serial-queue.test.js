import { describe, it, expect, vi } from 'vitest'
import { createSerialQueue } from '../../src/lib/serial-queue.js'

describe('createSerialQueue', () => {
  it('runs a single call normally and resolves with its value', async () => {
    const run = createSerialQueue()
    const result = await run(async () => 'ok')
    expect(result).toBe('ok')
  })

  it('never overlaps two calls — the second only starts once the first settles', async () => {
    const run = createSerialQueue()
    const events = []
    let activeCount = 0

    function task(name, delayMs) {
      return run(async () => {
        activeCount++
        events.push(`${name}:start`)
        // If the queue let two tasks run concurrently, this would catch
        // activeCount > 1 at some point during either task's body — the
        // exact shape of the mic double-connect bug this queue exists to
        // prevent (two live sources wired in at once).
        expect(activeCount).toBe(1)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        events.push(`${name}:end`)
        activeCount--
      })
    }

    // Kick off two overlapping "reconnect" attempts back-to-back, exactly
    // like track.onended and a devicechange event firing for the same blip.
    const a = task('a', 20)
    const b = task('b', 5)
    await Promise.all([a, b])

    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('a rejected call does not wedge the queue — later calls still run', async () => {
    const run = createSerialQueue()
    const failing = run(async () => { throw new Error('boom') })
    await expect(failing).rejects.toThrow('boom')

    const after = await run(async () => 'still works')
    expect(after).toBe('still works')
  })

  it('queues calls made while an earlier one is still pending', async () => {
    const run = createSerialQueue()
    const order = []
    const first = run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push(1)
    })
    // Queued synchronously, before `first` has resolved.
    const second = run(async () => { order.push(2) })

    await Promise.all([first, second])
    expect(order).toEqual([1, 2])
  })

  it('runs functions in the order they were queued regardless of individual duration', async () => {
    const run = createSerialQueue()
    const order = []
    const fast = run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      order.push('fast')
    })
    const slow = run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      order.push('slow')
    })
    await Promise.all([fast, slow])
    // 'fast' was queued first, so it must run — and fully finish — first,
    // even though its own delay is shorter than the one after it.
    expect(order).toEqual(['fast', 'slow'])
  })
})
