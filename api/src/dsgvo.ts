import type { Hono, MiddlewareHandler } from 'hono'
import { db, type LeadRow } from './db'
import { audit } from './audit'
import { AI, isLocalInference } from './ai/provider'

type Vars = { user: { id: number; username: string; role: string } }
type App = Hono<{ Variables: Vars }>

function ip(c: Parameters<MiddlewareHandler>[0]): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null
}

/**
 * DSGVO operator tooling. These endpoints make the data-subject rights concrete:
 * Auskunft/Datenübertragbarkeit (Art. 15/20), Löschung (Art. 17), Verzeichnis der
 * Verarbeitungstätigkeiten (Art. 30) and the accountability log (Art. 5(2)).
 */
export function registerDsgvoRoutes(app: App, auth: MiddlewareHandler): void {
  app.use('/api/dsgvo/*', auth)

  // Accountability log, filterable by entity.
  app.get('/api/dsgvo/audit', (c) => {
    const entity = c.req.query('entity')
    const entityId = c.req.query('entity_id')
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500)
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (entity) { clauses.push('entity = ?'); params.push(entity) }
    if (entityId) { clauses.push('entity_id = ?'); params.push(Number(entityId)) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT ?`).all(...params, limit)
    return c.json({ audit: rows })
  })

  // Art. 15/20 — everything held about one lead, machine-readable.
  app.get('/api/dsgvo/lead/:id/export', (c) => {
    const id = Number(c.req.param('id'))
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as LeadRow | undefined
    if (!lead) return c.json({ error: 'not found' }, 404)
    const bundle = {
      exported_at: new Date().toISOString(),
      lead,
      events: db.prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY at').all(id),
      ai_analysis: db.prepare('SELECT * FROM lead_ai WHERE lead_id = ?').get(id) ?? null,
      outreach: db.prepare('SELECT * FROM outreach WHERE lead_id = ? ORDER BY created_at').all(id),
      consent: db.prepare('SELECT * FROM consent WHERE lead_id = ? ORDER BY at').all(id),
      documents: db.prepare('SELECT id, kind, number, status, created_at FROM documents WHERE lead_id = ?').all(id),
      audit: db.prepare("SELECT * FROM audit_log WHERE entity = 'lead' AND entity_id = ? ORDER BY at").all(id),
    }
    audit({ actor: c.get('user').username, action: 'dsgvo.export', entity: 'lead', entityId: id, ip: ip(c) })
    c.header('Content-Disposition', `attachment; filename="lead-${id}-dsgvo-export.json"`)
    return c.json(bundle)
  })

  // Art. 17 — erasure. Cascades remove events/AI/outreach/consent. Numbered
  // documents are legally retained (§147 AO / §14b UStG): we anonymise the link
  // rather than destroy the invoice. The erasure itself is logged.
  app.post('/api/dsgvo/lead/:id/erase', async (c) => {
    const id = Number(c.req.param('id'))
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as LeadRow | undefined
    if (!lead) return c.json({ error: 'not found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as { reason?: string }
    const docs = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE lead_id = ? AND number IS NOT NULL").get(id) as { n: number }
    // Detach retained invoices from the personal record before deleting the lead.
    db.prepare('UPDATE documents SET lead_id = NULL WHERE lead_id = ?').run(id)
    db.prepare('DELETE FROM leads WHERE id = ?').run(id) // cascades to events/ai/outreach/consent
    audit({
      actor: c.get('user').username, action: 'dsgvo.erase', entity: 'lead', entityId: id,
      detail: { company: lead.company, reason: b.reason ?? null, retained_documents: docs.n }, ip: ip(c),
    })
    return c.json({ ok: true, erased: id, retained_documents: docs.n })
  })

  // --- Consent / lawful-basis ledger -------------------------------------
  app.get('/api/dsgvo/lead/:id/consent', (c) => {
    const id = Number(c.req.param('id'))
    return c.json({ consent: db.prepare('SELECT * FROM consent WHERE lead_id = ? ORDER BY at DESC').all(id) })
  })

  app.post('/api/dsgvo/lead/:id/consent', async (c) => {
    const id = Number(c.req.param('id'))
    if (!db.prepare('SELECT id FROM leads WHERE id = ?').get(id)) return c.json({ error: 'not found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as { type?: string; basis?: string; source?: string; note?: string; status?: string }
    if (!b.type || !b.basis) return c.json({ error: 'type und basis erforderlich' }, 400)
    const info = db.prepare(
      `INSERT INTO consent (lead_id, type, basis, status, source, note) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, b.type, b.basis, b.status ?? 'active', b.source ?? null, b.note ?? null)
    audit({ actor: c.get('user').username, action: 'dsgvo.consent_add', entity: 'lead', entityId: id, detail: { type: b.type, basis: b.basis }, ip: ip(c) })
    return c.json({ consent: db.prepare('SELECT * FROM consent WHERE id = ?').get(Number(info.lastInsertRowid)) }, 201)
  })

  app.post('/api/dsgvo/consent/:id/withdraw', (c) => {
    const id = Number(c.req.param('id'))
    db.prepare("UPDATE consent SET status = 'withdrawn' WHERE id = ?").run(id)
    audit({ actor: c.get('user').username, action: 'dsgvo.consent_withdraw', entity: 'consent', entityId: id, ip: ip(c) })
    return c.json({ ok: true })
  })

  // Art. 30 — a living record of processing activities, partly derived from config.
  app.get('/api/dsgvo/processing', (c) => {
    const leadCount = (db.prepare('SELECT COUNT(*) AS n FROM leads').get() as { n: number }).n
    return c.json({
      controller: 'Betreiber dieser OpenLeads-Instanz (selbst-gehostet)',
      activities: [
        {
          name: 'Lead-Generierung & Vertrieb (B2B)',
          purpose: 'Anbahnung von Geschäftsbeziehungen mit lokalen Betrieben',
          legal_basis: 'Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse, B2B)',
          categories: ['Firmenname', 'Branche', 'Ort', 'Website', 'geschäftl. Kontaktdaten'],
          data_subjects: ['Geschäftskontakte / Gewerbetreibende'],
          recipients: ['keine — Daten verbleiben on-premise'],
          third_country: 'nein',
          retention: 'bis Zweckfortfall oder Widerspruch (Art. 21)',
        },
        {
          name: 'Rechnungsstellung',
          purpose: 'Erstellung und Aufbewahrung von Angeboten/Rechnungen',
          legal_basis: 'Art. 6 Abs. 1 lit. b/c DSGVO; §147 AO, §14b UStG',
          categories: ['Rechnungsdaten', 'Leistungen', 'Beträge'],
          retention: '10 Jahre (gesetzliche Aufbewahrung)',
        },
        {
          name: 'KI-gestützte Analyse & Textentwürfe',
          purpose: 'Qualifizierung von Leads und Entwurf von Ansprachen',
          legal_basis: 'Art. 6 Abs. 1 lit. f DSGVO',
          processor: isLocalInference()
            ? `lokale/​selbst-gehostete Inferenz (${AI.baseUrl}) — keine Drittübermittlung`
            : `externer Inferenz-Endpunkt (${AI.baseUrl}) — Auftragsverarbeitung/AVV erforderlich`,
          model: AI.model,
          automated_decision: 'nein — Vorschläge, finale Entscheidung beim Menschen',
        },
      ],
      stats: { leads: leadCount },
    })
  })
}
