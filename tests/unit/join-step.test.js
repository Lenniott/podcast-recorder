import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  JOIN_STEP,
  LOCAL_COPY_FOLDER,
  LOCAL_COPY_HEADING,
  LOCAL_COPY_INSURANCE,
  LOCAL_COPY_SERVER_COPY,
  afterLocalCopyChoice,
  afterMicContinue,
  createLocalCopyPicker,
  initialJoinStep,
  joinStepAfterName,
  openRecordingFile,
  showsExplainer,
  showsMic
} from '../../src/lib/recording/join-step.js'

function fakeDirectory() {
  const requested = []
  const files = new Map()
  return {
    requested,
    files,
    async getFileHandle(name, options) {
      requested.push({ name, options })
      if (!files.has(name)) {
        if (!options?.create) {
          throw Object.assign(new Error(`${name} not found`), { name: 'NotFoundError' })
        }
        files.set(name, { name })
      }
      return files.get(name)
    }
  }
}

const HOST_SHOW = {
  participantName: 'Host',
  roomName: 'Show',
  now: new Date('2026-09-30T12:00:00.000Z')
}

describe('createLocalCopyPicker attempts', () => {
  it('refuses to open an attempt before a Local Copy folder was chosen', async () => {
    const directory = fakeDirectory()
    const localCopy = createLocalCopyPicker({ showDirectoryPicker: async () => directory })

    await expect(localCopy.openNext(HOST_SHOW)).rejects.toThrow('Local Copy location has not been chosen')
    expect(directory.requested).toEqual([])
  })

  it('opens take-1 in the chosen folder as the first attempt', async () => {
    const directory = fakeDirectory()
    const localCopy = createLocalCopyPicker({ showDirectoryPicker: async () => directory })
    await localCopy.choose(HOST_SHOW)

    const first = await localCopy.openNext(HOST_SHOW)

    expect(first).toEqual({
      attempt: 1,
      name: 'host-show-2026-09-30-take-1.wav',
      fileHandle: { name: 'host-show-2026-09-30-take-1.wav' }
    })
    expect(directory.requested).toContainEqual({
      name: 'host-show-2026-09-30-take-1.wav',
      options: { create: true }
    })
  })

  it('opens take-2 for the next attempt and never asks for take-1 again', async () => {
    const directory = fakeDirectory()
    const localCopy = createLocalCopyPicker({ showDirectoryPicker: async () => directory })
    await localCopy.choose(HOST_SHOW)
    await localCopy.openNext(HOST_SHOW)
    const afterFirst = directory.requested.length

    const second = await localCopy.openNext(HOST_SHOW)

    expect(second.attempt).toBe(2)
    expect(second.name).toBe('host-show-2026-09-30-take-2.wav')
    const laterNames = directory.requested.slice(afterFirst).map((r) => r.name)
    expect(laterNames).toContain('host-show-2026-09-30-take-2.wav')
    expect(laterNames).not.toContain('host-show-2026-09-30-take-1.wav')
  })

  it('skips a take already in the folder from an earlier visit instead of overwriting it', async () => {
    const directory = fakeDirectory()
    const earlier = { name: 'host-show-2026-09-30-take-1.wav', earlierVisit: true }
    directory.files.set(earlier.name, earlier)
    const localCopy = createLocalCopyPicker({ showDirectoryPicker: async () => directory })
    await localCopy.choose(HOST_SHOW)

    const next = await localCopy.openNext(HOST_SHOW)

    expect(next.name).toBe('host-show-2026-09-30-take-2.wav')
    expect(next.attempt).toBe(2)
    expect(directory.files.get(earlier.name)).toBe(earlier)
    expect(directory.requested).not.toContainEqual({ name: earlier.name, options: { create: true } })
  })

  it('surfaces a folder that can no longer be read instead of opening a file blind', async () => {
    const directory = fakeDirectory()
    directory.getFileHandle = async (name, options) => {
      directory.requested.push({ name, options })
      throw Object.assign(new Error('Permission revoked'), { name: 'NotAllowedError' })
    }
    const localCopy = createLocalCopyPicker({ showDirectoryPicker: async () => directory })
    await localCopy.choose(HOST_SHOW)

    await expect(localCopy.openNext(HOST_SHOW)).rejects.toThrow('Permission revoked')
    expect(directory.requested.filter((r) => r.options?.create)).toEqual([])
  })
})

