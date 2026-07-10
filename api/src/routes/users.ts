import type { Hono } from 'hono'
import { listUsers, createUser, updateUser, deleteUser } from '../users'
import { audit } from '../audit'
import { requireAuth, requireAdmin, type Vars } from './middleware'

export function registerUserRoutes(app: Hono<{ Variables: Vars }>): void {
  // Any signed-in user may read the roster (for the lead-assignment dropdown).
  app.get('/api/users', requireAuth, (c) => c.json({ users: listUsers() }))

  app.post('/api/users', requireAdmin, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const user = createUser(String(b.username ?? ''), String(b.password ?? ''), b.role)
      audit({ actor: c.get('user').username, action: 'user.create', entity: 'user', entityId: user.id, detail: { username: user.username, role: user.role } })
      return c.json({ user }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.patch('/api/users/:id', requireAdmin, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const user = updateUser(id, {
        role: b.role,
        password: typeof b.password === 'string' && b.password ? b.password : undefined,
      })
      if (!user) return c.json({ error: 'not found' }, 404)
      audit({ actor: c.get('user').username, action: 'user.update', entity: 'user', entityId: id, detail: { role: user.role, password_reset: typeof b.password === 'string' && !!b.password } })
      return c.json({ user })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.delete('/api/users/:id', requireAdmin, (c) => {
    const id = Number(c.req.param('id'))
    if (id === c.get('user').id) return c.json({ error: 'Das eigene Konto kann nicht gelöscht werden.' }, 400)
    try {
      if (!deleteUser(id)) return c.json({ error: 'not found' }, 404)
      audit({ actor: c.get('user').username, action: 'user.delete', entity: 'user', entityId: id })
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
}
