import { readFileSync } from 'node:fs'

const base = JSON.parse(readFileSync(new URL('./stryker.config.json', import.meta.url), 'utf8'))

export default {
  ...base,
  vitest: { configFile: 'vitest.dashboard-mutation.config.js', related: true },
  mutate: [
    'src/lib/home/room-table-filter.js',
    'src/lib/home/room-selection.js',
    'src/lib/server/guest-join.js',
    'src/lib/server/dashboard-room-delete.js',
    'src/lib/server/dashboard-room-batch.js',
    'src/lib/server/usage-dashboard.js',
    // The shared admission rule must also stay wired into socket entry.
    'src/lib/server/ws-rooms.js:952:0-961:0',
    'src/lib/server/ws-rooms.js:1003:0-1010:0',
    'src/lib/server/ws-rooms.js:1043:0-1045:0',
    'src/lib/room/room-connection.js',
    'src/routes/+page.server.js',
    // Guest access, unlock, and explicit delete; the rest of db.js belongs
    // to other features. Keep the range aligned when these functions move.
    'src/lib/server/db.js:178:0-222:0'
  ],
  concurrency: 4,
  thresholds: { high: 90, low: 80, break: 80 },
  incremental: false,
  htmlReporter: { fileName: 'reports/mutation/dashboard/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/dashboard/mutation.json' }
}
