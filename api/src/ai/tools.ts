import { db, STAGES, EXPENSE_CATEGORIES, type LeadRow } from '../db'
import { getDocument, getSettings, replaceItems, type DocItemInput } from '../documents'
import { createExpense, listExpenses, expenseSummary } from '../expenses'
import { audit } from '../audit'
import { analyzeLead, draftOutreach } from './leadIntel'
import type { ToolSchema } from './types'

// The agent's hands. Each tool is a small, auditable capability over the same
// data the UI uses — the AI is a first-class operator of OpenLeads, not a bolt-on.

export interface ToolContext {
  actor: string
  ip?: string | null
}

export interface AgentTool {
  schema: ToolSchema
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown> | unknown
}

function def(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: AgentTool['handler'],
): AgentTool {
  return { schema: { type: 'function', function: { name, description, parameters } }, handler }
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
})

function getLeadRow(id: number): LeadRow | undefined {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as LeadRow | undefined
}

export const TOOLS: AgentTool[] = [
  def(
    'search_leads',
    'Suche/filtere Leads. Gibt kompakte Treffer (id, Firma, Ort, Score, Stage) zurück.',
    obj({
      query: { type: 'string', description: 'Freitext über Firma/Ort/Gewerk/Website' },
      stage: { type: 'string', enum: [...STAGES], description: 'optionaler Stage-Filter' },
      limit: { type: 'number', description: 'max. Treffer, Standard 20' },
    }),
    (a) => {
      const clauses: string[] = []
      const params: string[] = []
      const q = typeof a.query === 'string' ? a.query.trim() : ''
      if (q) {
        clauses.push('(company LIKE ? OR city LIKE ? OR trade LIKE ? OR website LIKE ?)')
        const like = `%${q}%`
        params.push(like, like, like, like)
      }
      if (typeof a.stage === 'string' && STAGES.includes(a.stage as never)) {
        clauses.push('stage = ?')
        params.push(a.stage)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const limit = Math.min(Number(a.limit ?? 20) || 20, 50)
      const rows = db
        .prepare(`SELECT id, company, trade, city, score, priority, stage, email, phone FROM leads ${where} ORDER BY score DESC, created_at DESC LIMIT ?`)
        .all(...params, limit) as unknown as Record<string, unknown>[]
      return { count: rows.length, leads: rows }
    },
  ),

  def(
    'get_lead',
    'Lies einen Lead vollständig inkl. der letzten Verlaufsereignisse.',
    obj({ id: { type: 'number' } }, ['id']),
    (a) => {
      const id = Number(a.id)
      const lead = getLeadRow(id)
      if (!lead) return { error: 'Lead nicht gefunden' }
      const events = db
        .prepare('SELECT type, from_stage, to_stage, body, at FROM lead_events WHERE lead_id = ? ORDER BY at DESC LIMIT 8')
        .all(id)
      const ai = db.prepare('SELECT * FROM lead_ai WHERE lead_id = ?').get(id) ?? null
      return { lead, events, ai }
    },
  ),

  def(
    'update_lead',
    'Aktualisiere Felder eines Leads (z.B. email, phone, priority, notes, tags).',
    obj({
      id: { type: 'number' },
      fields: { type: 'object', description: 'Schlüssel/Wert der zu ändernden Felder' },
    }, ['id', 'fields']),
    (a, ctx) => {
      const id = Number(a.id)
      const lead = getLeadRow(id)
      if (!lead) return { error: 'Lead nicht gefunden' }
      const allowed = new Set(['company', 'trade', 'city', 'website', 'phone', 'email', 'priority', 'why_lead', 'notes', 'tags'])
      const fields = (a.fields ?? {}) as Record<string, unknown>
      const sets: string[] = []
      const params: Record<string, string | number | null> = { id }
      for (const k of Object.keys(fields)) {
        if (!allowed.has(k)) continue
        sets.push(`${k} = @${k}`)
        params[k] = (fields[k] as string | number | null) ?? null
      }
      if (!sets.length) return { error: 'Keine gültigen Felder' }
      sets.push("updated_at = datetime('now')")
      db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = @id`).run(params)
      audit({ actor: ctx.actor, action: 'ai.update_lead', entity: 'lead', entityId: id, detail: { fields: Object.keys(params).filter((k) => k !== 'id') }, ip: ctx.ip })
      return { ok: true, lead: getLeadRow(id) }
    },
  ),

  def(
    'move_lead_stage',
    'Verschiebe einen Lead in eine andere Pipeline-Stage und protokolliere den Wechsel.',
    obj({ id: { type: 'number' }, stage: { type: 'string', enum: [...STAGES] } }, ['id', 'stage']),
    (a, ctx) => {
      const id = Number(a.id)
      const lead = getLeadRow(id)
      if (!lead) return { error: 'Lead nicht gefunden' }
      const stage = String(a.stage)
      if (!STAGES.includes(stage as never)) return { error: 'Ungültige Stage' }
      if (stage === lead.stage) return { ok: true, unchanged: true }
      db.prepare("UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(stage, id)
      db.prepare(
        `INSERT INTO lead_events (lead_id, actor, type, from_stage, to_stage) VALUES (?, ?, 'stage_change', ?, ?)`,
      ).run(id, ctx.actor, lead.stage, stage)
      audit({ actor: ctx.actor, action: 'ai.move_stage', entity: 'lead', entityId: id, detail: { from: lead.stage, to: stage }, ip: ctx.ip })
      return { ok: true, from: lead.stage, to: stage }
    },
  ),

  def(
    'add_note',
    'Füge einem Lead eine Vertriebs-Notiz im Verlauf hinzu.',
    obj({ id: { type: 'number' }, note: { type: 'string' } }, ['id', 'note']),
    (a, ctx) => {
      const id = Number(a.id)
      if (!getLeadRow(id)) return { error: 'Lead nicht gefunden' }
      db.prepare(`INSERT INTO lead_events (lead_id, actor, type, body) VALUES (?, ?, 'note', ?)`).run(id, ctx.actor, String(a.note ?? ''))
      audit({ actor: ctx.actor, action: 'ai.add_note', entity: 'lead', entityId: id, ip: ctx.ip })
      return { ok: true }
    },
  ),

  def(
    'analyze_lead',
    'Lass den Lead von der KI qualifizieren (Zusammenfassung, Fit, nächste Maßnahme). Ergebnis wird gespeichert.',
    obj({ id: { type: 'number' } }, ['id']),
    async (a, ctx) => {
      const lead = getLeadRow(Number(a.id))
      if (!lead) return { error: 'Lead nicht gefunden' }
      const row = await analyzeLead(lead, ctx.actor)
      return { ok: true, analysis: row }
    },
  ),

  def(
    'draft_outreach',
    'Entwirf eine erste Ansprache (E-Mail/Brief/Telefonleitfaden). Wird NICHT versendet, nur gespeichert.',
    obj({ id: { type: 'number' }, channel: { type: 'string', enum: ['email', 'letter', 'call_script'] } }, ['id']),
    async (a, ctx) => {
      const lead = getLeadRow(Number(a.id))
      if (!lead) return { error: 'Lead nicht gefunden' }
      const ch = (['email', 'letter', 'call_script'] as const).includes(a.channel as never) ? (a.channel as 'email') : 'email'
      const row = await draftOutreach(lead, ctx.actor, ch)
      return { ok: true, outreach: row }
    },
  ),

  def(
    'pipeline_stats',
    'Kennzahlen der Pipeline: Anzahl Leads je Stage und je Priorität.',
    obj({}),
    () => {
      const byStage = db.prepare('SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage').all()
      const byPriority = db.prepare('SELECT priority, COUNT(*) AS n FROM leads GROUP BY priority').all()
      const total = (db.prepare('SELECT COUNT(*) AS n FROM leads').get() as { n: number }).n
      return { total, byStage, byPriority }
    },
  ),

  def(
    'list_documents',
    'Liste Angebote/Rechnungen (neueste zuerst).',
    obj({ kind: { type: 'string', enum: ['angebot', 'rechnung'] }, limit: { type: 'number' } }),
    (a) => {
      const where = a.kind === 'angebot' || a.kind === 'rechnung' ? 'WHERE kind = ?' : ''
      const params = where ? [a.kind as string] : []
      const limit = Math.min(Number(a.limit ?? 20) || 20, 50)
      const rows = db.prepare(`SELECT id FROM documents ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as unknown as { id: number }[]
      return { documents: rows.map((r) => getDocument(r.id)) }
    },
  ),

  def(
    'create_document',
    'Erstelle einen Entwurf (Angebot/Rechnung), optional mit Positionen und Bezug zu einem Lead. Nicht finalisiert.',
    obj({
      kind: { type: 'string', enum: ['angebot', 'rechnung'] },
      client_name: { type: 'string' },
      title: { type: 'string' },
      intro: { type: 'string' },
      notes: { type: 'string' },
      lead_id: { type: 'number' },
      items: {
        type: 'array',
        items: obj({
          description: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string' },
          unit_price_cents: { type: 'number' },
        }, ['description', 'unit_price_cents']),
      },
    }, ['kind']),
    (a, ctx) => {
      const kind = a.kind === 'angebot' ? 'angebot' : 'rechnung'
      const s = getSettings()
      const info = db.prepare(
        `INSERT INTO documents (kind, lead_id, client_name, title, intro, notes, small_business, vat_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        kind,
        a.lead_id != null ? Number(a.lead_id) : null,
        (a.client_name as string) ?? null,
        (a.title as string) ?? (kind === 'rechnung' ? 'Rechnung' : 'Angebot'),
        (a.intro as string) ?? null,
        (a.notes as string) ?? null,
        s.small_business,
        s.vat_rate,
      )
      const id = Number(info.lastInsertRowid)
      if (Array.isArray(a.items)) replaceItems(id, a.items as DocItemInput[])
      audit({ actor: ctx.actor, action: 'ai.create_document', entity: 'document', entityId: id, detail: { kind }, ip: ctx.ip })
      return { ok: true, document: getDocument(id) }
    },
  ),

  def(
    'list_expenses',
    'Liste Ausgaben (Belege), optional gefiltert nach Belegdatum (from/to, YYYY-MM-DD) oder Kategorie. Liefert auch eine Summe (Brutto/Netto/Vorsteuer).',
    obj({
      from: { type: 'string', description: 'Belegdatum ab, YYYY-MM-DD' },
      to: { type: 'string', description: 'Belegdatum bis, YYYY-MM-DD' },
      category: { type: 'string', enum: EXPENSE_CATEGORIES.map((c) => c.id), description: 'Kategorie-Filter' },
      limit: { type: 'number', description: 'max. Treffer, Standard 20' },
    }),
    (a) => {
      const filter = {
        from: typeof a.from === 'string' ? a.from : undefined,
        to: typeof a.to === 'string' ? a.to : undefined,
        category: typeof a.category === 'string' ? a.category : undefined,
      }
      const limit = Math.min(Number(a.limit ?? 20) || 20, 100)
      const expenses = listExpenses(filter).slice(0, limit)
      return { count: expenses.length, summary: expenseSummary(filter), expenses }
    },
  ),

  def(
    'create_expense',
    'Erfasse eine Ausgabe/einen Beleg. Betrag ist der BRUTTO-Betrag in Cent; Netto und Vorsteuer werden aus USt-Satz berechnet. Der Beleg-Scan wird hier nicht hochgeladen (nur in der Oberfläche).',
    obj({
      vendor: { type: 'string', description: 'Lieferant / Zahlungsempfänger' },
      category: { type: 'string', enum: EXPENSE_CATEGORIES.map((c) => c.id) },
      description: { type: 'string' },
      gross_cents: { type: 'number', description: 'Bruttobetrag in Cent (positiv)' },
      vat_rate: { type: 'number', enum: [0, 7, 19], description: 'USt-Satz in %, Standard 19' },
      expense_date: { type: 'string', description: 'Belegdatum YYYY-MM-DD (Standard heute)' },
      paid_on: { type: 'string', description: 'Bezahlt am YYYY-MM-DD (optional)' },
      payment_method: { type: 'string', description: 'z. B. Überweisung, Karte, Bar' },
      note: { type: 'string' },
    }, ['gross_cents']),
    (a, ctx) => {
      const gross = Math.round(Number(a.gross_cents))
      if (!Number.isFinite(gross) || gross <= 0) return { error: 'Bruttobetrag (Cent) muss positiv sein.' }
      const exp = createExpense(
        {
          vendor: (a.vendor as string) ?? null,
          category: (a.category as string) ?? null,
          description: (a.description as string) ?? null,
          gross_cents: gross,
          vat_rate: Number(a.vat_rate ?? 19),
          expense_date: (a.expense_date as string) ?? null,
          paid_on: (a.paid_on as string) ?? null,
          payment_method: (a.payment_method as string) ?? null,
          note: (a.note as string) ?? null,
        },
        ctx.actor,
      )
      audit({ actor: ctx.actor, action: 'ai.create_expense', entity: 'expense', entityId: exp.id, detail: { gross_cents: exp.gross_cents, category: exp.category }, ip: ctx.ip })
      return { ok: true, expense: exp }
    },
  ),

  def(
    'get_settings',
    'Lies das Geschäftsprofil (Absenderdaten, §19-Status, USt-Satz, Zahlungsziel).',
    obj({}),
    () => {
      const s = getSettings()
      return {
        business_name: s.business_name, owner: s.owner, city: s.city, email: s.email,
        small_business: !!s.small_business, vat_rate: s.vat_rate, payment_terms: s.payment_terms,
      }
    },
  ),
]

export const TOOL_SCHEMAS: ToolSchema[] = TOOLS.map((t) => t.schema)

const BY_NAME = new Map(TOOLS.map((t) => [t.schema.function.name, t]))

/** Execute a tool by name. Returns a JSON-serialisable result (never throws into
 *  the agent loop — errors come back as { error } so the model can react). */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const tool = BY_NAME.get(name)
  if (!tool) return { error: `Unbekanntes Werkzeug: ${name}` }
  try {
    return await tool.handler(args, ctx)
  } catch (e) {
    return { error: (e as Error).message }
  }
}
