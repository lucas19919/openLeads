import { db, LINK_KINDS, type LeadLinkRow, type LinkKind } from './db'

// Links attached to a lead — the preview URL a site agent published, the live
// site after go-live, a shared quote. Two rules shape this module:
//
//  1. Only http(s). A lead link ends up as an href in the drawer and in mails to
//     the operator; javascript:, data: and file: URLs have no business there.
//  2. Attaching is idempotent per (lead, url). Agents retry, and a retry that
//     doubles the list is a worse outcome than one that changes nothing.
//
// Every attach also writes a lead_event, so the timeline shows who added which
// link and when — the same trail a stage change leaves.

/** Longest URL accepted. Well past any real share URL, short of an abuse vector. */
const MAX_URL = 2048
const MAX_LABEL = 120

export interface LeadLinkInput {
  url: string
  label?: string | null
  kind?: string | null
}

/**
 * Normalise a user- or agent-supplied URL, or throw with a message meant for
 * the caller. Bare hosts ("example.de") gain https:// — imports and models both
 * produce them — but anything that is not http(s) after that is rejected.
 */
export function normalizeLinkUrl(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw new Error('url fehlt')
  if (text.length > MAX_URL) throw new Error('url ist zu lang')
  // Only prepend a scheme when there is none at all. A "javascript:…" value has
  // a scheme and must fall through to the protocol check below, not be rescued.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('url ist keine gültige Adresse')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('nur http(s)-Adressen sind erlaubt')
  }
  if (!parsed.hostname) throw new Error('url hat keinen Host')
  return parsed.toString()
}

function normalizeKind(raw: unknown): LinkKind {
  return LINK_KINDS.includes(raw as never) ? (raw as LinkKind) : 'sonstiges'
}

export function listLeadLinks(leadId: number): LeadLinkRow[] {
  return db
    .prepare('SELECT * FROM lead_links WHERE lead_id = ? ORDER BY created_at DESC, id DESC')
    .all(leadId) as unknown as LeadLinkRow[]
}

export function getLeadLink(id: number): LeadLinkRow | null {
  return (db.prepare('SELECT * FROM lead_links WHERE id = ?').get(id) as unknown as LeadLinkRow) ?? null
}

/**
 * Attach a link to a lead. Returns the row plus whether it already existed, so
 * callers can answer 200-existing vs 201-created without a second query.
 * Throws Error('not found') for an unknown lead and a German message for a bad URL.
 */
export function addLeadLink(
  leadId: number,
  input: LeadLinkInput,
  actor: string | null,
): { link: LeadLinkRow; existed: boolean } {
  if (!db.prepare('SELECT 1 FROM leads WHERE id = ?').get(leadId)) throw new Error('not found')
  const url = normalizeLinkUrl(input.url)
  const kind = normalizeKind(input.kind)
  const label =
    typeof input.label === 'string' && input.label.trim()
      ? input.label.trim().slice(0, MAX_LABEL)
      : null

  const existing = db
    .prepare('SELECT * FROM lead_links WHERE lead_id = ? AND url = ?')
    .get(leadId, url) as unknown as LeadLinkRow | undefined
  if (existing) return { link: existing, existed: true }

  const info = db
    .prepare(
      `INSERT INTO lead_links (lead_id, url, label, kind, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(leadId, url, label, kind, actor)
  const link = getLeadLink(Number(info.lastInsertRowid))!
  db.prepare(`INSERT INTO lead_events (lead_id, actor, type, body) VALUES (?, ?, 'link', ?)`).run(
    leadId,
    actor,
    `${label ?? kind}: ${url}`,
  )
  return { link, existed: false }
}

/** Remove one link from a lead. False when the id is unknown or on another lead. */
export function deleteLeadLink(leadId: number, linkId: number): boolean {
  return db.prepare('DELETE FROM lead_links WHERE id = ? AND lead_id = ?').run(linkId, leadId).changes > 0
}

/**
 * Append a note to a lead's timeline without touching `leads.notes`.
 *
 * The PATCH route records a note only as a side effect of *replacing* the notes
 * field, which means two agents writing notes overwrite each other. This is the
 * append-only path: the timeline grows, the stored note text is left alone.
 */
export function appendLeadNote(leadId: number, body: unknown, actor: string | null): boolean {
  const text = typeof body === 'string' ? body.trim() : ''
  if (!text) throw new Error('body fehlt')
  if (!db.prepare('SELECT 1 FROM leads WHERE id = ?').get(leadId)) return false
  db.prepare(`INSERT INTO lead_events (lead_id, actor, type, body) VALUES (?, ?, 'note', ?)`).run(
    leadId,
    actor,
    text,
  )
  db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE id = ?").run(leadId)
  return true
}
