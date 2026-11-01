import { readFileSync } from 'node:fs'

const base = JSON.parse(readFileSync(new URL('./stryker.config.json', import.meta.url), 'utf8'))

export const mutationModules = [
  ['room-connection', 'src/lib/room/room-connection.js'],
  ['recording-session', 'src/lib/recording/recording-session.js'],
  ['server-copy-upload', 'src/lib/server-copy/server-copy-upload.js'],
  ['server-copy-session', 'src/lib/server/server-copy-session.js'],
  ['server-copy-storage', 'src/lib/server/server-copy-storage.js'],
  ['recorder-processor', 'static/worklet/recorder-processor.js'],
  ...['audio-engine', 'audio-utils', 'capture-writer', 'clock-sync', 'exit-guard',
    'level-meter', 'meter', 'microphones', 'recording-check', 'recording-check-share',
    'waveform-renderer', 'written-audio-ring'].map(name => [name, `src/lib/recording/${name}.js`]),
  ['server-copy-status', 'src/lib/server-copy/server-copy-status.js']
]
const name = process.env.MUTATION_MODULE ?? mutationModules[0][0]
const selected = mutationModules.find(([module]) => module === name)
if (!selected) throw new Error(`Unknown mutation module: ${name}`)
const reportDir = `reports/mutation/recording/${name}`

export default {
  ...base,
  vitest: { configFile: 'vitest.recording-mutation.config.js', related: name !== 'recorder-processor' },
  mutate: [selected[1]],
  concurrency: 4,
  // The pinned runner reports no coverage map with this Vitest version, so its
  // incremental mode can reuse results even after tests change. Always retest.
  incremental: false,
  htmlReporter: { fileName: `${reportDir}/mutation.html` },
  jsonReporter: { fileName: `${reportDir}/mutation.json` }
}
