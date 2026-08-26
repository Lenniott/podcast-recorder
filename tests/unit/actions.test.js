import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { noAutofill } from '../../src/lib/actions.js'

describe('noAutofill', () => {
  let previousDocument

  beforeEach(() => {
    previousDocument = globalThis.document
    globalThis.document = { activeElement: null }
  })

  afterEach(() => {
    globalThis.document = previousDocument
  })

  function fakeNode() {
    const listeners = []
    return {
      readOnly: false,
      listeners,
      addEventListener(type, fn, options) {
        listeners.push({ type, fn, options })
      },
      removeEventListener(type, fn) {
        const i = listeners.findIndex((l) => l.type === type && l.fn === fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    }
  }

  it('sets readOnly and registers a one-shot focus listener', () => {
    const node = fakeNode()
    noAutofill(node)
    expect(node.readOnly).toBe(true)
    expect(node.listeners).toHaveLength(1)
    expect(node.listeners[0]).toMatchObject({
      type: 'focus',
      options: { once: true }
    })
  })

  it('unlocks on focus', () => {
    const node = fakeNode()
    noAutofill(node)
    node.listeners[0].fn()
    expect(node.readOnly).toBe(false)
  })

  it('unlocks immediately when the node is already focused', () => {
    const node = fakeNode()
    globalThis.document.activeElement = node
    noAutofill(node)
    expect(node.readOnly).toBe(false)
  })

  it('destroy removes the same listener', () => {
    const node = fakeNode()
    const action = noAutofill(node)
    expect(node.listeners).toHaveLength(1)
    action.destroy()
    expect(node.listeners).toHaveLength(0)
  })
})
