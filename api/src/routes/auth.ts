import type { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import {
  db,
  STAGES,
  PRIORITIES,
  DOC_KINDS,
  DOC_STATUSES,
  CLIENT_TYPES,
  ROLES,
  RECURRING_CADENCES,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  CONTRACT_TYPES,
  CONTRACT_STATUSES,
  type UserRow,
} from '../db'
import { verifyPassword, createSession, destroySession, SESSION_TTL_S } from '../auth'
import { audit } from '../audit'
import { rateLimit } from '../ratelimit'
import { COOKIE, requireAuth, clientIp, type Vars } from './middleware'
import { isProxyAuth, proxyAuth } from '../proxyAuth'

const isProd = process.env.NODE_ENV === 'production'

export function registerAuthRoutes(app: Hono<{ Variables: Vars }>): void {
  // Throttle password attempts per client IP to blunt credential stuffing /
  // brute force. scrypt already makes each attempt costly; this caps the rate on
  // top. Failed attempts land in the audit trail with the source IP.
  app.post('/api/login', rateLimit({ windowMs: 60_000, max: 10, key: clientIp }), async (c) => {
    // In proxy mode there are no local passwords — the reverse proxy authenticates.
    if (isProxyAuth) return c.json({ error: 'password login is disabled (AUTH_MODE=proxy)' }, 409)
    const { username, password } = await c.req.json().catch(() => ({}))
    if (!username || !password) return c.json({ error: 'missing credentials' }, 400)
    const user = db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username) as unknown as UserRow | undefined
    if (!user || !verifyPassword(password, user.password_hash)) {
      audit({ actor: String(username), action: 'login.failed', ip: clientIp(c) })
      return c.json({ error: 'invalid credentials' }, 401)
    }
    setCookie(c, COOKIE, createSession(user.id), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isProd,
      path: '/',
      maxAge: SESSION_TTL_S,
    })
    audit({ actor: user.username, action: 'login.success', ip: clientIp(c) })
    return c.json({ user: { id: user.id, username: user.username, role: user.role } })
  })

  // Logout revokes the session server-side — the cookie alone is dead afterwards.
  // In proxy mode there is no local session to revoke; we hand the client the
  // proxy/IdP sign-out URL (if configured) so it can end the upstream session too.
  app.post('/api/logout', (c) => {
    if (isProxyAuth) return c.json({ ok: true, logoutUrl: proxyAuth.logoutUrl || null })
    destroySession(getCookie(c, COOKIE))
    deleteCookie(c, COOKIE, { path: '/' })
    return c.json({ ok: true, logoutUrl: null })
  })

  app.get('/api/me', requireAuth, (c) => c.json({ user: c.get('user') }))

  app.get('/api/config', (c) =>
    c.json({
      stages: STAGES,
      priorities: PRIORITIES,
      docKinds: DOC_KINDS,
      docStatuses: DOC_STATUSES,
      clientTypes: CLIENT_TYPES,
      roles: ROLES,
      cadences: RECURRING_CADENCES,
      expenseCategories: EXPENSE_CATEGORIES,
      paymentMethods: PAYMENT_METHODS,
      contractTypes: CONTRACT_TYPES,
      contractStatuses: CONTRACT_STATUSES,
      // How the client should treat auth: 'password' shows the login form;
      // 'proxy' means an upstream proxy authenticates and the form is skipped.
      authMode: isProxyAuth ? 'proxy' : 'password',
      proxyLogoutUrl: isProxyAuth ? proxyAuth.logoutUrl || null : null,
    }),
  )
}
