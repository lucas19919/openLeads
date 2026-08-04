import { db, type LeadRow, type LeadFactRow } from './db'
import { audit } from './audit'

// The evidence ledger.
//
// The rule the whole module exists to enforce: never overwrite something a human
// put there. The AI may *observe* — "the Impressum says the Firma is X" — and an
// observation is worth keeping whether or not it wins. What it may not do is
// quietly replace a value the operator typed, because a confidently wrong field
// costs more than an empty one.
//
// Provenance is derived, not stored on the lead: a lead value counts as
// machine-set only if some earlier applied fact carries exactly that value.
// Anything else — imported, typed, edited in the UI — is human and untouchable.

/** Evidence strength, borrowed from the classic identity-resolution split. */
export const EVIDENCE_KINDS = ['primary', 'supporting', 'contradiction'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/** Status of a recorded fact. German, because it surfaces in the UI. */
export const FACT_STATUSES = ['offen', 'uebernommen', 'verworfen', 'widersprochen'] as const
export type FactStatus = (typeof FACT_STATUSES)[number]

/**
 * What a fact may be *about*. Fields with a `column` write through to the lead
 * when the evidence is strong enough. The rest are ledger-only: a German
 * Impressum hands you the USt-IdNr., the Handelsregister entry and the
 * Geschäftsführer, none of which the leads table has a home for — but all of
 * which you want on hand the moment the lead becomes a Kunde.
 */
export const FACT_FIELDS = {
  company: { column: 'company', label: 'Firma' },
  trade: { column: 'trade', label: 'Gewerk' },
  city: { column: 'city', label: 'Ort' },
  website: { column: 'website', label: 'Website' },
  email: { column: 'email', label: 'E-Mail' },
  phone: { column: 'phone', label: 'Telefon' },
  tech: { column: 'tech', label: 'Technik' },
  mobile_friendly: { column: 'mobile_friendly', label: 'Mobilfähig' },
  staleness_signal: { column: 'staleness_signal', label: 'Veraltungs-Signal' },
  legal_form: { column: null, label: 'Rechtsform' },
  owner: { column: null, label: 'Inhaber/Geschäftsführung' },
  address: { column: null, label: 'Straße und Hausnummer' },
  zip: { column: null, label: 'PLZ' },
  vat_id: { column: null, label: 'USt-IdNr.' },
  register: { column: null, label: 'Handelsregister' },
} as const

export type FactField = keyof typeof FACT_FIELDS
export const FACT_FIELD_NAMES = Object.keys(FACT_FIELDS) as FactField[]

export function isFactField(v: unknown): v is FactField {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FACT_FIELDS, v)
}

export interface RecordFactInput {
  lead_id: number
  field: FactField
  /** The claim exactly as the source stated it — not a normalised or inferred form. */
  value: string
  evidence: EvidenceKind
  /** One line a salesperson would understand: what the source actually said. */
  detail: string
  source_url?: string | null
  /** Where it came from, e.g. `impressum.parse`, `website.meta`, `tech.probe`, `model`. */
  method: string
  actor?: string
}

export interface RecordFactResult {
  fact: LeadFactRow
  /** Did the lead row change as a result? */
  applied: boolean
  status: FactStatus
  /** Why it was applied / held back — fed straight back to the model. */
  reason: string
}

/** `mobile_friendly` is an INTEGER column; everything else is text. */
function toColumnValue(field: FactField, value: string): string | number | null {
  if (field !== 'mobile_friendly') return value
  if (/^(ja|yes|true|1)$/i.test(value.trim())) return 1
  if (/^(nein|no|false|0)$/i.test(value.trim())) return 0
  return null
}

/** Render a lead's stored column value back into comparable text. */
function fromColumnValue(field: FactField, raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (field === 'mobile_friendly') return raw === 1 || raw === '1' ? 'ja' : raw === 0 || raw === '0' ? 'nein' : ''
  return String(raw).trim()
}

