import { test, expect } from '@playwright/test'
import { createRoom, joinAsGuest, stubYouTubeApi } from './helpers.js'

test('a socket lock is visible and waits for an explicit retry after unlock', async ({ browser }) => {
  const host = await browser.newPage()
  const guest = await browser.newPage()
  await stubYouTubeApi(host)
  await stubYouTubeApi(guest)
  const password = 'socket-lock'
  const roomUrl = await createRoom(host, { name: `Dash Socket ${Date.now()}`, password })
  const sockets = []
  await guest.routeWebSocket('**/ws?slug=*', socket => {
    sockets.push(socket)
    socket.connectToServer()
  })
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })
  await expect.poll(() => sockets.length).toBe(1)
  await sockets[0].close({ code: 4403, reason: 'Room locked' })
  const alert = guest.getByRole('alert').filter({ hasText: 'This room is locked.' })
  await expect(alert).toContainText('Ask the host to unlock it.')
  // At the maximum initial backoff an automatic reconnect would already
  // have happened. Only the explicit retry should open another socket.
  await guest.waitForTimeout(1500)
  expect(sockets).toHaveLength(1)
  await alert.getByRole('button', { name: 'Try again' }).click()
  await expect.poll(() => sockets.length).toBe(2)
  await expect(alert).toBeHidden()
  await guest.close()
  await host.close()
})
