import type { Hono } from 'hono'
import { db, DOC_KINDS, type DocumentRow } from '../db'
import {
  getSettings,
  getDocument,
  listDocuments,
  finalizeDraft,
  setDocumentSignedDoc,
  getDocumentSignedDoc,
  deleteDocumentSignedDoc,
  stornoFromDocument,
  createDraftDocument,
  patchDocument,
  deleteDraftDocument,
  invoiceFromQuote,
} from '../documents'
import { mailDocument, DocumentMailError } from '../documentMail'
import { renderDocumentPdf, pdfFilename } from '../pdf'
import { validateInvoice } from '../validate'
import { listPayments, addPayment, deletePayment, paidCents } from '../payments'
import { contractFromDocument } from '../contracts'
import { audit } from '../audit'
import { ApprovalError, requireApproval } from '../approvals'
import { requireAuth, type AppContext, type Vars } from './middleware'
import { readUpload, inlineFile, errorStatus } from './helpers'

/**
 * Who is asking, and may they walk through a one-way door unaccompanied?
 *
 * A cookie (or SSO-proxy) session is a person at a screen: clicking
 * "Festschreiben" IS the explicit approval, and there is nothing to gate. A
 * bearer token is a headless caller — the CLI, the MCP server, a cron job, an
 * agent — and for those the yes has to come from a human first, carried as an
 * `approval_id` from the Freigaben queue (approvals.ts).
 */
function headless(c: AppContext): boolean {
  return c.get('token') !== undefined
}


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
    try {
      return c.json({ document: createDraftDocument(b) }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.patch('/api/documents/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const document = patchDocument(id, b)
      if (!document) return c.json({ error: 'not found' }, 404)
      return c.json({ document })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Finalise a draft: assign a gapless number + issue/due dates, mark "versendet".
  // Done atomically in finalizeDraft() so a number is never consumed without the
  // matching invoice (gapless numbering, §14 UStG / GoBD).
  //
  // A person clicking this in the UI is the approval. A headless caller has to
  // bring one: `approval_id` of a Freigabe a human granted for exactly this
  // document, in exactly this state.
  app.post('/api/documents/:id/finalize', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const actor = c.get('user').username
    let approvalId: number | null = null
    if (headless(c)) {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      try {
        approvalId = requireApproval({ body: b, action: 'document.finalize', entityId: id, actor }).id
      } catch (e) {
        const err = e as ApprovalError
        return c.json({ error: err.message }, errorStatus(err.status))
      }
    }
    const wasFinal = !!(db.prepare('SELECT number FROM documents WHERE id = ?').get(id) as { number?: string } | undefined)?.number
    const doc = finalizeDraft(id)
    if (!doc) return c.json({ error: 'not found' }, 404)
    // Audit the issuance (who finalised which number, when) — but not a re-finalise no-op.
    if (!wasFinal) {
      audit({ actor, action: 'document.finalize', entity: 'document', entityId: id, detail: { number: doc.number, kind: doc.kind, approval_id: approvalId } })
    }
    return c.json({ document: doc })
  })

  // Validate a document against EN 16931 (Factur-X/ZUGFeRD) business rules.
  app.get('/api/documents/:id/validate', requireAuth, (c) => {
    const doc = getDocument(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    return c.json({ validation: validateInvoice(doc, getSettings()) })
  })

  // E-mail a finalised document as a PDF to the client. Same posture as
  // finalise: a click is its own approval, a headless caller brings one.
  app.post('/api/documents/:id/send', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const doc = getDocument(id)
    if (!doc) return c.json({ error: 'not found' }, 404)
    const actor = c.get('user').username
    let approvalId: number | null = null
    if (headless(c)) {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      try {
        approvalId = requireApproval({ body: b, action: 'document.send', entityId: id, actor }).id
      } catch (e) {
        const err = e as ApprovalError
        return c.json({ error: err.message }, errorStatus(err.status))
      }
    }
    try {
      const sent = await mailDocument(doc, actor)
      audit({ actor, action: 'invoice.send', entity: 'document', entityId: doc.id, detail: { to: sent.to, messageId: sent.messageId, via: sent.via, approval_id: approvalId } })
      return c.json({ ok: true, messageId: sent.messageId, to: sent.to })
    } catch (e) {
      // A consumed Freigabe stays consumed even when the relay refuses: it is
      // spent before the attempt so it can never authorise two mails, and from
      // here we cannot tell a refused hand-off from a delivered one.
      const err = e as DocumentMailError
      const spent = approvalId ? ` Die Freigabe ${approvalId} ist verbraucht — bitte erneut anfragen.` : ''
      return c.json({ error: err.message + spent }, errorStatus(err.status))
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
    return c.json({ payment, document: getDocument(doc.id) }, 201)
  })

  // Delete a recorded payment (re-opens the invoice if it drops below the total).
  app.delete('/api/payments/:id', requireAuth, (c) => {
    const pid = Number(c.req.param('id'))
    const docId = deletePayment(pid)
    if (docId === null) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'invoice.payment.delete', entity: 'document', entityId: docId, detail: { payment_id: pid } })
    return c.json({ document: getDocument(docId) })
  })

  // Convert an Angebot into a draft Rechnung (copies client + items).
  app.post('/api/documents/:id/convert', requireAuth, (c) => {
    try {
      const document = invoiceFromQuote(Number(c.req.param('id')))
      if (!document) return c.json({ error: 'not found' }, 404)
      return c.json({ document }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Create a draft Stornorechnung for a finalised Rechnung (negated items,
  // reference to the original). The original flips to 'storniert' only when the
  // Storno is finalised.
  app.post('/api/documents/:id/storno', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    if (!getDocument(id)) return c.json({ error: 'not found' }, 404)
    try {
      const doc = stornoFromDocument(id)
      audit({
        actor: c.get('user').username,
        action: 'document.storno',
        entity: 'document',
        entityId: doc.id,
        detail: { corrects_document_id: id },
      })
      return c.json({ document: doc }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Turn a document (typically an accepted Angebot) into a draft Vertrag, carrying
  // the client block, customer/lead links, net value and a Leistungsbeschreibung.
  app.post('/api/documents/:id/to-contract', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const contract = contractFromDocument(id, c.get('user').username)
    if (!contract) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'contract.from_document', entity: 'contract', entityId: contract.id, detail: { document_id: id } })
    return c.json({ contract }, 201)
  })

  app.delete('/api/documents/:id', requireAuth, (c) => {
    // Keep the audit trail intact: finalised (numbered) documents must not vanish.
    const result = deleteDraftDocument(Number(c.req.param('id')))
    if (result === 'not-found') return c.json({ error: 'not found' }, 404)
    if (result === 'finalised')
      return c.json({ error: 'Ausgestellte Dokumente können nicht gelöscht werden.' }, 400)
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
