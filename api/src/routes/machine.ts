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
import {
  listDocuments,
  getDocument,
  getSettings,
  createDraftDocument,
  patchDocument,
  deleteDraftDocument,
  invoiceFromQuote,
  stornoFromDocument,
  finalizeDraft,
} from '../documents'
import { mailDocument, DocumentMailError } from '../documentMail'
import { validateInvoice } from '../validate'
import {
  ApprovalError,
  requestApproval,
  listApprovals,
  getApproval,
  withdrawApproval,
  requireApproval,
  isApprovalAction,
  ACTION_LABELS,
} from '../approvals'
import { errorStatus } from './helpers'
import { APPROVAL_STATUSES, type ApprovalAction, type ApprovalStatus } from '../db'
import { processDueRecurring } from '../recurring'
import { buildDashboard } from '../dashboard'
import { listLeadLinks, addLeadLink, deleteLeadLink, appendLeadNote } from '../leadLinks'
import { listContracts, getContract } from '../contracts'
import { listExpenses, getExpense, expenseSummary } from '../expenses'
import { listRecurring, getRecurring } from '../recurring'
import { listSubscriptions, getSubscription, subscriptionSummary } from '../subscriptions'
import { listCatalog, getCatalogItem } from '../catalog'
import { listPayments } from '../payments'
import { buildEuer } from '../report'

// The machine API: stable surface for agents (suite MCP). Pipeline + Stammkunde
// writes stay available; finance is readable in full — contracts, expenses,
// recurring invoices, subscriptions, the service catalog, payments and the EÜR
// report.
//
// Since 2026-08 an agent may also *write invoices* — but only the half of
// invoicing that swings back. It drafts an Angebot or a Rechnung, prices it,
// corrects a position, converts an accepted quote, prepares a Storno, and throws
// any of it away again. No number is consumed, nothing leaves the house, and one
// click in the UI undoes any of it.
//
// The other half — Festschreiben (§14 UStG / GoBD: a gapless number is spent and
// the content freezes) and Versenden (a PDF lands in a client's inbox) — needs a
// human to say yes first, per document, in writing: a Freigabe (approvals.ts)
// granted from an interactive login, bound to a fingerprint of exactly the
// content that was shown, single-use and time-boxed. The machine token cannot
// grant its own Freigabe; that is the whole point of the mechanism.
//
// Still human-only, unchanged: booking payments (an accounting act that needs the
// bank statement), writing contracts, deleting anything issued, and every binary
// (signed PDFs, receipt scans).
//
// Reading is wide on purpose: an agent asked what a client costs us and what
// they have paid should not have to answer "open a browser".

/** Event history returned with a single lead — context, not the full log. */
const RECENT_EVENTS = 50

/** Hard ceiling for ?limit=, so one call cannot pull an unbounded table. */
const MAX_LIMIT = 500

/**
 * Document statuses an agent may set. 'entwurf' and the Angebot outcomes are
 * ordinary pipeline bookkeeping a human can flip back. 'bezahlt' and
 * 'storniert' are claims about money and are deliberately absent: they follow
 * from recording a payment or finalising a Storno, both human acts.
 */
const MACHINE_DOC_STATUSES = new Set(['entwurf', 'angenommen', 'abgelehnt'])

