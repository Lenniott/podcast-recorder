import { describe, it, expect, vi } from 'vitest'
import { appendResearchEvalLog, isResearchEvalLogEnabled, researchEvalLogPath } from '../../src/lib/server/research-eval-log.js'

describe('research eval log flag', () => {
  it('is off unless RESEARCH_EVAL_LOG is 1/true/yes', () => {
    expect(isResearchEvalLogEnabled({})).toBe(false)
    expect(isResearchEvalLogEnabled({ RESEARCH_EVAL_LOG: '0' })).toBe(false)
    expect(isResearchEvalLogEnabled({ RESEARCH_EVAL_LOG: '1' })).toBe(true)
    expect(isResearchEvalLogEnabled({ RESEARCH_EVAL_LOG: 'true' })).toBe(true)
  })

  it('does not write when the flag is off', async () => {
    const appendFileImpl = vi.fn()
    await appendResearchEvalLog({ mode: 'ask' }, { env: {}, appendFileImpl, mkdirImpl: vi.fn() })
    expect(appendFileImpl).not.toHaveBeenCalled()
  })

  it('appends one JSONL line when enabled', async () => {
    const appendFileImpl = vi.fn().mockResolvedValue()
    const mkdirImpl = vi.fn().mockResolvedValue()
    await appendResearchEvalLog(
      { mode: 'facts' },
      { env: { RESEARCH_EVAL_LOG: '1', RESEARCH_EVAL_LOG_DIR: '/tmp/eval-test' }, appendFileImpl, mkdirImpl }
    )
    expect(mkdirImpl).toHaveBeenCalled()
    expect(appendFileImpl).toHaveBeenCalledTimes(1)
    const line = appendFileImpl.mock.calls[0][1]
    expect(line).toContain('"mode":"facts"')
    expect(researchEvalLogPath({ RESEARCH_EVAL_LOG_DIR: '/tmp/eval-test' })).toBe('/tmp/eval-test/calls.jsonl')
  })
})
