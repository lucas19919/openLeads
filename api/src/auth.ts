import './env'
import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHash,
} from 'node:crypto'
import { db } from './db'

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

/** Resolve a cookie token to its session, or null if unknown/expired. */
export function readSession(token: string | undefined): { uid: number } | null {
  if (!token) return null
  const row = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash(token)) as unknown as { user_id: number; expires_at: string } | undefined
  if (!row) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) return null
  return { uid: row.user_id }
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
