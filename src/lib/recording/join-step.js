/**
 * Join sequence after the display name: the mic step, then the room. The
 * Local Copy needs no choice at join; it is written in this browser's
 * private storage (see local-copy-store.js).
 */

export const JOIN_STEP = {
  mic: 'mic',
  room: 'room',
  unsupported: 'unsupported'
}

// A refresh in a tab that already confirmed its mic goes straight back in.
export function joinStepAfterName({ browserSupported, micConfirmed = false }) {
  if (!browserSupported) return JOIN_STEP.unsupported
  return micConfirmed ? JOIN_STEP.room : JOIN_STEP.mic
}

export function micConfirmedKey(slug) {
  return `pr_mic_confirmed_${slug}`
}

export const MIC_DEVICE_KEY = 'pr_mic_device'

// The mic chosen last time, if this browser still has it; else the first.
export function preferredMicId(devices, savedId) {
  if (savedId && devices.some((d) => d.deviceId === savedId)) return savedId
  return devices[0]?.deviceId ?? ''
}

export function afterMicContinue() {
  return JOIN_STEP.room
}

export function showsMic(step) {
  return step === JOIN_STEP.mic
}
