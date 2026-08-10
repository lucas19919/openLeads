import { createHash } from 'node:crypto'
import {
  db,
  APPROVAL_ACTIONS,
  type ApprovalAction,
  type ApprovalRow,
  type ApprovalStatus,
} from './db'
import { getDocument, getSettings } from './documents'
import { getContract } from './contracts'

// Freigaben — the gate in front of the one-way doors.
//
// An agent can do everything reversible on its own: draft an Angebot, price a
// Rechnung, correct a position, throw the draft away. It cannot walk through a
// door that does not swing back. Festschreiben consumes a gapless number and
// freezes the document (§14 UStG / GoBD); Versenden puts a PDF in someone's
// inbox. Both need a human to look at the actual paper and say yes.
//
// The properties that make this a gate rather than a formality:
//
//   bound to content — the approval carries a fingerprint of exactly what was
//                      shown. Change a line item afterwards and the fingerprint
//                      no longer matches, so the approval no longer applies.
//   single use       — consumed on the act; a granted approval is not a standing
//                      permission to finalise that document again later.
//   time boxed       — an approval nobody used expires; yesterday's yes is not
//                      today's yes.
//   decided by a person — only an interactive login may decide. An API token can
//                      request, never grant (see routes/approvals.ts).

/** How long a request (and a grant) stays good. Operator-tunable. */
const DEFAULT_TTL_MINUTES = 24 * 60

function ttlMinutes(): number {
  const raw = Number(process.env.CRM_APPROVAL_TTL_MINUTES)
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 60 * 24 * 30) : DEFAULT_TTL_MINUTES
}

export function isApprovalAction(v: unknown): v is ApprovalAction {
  return typeof v === 'string' && (APPROVAL_ACTIONS as readonly string[]).includes(v)
}

/** Plain-language label for a request, so a human is not reading dotted keys. */
export const ACTION_LABELS: Record<ApprovalAction, string> = {
  'document.finalize': 'Festschreiben (Nummer vergeben, Inhalt einfrieren)',
  'document.send': 'Per E-Mail an den Kunden senden',
  'contract.finalize': 'Vertrag festschreiben (Nummer vergeben, AGB einfrieren)',
  'contract.send': 'Vertrag per E-Mail an den Kunden senden',
}

const ENTITY_OF: Record<ApprovalAction, 'document' | 'contract'> = {
  'document.finalize': 'document',
  'document.send': 'document',
  'contract.finalize': 'contract',
  'contract.send': 'contract',
}

export function entityOfAction(action: ApprovalAction): 'document' | 'contract' {
  return ENTITY_OF[action]
}

