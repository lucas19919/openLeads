import { db, ROLES, type UserRow } from './db'
import { hashPassword, destroyUserSessions } from './auth'

// Multi-user account management. Roles are 'admin' (may manage users + settings)
// and 'member' (works the pipeline + invoicing). A single-operator install has
// one admin and never needs this; it exists for teams.

export interface PublicUser {
  id: number
  username: string
  role: string
  created_at: string
}

export function listUsers(): PublicUser[] {
  return db
    .prepare('SELECT id, username, role, created_at FROM users ORDER BY username')
    .all() as unknown as PublicUser[]
}

function countAdmins(): number {
  return Number(
    (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n,
  )
}

function normRole(role: unknown): string {
  return ROLES.includes(role as never) ? (role as string) : 'member'
}

/** Create a user. Throws 'exists' if the username is taken, 'weak' if too short. */
export function createUser(username: string, password: string, role: unknown): PublicUser {
  const name = String(username ?? '').trim()
  if (!name) throw new Error('Benutzername fehlt.')
  if (!password || String(password).length < 8) throw new Error('Passwort zu kurz (min. 8 Zeichen).')
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(name)
  if (existing) throw new Error('Benutzername ist bereits vergeben.')
  const info = db
    .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(name, hashPassword(String(password)), normRole(role))
  return db
    .prepare('SELECT id, username, role, created_at FROM users WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as unknown as PublicUser
}

/**
 * Update a user's role and/or reset their password. Guards the last admin: the
 * final admin cannot be demoted (you'd lock yourself out of administration).
 */
export function updateUser(
  id: number,
  patch: { role?: unknown; password?: string },
): PublicUser | null {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined
  if (!user) return null
  const sets: string[] = []
  const params: Record<string, string | number> = { id }
  if (patch.role !== undefined) {
    const role = normRole(patch.role)
    if (user.role === 'admin' && role !== 'admin' && countAdmins() <= 1) {
      throw new Error('Der letzte Admin kann nicht herabgestuft werden.')
    }
    sets.push('role = @role')
    params.role = role
  }
  if (patch.password !== undefined) {
    if (String(patch.password).length < 8) throw new Error('Passwort zu kurz (min. 8 Zeichen).')
    sets.push('password_hash = @password_hash')
    params.password_hash = hashPassword(String(patch.password))
  }
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run(params)
  // A password reset invalidates every existing login of that user — whoever
  // held the old credential (or a stolen cookie) is signed out immediately.
  if (patch.password !== undefined) destroyUserSessions(id)
  return db
    .prepare('SELECT id, username, role, created_at FROM users WHERE id = ?')
    .get(id) as unknown as PublicUser
}

/** Delete a user. Refuses to remove the last admin. Returns false if not found. */
export function deleteUser(id: number): boolean {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined
  if (!user) return false
  if (user.role === 'admin' && countAdmins() <= 1) {
    throw new Error('Der letzte Admin kann nicht gelöscht werden.')
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id)
  return true
}