function sameValue(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Was the lead's current value written by an earlier fact from this ledger?
 * If yes we may refine it; if no, a human owns it and we keep our hands off.
 */
function isMachineSet(leadId: number, field: FactField, current: string): boolean {
  if (!current) return false
  const rows = db
    .prepare("SELECT value FROM lead_facts WHERE lead_id = ? AND field = ? AND status = 'uebernommen'")
    .all(leadId, field) as unknown as { value: string }[]
  return rows.some((r) => sameValue(r.value, current))
}

function getLead(id: number): LeadRow | undefined {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as LeadRow | undefined
}

/**
 * Record an observation about a lead and decide what it may do to the record.
 *
 * The decision table:
 *   contradiction            → stored as `widersprochen`, never written through
 *   field is empty  + primary→ written through (`uebernommen`)
 *   field is empty  + support→ held as a suggestion (`offen`)
 *   value already matches    → confirmed, no write needed (`uebernommen`)
 *   differs, machine-set     → primary refines it; supporting stays a suggestion
 *   differs, human-set       → always a suggestion, however strong the evidence
 */
export function recordFact(input: RecordFactInput): RecordFactResult {
  const lead = getLead(input.lead_id)
  if (!lead) throw new Error('Lead nicht gefunden')

  const value = String(input.value ?? '').trim()
  if (!value) throw new Error('Ein Fakt braucht einen Wert')
  const detail = String(input.detail ?? '').trim()
  if (!detail) throw new Error('Ein Fakt braucht einen Beleg (detail): was stand da genau?')

  const spec = FACT_FIELDS[input.field]
  const column = spec.column as string | null
  const current = column ? fromColumnValue(input.field, (lead as unknown as Record<string, unknown>)[column]) : ''

  let status: FactStatus
  let reason: string

  if (input.evidence === 'contradiction') {
    status = 'widersprochen'
    reason = `Widerspruch zu „${current || '—'}" vermerkt. Feld bleibt unverändert, bis ein Mensch entscheidet.`
  } else if (!column) {
    // Ledger-only field: nothing to write through to, but worth keeping.
    status = input.evidence === 'primary' ? 'uebernommen' : 'offen'
    reason =
      input.evidence === 'primary'
        ? `${spec.label} vermerkt (kein Lead-Feld — wird beim Anlegen als Kunde übernommen).`
        : `${spec.label} als Vorschlag vermerkt (Beleg nur mittelbar).`
  } else if (!current) {
    if (input.evidence === 'primary') {
      status = 'uebernommen'
      reason = `${spec.label} war leer und der Beleg ist direkt — übernommen.`
    } else {
      status = 'offen'
      reason = `${spec.label} war leer, aber der Beleg ist nur mittelbar — als Vorschlag hinterlegt.`
    }
  } else if (sameValue(current, value)) {
    status = 'uebernommen'
    reason = `${spec.label} war bereits korrekt — bestätigt, nichts geändert.`
  } else if (isMachineSet(input.lead_id, input.field, current)) {
    if (input.evidence === 'primary') {
      status = 'uebernommen'
      reason = `${spec.label} stammte aus einer früheren Recherche und wurde durch den direkten Beleg ersetzt.`
    } else {
      status = 'offen'
      reason = `${spec.label} weicht ab, der Beleg ist aber nur mittelbar — als Vorschlag hinterlegt.`
    }
  } else {
    status = 'offen'
    reason = `${spec.label} wurde von Hand gesetzt („${current}") — nicht überschrieben, als Vorschlag hinterlegt.`
  }

  const info = db
    .prepare(
      `INSERT INTO lead_facts (lead_id, field, value, evidence, detail, source_url, method, status, actor)
       VALUES (@lead_id, @field, @value, @evidence, @detail, @source_url, @method, @status, @actor)`,
    )
    .run({
      lead_id: input.lead_id,
      field: input.field,
      value,
      evidence: input.evidence,
      detail,
      source_url: input.source_url ?? null,
      method: input.method,
      status,
      actor: input.actor ?? 'ai',
    })
  const factId = Number(info.lastInsertRowid)

  // Write through only when the grading said so *and* there is something to write.
  let applied = false
  if (status === 'uebernommen' && column && !sameValue(current, value)) {
    const col = toColumnValue(input.field, value)
    if (col !== null) {
      db.prepare(`UPDATE leads SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`).run(col, input.lead_id)
      applied = true
    }
  }

  if (applied) {
    audit({
      actor: input.actor ?? 'ai',
      action: 'fact.apply',
      entity: 'lead',
      entityId: input.lead_id,
      detail: { field: input.field, value, method: input.method, source_url: input.source_url ?? null },
    })
  }

  return { fact: getFact(factId)!, applied, status, reason }
}

export function getFact(id: number): LeadFactRow | undefined {
  return db.prepare('SELECT * FROM lead_facts WHERE id = ?').get(id) as unknown as LeadFactRow | undefined
}

export interface ListFactsOptions {
  field?: FactField
  status?: FactStatus
  limit?: number
}

export function listFacts(leadId: number, opts: ListFactsOptions = {}): LeadFactRow[] {
  const clauses = ['lead_id = ?']
  const params: (string | number)[] = [leadId]
  if (opts.field) {
    clauses.push('field = ?')
    params.push(opts.field)
  }
  if (opts.status) {
    clauses.push('status = ?')
    params.push(opts.status)
  }
  const limit = Math.min(Math.max(Number(opts.limit ?? 50) || 50, 1), 200)
  return db
    .prepare(`SELECT * FROM lead_facts WHERE ${clauses.join(' AND ')} ORDER BY observed_at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as unknown as LeadFactRow[]
}

/** The open suggestions across the pipeline — what the UI shows for review. */
export function pendingFacts(limit = 50): (LeadFactRow & { company: string | null })[] {
  return db
    .prepare(
      `SELECT f.*, l.company FROM lead_facts f
       JOIN leads l ON l.id = f.lead_id
       WHERE f.status IN ('offen', 'widersprochen')
       ORDER BY f.observed_at DESC, f.id DESC LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 200)) as unknown as (LeadFactRow & { company: string | null })[]
}

