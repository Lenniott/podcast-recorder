export async function listMicrophones(mediaDevices = navigator.mediaDevices) {
  return (await mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput')
}

export function watchMicrophoneDisconnect(track, onDisconnect) {
  let fired = false
  const ended = () => { if (!fired) { fired = true; onDisconnect() } }
  track.addEventListener?.('ended', ended)
  if (!track.addEventListener) track.onended = ended
  return () => {
    track.removeEventListener?.('ended', ended)
    if (track.onended === ended) track.onended = null
  }
}

const RAW_INPUT = {
  echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1
}

function releaseStream(stream) {
  stream.getTracks().forEach(track => track.stop())
}

export async function openMicrophone(deviceId, mediaDevices = navigator.mediaDevices, timeoutMs = 3000) {
  let expired = false
  let timer
  // Name the device alone. macOS Chrome captures the system default input when
  // processing is disabled in this same call, so raw-audio constraints are
  // applied only after the requested device is open.
  const opening = mediaDevices.getUserMedia({ audio: {
    deviceId: deviceId ? { exact: deviceId } : undefined
  } }).then(async stream => {
    if (expired) { releaseStream(stream); throw new Error('Microphone opened after timeout') }
    const track = stream.getAudioTracks()[0]
    if (track?.applyConstraints) {
      try { await track.applyConstraints(RAW_INPUT) }
      catch {
        if (expired) { releaseStream(stream); throw new Error('Microphone opened after timeout') }
      }
    }
    if (expired) { releaseStream(stream); throw new Error('Microphone opened after timeout') }
    return stream
  })
  try {
    return await Promise.race([opening, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('Microphone did not open in time')) }, timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

// After the open track ends, try the devices listed after it, then the ones
// before it. Retry the ended device only when it is the only one still listed.
// A live track is never a candidate: a quiet room and a changed device id are
// not reasons to open anything else.
function devicesToOpen(devices, endedId) {
  const index = devices.findIndex(device => device.deviceId === endedId)
  if (index === -1) return devices
  const others = [...devices.slice(index + 1), ...devices.slice(0, index)]
  return others.length ? others : [devices[index]]
}

export function createMicrophoneManager({ list, switchMic, getCurrentId, isConnected }) {
  let switching = null
  let closed = false

  function openNextListed() {
    if (isConnected()) return Promise.resolve(false)
    if (switching) return switching
    switching = (async () => {
      const endedId = getCurrentId()
      for (const device of devicesToOpen(await list(), endedId)) {
        if (closed || isConnected()) return false
        try {
          await switchMic(device.deviceId)
          return true
        } catch (error) {
          if (closed || error?.message === 'Microphone switch was superseded') throw error
        }
      }
      return false
    })().finally(() => { switching = null })
    return switching
  }

  return {
    listMicrophones: list,
    openNextListed,
    close() { closed = true }
  }
}
