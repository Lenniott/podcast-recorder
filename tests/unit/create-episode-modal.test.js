import { describe, expect, it } from 'vitest'
import { shouldOpenCreateEpisodeModal } from '../../src/lib/home/create-episode-modal.js'

describe('shouldOpenCreateEpisodeModal', () => {
  it('stays closed when there is no form payload', () => {
    expect(shouldOpenCreateEpisodeModal(undefined)).toBe(false)
    expect(shouldOpenCreateEpisodeModal(null)).toBe(false)
    expect(shouldOpenCreateEpisodeModal({})).toBe(false)
  })

  it('stays closed for a site-gate failure', () => {
    expect(shouldOpenCreateEpisodeModal({ siteError: 'Not authorised.' })).toBe(false)
  })

  it('opens after a failed create so the error is visible', () => {
    expect(shouldOpenCreateEpisodeModal({ error: 'Episode name is required', name: '' })).toBe(true)
  })
})
