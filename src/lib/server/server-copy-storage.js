import { rmSync } from 'fs'
import { resolve, sep } from 'path'

function serverCopyRoot() {
  return resolve(process.env.SERVER_COPY_DIR || './data/server-copies')
}

export function getServerCopyRoomDir(slug) {
  const root = serverCopyRoot()
  const dir = resolve(root, String(slug || ''))
  if (dir !== root && dir.startsWith(root + sep)) return dir
  throw new Error('Invalid room slug for server-copy storage')
}

export function removeServerCopiesForRoom(slug) {
  rmSync(getServerCopyRoomDir(slug), { recursive: true, force: true })
}