/**
 * A human's verdict on a suggestion. Accepting writes the value through even if
 * the evidence was weak — the operator has overruled the grading, which is the
 * whole point of surfacing it.
 */
export function resolveFact(id: number, accept: boolean, actor: string): RecordFactResult {
  const fact = getFact(id)
  if (!fact) throw new Error('Fakt nicht gefunden')
  if (fact.status === 'uebernommen' || fact.status === 'verworfen') {
    throw new Error('Dieser Fakt wurde bereits entschieden')
  }
  if (!isFactField(fact.field)) throw new Error('Unbekanntes Feld')

  const status: FactStatus = accept ? 'uebernommen' : 'verworfen'
  db.prepare('UPDATE lead_facts SET status = ? WHERE id = ?').run(status, id)

  let applied = false
  const column = FACT_FIELDS[fact.field].column as string | null
  if (accept && column) {
    const col = toColumnValue(fact.field, fact.value)
    if (col !== null) {
      db.prepare(`UPDATE leads SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`).run(col, fact.lead_id)
      applied = true
    }
  }
  audit({
    actor,
    action: accept ? 'fact.accept' : 'fact.reject',
    entity: 'lead',
    entityId: fact.lead_id,
    detail: { field: fact.field, value: fact.value, fact_id: id },
  })
  return {
    fact: getFact(id)!,
    applied,
    status,
    reason: accept ? 'Vom Menschen übernommen.' : 'Vom Menschen verworfen.',
  }
}

/**
 * Everything known about a lead that the leads table has no column for —
 * used when promoting a lead to a Kunde so the Impressum's USt-IdNr. and
 * address don't have to be typed again.
 */
export function ledgerOnlyFacts(leadId: number): Record<string, string> {
  const out: Record<string, string> = {}
  const rows = db
    .prepare("SELECT field, value FROM lead_facts WHERE lead_id = ? AND status = 'uebernommen' ORDER BY id")
    .all(leadId) as unknown as { field: string; value: string }[]
  for (const r of rows) {
    if (isFactField(r.field) && FACT_FIELDS[r.field].column === null) out[r.field] = r.value
  }
  return out
}