export class ApprovalError extends Error {
  /** HTTP status the route should answer with. */
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

// --- what the human is shown, and what the yes is bound to -------------------

export interface ApprovalSummary {
  action: ApprovalAction
  label: string
  entity: 'document' | 'contract'
  entity_id: number
  title: string
  recipient: string | null
  recipient_email: string | null
  gross_cents: number
  /** Present once issued; null while it is still a draft. */
  number: string | null
  /** One line per position, so the yes is given to real content, not an id. */
  lines: string[]
  /** Extra caveats worth reading before saying yes (e.g. a Storno). */
  warnings: string[]
}

const euro = (cents: number) => (cents / 100).toFixed(2).replace('.', ',') + ' €'

/**
 * Everything a decision rests on, as a stable object. The fingerprint is taken
 * over this, so any change that would alter what the human read invalidates the
 * approval — that is the whole point.
 */
function buildSummary(action: ApprovalAction, entityId: number): ApprovalSummary {
  return ENTITY_OF[action] === 'document'
    ? documentSummary(action, entityId)
    : contractSummary(action, entityId)
}

function documentSummary(action: ApprovalAction, id: number): ApprovalSummary {
  const doc = getDocument(id)
  if (!doc) throw new ApprovalError('Dokument nicht gefunden.', 404)
  const warnings: string[] = []
  const kindLabel = doc.kind === 'rechnung' ? 'Rechnung' : 'Angebot'

  if (action === 'document.finalize') {
    if (doc.number)
      throw new ApprovalError(
        `${kindLabel} ${doc.number} ist bereits festgeschrieben — keine Freigabe nötig.`,
      )
    const s = getSettings()
    const next = doc.kind === 'rechnung' ? s.rechnung_next : s.angebot_next
    const prefix = doc.kind === 'rechnung' ? s.rechnung_prefix : s.angebot_prefix
    // "aktuell", not a promise: another invoice issued in the meantime takes
    // this number and moves the counter on. The fingerprint deliberately does
    // not cover the counter, so that does not invalidate the decision.
    warnings.push(
      `Vergibt die nächste freie Nummer (aktuell ${prefix}${new Date().getFullYear()}-${String(next).padStart(4, '0')}). ` +
        'Danach ist der Inhalt unveränderlich (GoBD) und die Nummer verbraucht.',
    )
    if (doc.corrects_document_id != null) {
      const orig = getDocument(doc.corrects_document_id)
      warnings.push(
        `Stornorechnung: setzt Rechnung ${orig?.number ?? `#${doc.corrects_document_id}`} auf storniert.`,
      )
    }
    if (doc.items.length === 0) warnings.push('Das Dokument hat keine Positionen.')
  }

  if (action === 'document.send') {
    if (!doc.number)
      throw new ApprovalError('Nur festgeschriebene Dokumente können versendet werden.')
    if (!doc.client_email)
      throw new ApprovalError('Kein Empfänger (E-Mail) am Dokument hinterlegt.')
    warnings.push(`Verschickt eine E-Mail mit PDF an ${doc.client_email}. Nicht zurückholbar.`)
  }

  return {
    action,
    label: ACTION_LABELS[action],
    entity: 'document',
    entity_id: doc.id,
    title: `${kindLabel}${doc.number ? ` ${doc.number}` : ' (Entwurf)'}: ${doc.title ?? ''}`.trim(),
    recipient: doc.client_name,
    recipient_email: doc.client_email,
    gross_cents: doc.totals.gross_cents,
    number: doc.number,
    lines: doc.items.map(
      (it) =>
        `${it.quantity} ${it.unit ?? 'x'} · ${it.description ?? '—'} · ${euro(
          Math.round(it.quantity * it.unit_price_cents),
        )}`,
    ),
    warnings,
  }
}

function contractSummary(action: ApprovalAction, id: number): ApprovalSummary {
  const contract = getContract(id)
  if (!contract) throw new ApprovalError('Vertrag nicht gefunden.', 404)
  const warnings: string[] = []

  if (action === 'contract.finalize') {
    if (contract.number)
      throw new ApprovalError(
        `Vertrag ${contract.number} ist bereits festgeschrieben — keine Freigabe nötig.`,
      )
    warnings.push(
      'Vergibt eine Vertragsnummer und friert die aktuell geltenden AGB in den Vertrag ein.',
    )
  }

  if (action === 'contract.send') {
    if (!contract.number)
      throw new ApprovalError('Nur festgeschriebene Verträge können versendet werden.')
    if (!contract.client_email) throw new ApprovalError('Kein Empfänger (E-Mail) am Vertrag hinterlegt.')
    warnings.push(`Verschickt den Vertrag als PDF an ${contract.client_email}. Nicht zurückholbar.`)
  }

  return {
    action,
    label: ACTION_LABELS[action],
    entity: 'contract',
    entity_id: contract.id,
    title: `Vertrag${contract.number ? ` ${contract.number}` : ' (Entwurf)'}: ${contract.title ?? ''}`.trim(),
    recipient: contract.client_name,
    recipient_email: contract.client_email,
    gross_cents: contract.totals.gross_cents,
    number: contract.number,
    lines: [
      `${contract.type} · ${contract.start_date ?? 'ohne Beginn'} – ${contract.end_date ?? 'unbefristet'}`,
      `Wert: ${euro(contract.totals.gross_cents)}`,
    ],
    warnings,
  }
}

/**
 * The hash the yes is bound to. Deliberately covers the *content* of the act —
 * recipient, positions, amounts, term — and not volatile bookkeeping fields like
 * updated_at, so re-saving a draft without changing anything does not silently
 * revoke a grant.
 */
function fingerprint(action: ApprovalAction, entityId: number): string {
  const material: unknown =
    ENTITY_OF[action] === 'document' ? documentMaterial(entityId) : contractMaterial(entityId)
  return createHash('sha256').update(`${action}|${JSON.stringify(material)}`).digest('hex')
}

function documentMaterial(id: number) {
  const d = getDocument(id)
  if (!d) throw new ApprovalError('Dokument nicht gefunden.', 404)
  return {
    kind: d.kind,
    number: d.number,
    client: [d.client_name, d.client_address, d.client_zip, d.client_city, d.client_email, d.client_vat_id],
    client_type: d.client_type,
    title: d.title,
    intro: d.intro,
    notes: d.notes,
    due_date: d.due_date,
    small_business: d.small_business,
    vat_rate: d.vat_rate,
    corrects: d.corrects_document_id,
    items: d.items.map((it) => [it.description, it.quantity, it.unit, it.unit_price_cents]),
    totals: d.totals,
  }
}

function contractMaterial(id: number) {
  const k = getContract(id)
  if (!k) throw new ApprovalError('Vertrag nicht gefunden.', 404)
  return {
    number: k.number,
    type: k.type,
    client: [k.client_name, k.client_address, k.client_zip, k.client_city, k.client_email],
    title: k.title,
    intro: k.intro,
    body: k.body,
    value_cents: k.value_cents,
    small_business: k.small_business,
    vat_rate: k.vat_rate,
    payment_terms: k.payment_terms,
    term: [k.start_date, k.end_date, k.notice_period],
  }
}

// --- store -------------------------------------------------------------------

export interface Approval extends Omit<ApprovalRow, 'summary'> {
  summary: ApprovalSummary
  /** True when the content still matches what was approved. */
  content_unchanged?: boolean
}

function hydrate(row: ApprovalRow): Approval {
  let summary: ApprovalSummary
  try {
    summary = JSON.parse(row.summary) as ApprovalSummary
  } catch {
    // A row written by an older/incompatible version: keep the record readable
    // rather than throwing in a list route.
    summary = {
      action: row.action,
      label: ACTION_LABELS[row.action] ?? row.action,
      entity: row.entity as 'document' | 'contract',
      entity_id: row.entity_id,
      title: `${row.entity} #${row.entity_id}`,
      recipient: null,
      recipient_email: null,
      gross_cents: 0,
      number: null,
      lines: [],
      warnings: [],
    }
  }
  return { ...row, summary }
}

/**
 * Flip rows whose window has passed. Called before every read and decision, so
 * an expired approval is never handed out as usable — no scheduler needed.
 */
export function expireStaleApprovals(): void {
  db.prepare(
    `UPDATE approvals SET status = 'abgelaufen'
      WHERE status IN ('offen', 'genehmigt') AND expires_at <= datetime('now')`,
  ).run()
}

export function getApproval(id: number): Approval | null {
  expireStaleApprovals()
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as unknown as
    | ApprovalRow
    | undefined
  if (!row) return null
  const approval = hydrate(row)
  // Only meaningful while the approval could still be used.
  if (row.status === 'offen' || row.status === 'genehmigt') {
    approval.content_unchanged = safeFingerprint(row) === row.fingerprint
  }
  return approval
}

/** Fingerprint that survives a deleted entity (then: definitely changed). */
function safeFingerprint(row: ApprovalRow): string | null {
  try {
    return fingerprint(row.action, row.entity_id)
  } catch {
    return null
  }
}

export interface ApprovalFilter {
  status?: ApprovalStatus
  action?: ApprovalAction
  entity_id?: number
  /** Only requests raised by this principal. */
  requested_by?: string
  limit?: number
}

export function listApprovals(filter: ApprovalFilter = {}): Approval[] {
  expireStaleApprovals()
  const where: string[] = []
  const params: (string | number)[] = []
  if (filter.status) {
    where.push('status = ?')
    params.push(filter.status)
  }
  if (filter.action) {
    where.push('action = ?')
    params.push(filter.action)
  }
  if (filter.entity_id != null) {
    where.push('entity_id = ?')
    params.push(filter.entity_id)
  }
  if (filter.requested_by) {
    where.push('requested_by = ?')
    params.push(filter.requested_by)
  }
  const sql =
    `SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ` +
    'ORDER BY requested_at DESC, id DESC LIMIT ?'
  const rows = db
    .prepare(sql)
    .all(...params, Math.min(filter.limit ?? 200, 500)) as unknown as ApprovalRow[]
  return rows.map((r) => {
    const a = hydrate(r)
    if (r.status === 'offen' || r.status === 'genehmigt') {
      a.content_unchanged = safeFingerprint(r) === r.fingerprint
    }
    return a
  })
}

export interface RequestInput {
  action: ApprovalAction
  entity_id: number
  requested_by: string
  reason?: string | null
}

/**
 * Ask a human for permission. Validates that the act is actually possible right
 * now (a finalised invoice cannot be finalised again, an unnumbered one cannot
 * be sent), so a request is never a promise the app cannot keep.
 *
 * An open request for the same act on the same, unchanged content is returned as
 * is instead of stacking duplicates in the operator's inbox.
 */
export function requestApproval(input: RequestInput): { approval: Approval; existed: boolean } {
  if (!isApprovalAction(input.action)) throw new ApprovalError(`Unbekannte Aktion: ${input.action}`)
  const entityId = Number(input.entity_id)
  if (!Number.isInteger(entityId) || entityId <= 0) throw new ApprovalError('entity_id fehlt.')
  expireStaleApprovals()

  const summary = buildSummary(input.action, entityId) // throws if the act is impossible
  const print = fingerprint(input.action, entityId)

  const open = db
    .prepare(
      `SELECT * FROM approvals
        WHERE action = ? AND entity_id = ? AND fingerprint = ? AND status IN ('offen', 'genehmigt')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(input.action, entityId, print) as unknown as ApprovalRow | undefined
  if (open) return { approval: hydrate(open), existed: true }

  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 2000) : null
  const expires = new Date(Date.now() + ttlMinutes() * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  const info = db
    .prepare(
      `INSERT INTO approvals (action, entity, entity_id, fingerprint, summary, reason, requested_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.action,
      ENTITY_OF[input.action],
      entityId,
      print,
      JSON.stringify(summary),
      reason,
      input.requested_by,
      expires,
    )
  return { approval: getApproval(Number(info.lastInsertRowid))!, existed: false }
}

export interface DecisionInput {
  approve: boolean
  by: string
  note?: string | null
}

/** A human's yes or no. Only ever called from an interactive login. */
export function decideApproval(id: number, decision: DecisionInput): Approval {
  expireStaleApprovals()
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as unknown as
    | ApprovalRow
    | undefined
  if (!row) throw new ApprovalError('Freigabe nicht gefunden.', 404)
  if (row.status !== 'offen')
    throw new ApprovalError(`Diese Freigabe ist bereits ${row.status} — keine Entscheidung mehr möglich.`, 409)
  // Approving content that has drifted since the request would grant a yes to
  // something nobody read. Refusing is always allowed.
  if (decision.approve && safeFingerprint(row) !== row.fingerprint) {
    throw new ApprovalError(
      'Der Inhalt hat sich seit der Anfrage geändert. Bitte die Anfrage ablehnen und neu stellen lassen.',
      409,
    )
  }
  db.prepare(
    `UPDATE approvals
        SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?
      WHERE id = ?`,
  ).run(
    decision.approve ? 'genehmigt' : 'abgelehnt',
    decision.by,
    typeof decision.note === 'string' && decision.note.trim() ? decision.note.trim().slice(0, 2000) : null,
    id,
  )
  return getApproval(id)!
}

/** The requester taking its own open request back (e.g. it fixed the draft). */
export function withdrawApproval(id: number, by: string): Approval {
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as unknown as
    | ApprovalRow
    | undefined
  if (!row) throw new ApprovalError('Freigabe nicht gefunden.', 404)
  if (row.status !== 'offen')
    throw new ApprovalError(`Nur offene Anfragen können zurückgezogen werden (Status: ${row.status}).`, 409)
  if (row.requested_by !== by)
    throw new ApprovalError('Nur der Antragsteller kann eine Anfrage zurückziehen.', 403)
  db.prepare("UPDATE approvals SET status = 'zurueckgezogen' WHERE id = ?").run(id)
  return getApproval(id)!
}

/**
 * Spend an approval on the act it was granted for. Every failure mode gets its
 * own message, because "denied" without a reason is what makes an agent retry
 * blindly. On success the row is marked `verbraucht` — the yes is used up.
 *
 * Call this INSIDE the same request that performs the act, and only proceed if
 * it returns.
 */
export function consumeApproval(params: {
  id: number
  action: ApprovalAction
  entityId: number
  actor: string
}): Approval {
  expireStaleApprovals()
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(params.id) as unknown as
    | ApprovalRow
    | undefined
  if (!row) throw new ApprovalError('Freigabe nicht gefunden.', 404)
  if (row.action !== params.action)
    throw new ApprovalError(
      `Diese Freigabe gilt für "${row.action}", nicht für "${params.action}".`,
      403,
    )
  if (row.entity_id !== params.entityId)
    throw new ApprovalError(
      `Diese Freigabe gilt für ${row.entity} #${row.entity_id}, nicht für #${params.entityId}.`,
      403,
    )
  if (row.status === 'verbraucht')
    throw new ApprovalError(
      `Diese Freigabe wurde am ${row.used_at} bereits verwendet. Freigaben gelten einmal.`,
      409,
    )
  if (row.status !== 'genehmigt')
    throw new ApprovalError(
      row.status === 'offen'
        ? 'Diese Freigabe wurde noch nicht entschieden — sie muss von einem Menschen genehmigt werden.'
        : `Diese Freigabe ist ${row.status}.`,
      403,
    )
  if (safeFingerprint(row) !== row.fingerprint)
    throw new ApprovalError(
      'Der Inhalt hat sich seit der Freigabe geändert. Die Freigabe gilt nicht mehr — bitte neu anfragen.',
      409,
    )
  db.prepare("UPDATE approvals SET status = 'verbraucht', used_at = datetime('now') WHERE id = ?").run(
    row.id,
  )
  return getApproval(row.id)!
}

/**
 * The guard a route calls: reads `approval_id` off the body, or explains — in
 * the answer itself — how to obtain one. Returns the consumed approval so the
 * caller can put its id in the audit trail.
 */
export function requireApproval(params: {
  body: Record<string, unknown>
  action: ApprovalAction
  entityId: number
  actor: string
}): Approval {
  const raw = params.body.approval_id ?? params.body.approvalId
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApprovalError(
      `Diese Aktion (${ACTION_LABELS[params.action]}) braucht eine menschliche Freigabe. ` +
        `Erst POST /api/machine/approvals {"action":"${params.action}","entity_id":${params.entityId}} ` +
        'aufrufen, auf die Entscheidung eines Menschen warten und die genehmigte approval_id hier mitgeben.',
      403,
    )
  }
  return consumeApproval({ id, action: params.action, entityId: params.entityId, actor: params.actor })
}
