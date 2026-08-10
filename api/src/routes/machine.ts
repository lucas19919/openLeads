import type { Context, Hono } from 'hono'
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
import { listContracts, getContract } from '../contracts'
import { listExpenses, getExpense, expenseSummary } from '../expenses'
import { listRecurring, getRecurring } from '../recurring'
import { listSubscriptions, getSubscription, subscriptionSummary } from '../subscriptions'
import { listCatalog, getCatalogItem } from '../catalog'

// The machine API: stable surface for agents (suite MCP). Pipeline + Stammkunde
// writes stay available; finance is readable in full — contracts, expenses,
// recurring invoices, subscriptions and the service catalog — but strictly
// read-only, so an agent can report on the books and still not issue an
// invoice, finalize a contract or bill anyone. Irreversible money ops and
// every binary (signed PDFs, receipt scans) stay behind human login.

/** Event history returned with a single lead — context, not the full log. */
const RECENT_EVENTS = 50

/** Hard ceiling for ?limit=, so one call cannot pull an unbounded table. */
const MAX_LIMIT = 500

type Ctx = Context<{ Variables: Vars }>

/** An optional numeric query param; undefined when absent or blank. */
function numQuery(v: string | undefined): number | undefined {
  return v != null && v !== '' ? Number(v) : undefined
}

/** Tri-state ?active=1|0 filter; undefined means "no opinion". */
function activeQuery(v: string | undefined): boolean | undefined {
  return v === '1' ? true : v === '0' ? false : undefined
}

/**
 * Body for a list route. Rows stay under `key` exactly as before and `?limit=`
 * is optional, so callers written against the unpaged surface are unaffected;
 * `total` lets a client that does page tell "that's everything" from "there is
 * more". The pipeline is 400+ wide rows, which is a lot of context to hand a
 * model that only wanted the first twenty.
 */
function listBody<T>(
  c: Ctx,
  key: string,
  rows: T[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const offset = Math.max(Math.trunc(Number(c.req.query('offset')) || 0), 0)
  const raw = Math.trunc(Number(c.req.query('limit')))
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : null
  const page = limit == null ? rows.slice(offset) : rows.slice(offset, offset + limit)
  return { [key]: page, total: rows.length, returned: page.length, offset, ...extra }
}

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
    c.json(listBody(c, 'leads', queryLeads(c.req.query('stage'), c.req.query('q')))),
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
    const leadId = numQuery(c.req.query('lead_id'))
    if (leadId != null) {
      const customer = getCustomerByLeadId(leadId)
      return c.json(listBody(c, 'customers', customer ? [customer] : []))
    }
    return c.json(listBody(c, 'customers', listCustomers(c.req.query('active') === '1')))
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
    return c.json(listBody(c, 'documents', listDocuments(kind, numQuery(c.req.query('customer_id')))))
  })

  app.get('/api/machine/documents/:id', requireMachine, (c) => {
    const document = getDocument(Number(c.req.param('id')))
    if (!document) return c.json({ error: 'not found' }, 404)
    return c.json({ document })
  })

  // ── contracts — read-only: no create, finalize, sign or delete ──────────
  // Rows carry `has_signed_doc`; the PDF bytes themselves are not on this
  // surface, matching documents (an agent learns a signed copy exists without
  // being handed it).
  app.get('/api/machine/contracts', requireMachine, (c) =>
    c.json(
      listBody(
        c,
        'contracts',
        listContracts(numQuery(c.req.query('customer_id')), c.req.query('status') || undefined),
      ),
    ),
  )

  app.get('/api/machine/contracts/:id', requireMachine, (c) => {
    const contract = getContract(Number(c.req.param('id')))
    if (!contract) return c.json({ error: 'not found' }, 404)
    return c.json({ contract })
  })

  // ── expenses — the cost side, so an agent can reason about more than revenue
  // `summary` covers the whole filter, not just the returned page.
  app.get('/api/machine/expenses', requireMachine, (c) => {
    const filter = {
      from: c.req.query('from') || undefined,
      to: c.req.query('to') || undefined,
      category: c.req.query('category') || undefined,
      q: c.req.query('q') || undefined,
    }
    return c.json(
      listBody(c, 'expenses', listExpenses(filter), { summary: expenseSummary(filter) }),
    )
  })

  app.get('/api/machine/expenses/:id', requireMachine, (c) => {
    const expense = getExpense(Number(c.req.param('id')))
    if (!expense) return c.json({ error: 'not found' }, 404)
    return c.json({ expense })
  })

  // ── recurring invoices — reading the schedule is fine; running it is not ──
  app.get('/api/machine/recurring', requireMachine, (c) =>
    c.json(
      listBody(
        c,
        'recurring',
        listRecurring({
          customer_id: numQuery(c.req.query('customer_id')),
          contract_id: numQuery(c.req.query('contract_id')),
          active: activeQuery(c.req.query('active')),
        }),
      ),
    ),
  )

  app.get('/api/machine/recurring/:id', requireMachine, (c) => {
    const recurring = getRecurring(Number(c.req.param('id')))
    if (!recurring) return c.json({ error: 'not found' }, 404)
    return c.json({ recurring })
  })

  // ── subscriptions — own running costs, with run-rate + upcoming renewals ──
  app.get('/api/machine/subscriptions', requireMachine, (c) =>
    c.json(
      listBody(c, 'subscriptions', listSubscriptions(c.req.query('active') === '1'), {
        summary: subscriptionSummary(),
      }),
    ),
  )

  app.get('/api/machine/subscriptions/:id', requireMachine, (c) => {
    const subscription = getSubscription(Number(c.req.param('id')))
    if (!subscription) return c.json({ error: 'not found' }, 404)
    return c.json({ subscription })
  })

  // ── service catalog — what the shop sells, so a quote can cite real prices ─
  app.get('/api/machine/catalog', requireMachine, (c) =>
    c.json(listBody(c, 'items', listCatalog(c.req.query('active') === '1'))),
  )

  app.get('/api/machine/catalog/:id', requireMachine, (c) => {
    const item = getCatalogItem(Number(c.req.param('id')))
    if (!item) return c.json({ error: 'not found' }, 404)
    return c.json({ item })
  })

  app.get('/api/machine/dashboard', requireMachine, (c) =>
    c.json({ dashboard: buildDashboard() }),
  )
}
