/**
 * Append-only Research Eval Log. Written only when RESEARCH_EVAL_LOG is a
 * truthy flag. Rooms still expire — this file is what survives a show.
 * Never throws into the lookup path.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function isResearchEvalLogEnabled(env = process.env) {
  const raw = String(env.RESEARCH_EVAL_LOG || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

export function researchEvalLogPath(env = process.env) {
  const dir = env.RESEARCH_EVAL_LOG_DIR || '.research-eval-logs'
  return join(dir, 'calls.jsonl')
}

export async function appendResearchEvalLog(entry, { env = process.env, appendFileImpl = appendFile, mkdirImpl = mkdir } = {}) {
  if (!isResearchEvalLogEnabled(env)) return
  const path = researchEvalLogPath(env)
  try {
    await mkdirImpl(dirname(path), { recursive: true })
    await appendFileImpl(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    // Logging must never fail a lookup.
  }
}
