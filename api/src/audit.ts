import { db } from './db'

/**
 * Append a row to the accountability trail. This is deliberately the *only* way
 * the app records "who did what to which personal data" — DSGVO Art. 5(2)
 * (Rechenschaftspflicht) and Art. 30 (Verzeichnis von Verarbeitungstätigkeiten).
 * Never throws into the request path: a logging failure must not break a write.
 */
export function audit(entry: {
  actor: string | null
  action: string
  entity?: string | null
  entityId?: number | null
  detail?: unknown
  ip?: string | null
}): void {
  try {
    db.prepare(
      `INSERT INTO audit_log (actor, action, entity, entity_id, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.actor,
      entry.action,
      entry.entity ?? null,
      entry.entityId ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      entry.ip ?? null,
    )
  } catch (e) {
    console.error('audit log failed:', (e as Error).message)
  }
}
