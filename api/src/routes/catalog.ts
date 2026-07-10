import type { Hono } from 'hono'
import {
  listCatalog,
  getCatalogItem,
  createCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
} from '../catalog'
import { audit } from '../audit'
import { requireAuth, type Vars } from './middleware'

export function registerCatalogRoutes(app: Hono<{ Variables: Vars }>): void {
  app.get('/api/catalog', requireAuth, (c) => {
    const activeOnly = c.req.query('active') === '1'
    return c.json({ items: listCatalog(activeOnly) })
  })

  app.post('/api/catalog', requireAuth, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const item = createCatalogItem(b)
      audit({ actor: c.get('user').username, action: 'catalog.create', entity: 'catalog', entityId: item.id, detail: { name: item.name, unit_price_cents: item.unit_price_cents } })
      return c.json({ item }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.patch('/api/catalog/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const item = updateCatalogItem(id, b)
      if (!item) return c.json({ error: 'not found' }, 404)
      audit({ actor: c.get('user').username, action: 'catalog.update', entity: 'catalog', entityId: id, detail: { fields: Object.keys(b) } })
      return c.json({ item })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.delete('/api/catalog/:id', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    if (!getCatalogItem(id)) return c.json({ error: 'not found' }, 404)
    deleteCatalogItem(id)
    audit({ actor: c.get('user').username, action: 'catalog.delete', entity: 'catalog', entityId: id })
    return c.json({ ok: true })
  })
}
