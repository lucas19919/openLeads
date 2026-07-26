import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { TokenScope, UserRow } from '../db'
import { sessionUser, readApiToken } from '../auth'

// Shared HTTP plumbing for every route module: the request-scoped user variable,
// the session cookie, and the auth gates. Routes import from here so the whole
// API keeps exactly one definition of "logged in" and "admin".

export type Vars = {
  user: Pick<UserRow, 'id' | 'username' | 'role'>
  /** Set only when the caller authenticated with an API token, not a cookie. */
  token?: { id: number; name: string; scope: TokenScope }
}
export type AppContext = Context<{ Variables: Vars }>

export const COOKIE = 'sid'

/** Requests a read-only token may make: everything that cannot change state. */
const SAFE_METHODS = /^(GET|HEAD)$/

/** Extract the `Authorization: Bearer <token>` value, if the header is present. */
function bearer(c: AppContext): string | undefined {
  const header = c.req.header('authorization')
  if (!header) return undefined
  const [scheme, value] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined
}

/**
 * Resolve the caller: an API token (headless — CLI, MCP, cron) if one is
 * presented, otherwise the browser's session cookie. Two credential kinds, one
 * identity, so every route below sees the same `user` variable either way.
 */
function identify(c: AppContext): Vars | null {
  const raw = bearer(c)
  if (raw) {
    const id = readApiToken(raw)
    return id ? { user: id.user, token: id.token } : null
  }
  const user = sessionUser(getCookie(c, COOKIE))
  return user ? { user } : null
}

/** Gate: any valid credential. Read-only tokens are held to safe methods. */
export async function requireAuth(c: AppContext, next: Next) {
  const id = identify(c)
  if (!id) return c.json({ error: 'unauthorized' }, 401)
  if (id.token?.scope === 'read' && !SAFE_METHODS.test(c.req.method)) {
    return c.json({ error: 'Dieses API-Token darf nur lesen.' }, 403)
  }
  c.set('user', id.user)
  if (id.token) c.set('token', id.token)
  await next()
}

/** Gate: a valid credential whose role is admin (user management, settings, backups). */
export async function requireAdmin(c: AppContext, next: Next) {
  const id = identify(c)
  if (!id) return c.json({ error: 'unauthorized' }, 401)
  if (id.user.role !== 'admin') return c.json({ error: 'Nur für Administratoren.' }, 403)
  if (id.token?.scope === 'read' && !SAFE_METHODS.test(c.req.method)) {
    return c.json({ error: 'Dieses API-Token darf nur lesen.' }, 403)
  }
  c.set('user', id.user)
  if (id.token) c.set('token', id.token)
  await next()
}

/**
 * True for requests that carry no ambient (cookie) authority and therefore need
 * no CSRF origin check: bearer-authenticated calls (a token has to be set
 * deliberately by the caller, so a foreign page cannot make the victim's
 * browser attach one — and the CLI's multipart uploads would otherwise trip the
 * form-content-type check), and the /api/machine/* surface, which never uses
 * cookie auth and must stay reachable for headless clients regardless of
 * content type.
 */
export function csrfExempt(c: Context): boolean {
  if (c.req.path.startsWith('/api/machine/')) return true
  return c.req.header('authorization')?.toLowerCase().startsWith('bearer ') ?? false
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
