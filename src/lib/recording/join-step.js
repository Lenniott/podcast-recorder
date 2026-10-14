/**
 * Join-step Local Copy: choose a folder once per room visit, then open a new
 * `-take-N.wav` file in it for every recording attempt. The picker itself
 * must run from the explainer screen's own click (a user gesture);
 * startRecording() only calls openNext() on the already-chosen folder.
 */

export const JOIN_STEP = {
  explainer: 'explainer',
  mic: 'mic',
  room: 'room',
  unsupported: 'unsupported'
}

export const LOCAL_COPY_HEADING = 'Local Copy'

export const LOCAL_COPY_INSURANCE =
  'Your audio is also recorded on this device, as insurance if our end drops out.'

export const LOCAL_COPY_SERVER_COPY =
  'The host normally uses the automatic server copy. You will not normally need to send us this file.'

export const LOCAL_COPY_FOLDER =
  'Pick a folder inside Downloads, or make a new one there.'

function attemptFileName({ participantName, roomName, now = new Date(), attempt }) {
  const safeParticipant = (participantName || 'guest').replace(/[^a-z0-9]/gi, '-').toLowerCase()
  const safeName = String(roomName || 'episode').replace(/[^a-z0-9]/gi, '-').toLowerCase()
  return `${safeParticipant}-${safeName}-${now.toISOString().slice(0, 10)}-take-${attempt}.wav`
}

// createWritable() truncates an existing file, so a take left in the folder
// by an earlier visit must never be reopened.
async function fileExists(directory, name) {
  try {
    await directory.getFileHandle(name)
    return true
  } catch (err) {
    if (err?.name === 'NotFoundError') return false
    throw err
  }
}

export function initialJoinStep() {
  return JOIN_STEP.explainer
}

export function joinStepAfterName({ browserSupported }) {
  return browserSupported ? JOIN_STEP.explainer : JOIN_STEP.unsupported
}

export function afterLocalCopyChoice({ browserSupported, handle }) {
  if (!browserSupported) return JOIN_STEP.unsupported
  if (handle) return JOIN_STEP.mic
  return JOIN_STEP.explainer
}

export function afterMicContinue() {
  return JOIN_STEP.room
}

export function showsExplainer(step) {
  return step === JOIN_STEP.explainer
}

export function showsMic(step) {
  return step === JOIN_STEP.mic
}

export function createLocalCopyPicker({ showDirectoryPicker }) {
  let directory = null
  let attempts = 0

  async function prompt() {
    try {
      directory = await showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' })
      return directory
    } catch (err) {
      if (err?.name === 'AbortError') return null
      throw err
    }
  }

  async function choose() {
    if (directory) return directory
    return prompt()
  }

  async function chooseAgain() {
    directory = null
    attempts = 0
    return prompt()
  }

  async function openNext(options = {}) {
    if (!directory) throw new Error('Local Copy location has not been chosen')
    let name
    do {
      attempts += 1
      name = attemptFileName({ ...options, attempt: attempts })
    } while (await fileExists(directory, name))
    const fileHandle = await directory.getFileHandle(name, { create: true })
    return { attempt: attempts, name, fileHandle }
  }

  return {
    choose,
    chooseAgain,
    openNext
  }
}

export async function openRecordingFile(fileHandle) {
  if (!fileHandle) {
    throw new Error('Local Copy location has not been chosen')
  }
  return fileHandle.createWritable()
}
