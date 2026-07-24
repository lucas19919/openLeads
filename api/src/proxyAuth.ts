import './env'
import { timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { db, ROLES } from './db'
import type { SessionUser } from './auth'

// --- Reverse-proxy / forward-auth mode --------------------------------------
//
// Optional, off by default. When AUTH_MODE=proxy, OpenLeads stops running its
// own password login and instead trusts an identity asserted by an
// authenticating reverse proxy placed in front of it — e.g. Authelia,
// Authentik, oauth2-proxy, Pomerium, or Cloudflare Access. The proxy
// authenticates the user (SSO, MFA, whatever it does) and forwards the identity
// as request headers; OpenLeads reads those headers, provisions the user on
// first sight, and maps a group to the admin role.
//
// Nothing here is tied to a specific proxy: every header name, the group
// separator, the admin group, and the sign-out URL are configuration, with
// widely-used defaults (the X-Forwarded-* set that oauth2-proxy/Authelia emit).
//
// SECURITY. Trusting request headers is only safe if the app cannot be reached
// except THROUGH the proxy — anything able to talk to the process directly could
// otherwise forge the identity headers. PROXY_AUTH_SHARED_SECRET closes that
// gap: the proxy is configured to send a secret header that OpenLeads verifies
// on every request, so a direct/bypassing caller without it is rejected. It is
// optional but strongly recommended; a warning is logged at boot if it is unset.

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim()
}

export const AUTH_MODE = env('AUTH_MODE', 'password').toLowerCase()
export const isProxyAuth = AUTH_MODE === 'proxy'

const adminGroup = env('PROXY_AUTH_ADMIN_GROUP')

export const proxyAuth = {
  userHeader: env('PROXY_AUTH_USER_HEADER', 'X-Forwarded-User'),
  emailHeader: env('PROXY_AUTH_EMAIL_HEADER', 'X-Forwarded-Email'),
  groupsHeader: env('PROXY_AUTH_GROUPS_HEADER', 'X-Forwarded-Groups'),
  groupsSeparator: env('PROXY_AUTH_GROUPS_SEPARATOR', ','),
  adminGroup,
  secretHeader: env('PROXY_AUTH_SECRET_HEADER', 'X-Proxy-Auth-Secret'),
  sharedSecret: env('PROXY_AUTH_SHARED_SECRET'),
  // Where the SPA sends the user on logout (the proxy/IdP sign-out endpoint).
  // Empty → logout just reloads and the proxy re-authenticates.
  logoutUrl: env('PROXY_AUTH_LOGOUT_URL'),
  // With no admin group configured we trust the proxy fully (single-tenant): a
  // provisioned user is an admin. With an admin group configured, only its
  // members are admins and everyone else gets the default role.
  defaultRole: env('PROXY_AUTH_DEFAULT_ROLE') || (adminGroup ? 'member' : 'admin'),
}

const DEFAULT_ROLE: string = ROLES.includes(proxyAuth.defaultRole as never)
  ? proxyAuth.defaultRole
  : 'member'

// Managed users have no usable password — login is disabled in proxy mode and
// this value can never verify (verifyPassword expects a "salt:hash" shape).
const NO_PASSWORD = 'x-proxy-managed-no-password'

// Warn loudly at boot on an unsafe or invalid proxy configuration.
if (isProxyAuth) {
  if (!proxyAuth.userHeader) {
    console.warn('[auth] AUTH_MODE=proxy but PROXY_AUTH_USER_HEADER is empty — no user can be identified.')
  }
  if (!proxyAuth.sharedSecret) {
    console.warn(
      '[auth] AUTH_MODE=proxy without PROXY_AUTH_SHARED_SECRET: identity headers are trusted from ANY ' +
        'caller that can reach this process. Set PROXY_AUTH_SHARED_SECRET, have the proxy send it, and ' +
        'ensure the app is not reachable except through the proxy.',
    )
  }
  if (!ROLES.includes(proxyAuth.defaultRole as never)) {
    console.warn(
      `[auth] PROXY_AUTH_DEFAULT_ROLE="${proxyAuth.defaultRole}" is not a known role (${ROLES.join(', ')}); using "member".`,
    )
  }
}

function secretOk(c: Context): boolean {
  if (!proxyAuth.sharedSecret) return true // not configured → not enforced
  const got = Buffer.from(c.req.header(proxyAuth.secretHeader) ?? '')
  const want = Buffer.from(proxyAuth.sharedSecret)
  return got.length === want.length && timingSafeEqual(got, want)
}

function parseGroups(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(proxyAuth.groupsSeparator)
    .map((g) => g.trim())
    .filter(Boolean)
}

function roleFor(groups: string[]): string {
  if (proxyAuth.adminGroup && groups.includes(proxyAuth.adminGroup)) return 'admin'
  return DEFAULT_ROLE
}

/**
 * Provision-or-sync a proxy-authenticated user and return their public row. The
 * upstream identity provider is authoritative: the user is created on first
 * sight, and their role is re-synced from group membership whenever it changes
 * (so removing someone from the admin group demotes them on their next request).
 */
export function upsertProxyUser(username: string, role: string): SessionUser {
  const existing = db
    .prepare('SELECT id, username, role FROM users WHERE username = ?')
    .get(username) as unknown as SessionUser | undefined
  if (!existing) {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, NO_PASSWORD, role)
    return { id: Number(info.lastInsertRowid), username, role }
  }
  if (existing.role !== role) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, existing.id)
    return { ...existing, role }
  }
  return existing
}

/**
 * Resolve the request's proxy-asserted identity to a user, or null if the shared
 * secret is missing/wrong or no username header is present. Called by the auth
 * gates when AUTH_MODE=proxy — there is no cookie or server session in this mode;
 * the proxy owns the session and the identity is re-read on every request.
 */
export function resolveProxyUser(c: Context): SessionUser | null {
  if (!secretOk(c)) return null
  const username = c.req.header(proxyAuth.userHeader)?.trim()
  if (!username) return null
  const groups = parseGroups(proxyAuth.groupsHeader ? c.req.header(proxyAuth.groupsHeader) : undefined)
  return upsertProxyUser(username, roleFor(groups))
}
