import { expect, it, vi } from 'vitest'
import { createMicrophoneManager, watchMicrophoneDisconnect, listMicrophones, openMicrophone } from '../../src/lib/recording/microphones.js'

it('does not open another microphone while the current track is live', async () => {
  const switchMic = vi.fn()
  const manager = createMicrophoneManager({
    list: async () => [{ deviceId: 'other' }],
    switchMic,
    getCurrentId: () => 'stored-id',
    isConnected: () => true
  })
  expect(await manager.openNextListed()).toBe(false)
  expect(switchMic).not.toHaveBeenCalled()
})

it('after the track ends, opens the next listed device', async () => {
  const switchMic = vi.fn(async () => {})
  const manager = createMicrophoneManager({
    list: async () => [{ deviceId: 'ended' }, { deviceId: 'next' }, { deviceId: 'spare' }],
    switchMic,
    getCurrentId: () => 'ended',
    isConnected: () => false
  })
  expect(await manager.openNextListed()).toBe(true)
  expect(switchMic).toHaveBeenCalledExactlyOnceWith('next')
})

it('a failed open after the track ends falls through to the following listed device', async () => {
  const switchMic = vi.fn(async id => { if (id === 'next') throw new Error('open failed') })
  const manager = createMicrophoneManager({
    list: async () => [{ deviceId: 'ended' }, { deviceId: 'next' }, { deviceId: 'spare' }],
    switchMic,
    getCurrentId: () => 'ended',
    isConnected: () => false
  })
  expect(await manager.openNextListed()).toBe(true)
  expect(switchMic.mock.calls.map(call => call[0])).toEqual(['next', 'spare'])
})

it('reopens the only listed device after its track ends', async () => {
  const switchMic = vi.fn(async () => {})
  const manager = createMicrophoneManager({
    list: async () => [{ deviceId: 'only' }],
    switchMic,
    getCurrentId: () => 'only',
    isConnected: () => false
  })
  expect(await manager.openNextListed()).toBe(true)
  expect(switchMic).toHaveBeenCalledExactlyOnceWith('only')
})

it('when the ended id is gone, a failed open of the first listed device falls through to the next', async () => {
  const switchMic = vi.fn(async id => { if (id === 'first') throw new Error('open failed') })
  const manager = createMicrophoneManager({
    list: async () => [{ deviceId: 'first' }, { deviceId: 'second' }],
    switchMic,
    getCurrentId: () => 'unplugged',
    isConnected: () => false
  })
  expect(await manager.openNextListed()).toBe(true)
  expect(switchMic.mock.calls.map(call => call[0])).toEqual(['first', 'second'])
})

it('disconnect detection notifies once and can be detached without switching anything', () => {
  const track = { onended: null }
  const disconnected = vi.fn()
  const detach = watchMicrophoneDisconnect(track, disconnected)
  track.onended()
  track.onended()
  expect(disconnected).toHaveBeenCalledTimes(1)
  detach()
  expect(track.onended).toBe(null)
})

it('opens the chosen microphone instead of the system default when processing is turned off', async () => {
  // macOS Chrome captures the default input (here, the webcam) when processing
  // is disabled in the same getUserMedia call that names the device. Disabling
  // it afterwards keeps the device that was actually opened.
  const mediaDevices = {
    getUserMedia: vi.fn(async constraints => {
      const audio = constraints.audio
      const processingInOpen = ['echoCancellation', 'noiseSuppression', 'autoGainControl']
        .some(key => key in audio)
      const settings = { deviceId: processingInOpen ? 'webcam' : audio.deviceId.exact }
      const track = {
        readyState: 'live',
        stop: vi.fn(),
        getSettings: () => ({ ...settings }),
        applyConstraints: async next => Object.assign(settings, next)
      }
      return { getTracks: () => [track], getAudioTracks: () => [track] }
    })
  }

  const stream = await openMicrophone('yeti', mediaDevices)

  expect(stream.getAudioTracks()[0].getSettings()).toMatchObject({
    deviceId: 'yeti',
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1
  })
})

it('lists audio inputs without attempting to open or qualify them', async () => {
  const mediaDevices = { enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'silent' }, { kind: 'videoinput' }], getUserMedia: vi.fn() }
  expect(await listMicrophones(mediaDevices)).toEqual([{ kind: 'audioinput', deviceId: 'silent' }])
  expect(mediaDevices.getUserMedia).not.toHaveBeenCalled()
})
