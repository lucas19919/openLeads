import type { Hono } from 'hono'
import { db, DOC_KINDS, DOC_STATUSES, type DocumentRow, type LeadRow } from '../db'
import {
  getSettings,
  getDocument,
  listDocuments,
  replaceItems,
  finalizeDraft,
  setDocumentSignedDoc,
  getDocumentSignedDoc,
  deleteDocumentSignedDoc,
  type DocItemInput,
} from '../documents'
import { renderDocumentPdf, pdfFilename } from '../pdf'
import { validateInvoice } from '../validate'
import { listPayments, addPayment, deletePayment, paidCents } from '../payments'
import { getCustomer } from '../customers'
import { contractFromDocument } from '../contracts'
import { audit } from '../audit'
import { emit } from '../events'
import { SMTP } from '../mailer'
import { deliverMail } from '../maildispatch'
import { requireAuth, type Vars } from './middleware'
import { readUpload, inlineFile } from './helpers'

const DOC_EDITABLE = new Set([
  'client_name', 'client_address', 'client_zip', 'client_city', 'client_email',
  'client_type', 'title', 'intro', 'notes', 'due_date', 'small_business', 'vat_rate',
  'buyer_reference', 'client_vat_id', 'include_payment_link', 'customer_id', 'lead_id',
])

