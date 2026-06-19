import './env'
import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from 'node:crypto'

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

// --- Stateless signed session tokens (HMAC over `uid.exp`) ---

const DEV_SECRET = 'dev-insecure-secret-change-me'
const SECRET = process.env.SESSION_SECRET ?? DEV_SECRET
// Fail closed: a production instance must never run on the known default, or
// session tokens could be forged. In dev we only warn.
if (SECRET === DEV_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET ist nicht gesetzt — Start im Produktivbetrieb mit unsicherem Default verweigert.')
  }
  console.warn('WARN: SESSION_SECRET nicht gesetzt — unsicherer Entwicklungs-Default in Verwendung.')
}
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
export const SESSION_TTL_S = SESSION_TTL_MS / 1000

export function createSession(uid: number): string {
  const exp = Date.now() + SESSION_TTL_MS
  const payload = `${uid}.${exp}`
  const sig = createHmac('sha256', SECRET).update(payload).digest('hex')
  return `${payload}.${sig}`
}

export function readSession(token: string | undefined): { uid: number } | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [uidStr, expStr, sig] = parts
  const payload = `${uidStr}.${expStr}`
  const expected = createHmac('sha256', SECRET).update(payload).digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (Date.now() > Number(expStr)) return null
  return { uid: Number(uidStr) }
}
