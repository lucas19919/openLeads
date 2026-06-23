import { db, type WebhookEndpointRow } from '../db'

// The outbound event bus. emit(event, payload) is the ONLY thing the request path
// touches: it enqueues one webhook_deliveries row per subscribed active endpoint
// and returns. The actual HTTP send is the dispatcher's job (dispatcher.ts),
// decoupled so a slow or dead subscriber can never block — or break — a write.
//
// Like audit(), emit() NEVER throws into the caller. And like audit(), when no
// endpoints are configured it is one cheap indexed SELECT that matches nothing,
// so hooking it into hot paths (incl. bulk import) is effectively free until the
// operator actually subscribes a webhook.

// The event catalogue. Keep in sync with docs/INTEGRATIONS.md.
export const WEBHOOK_EVENTS = [
  'lead.created',
  'lead.stage_changed',
  'document.created',
  'document.finalized',
  'invoice.sent',
  'payment.recorded',
  'payment.deleted',
  'expense.created',
  'expense.updated',
  'expense.deleted',
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/** True if an endpoint's CSV `events` subscription matches `event` ('*' = all). */
export function endpointWantsEvent(events: string, event: string): boolean {
  if (!events) return false
  const list = events.split(',').map((s) => s.trim()).filter(Boolean)
  return list.includes('*') || list.includes(event)
}

/**
 * Enqueue `event` for delivery to every active subscribed endpoint. The body is
 * canonicalised ONCE here (`{ event, created_at, data }`) and stored verbatim so
 * the dispatcher signs and (re)delivers byte-identical content. Synchronous and
 * non-throwing — a bus failure is logged, never propagated.
 */
export function emit(event: WebhookEvent | string, data: Record<string, unknown>): void {
  try {
    const endpoints = db
      .prepare('SELECT id, events FROM webhook_endpoints WHERE active = 1')
      .all() as unknown as Pick<WebhookEndpointRow, 'id' | 'events'>[]
    if (endpoints.length === 0) return
    const body = JSON.stringify({ event, created_at: new Date().toISOString(), data })
    const insert = db.prepare(
      `INSERT INTO webhook_deliveries (endpoint_id, event, payload)
       VALUES (?, ?, ?)`,
    )
    for (const ep of endpoints) {
      if (endpointWantsEvent(ep.events, event)) insert.run(ep.id, event, body)
    }
  } catch (e) {
    console.error('webhook emit failed:', (e as Error).message)
  }
}
