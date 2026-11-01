import { expect, it, vi, afterEach } from 'vitest'
import { rankMicrophones, createMicrophoneManager, assessMicrophone, watchMicrophoneDisconnect, listMicrophones, openMicrophone } from '../../src/lib/recording/microphones.js'

it('ranks a mic with measured sound ahead of a listed but silent mic', () => {
  expect(rankMicrophones([
    { deviceId: 'silent', status: 'no-signal' },
    { deviceId: 'working', status: 'signal' },
    { deviceId: 'broken', status: 'unavailable' }
  ], 'silent').map(d => d.deviceId)).toEqual(['working', 'silent', 'broken'])
})

it('switches to the measured working mic instead of the silent auto-selected one', async () => {
  let current = 'silent'
  const switchMic = vi.fn(async id => { current = id })
  const manager = createMicrophoneManager({
    list: async () => [{ deviceId: 'silent' }, { deviceId: 'working' }],
    assess: async device => ({ ...device, status: device.deviceId === 'silent' ? 'no-signal' : 'signal' }),
    switchMic, getCurrentId: () => current, isConnected: () => true
  })
  await manager.assessMicrophones()
  expect(await manager.switchToBestMic()).toBe(true)
  expect(switchMic).toHaveBeenCalledWith('working')
})

it('adding a mic does not constitute a disconnect', () => {
  const manager = createMicrophoneManager({ getCurrentId: () => 'current', isConnected: () => true })
  expect(manager.detectMicDisconnect([{ deviceId: 'current' }, { deviceId: 'new' }])).toBe(false)
  expect(manager.detectMicDisconnect([{ deviceId: 'new' }])).toBe(true)
})


afterEach(() => vi.useRealTimers())

function probeContext() {
  return {
    state: 'running', destination: {},
    createMediaStreamSource: stream => ({ connect: node => { node.sample = stream.sample }, disconnect: vi.fn() }),
    createAnalyser: () => ({ fftSize: 2048, getFloatTimeDomainData(samples) { samples.fill(this.sample) }, connect: vi.fn(), disconnect: vi.fn() }),
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })
  }
}

it('distinguishes an open but silent input from an input with sound and releases probe tracks', async () => {
  vi.useFakeTimers()
  const streams = []
  const mediaDevices = { getUserMedia: vi.fn(async constraints => {
    const track = { readyState: 'live', stop: vi.fn(), applyConstraints: vi.fn(async () => {}), getSettings: () => ({ sampleRate: 48000 }) }
    const stream = { sample: constraints.audio.deviceId.exact === 'silent' ? 0 : 0.1,
      getTracks: () => [track], getAudioTracks: () => [track] }
    streams.push(stream)
    return stream
  }) }
  const check = async deviceId => {
    const promise = assessMicrophone({ deviceId }, { audioContext: probeContext(), mediaDevices, durationMs: 50 })
    await vi.runAllTimersAsync()
    return promise
  }
  expect(await check('silent')).toMatchObject({ status: 'no-signal', rms: 0 })
  expect(await check('working')).toMatchObject({ status: 'signal', settings: { sampleRate: 48000 } })
  expect(streams.every(s => s.getTracks()[0].stop.mock.calls.length === 1)).toBe(true)
})

it('assessing the current microphone never stops its recording track', async () => {
  vi.useFakeTimers()
  const track = { readyState: 'live', stop: vi.fn() }
  const stream = { sample: 0.1, getTracks: () => [track], getAudioTracks: () => [track] }
  const pending = assessMicrophone({ deviceId: 'current' }, { audioContext: probeContext(), stream, durationMs: 50, mediaDevices: {} })
  await vi.runAllTimersAsync()
  expect((await pending).status).toBe('signal')
  expect(track.stop).not.toHaveBeenCalled()
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

it('can explicitly switch to the next candidate while the current microphone is connected', async () => {
  const switchMic = vi.fn(async () => {})
  const manager = createMicrophoneManager({ list: async () => [{ deviceId: 'current' }, { deviceId: 'next' }],
    assess: async device => ({ ...device, status: 'signal' }), switchMic,
    getCurrentId: () => 'current', isConnected: () => true })
  await manager.assessMicrophones()
  await manager.switchToBestMic({ excludeCurrent: true })
  expect(switchMic).toHaveBeenCalledExactlyOnceWith('next')
})
