import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = (path) => readFileSync(fileURLToPath(new URL(`../../src/${path}`, import.meta.url)), 'utf8')

describe('Research panel layout contract', () => {
  it('renders a single keyed feed rather than separate Annotation and research lists', () => {
    const panel = source('lib/research/ResearchPanel.svelte')
    expect(panel).toContain('data-testid="panel-feed"')
    expect(panel).toContain('{#each feed as row (row.key)}')
    expect(panel).not.toContain('class="annotation-entries"')
    expect(panel).not.toContain('class="research-entries"')
  })

  it('lets long unbroken Block and Annotation content wrap inside the panel', () => {
    const blocks = source('lib/research/BlockList.svelte')
    const panel = source('lib/research/ResearchPanel.svelte')
    expect(blocks.match(/overflow-wrap: anywhere/g)?.length).toBeGreaterThanOrEqual(4)
    expect(blocks).toContain('min-width: 0')
    expect(panel.match(/overflow-wrap: anywhere/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
