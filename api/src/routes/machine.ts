import type { Hono } from 'hono'
import { db, type LeadRow } from '../db'
import { insertLead, applyLeadUpdate, queryLeads } from '../leads'
import { audit } from '../audit'
import { rateLimit } from '../ratelimit'
import { requireMachine, machinePrincipal } from '../machineAuth'
import { clientIp, type Vars } from './middleware'
import {
  listCustomers,
  getCustomer,
  getCustomerByLeadId,
  createCustomer,
  updateCustomer,
  customerOverview,
} from '../customers'
import { listDocuments, getDocument } from '../documents'
import { buildDashboard } from '../dashboard'

// The machine API: stable surface for agents (suite MCP). Pipeline + Stammkunde
// writes stay available; finance documents are read-only so agents cannot issue
// invoices or finalize contracts. Irreversible money ops stay behind human login.

/** Event history returned with a single lead — context, not the full log. */
const RECENT_EVENTS = 50

export function registerMachineRoutes(app: Hono<{ Variables: Vars }>): void {
  // Throttle the machine surface per client IP. It carries no per-user identity,
  // so without this a leaked token — or a token-guessing loop — runs unbounded.
  // Registered before the routes so it runs ahead of requireMachine and also
  // throttles failed-auth attempts; the data-free health probe stays unlimited.
  const limit = rateLimit({ windowMs: 60_000, max: 120, key: clientIp })
  app.use('/api/machine/*', (c, next) =>
    c.req.path === '/api/machine/health' ? next() : limit(c, next),
  )

  // Liveness/routing probe. Unauthenticated and data-free on purpose, so an
  // operator can verify reachability before the token is provisioned.
  app.get('/api/machine/health', (c) => c.json({ ok: true, service: 'openleads' }))

  // Same query contract as GET /api/leads: ?stage= filters by pipeline stage,
  // ?q= free-text matches company/city/trade/website.
  app.get('/api/machine/leads', requireMachine, (c) =>
    c.json({ leads: queryLeads(c.req.query('stage'), c.req.query('q')) }),
  )

  app.get('/api/machine/leads/:id', requireMachine, (c) => {
    const id = Number(c.req.param('id'))
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as
      | LeadRow
      | undefined
    if (!lead) return c.json({ error: 'not found' }, 404)
    const events = db
      .prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(id, RECENT_EVENTS)
    const customer = getCustomerByLeadId(id)
    return c.json({ lead, events, customer: customer ?? null })
  })

  app.post('/api/machine/leads', requireMachine, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    // Machine-created leads default their source to 'machine' so the pipeline
    // shows where they came from; an explicit source in the body still wins.
    const source = typeof b.source === 'string' && b.source.trim() ? b.source : 'machine'
    const r = insertLead({ ...b, source }, machinePrincipal())
    if (!r.deduped) {
      audit({
        actor: machinePrincipal(), action: 'lead.create', entity: 'lead',
        entityId: r.id, detail: { source }, ip: clientIp(c),
      })
    }
    return r.deduped ? c.json({ deduped: true, id: r.id }) : c.json({ id: r.id }, 201)
  })

  app.patch('/api/machine/leads/:id', requireMachine, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const lead = applyLeadUpdate(id, b, machinePrincipal())
      if (!lead) return c.json({ error: 'not found' }, 404)
      audit({
        actor: machinePrincipal(), action: 'lead.update', entity: 'lead',
        entityId: id, detail: { fields: Object.keys(b) }, ip: clientIp(c),
      })
      return c.json({ lead })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // ── customers (Stammkunden) — create/update ok; delete stays human-only ──
  app.get('/api/machine/customers', requireMachine, (c) => {
    const activeOnly = c.req.query('active') === '1'
    const leadId = c.req.query('lead_id')
    if (leadId != null && leadId !== '') {
      const customer = getCustomerByLeadId(Number(leadId))
      return c.json({ customers: customer ? [customer] : [] })
    }
    return c.json({ customers: listCustomers(activeOnly) })
  })

  // overview before /:id so "overview" is never captured as an id.
  app.get('/api/machine/customers/:id/overview', requireMachine, (c) => {
    const overview = customerOverview(Number(c.req.param('id')))
    if (!overview) return c.json({ error: 'not found' }, 404)
    return c.json({ overview })
  })

  app.get('/api/machine/customers/:id', requireMachine, (c) => {
    const customer = getCustomer(Number(c.req.param('id')))
    if (!customer) return c.json({ error: 'not found' }, 404)
    return c.json({ customer })
  })

  app.post('/api/machine/customers', requireMachine, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const customer = createCustomer(b)
      audit({
        actor: machinePrincipal(), action: 'customer.create', entity: 'customer',
        entityId: customer.id, detail: { name: customer.name }, ip: clientIp(c),
      })
      return c.json({ customer }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.patch('/api/machine/customers/:id', requireMachine, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const customer = updateCustomer(id, b)
      if (!customer) return c.json({ error: 'not found' }, 404)
      audit({
        actor: machinePrincipal(), action: 'customer.update', entity: 'customer',
        entityId: id, detail: { fields: Object.keys(b) }, ip: clientIp(c),
      })
      return c.json({ customer })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // ── documents + dashboard — read-only (no issue / finalise / storno) ─────
  app.get('/api/machine/documents', requireMachine, (c) => {
    const kind = c.req.query('kind') || undefined
    const customer_id = c.req.query('customer_id')
    const cid =
      customer_id != null && customer_id !== '' ? Number(customer_id) : undefined
    return c.json({ documents: listDocuments(kind, cid) })
  })

  app.get('/api/machine/documents/:id', requireMachine, (c) => {
    const document = getDocument(Number(c.req.param('id')))
    if (!document) return c.json({ error: 'not found' }, 404)
    return c.json({ document })
  })

  app.get('/api/machine/dashboard', requireMachine, (c) =>
    c.json({ dashboard: buildDashboard() }),
  )
}
