import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  JOIN_STEP,
  afterMicContinue,
  joinStepAfterName,
  preferredMicId,
  showsMic
} from '../../src/lib/recording/join-step.js'

describe('join sequence', () => {
  it('goes from the display name straight to the mic step', () => {
    const step = joinStepAfterName({ browserSupported: true })
    expect(step).toBe(JOIN_STEP.mic)
    expect(showsMic(step)).toBe(true)
  })

  it('does not reach the mic when the browser cannot keep a Local Copy', () => {
    expect(joinStepAfterName({ browserSupported: false })).toBe(JOIN_STEP.unsupported)
    expect(showsMic(JOIN_STEP.unsupported)).toBe(false)
  })

  it('a refresh in a tab that already confirmed its mic goes straight back into the room', () => {
    expect(joinStepAfterName({ browserSupported: true, micConfirmed: true })).toBe(JOIN_STEP.room)
    expect(joinStepAfterName({ browserSupported: false, micConfirmed: true })).toBe(JOIN_STEP.unsupported)
  })

  it('preselects the mic chosen last time when this browser still has it', () => {
    const devices = [{ deviceId: 'built-in' }, { deviceId: 'usb' }]
    expect(preferredMicId(devices, 'usb')).toBe('usb')
    expect(preferredMicId(devices, 'gone')).toBe('built-in')
    expect(preferredMicId(devices, null)).toBe('built-in')
    expect(preferredMicId([], 'usb')).toBe('')
  })

  it('enters the room only after the mic step', () => {
    expect(afterMicContinue()).toBe(JOIN_STEP.room)
    expect(showsMic(JOIN_STEP.room)).toBe(false)
  })
})

describe('room page recording-start path', () => {
  const pagePath = fileURLToPath(new URL('../../src/routes/rec/[slug]/+page.svelte', import.meta.url))
  const src = readFileSync(pagePath, 'utf8')

  it('opens the next Local Copy attempt from the store, with no file or folder picker anywhere', () => {
    const startAt = src.indexOf('async function startRecording')
    const stopAt = src.indexOf('async function stopRecording')
    expect(startAt).toBeGreaterThan(-1)
    expect(stopAt).toBeGreaterThan(startAt)
    expect(src).not.toContain('showSaveFilePicker')
    expect(src).not.toContain('showDirectoryPicker')
    expect(src.slice(startAt, stopAt)).toContain('localCopy.openNext(')
  })

  it('asks the browser to keep storage from the mic step\'s own click', () => {
    const continueAt = src.indexOf('function continueFromMic')
    const body = src.slice(continueAt, src.indexOf('}', continueAt))
    expect(body).toContain('requestLocalCopyPersistence()')
    expect(body).not.toContain('await')
  })
})
