import type { Hono } from 'hono'
import {
  listSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  subscriptionSummary,
} from '../subscriptions'
import { audit } from '../audit'
import { requireAuth, type Vars } from './middleware'

export function registerSubscriptionRoutes(app: Hono<{ Variables: Vars }>): void {
  app.get('/api/subscriptions', requireAuth, (c) => {
    const activeOnly = c.req.query('active') === '1'
    return c.json({ subscriptions: listSubscriptions(activeOnly), summary: subscriptionSummary() })
  })

  app.get('/api/subscriptions/:id', requireAuth, (c) => {
    const sub = getSubscription(Number(c.req.param('id')))
    if (!sub) return c.json({ error: 'not found' }, 404)
    return c.json({ subscription: sub })
  })

  app.post('/api/subscriptions', requireAuth, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const amount = Math.round(Number(b.amount_cents))
    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ error: 'Betrag (Cent) muss positiv sein.' }, 400)
    }
    const sub = createSubscription(
      {
        vendor: (b.vendor as string) ?? null,
        description: (b.description as string) ?? null,
        category: (b.category as string) ?? null,
        amount_cents: amount,
        vat_rate: Number(b.vat_rate ?? 19),
        cadence: (b.cadence as string) ?? null,
        next_renewal: (b.next_renewal as string) ?? null,
        payment_method: (b.payment_method as string) ?? null,
        active: b.active as number | boolean | undefined,
        note: (b.note as string) ?? null,
      },
      c.get('user').username,
    )
    audit({ actor: c.get('user').username, action: 'subscription.create', entity: 'subscription', entityId: sub.id, detail: { vendor: sub.vendor, amount_cents: sub.amount_cents, cadence: sub.cadence } })
    return c.json({ subscription: sub }, 201)
  })

  app.patch('/api/subscriptions/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if ('amount_cents' in b) {
      const amount = Math.round(Number(b.amount_cents))
      if (!Number.isFinite(amount) || amount <= 0) {
        return c.json({ error: 'Betrag (Cent) muss positiv sein.' }, 400)
      }
      b.amount_cents = amount
    }
    const sub = updateSubscription(id, b)
    if (!sub) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'subscription.update', entity: 'subscription', entityId: id, detail: { fields: Object.keys(b) } })
    return c.json({ subscription: sub })
  })

  app.delete('/api/subscriptions/:id', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    if (!deleteSubscription(id)) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'subscription.delete', entity: 'subscription', entityId: id })
    return c.json({ ok: true })
  })
}
