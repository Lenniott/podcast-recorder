/** Holds each open Local Copy take as a sync access handle, which only exists
 * in a dedicated worker. Each write lands in the file and is flushed before it
 * is acknowledged, so a crash keeps every acknowledged chunk. */
const handles = new Map()

async function takeDirectory(room) {
  const root = await navigator.storage.getDirectory()
  const base = await root.getDirectoryHandle('local-copy', { create: true })
  return base.getDirectoryHandle(room, { create: true })
}

async function run({ op, room, name, position, bytes }) {
  const key = `${room}/${name}`
  if (op === 'open') {
    const directory = await takeDirectory(room)
    const file = await directory.getFileHandle(name)
    handles.set(key, await file.createSyncAccessHandle())
    return
  }
  const handle = handles.get(key)
  if (!handle) throw new Error(`Local Copy ${name} is not open`)
  if (op === 'write') {
    const view = new Uint8Array(bytes)
    const written = handle.write(view, { at: position })
    if (written !== view.byteLength) throw new Error('Local Copy write was incomplete')
    handle.flush()
  } else if (op === 'close') {
    handles.delete(key)
    handle.flush()
    handle.close()
  } else if (op === 'abort') {
    handles.delete(key)
    handle.close()
  } else {
    throw new Error(`Unknown Local Copy operation: ${op}`)
  }
}

self.onmessage = async ({ data }) => {
  try {
    await run(data)
    self.postMessage({ id: data.id, ok: true })
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, error: { name: error?.name, message: error?.message } })
  }
}
