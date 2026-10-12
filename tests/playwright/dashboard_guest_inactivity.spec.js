import { test, expect } from '@playwright/test'
import { closeSync, ftruncateSync, mkdirSync, openSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRoom, joinAsGuest, stubYouTubeApi, unlockIfNeeded } from './helpers.js'

const IDLE_CLIENT_ID = 'idleguest01'
const SHORT_CLIENT_ID = 'shortguest1'
// 601s of 48 kHz 16-bit mono, plus a 44-byte WAV header. Sparse on disk:
// listServerCopyFiles reads the stat size, not the bytes actually written.
const LONG_WAV_BYTES = 44 + 48000 * 2 * 601

function plantServerCopy(slug, clientId, byteSize) {
  const dir = join('./data/server-copies', slug)
  mkdirSync(dir, { recursive: true })
  const fd = openSync(join(dir, `${clientId}.wav`), 'w')
  try {
    writeFileSync(fd, Buffer.alloc(Math.min(44, byteSize)))
    ftruncateSync(fd, byteSize)
  } finally {
    closeSync(fd)
  }
}

test('a long server copy with no last access locks that guest until Unlock', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const name = `Dash Idle ${Date.now()}`
  const password = 'idle-pass'
  const roomUrl = await createRoom(host, {
    name,
    password,
    hostDisplayName: 'Host'
  })
  const slug = new URL(roomUrl).pathname.split('/').filter(Boolean).pop()

  // No guest_room_access row: missing access counts as stale.
  plantServerCopy(slug, IDLE_CLIENT_ID, LONG_WAV_BYTES)

  const guest = await browser.newPage()
  await guest.addInitScript(() => {
    sessionStorage.setItem('pr_clientId', 'idleguest01')
  })
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password, expectLocked: true })
  await expect(guest.getByText('That room is locked for guests. The host can still enter.')).toBeVisible()

  await host.goto('/')
  await unlockIfNeeded(host)
  const row = host.locator('tr', { has: host.getByRole('link', { name, exact: true }) })
  await expect(row.getByText('Guests locked', { exact: true })).toBeVisible()
  await row.getByRole('link', { name, exact: true }).click()
  await expect(host).toHaveURL(new RegExp(`/rec/${slug}$`))

  await host.goto('/')
  await unlockIfNeeded(host)
  await row.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(row.getByText('Open to guests', { exact: true })).toBeVisible()

  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeVisible()

  await guest.close()
  await host.close()
})

test('a short server copy with no last access still lets the guest join', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const name = `Dash Idle Short ${Date.now()}`
  const password = 'idle-pass'
  const roomUrl = await createRoom(host, {
    name,
    password,
    hostDisplayName: 'Host'
  })
  const slug = new URL(roomUrl).pathname.split('/').filter(Boolean).pop()

  plantServerCopy(slug, SHORT_CLIENT_ID, 300)

  const guest = await browser.newPage()
  await guest.addInitScript(() => {
    sessionStorage.setItem('pr_clientId', 'shortguest1')
  })
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeVisible()

  await guest.close()
  await host.close()
})
