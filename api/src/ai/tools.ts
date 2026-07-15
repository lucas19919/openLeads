import { db, STAGES, PRIORITIES, EXPENSE_CATEGORIES, CONTRACT_TYPES, type LeadRow } from '../db'
import { getDocument, getSettings, replaceItems, type DocItemInput } from '../documents'
import { createExpense, listExpenses, expenseSummary } from '../expenses'
import { listCatalog, createCatalogItem } from '../catalog'
import { listContracts, createContract, finalizeContract, contractFromDocument } from '../contracts'
import { listCustomers, getCustomer, createCustomer } from '../customers'
import { listRecurring, createRecurring, recurringFromContract } from '../recurring'
import { insertLead } from '../leads'
import { audit } from '../audit'
import { analyzeLead, draftOutreach } from './leadIntel'
import { lookupWebsite, companyFromDomain } from './weblookup'
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
    'fetch_website',
    'Rufe eine öffentliche Website auf und lies Eckdaten aus (Firmenname, Beschreibung, ' +
      'E-Mail, Telefon). Nutze dies, BEVOR du aus einer URL einen Lead anlegst, damit du ' +
      'Firma und Kontakt nicht erraten musst. Schreibt nichts.',
    obj({ url: { type: 'string', description: 'Website-URL (mit oder ohne https://)' } }, ['url']),
    async (a) => {
      const url = typeof a.url === 'string' ? a.url : ''
      const facts = await lookupWebsite(url)
      if (!facts) {
        return { ok: false, url, reachable: false, company_guess: companyFromDomain(url) }
      }
      return { ok: true, reachable: true, ...facts }
    },
  ),

  def(
    'create_lead',
    'Lege einen neuen Lead an. Nur `website` ist nötig — fehlt die Firma, wird sie aus der ' +
      'Domain abgeleitet. Für gute Daten vorher `fetch_website` nutzen. Dubletten werden über ' +
      'die Domain erkannt (kein doppelter Lead). Setze `analyze: true`, damit der Lead direkt ' +
      'voll bewertet wird (Qualifizierung + Priorität); `stage` legt ihn gleich in die richtige ' +
      'Pipeline-Spalte/Tab (z. B. "angebot"). WICHTIG: `stage: "angebot"` heißt Pipeline-Spalte ' +
      '„Angebot“ — NICHT ein Angebots-Dokument (dafür `create_document`).',
    obj({
      website: { type: 'string', description: 'Website-URL des Betriebs' },
      company: { type: 'string', description: 'Firmenname (falls leer: aus Domain abgeleitet)' },
      trade: { type: 'string', description: 'Gewerk/Branche, z. B. Dachdecker, Metallbau' },
      city: { type: 'string', description: 'Ort' },
      phone: { type: 'string' },
      email: { type: 'string' },
      priority: { type: 'string', enum: [...PRIORITIES], description: 'wird bei analyze:true überschrieben' },
      why_lead: { type: 'string', description: 'kurze Begründung, warum das ein Lead ist' },
      stage: { type: 'string', enum: [...STAGES], description: 'Pipeline-Spalte/Tab, in die der Lead soll (Standard: neu)' },
      analyze: { type: 'boolean', description: 'true = Lead sofort voll bewerten (Qualifizierung + Priorität setzen)' },
    }, ['website']),
    async (a, ctx) => {
      const website = typeof a.website === 'string' ? a.website.trim() : ''
      if (!website && typeof a.company !== 'string') {
        return { error: 'Mindestens `website` oder `company` angeben.' }
      }
      const company =
        (typeof a.company === 'string' && a.company.trim()) || companyFromDomain(website) || null
      const r = insertLead(
        {
          website: website || null,
          company,
          trade: (a.trade as string) ?? null,
          city: (a.city as string) ?? null,
          phone: (a.phone as string) ?? null,
          email: (a.email as string) ?? null,
          priority: PRIORITIES.includes(a.priority as never) ? (a.priority as string) : 'mittel',
          why_lead: (a.why_lead as string) ?? null,
          source: 'ai',
        },
        ctx.actor,
      )
      // Don't touch an existing lead's stage/priority on a dedupe hit — it may be
      // further along the pipeline already. Just report it back.
      if (r.deduped) {
        return { ok: true, deduped: true, lead: getLeadRow(r.id), note: 'Lead war bereits vorhanden (gleiche Domain) — Stage/Bewertung unverändert.' }
      }
      audit({ actor: ctx.actor, action: 'ai.create_lead', entity: 'lead', entityId: r.id, detail: { company, website }, ip: ctx.ip })

      // Place it straight into the requested pipeline column (e.g. "angebot"),
      // recording the move like move_lead_stage does.
      const stage = typeof a.stage === 'string' && STAGES.includes(a.stage as never) ? a.stage : null
      if (stage && stage !== 'neu') {
        db.prepare("UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(stage, r.id)
        db.prepare(`INSERT INTO lead_events (lead_id, actor, type, from_stage, to_stage) VALUES (?, ?, 'stage_change', 'neu', ?)`).run(r.id, ctx.actor, stage)
        audit({ actor: ctx.actor, action: 'ai.move_stage', entity: 'lead', entityId: r.id, detail: { from: 'neu', to: stage }, ip: ctx.ip })
      }

      // Full eval on request: qualifies the lead and sets its priority from the
      // verdict (so it no longer defaults to "mittel").
      let analysis: unknown = null
      if (a.analyze) {
        try {
          analysis = await analyzeLead(getLeadRow(r.id)!, ctx.actor)
        } catch (e) {
          analysis = { error: (e as Error).message }
        }
      }
      return { ok: true, lead: getLeadRow(r.id), analysis }
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
    'Erstelle einen Entwurf (Angebot/Rechnung), optional mit Positionen und Bezug zu einem Lead oder ' +
      'Kunden. Mit `customer_id` werden Empfänger/Adresse/USt-IdNr. aus dem Kunden übernommen; mit ' +
      '`lead_id` wird die Firma des Leads als Empfänger genommen. Nicht finalisiert.',
    obj({
      kind: { type: 'string', enum: ['angebot', 'rechnung'] },
      client_name: { type: 'string', description: 'Empfänger (überschreibt Kunde/Lead)' },
      title: { type: 'string' },
      intro: { type: 'string' },
      notes: { type: 'string' },
      lead_id: { type: 'number' },
      customer_id: { type: 'number', description: 'Kunde aus dem Kundenstamm (prefillt Adresse/USt-IdNr.)' },
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
      // Prefill precedence: explicit client_name > customer > lead.
      const customer = a.customer_id != null ? getCustomer(Number(a.customer_id)) : null
      if (a.customer_id != null && !customer) return { error: `Kunde ${a.customer_id} nicht gefunden` }
      let leadId: number | null = customer?.lead_id ?? null
      let lead: LeadRow | undefined
      if (a.lead_id != null) {
        leadId = Number(a.lead_id)
        lead = getLeadRow(leadId)
        if (!lead) return { error: `Lead ${leadId} nicht gefunden` }
      }
      const clientName =
        (typeof a.client_name === 'string' && a.client_name.trim()) || customer?.name || lead?.company || null
      const info = db.prepare(
        `INSERT INTO documents (kind, lead_id, customer_id, client_name, client_address, client_zip, client_city,
           client_email, client_vat_id, client_type, title, intro, notes, small_business, vat_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        kind,
        leadId,
        customer?.id ?? null,
        clientName,
        customer?.address ?? null,
        customer?.zip ?? null,
        customer?.city ?? lead?.city ?? null,
        customer?.email ?? lead?.email ?? null,
        customer?.vat_id ?? null,
        customer?.client_type === 'privat' ? 'privat' : 'geschaeft',
        (a.title as string) ?? (kind === 'rechnung' ? 'Rechnung' : 'Angebot'),
        (a.intro as string) ?? null,
        (a.notes as string) ?? null,
        s.small_business,
        s.vat_rate,
      )
      const id = Number(info.lastInsertRowid)
      if (Array.isArray(a.items)) replaceItems(id, a.items as DocItemInput[])
      audit({ actor: ctx.actor, action: 'ai.create_document', entity: 'document', entityId: id, detail: { kind, customer_id: customer?.id ?? null }, ip: ctx.ip })
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

  // --- Leistungskatalog (reusable services/products) ---
  def(
    'list_catalog',
    'Liste den Leistungskatalog (wiederverwendbare Positionen mit Netto-Preis/Einheit/USt). ' +
      'Standardmäßig nur aktive Einträge.',
    obj({ include_inactive: { type: 'boolean', description: 'auch inaktive Einträge zeigen' } }),
    (a) => {
      const items = listCatalog(!a.include_inactive)
      return { count: items.length, items }
    },
  ),

  def(
    'create_catalog_item',
    'Lege eine wiederverwendbare Katalog-Position an (z. B. „Webdesign Stunde"). Preis ist NETTO ' +
      'in Cent. Diese Positionen können später in Angebote/Rechnungen übernommen werden.',
    obj({
      name: { type: 'string', description: 'Bezeichnung (Pflicht)' },
      description: { type: 'string', description: 'Langtext für die Belegzeile (Standard: name)' },
      unit: { type: 'string', description: 'Std / Stk / Pauschal / Monat …' },
      unit_price_cents: { type: 'number', description: 'Netto-Einzelpreis in Cent' },
      vat_rate: { type: 'number', enum: [0, 7, 19] },
      category: { type: 'string' },
    }, ['name']),
    (a, ctx) => {
      try {
        const item = createCatalogItem({
          name: a.name as string,
          description: (a.description as string) ?? null,
          unit: (a.unit as string) ?? null,
          unit_price_cents: Number(a.unit_price_cents ?? 0),
          vat_rate: Number(a.vat_rate ?? 19),
          category: (a.category as string) ?? null,
        })
        audit({ actor: ctx.actor, action: 'ai.create_catalog', entity: 'catalog', entityId: item.id, detail: { name: item.name }, ip: ctx.ip })
        return { ok: true, item }
      } catch (e) {
        return { error: (e as Error).message }
      }
    },
  ),

  // --- Verträge (contracts / AGB) ---
  def(
    'list_contracts',
    'Liste Verträge (neueste zuerst) mit Nummer, Art, Kunde, Status und Wert.',
    obj({ limit: { type: 'number', description: 'max. Treffer, Standard 20' } }),
    (a) => {
      const limit = Math.min(Number(a.limit ?? 20) || 20, 50)
      const contracts = listContracts().slice(0, limit)
      return { count: contracts.length, contracts }
    },
  ),

  def(
    'create_contract',
    'Erstelle einen Vertrags-ENTWURF (Dienst-/Werk-/Wartungsvertrag, Auftragsbestätigung, ' +
      'Rahmenvertrag, AVV). `value_cents` ist der Netto-Auftragswert. Optional einem Lead zuordnen ' +
      '(Kunde wird dann übernommen). Beim Festschreiben (`finalize_contract`) bekommt der Vertrag ' +
      'eine Nummer und die AGB aus den Einstellungen werden eingefroren. Nicht finalisiert.',
    obj({
      type: { type: 'string', enum: CONTRACT_TYPES.map((t) => t.id), description: 'Vertragsart' },
      title: { type: 'string' },
      client_name: { type: 'string', description: 'Auftraggeber (falls leer und lead_id gesetzt: Firma des Leads)' },
      intro: { type: 'string', description: 'Präambel (optional)' },
      body: { type: 'string', description: 'Vertragsgegenstand / Leistungsbeschreibung' },
      value_cents: { type: 'number', description: 'Netto-Auftragswert in Cent' },
      payment_terms: { type: 'string', description: 'Zahlungsmodalitäten (Freitext)' },
      start_date: { type: 'string', description: 'Laufzeitbeginn YYYY-MM-DD' },
      end_date: { type: 'string', description: 'Laufzeitende YYYY-MM-DD (leer = unbefristet)' },
      notice_period: { type: 'string', description: 'Kündigungsfrist (Freitext)' },
      lead_id: { type: 'number' },
      customer_id: { type: 'number', description: 'Kunde aus dem Kundenstamm (prefillt Auftraggeber/Adresse)' },
    }, ['title']),
    (a, ctx) => {
      const contract = createContract(
        {
          type: (a.type as string) ?? null,
          title: a.title as string,
          client_name: (a.client_name as string) ?? null,
          intro: (a.intro as string) ?? null,
          body: (a.body as string) ?? null,
          value_cents: Number(a.value_cents ?? 0),
          payment_terms: (a.payment_terms as string) ?? null,
          start_date: (a.start_date as string) ?? null,
          end_date: (a.end_date as string) ?? null,
          notice_period: (a.notice_period as string) ?? null,
          lead_id: a.lead_id != null ? Number(a.lead_id) : null,
          customer_id: a.customer_id != null ? Number(a.customer_id) : null,
        },
        ctx.actor,
      )
      audit({ actor: ctx.actor, action: 'ai.create_contract', entity: 'contract', entityId: contract.id, detail: { type: contract.type }, ip: ctx.ip })
      return { ok: true, contract }
    },
  ),

  def(
    'finalize_contract',
    'Schreibe einen Vertrags-Entwurf fest: vergibt eine fortlaufende Vertragsnummer und friert die ' +
      'aktuellen AGB in den Vertrag ein. Danach ist der Inhalt unveränderlich. Bestätige vorher im Klartext.',
    obj({ id: { type: 'number' } }, ['id']),
    (a, ctx) => {
      const contract = finalizeContract(Number(a.id))
      if (!contract) return { error: 'Vertrag nicht gefunden' }
      audit({ actor: ctx.actor, action: 'ai.finalize_contract', entity: 'contract', entityId: contract.id, detail: { number: contract.number }, ip: ctx.ip })
      return { ok: true, contract }
    },
  ),

  def(
    'contract_from_document',
    'Erzeuge aus einem Dokument (i. d. R. einem angenommenen Angebot) einen Vertrags-ENTWURF: ' +
      'Empfänger, Kunde/Lead, Netto-Wert und eine Leistungsbeschreibung aus den Positionen werden ' +
      'übernommen. Nicht finalisiert.',
    obj({ document_id: { type: 'number' } }, ['document_id']),
    (a, ctx) => {
      const contract = contractFromDocument(Number(a.document_id), ctx.actor)
      if (!contract) return { error: 'Dokument nicht gefunden' }
      audit({ actor: ctx.actor, action: 'ai.contract_from_document', entity: 'contract', entityId: contract.id, detail: { document_id: Number(a.document_id) }, ip: ctx.ip })
      return { ok: true, contract }
    },
  ),

  // --- Serienrechnungen (recurring billing templates) ---
  def(
    'list_recurring',
    'Liste Serienrechnungen (Abrechnungsvorlagen mit Turnus). Filterbar nach Kunde, Vertrag, aktiv. ' +
      'Jede Serie erzeugt periodisch einen Rechnungs-ENTWURF — nichts wird automatisch finalisiert.',
    obj({
      customer_id: { type: 'number' },
      contract_id: { type: 'number' },
      active_only: { type: 'boolean', description: 'nur aktive Serien (Standard: alle)' },
      limit: { type: 'number' },
    }),
    (a) => {
      const rows = listRecurring({
        customer_id: a.customer_id != null ? Number(a.customer_id) : undefined,
        contract_id: a.contract_id != null ? Number(a.contract_id) : undefined,
        active: a.active_only ? true : undefined,
      })
      const limit = Math.min(Number(a.limit ?? 30) || 30, 100)
      return {
        count: rows.length,
        recurring: rows.slice(0, limit).map((r) => ({
          id: r.id,
          title: r.title,
          client_name: r.client_name,
          cadence: r.cadence,
          next_run: r.next_run,
          active: r.active,
          customer_id: r.customer_id,
          contract_id: r.contract_id,
        })),
      }
    },
  ),

  def(
    'create_recurring',
    'Lege eine Serienrechnung (Abrechnungsvorlage) an — ENTWURF-Vorlage, die je Turnus eine ' +
      'Rechnungsentwurf erzeugt. Mit `contract_id` wird aus dem Vertrag prefilled (empfohlen für ' +
      'Wartungsverträge); sonst `customer_id` oder manuelle Empfängerfelder. Nicht auto-finalisiert.',
    obj({
      title: { type: 'string' },
      customer_id: { type: 'number' },
      contract_id: { type: 'number', description: 'Vertrag (z. B. Wartungsvertrag) — prefillt Empfänger/Wert' },
      cadence: { type: 'string', enum: ['monatlich', 'quartalsweise', 'jährlich'] },
      next_run: { type: 'string', description: 'YYYY-MM-DD nächster Lauf' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'number' },
            unit: { type: 'string' },
            unit_price_cents: { type: 'number' },
          },
        },
      },
    }),
    (a, ctx) => {
      try {
        const items = Array.isArray(a.items)
          ? (a.items as { description?: string; quantity?: number; unit?: string; unit_price_cents?: number }[])
          : undefined
        const recurring =
          a.contract_id != null
            ? recurringFromContract(Number(a.contract_id), {
                title: (a.title as string) ?? undefined,
                cadence: (a.cadence as string) ?? undefined,
                next_run: (a.next_run as string) ?? undefined,
                customer_id: a.customer_id != null ? Number(a.customer_id) : undefined,
                items,
              })
            : createRecurring({
                title: (a.title as string) ?? null,
                customer_id: a.customer_id != null ? Number(a.customer_id) : null,
                cadence: (a.cadence as string) ?? null,
                next_run: (a.next_run as string) ?? null,
                items,
              })
        audit({
          actor: ctx.actor,
          action: 'ai.create_recurring',
          entity: 'recurring',
          entityId: recurring.id,
          detail: { contract_id: recurring.contract_id, customer_id: recurring.customer_id },
          ip: ctx.ip,
        })
        return { ok: true, recurring }
      } catch (e) {
        return { error: (e as Error).message }
      }
    },
  ),

  // --- Kunden (customer registry) ---
  def(
    'list_customers',
    'Liste den Kundenstamm (Stammdaten für Belege). Standardmäßig nur aktive Kunden. Nutze die ' +
      '`id` als `customer_id` in `create_document`/`create_contract`, um Empfänger + Adresse zu übernehmen.',
    obj({ query: { type: 'string', description: 'Freitext über Name/Ort/E-Mail' }, include_inactive: { type: 'boolean' }, limit: { type: 'number' } }),
    (a) => {
      const q = typeof a.query === 'string' ? a.query.trim().toLowerCase() : ''
      let customers = listCustomers(!a.include_inactive)
      if (q) customers = customers.filter((c) => `${c.name} ${c.city ?? ''} ${c.email ?? ''}`.toLowerCase().includes(q))
      const limit = Math.min(Number(a.limit ?? 30) || 30, 100)
      return { count: customers.length, customers: customers.slice(0, limit) }
    },
  ),

  def(
    'create_customer',
    'Lege einen Kunden im Kundenstamm an (einmalig pflegen, in Belegen wiederverwenden). Nur `name` ' +
      'ist Pflicht. Danach kann der Kunde per `customer_id` in Angebot/Rechnung/Vertrag übernommen werden.',
    obj({
      name: { type: 'string', description: 'Firma oder Name (Pflicht)' },
      contact_name: { type: 'string', description: 'Ansprechpartner' },
      address: { type: 'string' },
      zip: { type: 'string' },
      city: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      vat_id: { type: 'string', description: 'USt-IdNr.' },
      client_type: { type: 'string', enum: ['geschaeft', 'privat'] },
      lead_id: { type: 'number', description: 'optional: aus diesem Lead entstanden' },
    }, ['name']),
    (a, ctx) => {
      try {
        const customer = createCustomer({
          name: a.name as string,
          contact_name: (a.contact_name as string) ?? null,
          address: (a.address as string) ?? null,
          zip: (a.zip as string) ?? null,
          city: (a.city as string) ?? null,
          email: (a.email as string) ?? null,
          phone: (a.phone as string) ?? null,
          vat_id: (a.vat_id as string) ?? null,
          client_type: (a.client_type as string) ?? null,
          lead_id: a.lead_id != null ? Number(a.lead_id) : null,
        })
        audit({ actor: ctx.actor, action: 'ai.create_customer', entity: 'customer', entityId: customer.id, detail: { name: customer.name }, ip: ctx.ip })
        return { ok: true, customer }
      } catch (e) {
        return { error: (e as Error).message }
      }
    },
  ),

  def(
    'get_settings',
    'Lies das Geschäftsprofil (Absenderdaten, §19-Status, USt-Satz, Zahlungsziel, Standard-Stundensatz).',
    obj({}),
    () => {
      const s = getSettings()
      return {
        business_name: s.business_name, owner: s.owner, city: s.city, email: s.email,
        small_business: !!s.small_business, vat_rate: s.vat_rate, payment_terms: s.payment_terms,
        agb_set: !!(s.agb_text && s.agb_text.trim()),
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
