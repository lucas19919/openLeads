import type { Hono } from 'hono'
import { db, CONTRACT_TYPES } from '../db'
import {
  listContracts,
  getContract,
  createContract,
  updateContract,
  setContractStatus,
  finalizeContract,
  signContract,
  deleteContract,
  setSignedDoc,
  getSignedDoc,
  deleteSignedDoc,
} from '../contracts'
import { recurringFromContract } from '../recurring'
import { renderContractPdf, contractPdfFilename } from '../contractPdf'
import { getSettings } from '../documents'
import { audit } from '../audit'
import { SMTP } from '../mailer'
import { deliverMail } from '../maildispatch'
import { requireAuth, type Vars } from './middleware'
import { readUpload, inlineFile } from './helpers'

export function registerContractRoutes(app: Hono<{ Variables: Vars }>): void {
  app.get('/api/contracts', requireAuth, (c) => {
    const customer_id = c.req.query('customer_id')
    const cid =
      customer_id != null && customer_id !== '' ? Number(customer_id) : undefined
    return c.json({ contracts: listContracts(cid) })
  })

  app.get('/api/contracts/:id', requireAuth, (c) => {
    const contract = getContract(Number(c.req.param('id')))
    if (!contract) return c.json({ error: 'not found' }, 404)
    return c.json({ contract })
  })

  app.post('/api/contracts', requireAuth, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const contract = createContract(b, c.get('user').username)
      audit({ actor: c.get('user').username, action: 'contract.create', entity: 'contract', entityId: contract.id, detail: { type: contract.type, client_name: contract.client_name } })
      return c.json({ contract }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.patch('/api/contracts/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    // A status change goes through the dedicated transition (validated set).
    if (typeof b.status === 'string') {
      try {
        const contract = setContractStatus(id, b.status)
        if (!contract) return c.json({ error: 'not found' }, 404)
        return c.json({ contract })
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400)
      }
    }
    try {
      const contract = updateContract(id, b)
      if (!contract) return c.json({ error: 'not found' }, 404)
      return c.json({ contract })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Create a Serienrechnung (billing plan) from this Vertrag — draft only.
  app.post('/api/contracts/:id/recurring', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    if (!getContract(id)) return c.json({ error: 'not found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const recurring = recurringFromContract(id, b)
      audit({
        actor: c.get('user').username,
        action: 'recurring.create',
        entity: 'recurring',
        entityId: recurring.id,
        detail: { contract_id: id, cadence: recurring.cadence, next_run: recurring.next_run },
      })
      return c.json({ recurring }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Finalise: assign a gapless number, freeze the AGB text in force now, mark sent.
  app.post('/api/contracts/:id/finalize', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const wasFinal = !!(db.prepare('SELECT number FROM contracts WHERE id = ?').get(id) as { number?: string } | undefined)?.number
    const contract = finalizeContract(id)
    if (!contract) return c.json({ error: 'not found' }, 404)
    if (!wasFinal) {
      audit({ actor: c.get('user').username, action: 'contract.finalize', entity: 'contract', entityId: id, detail: { number: contract.number, type: contract.type } })
    }
    return c.json({ contract })
  })

  // Record acceptance / countersignature → status 'aktiv'.
  app.post('/api/contracts/:id/sign', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as { signed_by?: string; signed_at?: string; note?: string }
    try {
      const contract = signContract(id, b.signed_by ?? null, b.note ?? null, b.signed_at ?? null)
      if (!contract) return c.json({ error: 'not found' }, 404)
      audit({ actor: c.get('user').username, action: 'contract.sign', entity: 'contract', entityId: id, detail: { signed_by: contract.signed_by, signed_at: contract.signed_at, number: contract.number } })
      return c.json({ contract })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Download a contract as a PDF (AGB appended in full).
  app.get('/api/contracts/:id/pdf', requireAuth, async (c) => {
    const contract = getContract(Number(c.req.param('id')))
    if (!contract) return c.json({ error: 'not found' }, 404)
    const buf = await renderContractPdf(contract, getSettings())
    c.header('Content-Type', 'application/pdf')
    c.header('Content-Disposition', `inline; filename="${contractPdfFilename(contract)}"`)
    return c.body(buf as unknown as ArrayBuffer)
  })

  // E-mail a finalised contract as a PDF to the client for signature.
  app.post('/api/contracts/:id/send', requireAuth, async (c) => {
    const contract = getContract(Number(c.req.param('id')))
    if (!contract) return c.json({ error: 'not found' }, 404)
    if (!contract.number) return c.json({ error: 'Nur festgeschriebene Verträge können versendet werden.' }, 400)
    if (!contract.client_email) return c.json({ error: 'Kein Empfänger (E-Mail) am Vertrag hinterlegt.' }, 400)
    const s = getSettings()
    let pdf: Buffer
    try {
      pdf = await renderContractPdf(contract, s)
    } catch (e) {
      return c.json({ error: 'PDF konnte nicht erstellt werden: ' + (e as Error).message }, 500)
    }
    const label = CONTRACT_TYPES.find((t) => t.id === contract.type)?.label ?? 'Vertrag'
    const greeting = contract.client_name ? `Sehr geehrte Damen und Herren bei ${contract.client_name},` : 'Sehr geehrte Damen und Herren,'
    const body =
      `${greeting}\n\nanbei erhalten Sie unseren ${label} ${contract.number} als PDF. ` +
      `Bitte prüfen Sie den Vertrag in Ruhe; bei Einverständnis senden Sie ihn uns gegengezeichnet zurück.\n\n` +
      `Mit freundlichen Grüßen\n${s.business_name ?? ''}`
    const email = { to: contract.client_email, from: SMTP.from || s.email || '', subject: `${label} ${contract.number}`, text: body }
    try {
      const { messageId, via } = await deliverMail(email, {
        attachments: [{ filename: contractPdfFilename(contract), content: pdf, contentType: 'application/pdf' }],
        actor: c.get('user').username,
      })
      audit({ actor: c.get('user').username, action: 'contract.send', entity: 'contract', entityId: contract.id, detail: { to: email.to, messageId, via } })
      return c.json({ ok: true, messageId, to: email.to })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })

  app.delete('/api/contracts/:id', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const r = deleteContract(id)
    if (!r.ok && r.reason === 'not found') return c.json({ error: 'not found' }, 404)
    if (!r.ok && r.reason === 'finalised') {
      return c.json({ error: 'Festgeschriebene Verträge können nicht gelöscht werden.' }, 400)
    }
    audit({ actor: c.get('user').username, action: 'contract.delete', entity: 'contract', entityId: id })
    return c.json({ ok: true })
  })

  // Attach / replace the countersigned document the client returns (PDF or scan).
  // multipart field name: "file".
  app.post('/api/contracts/:id/signed-document', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    if (!getContract(id)) return c.json({ error: 'not found' }, 404)
    const up = await readUpload(c, `Vertrag-${id}-unterschrieben`)
    if (!up.ok) return c.json({ error: up.error }, up.status)
    const contract = setSignedDoc(id, up.file)
    audit({ actor: c.get('user').username, action: 'contract.signed_doc.upload', entity: 'contract', entityId: id, detail: { name: up.file.name, bytes: up.file.data.byteLength } })
    return c.json({ contract })
  })

  // Download / view the signed document inline.
  app.get('/api/contracts/:id/signed-document', requireAuth, (c) => {
    const doc = getSignedDoc(Number(c.req.param('id')))
    if (!doc) return c.json({ error: 'not found' }, 404)
    return inlineFile(c, doc)
  })

  app.delete('/api/contracts/:id/signed-document', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const contract = deleteSignedDoc(id)
    if (!contract) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'contract.signed_doc.delete', entity: 'contract', entityId: id })
    return c.json({ contract })
  })
}