/** Approval actions this surface can actually perform once granted. */
const MACHINE_ACTIONS: ApprovalAction[] = ['document.finalize', 'document.send']

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
    return c.json({ lead, events, customer: customer ?? null, links: listLeadLinks(id) })
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

  // ── lead notes (append-only) ────────────────────────────────────────────
  // PATCH ?notes= replaces the note field, so two agents writing notes clobber
  // each other. This appends to the timeline and leaves the field alone.
  app.post('/api/machine/leads/:id/note', requireMachine, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      if (!appendLeadNote(id, b.body, machinePrincipal())) return c.json({ error: 'not found' }, 404)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    audit({
      actor: machinePrincipal(), action: 'lead.note', entity: 'lead',
      entityId: id, detail: {}, ip: clientIp(c),
    })
    return c.json({ ok: true }, 201)
  })

  // ── lead links — preview URLs, the live site, a shared document ─────────
  app.get('/api/machine/leads/:id/links', requireMachine, (c) => {
    const id = Number(c.req.param('id'))
    if (!db.prepare('SELECT 1 FROM leads WHERE id = ?').get(id)) return c.json({ error: 'not found' }, 404)
    return c.json({ links: listLeadLinks(id) })
  })

  app.post('/api/machine/leads/:id/links', requireMachine, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const { link, existed } = addLeadLink(
        id,
        { url: b.url as string, label: b.label as string, kind: b.kind as string },
        machinePrincipal(),
      )
      if (existed) return c.json({ link, existed: true })
      audit({
        actor: machinePrincipal(), action: 'lead.link.add', entity: 'lead',
        entityId: id, detail: { url: link.url, kind: link.kind }, ip: clientIp(c),
      })
      return c.json({ link }, 201)
    } catch (e) {
      const msg = (e as Error).message
      return c.json({ error: msg }, msg === 'not found' ? 404 : 400)
    }
  })

  app.delete('/api/machine/leads/:id/links/:linkId', requireMachine, (c) => {
    const id = Number(c.req.param('id'))
    const linkId = Number(c.req.param('linkId'))
    if (!deleteLeadLink(id, linkId)) return c.json({ error: 'not found' }, 404)
    audit({
      actor: machinePrincipal(), action: 'lead.link.remove', entity: 'lead',
      entityId: id, detail: { linkId }, ip: clientIp(c),
    })
    return c.json({ ok: true })
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

  // ── documents — drafts are the agent's to write; issuing is not ──────────
  app.get('/api/machine/documents', requireMachine, (c) => {
    const kind = c.req.query('kind') || undefined
    return c.json(listBody(c, 'documents', listDocuments(kind, numQuery(c.req.query('customer_id')))))
  })

  app.get('/api/machine/documents/:id', requireMachine, (c) => {
    const document = getDocument(Number(c.req.param('id')))
    if (!document) return c.json({ error: 'not found' }, 404)
    return c.json({ document })
  })

  // EN 16931 (Factur-X/ZUGFeRD) business rules. Read-only, and the sensible
  // thing to call before asking a human to festschreiben something.
  app.get('/api/machine/documents/:id/validate', requireMachine, (c) => {
    const doc = getDocument(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    return c.json({ validation: validateInvoice(doc, getSettings()) })
  })

  app.post('/api/machine/documents', requireMachine, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const document = createDraftDocument(b)
      audit({
        actor: machinePrincipal(), action: 'document.create', entity: 'document',
        entityId: document.id, detail: { kind: document.kind, customer_id: document.customer_id }, ip: clientIp(c),
      })
      return c.json({ document }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.patch('/api/machine/documents/:id', requireMachine, async (c) => {
    const id = Number(c.req.param('id'))
    const existing = getDocument(id)
    if (!existing) return c.json({ error: 'not found' }, 404)
    // Drafts only. The human API lets a logged-in user still adjust a few
    // post-issuance fields on a numbered document; on the machine surface the
    // rule is the simpler one — once it is festgeschrieben, an agent is done
    // with it.
    if (existing.number) {
      return c.json(
        { error: `${existing.number} ist festgeschrieben und für Automaten unveränderlich (GoBD).` },
        409,
      )
    }
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    // 'bezahlt' and 'storniert' are bookkeeping claims, not document edits: they
    // are set by recording a payment or by finalising a Storno, both of which
    // need a human. Refuse rather than write a false state into the books.
    if (typeof b.status === 'string' && !MACHINE_DOC_STATUSES.has(b.status)) {
      return c.json(
        { error: `Status "${b.status}" kann nur ein Mensch setzen (erlaubt: ${[...MACHINE_DOC_STATUSES].join(', ')}).` },
        403,
      )
    }
    try {
      const document = patchDocument(id, b)
      if (!document) return c.json({ error: 'not found' }, 404)
      audit({
        actor: machinePrincipal(), action: 'document.update', entity: 'document',
        entityId: id, detail: { fields: Object.keys(b) }, ip: clientIp(c),
      })
      return c.json({ document })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.delete('/api/machine/documents/:id', requireMachine, (c) => {
    const id = Number(c.req.param('id'))
    const result = deleteDraftDocument(id)
    if (result === 'not-found') return c.json({ error: 'not found' }, 404)
    if (result === 'finalised')
      return c.json({ error: 'Ausgestellte Dokumente können nicht gelöscht werden.' }, 409)
    audit({
      actor: machinePrincipal(), action: 'document.delete', entity: 'document',
      entityId: id, detail: { draft: true }, ip: clientIp(c),
    })
    return c.json({ ok: true })
  })

  // Accepted Angebot → draft Rechnung. A copy, so the quote stays as it was.
  app.post('/api/machine/documents/:id/convert', requireMachine, (c) => {
    const id = Number(c.req.param('id'))
    try {
      const document = invoiceFromQuote(id)
      if (!document) return c.json({ error: 'not found' }, 404)
      audit({
        actor: machinePrincipal(), action: 'document.convert', entity: 'document',
        entityId: document.id, detail: { from_document_id: id }, ip: clientIp(c),
      })
      return c.json({ document }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Prepare a Stornorechnung as a DRAFT. Preparing it changes nothing in the
  // books — the original flips to 'storniert' only when the Storno is
  // festgeschrieben, which needs a Freigabe like any other issuance.
  app.post('/api/machine/documents/:id/storno', requireMachine, (c) => {
    const id = Number(c.req.param('id'))
    if (!getDocument(id)) return c.json({ error: 'not found' }, 404)
    try {
      const document = stornoFromDocument(id)
      audit({
        actor: machinePrincipal(), action: 'document.storno', entity: 'document',
        entityId: document.id, detail: { corrects_document_id: id }, ip: clientIp(c),
      })
      return c.json({ document }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // ── the one-way doors, behind a human's yes ─────────────────────────────
  //
  // Both routes take `approval_id` in the body. Without a granted, unused,
  // unexpired Freigabe for exactly this document in exactly this state, they
  // answer 403 and explain how to ask for one — nothing is written.

  app.post('/api/machine/documents/:id/finalize', requireMachine, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const actor = machinePrincipal()
    let approvalId: number
    try {
      approvalId = requireApproval({ body: b, action: 'document.finalize', entityId: id, actor }).id
    } catch (e) {
      const err = e as ApprovalError
      return c.json({ error: err.message }, errorStatus(err.status))
    }
    const document = finalizeDraft(id)
    if (!document) return c.json({ error: 'not found' }, 404)
    audit({
      actor, action: 'document.finalize', entity: 'document', entityId: id,
      detail: { number: document.number, kind: document.kind, approval_id: approvalId }, ip: clientIp(c),
    })
    return c.json({ document, approval_id: approvalId })
  })

  app.post('/api/machine/documents/:id/send', requireMachine, async (c) => {
    const id = Number(c.req.param('id'))
    const document = getDocument(id)
    if (!document) return c.json({ error: 'not found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const actor = machinePrincipal()
    let approvalId: number
    try {
      approvalId = requireApproval({ body: b, action: 'document.send', entityId: id, actor }).id
    } catch (e) {
      const err = e as ApprovalError
      return c.json({ error: err.message }, errorStatus(err.status))
    }
    try {
      const sent = await mailDocument(document, actor)
      audit({
        actor, action: 'invoice.send', entity: 'document', entityId: id,
        detail: { to: sent.to, messageId: sent.messageId, via: sent.via, approval_id: approvalId }, ip: clientIp(c),
      })
      return c.json({ ok: true, to: sent.to, messageId: sent.messageId, approval_id: approvalId })
    } catch (e) {
      // The Freigabe was spent before the attempt, on purpose: a yes must be
      // consumed exactly once, and we cannot know from here whether the relay
      // took the mail. Say so, so the agent asks again instead of retrying with
      // an id the server will now reject.
      const err = e as DocumentMailError
      return c.json(
        {
          error: `${err.message} Die Freigabe ${approvalId} ist damit verbraucht — bitte erneut anfragen.`,
        },
        errorStatus(err.status),
      )
    }
  })

  // ── Freigaben (approvals) ───────────────────────────────────────────────
  //
  // Ask, watch, withdraw. Deciding is deliberately absent: a machine token can
  // raise a request and read its fate, never grant it. That happens in the UI,
  // under a human login (routes/approvals.ts).

  app.post('/api/machine/approvals', requireMachine, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const action = b.action
    if (!isApprovalAction(action)) {
      return c.json(
        { error: `Unbekannte Aktion: ${String(action)}. Erlaubt: ${MACHINE_ACTIONS.join(', ')}` },
        400,
      )
    }
    // Only ask for what this surface can actually carry out afterwards, so an
    // agent never gets a granted Freigabe it has no route to spend.
    if (!MACHINE_ACTIONS.includes(action)) {
      return c.json(
        {
          error:
            `"${action}" ist über die Maschinen-Schnittstelle nicht ausführbar (${ACTION_LABELS[action]}). ` +
            `Erlaubt: ${MACHINE_ACTIONS.join(', ')}.`,
        },
        403,
      )
    }
    try {
      const { approval, existed } = requestApproval({
        action,
        entity_id: Number(b.entity_id),
        requested_by: machinePrincipal(),
        reason: (b.reason as string) ?? null,
      })
      if (!existed) {
        audit({
          actor: machinePrincipal(), action: 'approval.request', entity: 'approval',
          entityId: approval.id,
          detail: { action: approval.action, entity_id: approval.entity_id, reason: approval.reason },
          ip: clientIp(c),
        })
      }
      return c.json(
        {
          approval,
          existed,
          hinweis:
            'Wartet auf die Entscheidung eines Menschen im Kunden Manager unter „Freigaben". ' +
            'Nach der Genehmigung die approval_id beim Festschreiben/Versenden mitgeben.',
        },
        existed ? 200 : 201,
      )
    } catch (e) {
      const err = e as ApprovalError
      return c.json({ error: err.message }, errorStatus(err.status))
    }
  })

  app.get('/api/machine/approvals', requireMachine, (c) => {
    const status = c.req.query('status')
    if (status && !(APPROVAL_STATUSES as readonly string[]).includes(status)) {
      return c.json({ error: `Unbekannter Status: ${status}` }, 400)
    }
    const action = c.req.query('action')
    if (action && !isApprovalAction(action)) {
      return c.json({ error: `Unbekannte Aktion: ${action}` }, 400)
    }
    return c.json(
      listBody(
        c,
        'approvals',
        listApprovals({
          status: (status as ApprovalStatus) ?? undefined,
          action: (action as ApprovalAction) ?? undefined,
          entity_id: numQuery(c.req.query('entity_id')),
          // An agent sees the queue it raised, not the operator's whole inbox.
          requested_by: machinePrincipal(),
        }),
      ),
    )
  })

  app.get('/api/machine/approvals/:id', requireMachine, (c) => {
    const approval = getApproval(Number(c.req.param('id')))
    if (!approval || approval.requested_by !== machinePrincipal())
      return c.json({ error: 'not found' }, 404)
    return c.json({ approval })
  })

  // Take back an own open request — e.g. the agent noticed a wrong position and
  // is about to fix the draft. Cheaper than making a human decide on a document
  // that is about to change anyway.
  app.post('/api/machine/approvals/:id/withdraw', requireMachine, (c) => {
    try {
      const approval = withdrawApproval(Number(c.req.param('id')), machinePrincipal())
      audit({
        actor: machinePrincipal(), action: 'approval.withdraw', entity: 'approval',
        entityId: approval.id, detail: { approved_action: approval.action }, ip: clientIp(c),
      })
      return c.json({ approval })
    } catch (e) {
      const err = e as ApprovalError
      return c.json({ error: err.message }, errorStatus(err.status))
    }
  })

  // Who has paid what against one invoice. Read-only: booking a payment is an
  // accounting act, and it stays with the human who can see the bank statement.
  app.get('/api/machine/documents/:id/payments', requireMachine, (c) => {
    const id = Number(c.req.param('id'))
    if (!getDocument(id)) return c.json({ error: 'not found' }, 404)
    return c.json(listBody(c, 'payments', listPayments(id)))
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

  // Run the due templates. This is the same job the server's own scheduler runs;
  // it produces DRAFTS and advances next_run — nothing is issued or sent, so the
  // worst case is a handful of drafts to delete.
  app.post('/api/machine/recurring/run-due', requireMachine, (c) => {
    const result = processDueRecurring()
    if (result.generated > 0) {
      audit({
        actor: machinePrincipal(), action: 'recurring.run', entity: 'recurring',
        entityId: null, detail: { generated: result.generated, document_ids: result.document_ids },
        ip: clientIp(c),
      })
    }
    return c.json(result)
  })

  // ── subscriptions — own running costs, with run-rate + upcoming renewals ──
  // ?within_days= widens the "renewing soon" horizon in the summary; a missing
  // or nonsensical value falls back to the module's own 30 days.
  app.get('/api/machine/subscriptions', requireMachine, (c) => {
    const within = numQuery(c.req.query('within_days'))
    return c.json(
      listBody(c, 'subscriptions', listSubscriptions(c.req.query('active') === '1'), {
        summary: subscriptionSummary(
          within != null && Number.isFinite(within) && within > 0 ? within : 30,
        ),
      }),
    )
  })

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

  // ── reports ─────────────────────────────────────────────────────────────
  // EÜR for a date range: revenue from finalised invoices, costs from expenses,
  // plus the VAT position. Derived — reading it changes nothing.
  app.get('/api/machine/report/euer', requireMachine, (c) =>
    c.json({ report: buildEuer(c.req.query('from'), c.req.query('to')) }),
  )

  app.get('/api/machine/dashboard', requireMachine, (c) =>
    c.json({ dashboard: buildDashboard() }),
  )
}
