import { db, STAGES, PRIORITIES, normalizeDomain, type LeadRow } from './db'
import { emit } from './events'

// Shared lead create/update logic, extracted from index.ts so the routes reuse
// one implementation and domain events are emitted from a single place. emit()
// is a non-throwing no-op now (the webhook subsystem was removed).

// Fields a client may set on a lead (besides stage, handled separately).
export const EDITABLE = new Set([
  'company', 'trade', 'city', 'website', 'phone', 'email',
  'mobile_friendly', 'tech', 'staleness_signal', 'score', 'priority',
  'why_lead', 'notes', 'assigned_to', 'tags',
])

// Tags arrive as a comma-separated string; trim, drop blanks, and de-dupe
// (case-insensitive) so the stored value stays tidy. Empty → NULL.
export function normalizeTags(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input.split(',')) {
    const t = raw.trim()
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
  }
  return out.length ? out.join(',') : null
}

// Insert one lead. Dedupes by registrable domain so already-known businesses are
// never re-added. Shared by the create endpoint, the public API, and the xlsx
// import. Emits 'lead.created' only on a genuine insert (never on a dedupe hit).
export function insertLead(
  b: Record<string, unknown>,
  actor: string,
): { id: number; deduped?: boolean } {
  const domain = normalizeDomain((b.domain as string) ?? (b.website as string))
  if (domain) {
    const existing = db.prepare('SELECT id FROM leads WHERE domain = ?').get(domain) as unknown as
      | { id: number }
      | undefined
    if (existing) return { id: existing.id, deduped: true }
  }
  const info = db
    .prepare(
      `INSERT INTO leads
        (domain, company, trade, city, website, phone, email, mobile_friendly,
         tech, staleness_signal, score, priority, why_lead, stage, source)
       VALUES
        (@domain, @company, @trade, @city, @website, @phone, @email, @mobile_friendly,
         @tech, @staleness_signal, @score, @priority, @why_lead, @stage, @source)`,
    )
    .run({
      domain,
      company: (b.company as string) ?? null,
      trade: (b.trade as string) ?? null,
      city: (b.city as string) ?? null,
      website: (b.website as string) ?? null,
      phone: (b.phone as string) ?? null,
      email: (b.email as string) ?? null,
      mobile_friendly:
        b.mobile_friendly === undefined || b.mobile_friendly === null
          ? null
          : b.mobile_friendly
            ? 1
            : 0,
      tech: (b.tech as string) ?? null,
      staleness_signal: (b.staleness_signal as string) ?? null,
      score: Number(b.score ?? 0),
      priority: PRIORITIES.includes(b.priority as never) ? (b.priority as string) : 'mittel',
      why_lead: (b.why_lead as string) ?? null,
      stage: 'neu',
      source: (b.source as string) ?? 'manual',
    })
  const id = Number(info.lastInsertRowid)
  db.prepare(
    `INSERT INTO lead_events (lead_id, actor, type, to_stage, body)
     VALUES (?, ?, 'created', 'neu', ?)`,
  ).run(id, actor, `Quelle: ${(b.source as string) ?? 'manual'}`)
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as LeadRow
  emit('lead.created', { id, lead })
  return { id }
}

/**
 * Apply an edit to a lead. Returns the (possibly unchanged) lead, or null if the
 * id is unknown. Throws Error('invalid stage') for an unknown stage so callers
 * can map it to a 400. Mirrors the original PATCH /api/leads/:id behaviour
 * exactly, plus emits 'lead.stage_changed' on a stage move.
 */
export function applyLeadUpdate(
  id: number,
  b: Record<string, unknown>,
  actor: string,
): LeadRow | null {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as
    | LeadRow
    | undefined
  if (!lead) return null

  // Validate the stage up front (before any write) so an invalid stage is a clean
  // 400 with nothing persisted.
  const stageChanging = typeof b.stage === 'string' && b.stage !== lead.stage
  if (stageChanging && !STAGES.includes(b.stage as never)) throw new Error('invalid stage')

  const sets: string[] = []
  const params: Record<string, string | number | null> = { id }
  if (stageChanging) {
    sets.push('stage = @stage')
    params.stage = b.stage as string
  }

  for (const key of Object.keys(b)) {
    if (!EDITABLE.has(key)) continue
    const v = b[key]
    // node:sqlite binds only string | number | null. Coerce booleans, null/undefined
    // and tags; SKIP any non-scalar (object/array) value rather than letting the
    // bind throw a raw SQLite error out to the client.
    let bound: string | number | null
    if (key === 'tags') bound = normalizeTags(v)
    else if (v === undefined || v === null) bound = null
    else if (typeof v === 'boolean') bound = v ? 1 : 0
    else if (typeof v === 'string' || typeof v === 'number') bound = v
    else continue
    sets.push(`${key} = @${key}`)
    params[key] = bound
  }

  if (sets.length === 0) return lead

  sets.push("updated_at = datetime('now')")
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = @id`).run(params)

  // Side effects fire only AFTER the row write commits, so a failed UPDATE never
  // leaves a phantom stage-change event or an enqueued webhook for a move that
  // didn't actually happen.
  if (stageChanging) {
    db.prepare(
      `INSERT INTO lead_events (lead_id, actor, type, from_stage, to_stage)
       VALUES (?, ?, 'stage_change', ?, ?)`,
    ).run(id, actor, lead.stage, b.stage as string)
    emit('lead.stage_changed', { id, from: lead.stage, to: b.stage })
  }
  if (typeof b.notes === 'string' && b.notes !== (lead.notes ?? '')) {
    db.prepare(
      `INSERT INTO lead_events (lead_id, actor, type, body) VALUES (?, ?, 'note', ?)`,
    ).run(id, actor, b.notes)
  }

  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as LeadRow
}
