import base from './vitest.config.js'

// Keep static mutations focused on this subsystem rather than rerunning unrelated
// authentication and research suites. These include its server-route integration tests.
export default {
  ...base,
  test: {
    ...base.test,
    include: process.env.MUTATION_MODULE === 'recorder-processor'
      ? ['tests/unit/recorder-processor.test.js'] : [
      'tests/unit/audio-*.test.js',
      'tests/unit/capture-writer.test.js',
      'tests/unit/clock-sync.test.js',
      'tests/unit/exit-guard.test.js',
      'tests/unit/level-meter.test.js',
      'tests/unit/meter.test.js',
      'tests/unit/microphones.test.js',
      'tests/unit/recorder-processor.test.js',
      'tests/unit/recording-*.test.js',
      'tests/unit/room-connection.test.js',
      'tests/unit/server-copy-*.test.js',
      'tests/unit/waveform-renderer.test.js',
      'tests/unit/written-audio-ring.test.js'
    ]
  }
}
