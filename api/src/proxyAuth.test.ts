import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// Env must be set BEFORE importing proxyAuth — it reads its config once at load.
const DB_FILE = join(tmpdir(), `openleads-proxyauth-${process.pid}.db`)
process.env.DB_PATH = DB_FILE
process.env.AUTH_MODE = 'proxy'
process.env.PROXY_AUTH_USER_HEADER = 'X-Auth-User'
process.env.PROXY_AUTH_GROUPS_HEADER = 'X-Auth-Groups'
process.env.PROXY_AUTH_ADMIN_GROUP = 'crm-admins'
process.env.PROXY_AUTH_SHARED_SECRET = 'topsecret'
process.env.PROXY_AUTH_SECRET_HEADER = 'X-Proxy-Secret'

const { db } = await import('./db')
const { isProxyAuth, AUTH_MODE, resolveProxyUser } = await import('./proxyAuth')
const { verifyPassword } = await import('./auth')

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

type Headers = Record<string, string>
// Minimal Hono-Context stand-in: only c.req.header(name) is used, case-insensitive.
function ctx(headers: Headers): never {
  const lower: Headers = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
  return { req: { header: (n: string) => lower[n.toLowerCase()] } } as never
}
const SECRET: Headers = { 'X-Proxy-Secret': 'topsecret' }

test('AUTH_MODE=proxy is detected', () => {
  assert.equal(AUTH_MODE, 'proxy')
  assert.equal(isProxyAuth, true)
})

test('rejects a request missing the shared secret', () => {
  assert.equal(resolveProxyUser(ctx({ 'X-Auth-User': 'alice' })), null)
})

test('rejects a request with the wrong shared secret', () => {
  assert.equal(resolveProxyUser(ctx({ ...SECRET, 'X-Proxy-Secret': 'nope', 'X-Auth-User': 'alice' })), null)
})

test('rejects an authenticated-looking request with no user header', () => {
  assert.equal(resolveProxyUser(ctx({ ...SECRET })), null)
})

test('provisions a non-admin user as member and disables password login for them', () => {
  const u = resolveProxyUser(ctx({ ...SECRET, 'X-Auth-User': 'bob' }))
  assert.ok(u)
  assert.equal(u.username, 'bob')
  assert.equal(u.role, 'member')
  const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('bob') as {
    password_hash: string
  }
  assert.equal(verifyPassword('anything', row.password_hash), false)
})

test('provisions a user in the admin group as admin', () => {
  const u = resolveProxyUser(ctx({ ...SECRET, 'X-Auth-User': 'carol', 'X-Auth-Groups': 'staff,crm-admins' }))
  assert.equal(u?.role, 'admin')
})

test('re-syncs role from group membership on a later request', () => {
  const up = resolveProxyUser(ctx({ ...SECRET, 'X-Auth-User': 'dave', 'X-Auth-Groups': 'crm-admins' }))
  assert.equal(up?.role, 'admin')
  const down = resolveProxyUser(ctx({ ...SECRET, 'X-Auth-User': 'dave', 'X-Auth-Groups': 'staff' }))
  assert.equal(down?.role, 'member')
  assert.equal(down?.id, up?.id) // same row, updated in place — not a duplicate
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get('dave') as {
    n: number
  }
  assert.equal(n, 1)
})
