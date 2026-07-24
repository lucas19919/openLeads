import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { UserRow } from '../db'
import { sessionUser } from '../auth'
import { isProxyAuth, resolveProxyUser } from '../proxyAuth'

// Shared HTTP plumbing for every route module: the request-scoped user variable,
// the session cookie, and the auth gates. Routes import from here so the whole
// API keeps exactly one definition of "logged in" and "admin".

export type Vars = { user: Pick<UserRow, 'id' | 'username' | 'role'> }
export type AppContext = Context<{ Variables: Vars }>

export const COOKIE = 'sid'

// The current identity for a request. In password mode this is the cookie
// session; in proxy mode (AUTH_MODE=proxy) it is the upstream proxy's asserted
// identity, re-read from trusted headers on every request. Both gates below go
// through here so "logged in" has exactly one meaning per mode.
function currentUser(c: AppContext) {
  return isProxyAuth ? resolveProxyUser(c) : sessionUser(getCookie(c, COOKIE))
}

/** Gate: any authenticated user (cookie session, or proxy-asserted identity). */
export async function requireAuth(c: AppContext, next: Next) {
  const user = currentUser(c)
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  c.set('user', user)
  await next()
}

/** Gate: an authenticated user whose role is admin (user mgmt, settings, backups). */
export async function requireAdmin(c: AppContext, next: Next) {
  const user = currentUser(c)
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  if (user.role !== 'admin') return c.json({ error: 'Nur für Administratoren.' }, 403)
  c.set('user', user)
  await next()
}

// X-Forwarded-For is attacker-controlled unless a reverse proxy we run sets it.
// Only trust it when the operator says so (TRUST_PROXY=1, set in the production
// compose file behind nginx); otherwise use the socket's remote address.
const TRUST_PROXY = process.env.TRUST_PROXY === '1'

/** Best-effort client IP for rate limiting and the audit trail. */
export function clientIp(c: Context): string {
  if (TRUST_PROXY) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (fwd) return fwd
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