describe('createLocalCopyPicker', () => {
  it('chooses the Local Copy folder with showDirectoryPicker once per room visit', async () => {
    const directory = fakeDirectory()
    const pickerCalls = []
    const localCopy = createLocalCopyPicker({
      showDirectoryPicker: async (options) => {
        pickerCalls.push(options)
        return directory
      }
    })

    expect(await localCopy.choose(HOST_SHOW)).toBe(directory)
    expect(await localCopy.choose(HOST_SHOW)).toBe(directory)
    // readwrite up front: a guest's synced start has no gesture to grant write later.
    expect(pickerCalls).toEqual([{ mode: 'readwrite', startIn: 'downloads' }])
  })

  it('names attempts guest and episode when names are missing', async () => {
    const directory = fakeDirectory()
    const localCopy = createLocalCopyPicker({ showDirectoryPicker: async () => directory })
    await localCopy.choose()

    const first = await localCopy.openNext({
      participantName: '',
      roomName: '',
      now: new Date('2026-01-02T00:00:00.000Z')
    })

    expect(first.name).toBe('guest-episode-2026-01-02-take-1.wav')
  })

  it('opens the picker again only after chooseAgain', async () => {
    const firstDirectory = fakeDirectory()
    const secondDirectory = fakeDirectory()
    const queue = [firstDirectory, secondDirectory]
    const localCopy = createLocalCopyPicker({
      showDirectoryPicker: async () => queue.shift()
    })

    expect(await localCopy.choose(HOST_SHOW)).toBe(firstDirectory)
    expect(await localCopy.choose(HOST_SHOW)).toBe(firstDirectory)
    expect(await localCopy.chooseAgain(HOST_SHOW)).toBe(secondDirectory)
  })

  it('does not keep a folder when the person cancels the picker', async () => {
    const abort = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })
    const directory = fakeDirectory()
    const calls = [() => Promise.reject(abort), () => Promise.resolve(directory)]
    const localCopy = createLocalCopyPicker({
      showDirectoryPicker: async () => calls.shift()()
    })

    expect(await localCopy.choose(HOST_SHOW)).toBeNull()
    await expect(localCopy.openNext(HOST_SHOW)).rejects.toThrow('Local Copy location has not been chosen')
    expect(await localCopy.choose(HOST_SHOW)).toBe(directory)
  })

  it('surfaces a non-cancel picker failure to the caller', async () => {
    const localCopy = createLocalCopyPicker({
      showDirectoryPicker: async () => {
        throw new Error('Permission denied')
      }
    })
    await expect(localCopy.choose(HOST_SHOW)).rejects.toThrow('Permission denied')
    await expect(localCopy.openNext(HOST_SHOW)).rejects.toThrow('Local Copy location has not been chosen')
  })
})

describe('openRecordingFile', () => {
  it('opens the attempt handle and never calls a picker', async () => {
    globalThis.showSaveFilePicker = async () => {
      throw new Error('showSaveFilePicker must not run from recording start')
    }
    globalThis.showDirectoryPicker = async () => {
      throw new Error('showDirectoryPicker must not run from recording start')
    }
    const writable = { kind: 'writable' }
    const fileHandle = {
      createWritable: async () => writable
    }

    expect(await openRecordingFile(fileHandle)).toBe(writable)
  })

  it('refuses to start writing when no Local Copy location was chosen', async () => {
    await expect(openRecordingFile(null)).rejects.toThrow('Local Copy location has not been chosen')
  })
})

describe('join sequence', () => {
  it('starts on the Local Copy explainer, with the mic step unreachable', () => {
    const step = initialJoinStep()
    expect(step).toBe(JOIN_STEP.explainer)
    expect(showsExplainer(step)).toBe(true)
    expect(showsMic(step)).toBe(false)
    expect(LOCAL_COPY_HEADING).toBe('Local Copy')
    expect(LOCAL_COPY_INSURANCE).toBe(
      'Your audio is also recorded on this device, as insurance if our end drops out.'
    )
    expect(LOCAL_COPY_SERVER_COPY).toBe(
      'The host normally uses the automatic server copy. You will not normally need to send us this file.'
    )
    expect(LOCAL_COPY_FOLDER).toBe(
      'Pick a folder inside Downloads, or make a new one there.'
    )
  })

  it('does not open the mic step until a save location has been chosen', () => {
    expect(afterLocalCopyChoice({ browserSupported: true, handle: null })).toBe(JOIN_STEP.explainer)
    expect(showsMic(JOIN_STEP.explainer)).toBe(false)
    expect(afterLocalCopyChoice({ browserSupported: true, handle: { name: 'a.wav' } })).toBe(JOIN_STEP.mic)
    expect(showsMic(JOIN_STEP.mic)).toBe(true)
    expect(showsExplainer(JOIN_STEP.mic)).toBe(false)
  })

  it('skips the picker and does not reach the mic when the browser cannot save a Local Copy', () => {
    expect(joinStepAfterName({ browserSupported: false })).toBe(JOIN_STEP.unsupported)
    expect(showsMic(JOIN_STEP.unsupported)).toBe(false)
    expect(afterLocalCopyChoice({ browserSupported: false, handle: null })).toBe(JOIN_STEP.unsupported)
    expect(joinStepAfterName({ browserSupported: true })).toBe(JOIN_STEP.explainer)
  })

  it('enters the room only after the mic step', () => {
    expect(afterMicContinue()).toBe(JOIN_STEP.room)
    expect(showsMic(JOIN_STEP.room)).toBe(false)
    expect(showsExplainer(JOIN_STEP.room)).toBe(false)
  })
})

describe('room page recording-start path', () => {
  it('opens the next Local Copy attempt without calling either picker from startRecording', () => {
    const pagePath = fileURLToPath(new URL('../../src/routes/rec/[slug]/+page.svelte', import.meta.url))
    const src = readFileSync(pagePath, 'utf8')
    const startAt = src.indexOf('async function startRecording')
    const stopAt = src.indexOf('async function stopRecording')
    const startRecording = src.slice(startAt, stopAt)
    expect(startAt).toBeGreaterThan(-1)
    expect(stopAt).toBeGreaterThan(startAt)
    expect(startRecording).not.toContain('showSaveFilePicker')
    expect(startRecording).not.toContain('showDirectoryPicker')
    expect(startRecording).toContain('localCopyPicker.openNext(')
  })
})
