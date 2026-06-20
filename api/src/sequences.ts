import { db, type LeadRow, type OutreachRow, type OutreachSequenceRow } from './db'
import { draftOutreach } from './ai/leadIntel'

// Follow-up sequences. A sequence walks one lead through ordered steps; when a
// step falls due the scheduler drafts an outreach (status 'entwurf') that a
// human still approves and sends. Sending a step's draft advances the schedule
// to the next step — so the cadence is measured from the actual send, and
// nothing ever leaves the building without approval (same gate as a single
// outreach). Replies aren't auto-detected; the operator pauses or stops.

export interface SequenceStep {
  delay_days: number
  channel: 'email' | 'letter' | 'call_script'
  instruction?: string
}

// Built-in templates so "Sequenz starten" is one click. delay_days on step 0 is
// 0 (draft now); later steps count days after the *previous step was sent*.
export const SEQUENCE_TEMPLATES: Record<string, { name: string; steps: SequenceStep[] }> = {
  standard3: {
    name: 'Standard (3 Schritte)',
    steps: [
      { delay_days: 0, channel: 'email', instruction: 'Erstansprache' },
      { delay_days: 4, channel: 'email', instruction: 'freundlicher Nachfass, kurz' },
      { delay_days: 7, channel: 'email', instruction: 'letzter, sehr kurzer Versuch, danach Ruhe' },
    ],
  },
  kurz2: {
    name: 'Kurz (2 Schritte)',
    steps: [
      { delay_days: 0, channel: 'email', instruction: 'Erstansprache' },
      { delay_days: 5, channel: 'email', instruction: 'einmaliger kurzer Nachfass' },
    ],
  },
}

const today = () => new Date().toISOString().slice(0, 10)

/** Add whole days to a YYYY-MM-DD date (UTC). */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function parseSteps(raw: string): SequenceStep[] {
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as SequenceStep[]) : []
  } catch {
    return []
  }
}

/** Normalise + validate incoming steps. Throws on an empty/invalid list. */
export function sanitizeSteps(input: unknown): SequenceStep[] {
  if (!Array.isArray(input)) throw new Error('Schritte fehlen.')
  const steps = input.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>
    const channel = o.channel === 'letter' || o.channel === 'call_script' ? o.channel : 'email'
    const delay = Math.max(0, Math.round(Number(o.delay_days ?? 0)) || 0)
    const instruction = typeof o.instruction === 'string' ? o.instruction.slice(0, 200) : undefined
    return { delay_days: delay, channel, instruction } as SequenceStep
  })
  if (steps.length === 0 || steps.length > 8) throw new Error('Eine Sequenz hat 1–8 Schritte.')
  return steps
}

export function listSequences(leadId: number): OutreachSequenceRow[] {
  return db
    .prepare('SELECT * FROM outreach_sequences WHERE lead_id = ? ORDER BY created_at DESC')
    .all(leadId) as unknown as OutreachSequenceRow[]
}

export function getSequence(id: number): OutreachSequenceRow | null {
  return (
    (db.prepare('SELECT * FROM outreach_sequences WHERE id = ?').get(id) as unknown as
      | OutreachSequenceRow
      | undefined) ?? null
  )
}

export function createSequence(leadId: number, steps: SequenceStep[], name?: string): OutreachSequenceRow {
  const info = db
    .prepare(
      `INSERT INTO outreach_sequences (lead_id, name, steps, step_index, next_run, status)
       VALUES (?, ?, ?, 0, ?, 'aktiv')`,
    )
    .run(leadId, name ?? null, JSON.stringify(steps), today())
  return getSequence(Number(info.lastInsertRowid))!
}

const VALID_STATUS = new Set(['aktiv', 'pausiert', 'fertig', 'gestoppt'])

export function setSequenceStatus(id: number, status: string): OutreachSequenceRow | null {
  if (!VALID_STATUS.has(status)) return getSequence(id)
  const seq = getSequence(id)
  if (!seq) return null
  // Resuming a sequence whose next_run is in the past re-arms it for the next tick.
  const next = status === 'aktiv' && seq.next_run < today() ? today() : seq.next_run
  db.prepare("UPDATE outreach_sequences SET status = ?, next_run = ?, updated_at = datetime('now') WHERE id = ?").run(
    status,
    next,
    id,
  )
  return getSequence(id)
}

export function deleteSequence(id: number): boolean {
  return db.prepare('DELETE FROM outreach_sequences WHERE id = ?').run(id).changes > 0
}

/** Has the current step already been drafted? (any status — a discarded draft
 *  parks the sequence; the operator stops it rather than auto-redrafting). */
function stepDrafted(seqId: number, step: number): boolean {
  const r = db
    .prepare('SELECT 1 FROM outreach WHERE sequence_id = ? AND seq_step = ? LIMIT 1')
    .get(seqId, step)
  return !!r
}

/**
 * If a sequence's current step is due and not yet drafted, draft it. Returns the
 * new outreach draft, or null when nothing was due. Marks the sequence 'fertig'
 * once every step has been worked through.
 */
export async function materializeDueStep(
  seq: OutreachSequenceRow,
  actor: string,
  when: string = today(),
): Promise<OutreachRow | null> {
  if (seq.status !== 'aktiv') return null
  const steps = parseSteps(seq.steps)
  if (seq.step_index >= steps.length) {
    db.prepare("UPDATE outreach_sequences SET status = 'fertig', updated_at = datetime('now') WHERE id = ?").run(seq.id)
    return null
  }
  if (seq.next_run > when) return null
  if (stepDrafted(seq.id, seq.step_index)) return null
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(seq.lead_id) as unknown as LeadRow | undefined
  if (!lead) return null
  const step = steps[seq.step_index]
  return draftOutreach(lead, actor, step.channel, {
    sequenceId: seq.id,
    step: seq.step_index,
    instruction: step.instruction,
  })
}

/**
 * Advance a sequence after one of its drafts is sent: move to the next step and
 * schedule it `delay_days` after the send. Called from the outreach send route.
 * Best-effort — never let a sequence hiccup fail a successful send.
 */
export function advanceAfterSend(sent: OutreachRow, when: string = today()): void {
  if (sent.sequence_id == null || sent.seq_step == null) return
  const seq = getSequence(sent.sequence_id)
  if (!seq || seq.status !== 'aktiv') return
  const steps = parseSteps(seq.steps)
  const nextIndex = sent.seq_step + 1
  if (nextIndex >= steps.length) {
    db.prepare("UPDATE outreach_sequences SET step_index = ?, status = 'fertig', updated_at = datetime('now') WHERE id = ?").run(
      nextIndex,
      seq.id,
    )
    return
  }
  db.prepare("UPDATE outreach_sequences SET step_index = ?, next_run = ?, updated_at = datetime('now') WHERE id = ?").run(
    nextIndex,
    addDays(when, steps[nextIndex].delay_days),
    seq.id,
  )
}

/** Draft the due step for every active sequence. Per-sequence errors are
 *  swallowed (e.g. model offline) so one bad lead never blocks the rest. */
export async function processDueSequences(
  actor = 'system',
  when: string = today(),
): Promise<{ drafted: number }> {
  const due = db
    .prepare("SELECT * FROM outreach_sequences WHERE status = 'aktiv' AND next_run <= ? ORDER BY next_run, id")
    .all(when) as unknown as OutreachSequenceRow[]
  let drafted = 0
  for (const seq of due) {
    try {
      if (await materializeDueStep(seq, actor, when)) drafted++
    } catch {
      // model offline or transient — try again on the next tick
    }
  }
  return { drafted }
}
