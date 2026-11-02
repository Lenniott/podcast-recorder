import base from './vitest.config.js'

export default {
  ...base,
  test: {
    ...base.test,
    include: [
      'tests/unit/room-table-filter.test.js',
      'tests/unit/room-selection.test.js',
      'tests/unit/guest-join.test.js',
      'tests/unit/dashboard-room-*.test.js',
      'tests/unit/usage-dashboard.test.js',
      'tests/unit/room-connection.test.js',
      'tests/unit/ws-rooms.test.js',
      'tests/unit/home-page.server.test.js',
      'tests/unit/room-page.server.test.js',
      'tests/unit/db.test.js'
    ]
  }
}
