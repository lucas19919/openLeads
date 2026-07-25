import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// Isolate to a throwaway DB. DB_PATH is read when db.ts is first evaluated, so set
// it before the dynamic import (same pattern as the other suites).
const DB_FILE = join(tmpdir(), `openleads-tokens-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { createApiToken, readApiToken, listApiTokens, revokeApiToken, hashPassword } = await import('./auth')

after(() => {
  try {
    db.close()
  } catch {
    /* ignore */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_FILE + suffix)
    } catch {
      /* ignore */
    }
  }
})

function makeUser(username: string, role = 'admin'): number {
  const info = db
    .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hashPassword('irrelevant-for-token-tests'), role)
  return Number(info.lastInsertRowid)
}

const uid = makeUser('token-owner')

test('a fresh token resolves to its user and scope', () => {
  const { token } = createApiToken(uid, 'CLI', 'write')
  assert.ok(token.startsWith('ol_'))

  const identity = readApiToken(token)
  assert.ok(identity)
  assert.equal(identity.user.id, uid)
  assert.equal(identity.user.username, 'token-owner')
  assert.equal(identity.token.scope, 'write')
  assert.equal(identity.token.name, 'CLI')
})

test('only the hash is stored — the plaintext never touches the database', () => {
  const { token, id } = createApiToken(uid, 'Hash-Probe', 'read')
  const row = db.prepare('SELECT token_hash, prefix FROM api_tokens WHERE id = ?').get(id) as {
    token_hash: string
    prefix: string
  }
  assert.notEqual(row.token_hash, token)
  assert.equal(row.token_hash.length, 64) // sha256 hex
  // The prefix is short enough to be useless on its own but long enough to identify the row.
  assert.ok(token.startsWith(row.prefix))
  assert.ok(row.prefix.length < token.length / 2)
})

test('unknown, malformed and non-prefixed tokens resolve to null', () => {
  assert.equal(readApiToken(undefined), null)
  assert.equal(readApiToken(''), null)
  assert.equal(readApiToken('ol_definitely-not-a-real-token'), null)
  // A session cookie value must not be usable as an API token.
  assert.equal(readApiToken('some-session-cookie-value'), null)
})

test('an expired token stops resolving', () => {
  const past = new Date(Date.now() - 1000).toISOString()
  const { token } = createApiToken(uid, 'Abgelaufen', 'write', past)
  assert.equal(readApiToken(token), null)

  const future = new Date(Date.now() + 60_000).toISOString()
  const { token: live } = createApiToken(uid, 'Läuft noch', 'write', future)
  assert.ok(readApiToken(live))
})

test('using a token records last_used_at', () => {
  const { token, id } = createApiToken(uid, 'Zuletzt', 'read')
  const lastUsed = () =>
    (db.prepare('SELECT last_used_at FROM api_tokens WHERE id = ?').get(id) as {
      last_used_at: string | null
    }).last_used_at

  assert.equal(lastUsed(), null)
  readApiToken(token)
  const first = lastUsed()
  assert.ok(first)

  // Rewritten at most once a minute, so a burst of reads does not take a write
  // lock per request. A fresh call inside that window leaves the value alone.
  readApiToken(token)
  assert.equal(lastUsed(), first)

  // Backdated past the window: the next use refreshes it.
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(
    new Date(Date.now() - 5 * 60_000).toISOString(),
    id,
  )
  readApiToken(token)
  assert.notEqual(lastUsed(), null)
  assert.ok(Date.now() - new Date(lastUsed() as string).getTime() < 60_000)
})

test('revoking takes effect immediately, and only for the owner', () => {
  const other = makeUser('someone-else', 'member')
  const { token, id } = createApiToken(uid, 'Widerruf', 'write')
  assert.ok(readApiToken(token))

  // A different user cannot revoke a token that is not theirs.
  assert.equal(revokeApiToken(other, id), false)
  assert.ok(readApiToken(token))

  assert.equal(revokeApiToken(uid, id), true)
  assert.equal(readApiToken(token), null)
  // Revoking twice is a no-op, not an error.
  assert.equal(revokeApiToken(uid, id), false)
})

test('listing returns the owner’s tokens without anything replayable', () => {
  const scoped = makeUser('list-owner')
  createApiToken(scoped, 'Erstes', 'read')
  createApiToken(scoped, 'Zweites', 'write')

  const tokens = listApiTokens(scoped)
  assert.equal(tokens.length, 2)
  for (const t of tokens) {
    assert.ok(t.name)
    assert.ok(t.prefix.startsWith('ol_'))
    assert.equal('token_hash' in t, false)
    assert.equal('user_id' in t, false)
  }
  // Other users' tokens are not visible.
  assert.ok(listApiTokens(scoped).every((t) => t.name !== 'CLI'))
})

test('deleting a user cascades their tokens away', () => {
  const doomed = makeUser('doomed')
  const { token } = createApiToken(doomed, 'Erbe', 'write')
  assert.ok(readApiToken(token))

  db.prepare('DELETE FROM users WHERE id = ?').run(doomed)
  assert.equal(readApiToken(token), null)
})
