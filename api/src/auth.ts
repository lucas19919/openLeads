import './env'
import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHash,
} from 'node:crypto'
import { db, type ApiTokenRow, type TokenScope } from './db'

// --- Password hashing (scrypt, no native deps beyond Node's crypto) ---

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, salt, expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

// --- Server-side sessions (random bearer token, only its hash is stored) ---
//
// The cookie carries a 256-bit random token; the DB stores SHA-256(token). That
// gives real revocation semantics the old stateless HMAC cookie couldn't:
// logout deletes the row, a password reset revokes every session of that user,
// and deleting a user cascades their sessions away. A leaked database or backup
// contains only hashes, which cannot be replayed as a login. No signing secret
// is involved, so SESSION_SECRET is no longer required at all.

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
export const SESSION_TTL_S = SESSION_TTL_MS / 1000

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Create a session for the user and return the bearer token for the cookie. */
export function createSession(uid: number): string {
  sweepExpiredSessions()
  const token = randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    tokenHash(token),
    uid,
    expires,
  )
  return token
}

export interface SessionUser {
  id: number
  username: string
  role: string
}

/** Resolve a cookie token straight to its (public) user row in one query. */
export function sessionUser(token: string | undefined): SessionUser | null {
  if (!token) return null
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(tokenHash(token)) as unknown as (SessionUser & { expires_at: string }) | undefined
  if (!row) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) return null
  return { id: row.id, username: row.username, role: row.role }
}

/** Revoke a single session (logout). Unknown tokens are a no-op. */
export function destroySession(token: string | undefined): void {
  if (!token) return
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token))
}

/** Revoke every session of a user — called on password reset. */
export function destroyUserSessions(uid: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid)
}

/** Drop expired rows so the table can't grow unbounded. Called on login. */
export function sweepExpiredSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString())
}

// --- API tokens (headless callers: CLI, MCP server, cron) --------------------
//
// Same shape as a session — a random secret whose SHA-256 is all the DB keeps —
// but named, long-lived, and optionally read-only. A browser never sends one:
// they travel as `Authorization: Bearer`, so they carry no ambient authority and
// need no CSRF protection. The `ol_` prefix makes them greppable in leaked logs
// and lets secret scanners recognise them.

export const TOKEN_PREFIX = 'ol_'

export interface ApiTokenIdentity {
  user: SessionUser
  token: { id: number; name: string; scope: TokenScope }
}

/** Mint a token for the user. The plaintext is returned once and never stored. */
export function createApiToken(
  uid: number,
  name: string,
  scope: TokenScope = 'write',
  expiresAt: string | null = null,
): { id: number; token: string; prefix: string } {
  const secret = randomBytes(32).toString('base64url')
  const token = `${TOKEN_PREFIX}${secret}`
  // Enough to tell two rows apart in the UI, far too little to guess the rest.
  const prefix = token.slice(0, TOKEN_PREFIX.length + 6)
  const info = db
    .prepare(
      'INSERT INTO api_tokens (name, token_hash, prefix, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(name, tokenHash(token), prefix, uid, scope, expiresAt)
  return { id: Number(info.lastInsertRowid), token, prefix }
}

// last_used_at only has to answer "is this token still in use?", so it is
// written at most once a minute. Otherwise every authenticated read would take
// a write lock — and a busy MCP session or cron run is nearly all reads.
const LAST_USED_RESOLUTION_MS = 60_000

/**
 * Resolve a bearer token to its user + scope, or null if unknown/expired.
 * Touches last_used_at so a stale token is visible as such in the UI.
 */
export function readApiToken(token: string | undefined): ApiTokenIdentity | null {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null
  const row = db
    .prepare(
      `SELECT t.id, t.name, t.scope, t.expires_at, t.last_used_at,
              u.id AS user_id, u.username, u.role
         FROM api_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?`,
    )
    .get(tokenHash(token)) as unknown as
    | {
        id: number
        name: string
        scope: TokenScope
        expires_at: string | null
        last_used_at: string | null
        user_id: number
        username: string
        role: string
      }
    | undefined
  if (!row) return null
  const now = Date.now()
  if (row.expires_at && new Date(row.expires_at).getTime() <= now) return null
  const lastUsed = row.last_used_at ? new Date(row.last_used_at).getTime() : 0
  if (now - lastUsed >= LAST_USED_RESOLUTION_MS) {
    db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(
      new Date(now).toISOString(),
      row.id,
    )
  }
  return {
    user: { id: row.user_id, username: row.username, role: row.role },
    token: { id: row.id, name: row.name, scope: row.scope },
  }
}

export type PublicApiToken = Omit<ApiTokenRow, 'token_hash' | 'user_id'>

/** Tokens belonging to one user — never the hash, never a replayable secret. */
export function listApiTokens(uid: number): PublicApiToken[] {
  return db
    .prepare(
      `SELECT id, name, prefix, scope, created_at, last_used_at, expires_at
         FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(uid) as unknown as PublicApiToken[]
}

/** Revoke one of the user's tokens. Returns false if it isn't theirs. */
export function revokeApiToken(uid: number, id: number): boolean {
  const info = db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, uid)
  return info.changes > 0
}
