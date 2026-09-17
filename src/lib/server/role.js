/**
 * Role resolution (friend-password-auth, ticket 02) — the single source of
 * truth for "what role (if any) does this request/session have": 'host',
 * 'friend', or null. Every gate that used to hand-parse `pr_site_auth`
 * (hooks.server.js's site gate, +page.server.js's load/create/Custom-Prompt
 * actions) calls `resolveRole` instead of re-deriving the answer from raw
 * cookies — see .scratch/friend-password-auth/issues/02-friend-login-ai-off-dashboard-block.md,
 * TDD seam 1.
 */
import { verifyPasswordToken } from './auth.js'

export const SITE_COOKIE = 'pr_site_auth'
export const FRIEND_COOKIE = 'pr_friend_auth'

/**
 * `cookies` needs only a `.get(name)` method — the same minimal shape every
 * other role/session helper in this codebase accepts (SvelteKit's `Cookies`,
 * or a plain `Map`-backed test double).
 *
 * Host takes precedence, and "no SITE_PASSWORD configured" keeps meaning
 * open Host access — the exact policy `verifySiteToken` already had, just
 * moved here so nobody re-derives it. A Friend role is different: an unset
 * `FRIEND_PASSWORD` *disables* the role rather than opening it (see
 * .env.example) — there is no way to become a Friend until an operator
 * opts in by setting one, unlike the Host's historical default-open
 * behaviour which predates Friend and stays unchanged for compatibility.
 */
export function resolveRole(cookies, env = process.env) {
  if (!env.SITE_PASSWORD) return 'host'

  if (verifyPasswordToken('site', env.SITE_PASSWORD, cookies.get(SITE_COOKIE), env.SECRET)) {
    return 'host'
  }

  if (env.FRIEND_PASSWORD &&
      verifyPasswordToken('friend', env.FRIEND_PASSWORD, cookies.get(FRIEND_COOKIE), env.SECRET)) {
    return 'friend'
  }

  return null
}
