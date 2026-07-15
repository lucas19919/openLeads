import type { Hono } from 'hono'
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  customerOverview,
} from '../customers'
import { audit } from '../audit'
import { requireAuth, type Vars } from './middleware'

export function registerCustomerRoutes(app: Hono<{ Variables: Vars }>): void {
  app.get('/api/customers', requireAuth, (c) => {
    const activeOnly = c.req.query('active') === '1'
    return c.json({ customers: listCustomers(activeOnly) })
  })

  // Overview must be registered before /:id so "overview" is not captured as an id.
  app.get('/api/customers/:id/overview', requireAuth, (c) => {
    const overview = customerOverview(Number(c.req.param('id')))
    if (!overview) return c.json({ error: 'not found' }, 404)
    return c.json({ overview })
  })

  app.get('/api/customers/:id', requireAuth, (c) => {
    const customer = getCustomer(Number(c.req.param('id')))
    if (!customer) return c.json({ error: 'not found' }, 404)
    return c.json({ customer })
  })

  app.post('/api/customers', requireAuth, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const customer = createCustomer(b)
      audit({ actor: c.get('user').username, action: 'customer.create', entity: 'customer', entityId: customer.id, detail: { name: customer.name } })
      return c.json({ customer }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.patch('/api/customers/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const customer = updateCustomer(id, b)
      if (!customer) return c.json({ error: 'not found' }, 404)
      audit({ actor: c.get('user').username, action: 'customer.update', entity: 'customer', entityId: id, detail: { fields: Object.keys(b) } })
      return c.json({ customer })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.delete('/api/customers/:id', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    if (!getCustomer(id)) return c.json({ error: 'not found' }, 404)
    deleteCustomer(id)
    audit({ actor: c.get('user').username, action: 'customer.delete', entity: 'customer', entityId: id })
    return c.json({ ok: true })
  })
}
