import type { Hono } from 'hono'
import {
  listRecurring,
  getRecurring,
  createRecurring,
  updateRecurring,
  deleteRecurring,
  runRecurring,
  processDueRecurring,
} from '../recurring'
import { audit } from '../audit'
import { requireAuth, type Vars } from './middleware'

export function registerRecurringRoutes(app: Hono<{ Variables: Vars }>): void {
  app.get('/api/recurring', requireAuth, (c) => {
    const customer_id = c.req.query('customer_id')
    const contract_id = c.req.query('contract_id')
    const activeQ = c.req.query('active')
    return c.json({
      recurring: listRecurring({
        customer_id: customer_id != null && customer_id !== '' ? Number(customer_id) : undefined,
        contract_id: contract_id != null && contract_id !== '' ? Number(contract_id) : undefined,
        active: activeQ === '1' ? true : activeQ === '0' ? false : undefined,
      }),
    })
  })

  app.post('/api/recurring', requireAuth, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const r = createRecurring(b)
      audit({ actor: c.get('user').username, action: 'recurring.create', entity: 'recurring', entityId: r.id, detail: { cadence: r.cadence, next_run: r.next_run } })
      return c.json({ recurring: r }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.patch('/api/recurring/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const r = updateRecurring(id, b)
      if (!r) return c.json({ error: 'not found' }, 404)
      return c.json({ recurring: r })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.delete('/api/recurring/:id', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    if (!deleteRecurring(id)) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'recurring.delete', entity: 'recurring', entityId: id })
    return c.json({ ok: true })
  })

  // Generate a draft invoice from a template now (and advance its schedule).
  app.post('/api/recurring/:id/run', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    if (!getRecurring(id)) return c.json({ error: 'not found' }, 404)
    const doc = runRecurring(id)
    if (!doc) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'recurring.run', entity: 'recurring', entityId: id, detail: { document_id: doc.id } })
    return c.json({ document: doc }, 201)
  })

  // Generate drafts for every due template (the scheduler calls the same path).
  app.post('/api/recurring/run-due', requireAuth, (c) => {
    const result = processDueRecurring()
    if (result.generated) {
      audit({ actor: c.get('user').username, action: 'recurring.run_due', detail: result })
    }
    return c.json(result)
  })
}