export function registerDocumentRoutes(app: Hono<{ Variables: Vars }>): void {
  // List documents (optionally filtered by kind / customer), newest first, with totals.
  app.get('/api/documents', requireAuth, (c) => {
    const kind = c.req.query('kind')
    const filtered = kind && DOC_KINDS.includes(kind as never) ? kind : undefined
    const customer_id = c.req.query('customer_id')
    const cid =
      customer_id != null && customer_id !== '' ? Number(customer_id) : undefined
    return c.json({ documents: listDocuments(filtered, cid) })
  })

  app.get('/api/documents/:id', requireAuth, (c) => {
    const doc = getDocument(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    return c.json({ document: doc })
  })

  // Download a document as a PDF.
  app.get('/api/documents/:id/pdf', requireAuth, async (c) => {
    const doc = getDocument(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    const buf = await renderDocumentPdf(doc, getSettings())
    c.header('Content-Type', 'application/pdf')
    c.header('Content-Disposition', `inline; filename="${pdfFilename(doc)}"`)
    return c.body(buf as unknown as ArrayBuffer)
  })

  // Create a draft document. Optionally prefill from a customer or lead.
  app.post('/api/documents', requireAuth, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const kind = String(b.kind ?? '')
    if (!DOC_KINDS.includes(kind as never)) return c.json({ error: 'invalid kind' }, 400)
    const s = getSettings()

    // Prefill precedence: explicit body field > linked customer > linked lead.
    // Unknown customer_id → 400 (not a silent unlink).
    const customerId = b.customer_id != null ? Number(b.customer_id) : null
    const customer = customerId != null ? getCustomer(customerId) : null
    if (customerId != null && !customer) return c.json({ error: 'Kunde nicht gefunden.' }, 400)
    let prefillName: string | null = (b.client_name as string) ?? customer?.name ?? null
    let prefillAddress: string | null = (b.client_address as string) ?? customer?.address ?? null
    let prefillZip: string | null = (b.client_zip as string) ?? customer?.zip ?? null
    let prefillCity: string | null = (b.client_city as string) ?? customer?.city ?? null
    let prefillEmail: string | null = (b.client_email as string) ?? customer?.email ?? null
    let prefillVat: string | null = (b.client_vat_id as string) ?? customer?.vat_id ?? null
    const clientType = (b.client_type as string) ?? customer?.client_type ?? 'geschaeft'
    const leadId = b.lead_id != null ? Number(b.lead_id) : customer?.lead_id ?? null
    if (leadId) {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as unknown as
        | LeadRow
        | undefined
      if (lead) {
        prefillName = prefillName ?? lead.company
        prefillCity = prefillCity ?? lead.city
        prefillEmail = prefillEmail ?? lead.email
      }
    }

    const info = db
      .prepare(
        `INSERT INTO documents
          (kind, lead_id, customer_id, client_name, client_address, client_zip, client_city,
           client_email, client_vat_id, client_type, title, intro, notes, small_business, vat_rate)
         VALUES
          (@kind, @lead_id, @customer_id, @client_name, @client_address, @client_zip, @client_city,
           @client_email, @client_vat_id, @client_type, @title, @intro, @notes, @small_business, @vat_rate)`,
      )
      .run({
        kind,
        lead_id: leadId,
        customer_id: customer?.id ?? null,
        client_name: prefillName,
        client_address: prefillAddress,
        client_zip: prefillZip,
        client_city: prefillCity,
        client_email: prefillEmail,
        client_vat_id: prefillVat,
        client_type: clientType === 'privat' ? 'privat' : 'geschaeft',
        title: (b.title as string) ?? (kind === 'rechnung' ? 'Rechnung' : 'Angebot'),
        intro: (b.intro as string) ?? null,
        notes: (b.notes as string) ?? null,
        small_business: s.small_business,
        vat_rate: s.vat_rate,
      })
    const id = Number(info.lastInsertRowid)
    if (Array.isArray(b.items)) replaceItems(id, b.items as DocItemInput[])
    emit('document.created', { id, kind })
    return c.json({ document: getDocument(id) }, 201)
  })

  app.patch('/api/documents/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const doc = db.prepare('SELECT id, kind, status FROM documents WHERE id = ?').get(id) as unknown as
      | Pick<DocumentRow, 'id' | 'kind' | 'status'>
      | undefined
    if (!doc) return c.json({ error: 'not found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

    // Status change, validated against the kind's allowed statuses.
    if (typeof b.status === 'string' && b.status !== doc.status) {
      const allowed = DOC_STATUSES[doc.kind as keyof typeof DOC_STATUSES] ?? []
      if (!allowed.includes(b.status)) return c.json({ error: 'invalid status' }, 400)
    }

    // Link-only: customer_id may change; client_* snapshots are never auto-copied.
    if ('customer_id' in b && b.customer_id != null) {
      if (!getCustomer(Number(b.customer_id))) return c.json({ error: 'Kunde nicht gefunden.' }, 400)
    }

    const sets: string[] = []
    const params: Record<string, string | number | null> = { id }
    for (const key of [...DOC_EDITABLE, 'status']) {
      if (!(key in b)) continue
      const v = b[key]
      // node:sqlite binds only string|number|null — coerce booleans, skip non-scalar
      // (object/array) values rather than letting .run() throw a raw 500.
      let bound: string | number | null
      if (v === undefined || v === null) bound = null
      else if (typeof v === 'boolean') bound = v ? 1 : 0
      else if (key === 'customer_id' || key === 'lead_id') {
        bound = v === '' || v === null ? null : Number(v)
      } else if (typeof v === 'string' || typeof v === 'number') bound = v
      else continue
      sets.push(`${key} = @${key}`)
      params[key] = bound
    }
    if (sets.length) {
      sets.push("updated_at = datetime('now')")
      db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = @id`).run(params)
    }
    if (Array.isArray(b.items)) replaceItems(id, b.items as DocItemInput[])
    return c.json({ document: getDocument(id) })
  })

  // Finalise a draft: assign a gapless number + issue/due dates, mark "versendet".
  // Done atomically in finalizeDraft() so a number is never consumed without the
  // matching invoice (gapless numbering, §14 UStG / GoBD).
  app.post('/api/documents/:id/finalize', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const wasFinal = !!(db.prepare('SELECT number FROM documents WHERE id = ?').get(id) as { number?: string } | undefined)?.number
    const doc = finalizeDraft(id)
    if (!doc) return c.json({ error: 'not found' }, 404)
    // Audit the issuance (who finalised which number, when) — but not a re-finalise no-op.
    if (!wasFinal) {
      audit({ actor: c.get('user').username, action: 'document.finalize', entity: 'document', entityId: id, detail: { number: doc.number, kind: doc.kind } })
      emit('document.finalized', { id, number: doc.number, kind: doc.kind })
    }
    return c.json({ document: doc })
  })

  // Validate a document against EN 16931 (Factur-X/ZUGFeRD) business rules.
  app.get('/api/documents/:id/validate', requireAuth, (c) => {
    const doc = getDocument(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    return c.json({ validation: validateInvoice(doc, getSettings()) })
  })

  // E-mail a finalised document as a PDF to the client.
  app.post('/api/documents/:id/send', requireAuth, async (c) => {
    const doc = getDocument(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    if (!doc.number) return c.json({ error: 'Nur ausgestellte Dokumente können versendet werden.' }, 400)
    if (!doc.client_email) return c.json({ error: 'Kein Empfänger (E-Mail) am Dokument hinterlegt.' }, 400)
    const s = getSettings()

    let pdf: Buffer
    try {
      pdf = await renderDocumentPdf(doc, s)
    } catch (e) {
      return c.json({ error: 'PDF konnte nicht erstellt werden: ' + (e as Error).message }, 500)
    }
    const label = doc.kind === 'rechnung' ? 'Rechnung' : 'Angebot'
    const greeting = doc.client_name ? `Sehr geehrte Damen und Herren bei ${doc.client_name},` : 'Sehr geehrte Damen und Herren,'
    const body =
      `${greeting}\n\nanbei erhalten Sie ${label === 'Rechnung' ? 'unsere Rechnung' : 'unser Angebot'} ${doc.number} als PDF.\n\n` +
      `Mit freundlichen Grüßen\n${s.business_name ?? ''}`
    const email = { to: doc.client_email, from: SMTP.from || s.email || '', subject: `${label} ${doc.number}`, text: body }
    try {
      const { messageId, via } = await deliverMail(email, {
        attachments: [{ filename: pdfFilename(doc), content: pdf, contentType: 'application/pdf' }],
        actor: c.get('user').username,
      })
      audit({ actor: c.get('user').username, action: 'invoice.send', entity: 'document', entityId: doc.id, detail: { to: email.to, messageId, via } })
      emit('invoice.sent', { id: doc.id, number: doc.number, kind: doc.kind, to: email.to })
      return c.json({ ok: true, messageId, to: email.to })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })

  // --- Zahlungen (payments against an invoice) ------------------------------

  // List payments for an invoice plus the paid/outstanding summary.
  app.get('/api/documents/:id/payments', requireAuth, (c) => {
    const doc = getDocument(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    return c.json({
      payments: listPayments(doc.id),
      gross_cents: doc.totals.gross_cents,
      paid_cents: doc.paid_cents,
      outstanding_cents: Math.max(0, doc.totals.gross_cents - doc.paid_cents),
    })
  })

  // Record a payment. Settling the open amount flips the invoice to 'bezahlt'.
  app.post('/api/documents/:id/payments', requireAuth, async (c) => {
    const doc = getDocument(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    if (doc.kind !== 'rechnung' || !doc.number) {
      return c.json({ error: 'Zahlungen nur für ausgestellte Rechnungen.' }, 400)
    }
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const amount = Math.round(Number(b.amount_cents))
    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ error: 'Betrag (Cent) muss positiv sein.' }, 400)
    }
    const payment = addPayment(doc.id, {
      amount_cents: amount,
      paid_on: (b.paid_on as string) ?? null,
      method: (b.method as string) ?? null,
      note: (b.note as string) ?? null,
    })
    audit({ actor: c.get('user').username, action: 'invoice.payment', entity: 'document', entityId: doc.id, detail: { amount_cents: amount, paid_total_cents: paidCents(doc.id) } })
    emit('payment.recorded', { document_id: doc.id, amount_cents: amount, paid_total_cents: paidCents(doc.id), source: 'manual' })
    return c.json({ payment, document: getDocument(doc.id) }, 201)
  })

  // Delete a recorded payment (re-opens the invoice if it drops below the total).
  app.delete('/api/payments/:id', requireAuth, (c) => {
    const pid = Number(c.req.param('id'))
    const docId = deletePayment(pid)
    if (docId === null) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'invoice.payment.delete', entity: 'document', entityId: docId, detail: { payment_id: pid } })
    emit('payment.deleted', { document_id: docId, payment_id: pid })
    return c.json({ document: getDocument(docId) })
  })

  // Convert an Angebot into a draft Rechnung (copies client + items).
  app.post('/api/documents/:id/convert', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const src = getDocument(id)
    if (!src) return c.json({ error: 'not found' }, 404)
    if (src.kind !== 'angebot') return c.json({ error: 'nur Angebote konvertierbar' }, 400)
    const info = db
      .prepare(
        `INSERT INTO documents
          (kind, lead_id, client_name, client_address, client_zip, client_city,
           client_email, client_type, title, intro, notes, small_business, vat_rate)
         VALUES
          ('rechnung', @lead_id, @client_name, @client_address, @client_zip, @client_city,
           @client_email, @client_type, 'Rechnung', @intro, @notes, @small_business, @vat_rate)`,
      )
      .run({
        lead_id: src.lead_id,
        client_name: src.client_name,
        client_address: src.client_address,
        client_zip: src.client_zip,
        client_city: src.client_city,
        client_email: src.client_email,
        client_type: src.client_type,
        intro: src.intro,
        notes: src.notes,
        small_business: src.small_business,
        vat_rate: src.vat_rate,
      })
    const newId = Number(info.lastInsertRowid)
    replaceItems(
      newId,
      src.items.map((it) => ({
        description: it.description,
        quantity: it.quantity,
        unit: it.unit,
        unit_price_cents: it.unit_price_cents,
      })),
    )
    return c.json({ document: getDocument(newId) }, 201)
  })

  // Turn a document (typically an accepted Angebot) into a draft Vertrag, carrying
  // the client block, customer/lead links, net value and a Leistungsbeschreibung.
  app.post('/api/documents/:id/to-contract', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const contract = contractFromDocument(id, c.get('user').username)
    if (!contract) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'contract.from_document', entity: 'contract', entityId: contract.id, detail: { document_id: id } })
    emit('contract.created', { id: contract.id, type: contract.type, from_document: id })
    return c.json({ contract }, 201)
  })

  app.delete('/api/documents/:id', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const doc = db.prepare('SELECT id, number FROM documents WHERE id = ?').get(id) as unknown as
      | Pick<DocumentRow, 'id' | 'number'>
      | undefined
    if (!doc) return c.json({ error: 'not found' }, 404)
    // Keep the audit trail intact: finalised (numbered) documents must not vanish.
    if (doc.number) {
      return c.json({ error: 'Ausgestellte Dokumente können nicht gelöscht werden.' }, 400)
    }
    db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    return c.json({ ok: true })
  })

  // Save / replace the signed or final copy of an Angebot/Rechnung (PDF or scan).
  // multipart field name: "file".
  app.post('/api/documents/:id/signed-document', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    if (!getDocument(id)) return c.json({ error: 'not found' }, 404)
    const up = await readUpload(c, `Dokument-${id}`)
    if (!up.ok) return c.json({ error: up.error }, up.status)
    const document = setDocumentSignedDoc(id, up.file)
    audit({ actor: c.get('user').username, action: 'document.signed_doc.upload', entity: 'document', entityId: id, detail: { name: up.file.name, bytes: up.file.data.byteLength } })
    return c.json({ document })
  })

  app.get('/api/documents/:id/signed-document', requireAuth, (c) => {
    const doc = getDocumentSignedDoc(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    return inlineFile(c, doc)
  })

  app.delete('/api/documents/:id/signed-document', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const document = deleteDocumentSignedDoc(id)
    if (!document) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'document.signed_doc.delete', entity: 'document', entityId: id })
    return c.json({ document })
  })
}
