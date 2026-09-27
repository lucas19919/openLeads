import type { Hono } from 'hono'
import {
  ApprovalError,
  listApprovals,
  getApproval,
  decideApproval,
  requestApproval,
  withdrawApproval,
  isApprovalAction,
  ACTION_LABELS,
} from '../approvals'
import { APPROVAL_ACTIONS, APPROVAL_STATUSES, type ApprovalAction, type ApprovalStatus } from '../db'
import { audit } from '../audit'
import { requireAuth, type AppContext, type Vars } from './middleware'
import { errorStatus } from './helpers'

// Freigaben, human side. This is the inbox where an agent's request for a
// one-way door waits for a person.
//
// The one rule that makes the whole mechanism worth anything: **a decision needs
// an interactive login.** An API token can list Freigaben and raise them; it can
// never grant one. Otherwise an agent holding a write token would simply approve
// its own request, and the gate would be decoration.
//
// Deciding from a token is answered with a 403 that says where to go instead,
// because a headless caller silently receiving "no" is how retry loops are born.

function decisionsAllowed(c: AppContext): boolean {
  return c.get('token') === undefined
}

const TOKEN_REFUSAL =
  'Freigaben können nur von einem angemeldeten Menschen entschieden werden — nicht mit einem ' +
  'API-Token. Bitte im Kunden Manager anmelden und die Anfrage unter „Freigaben" entscheiden.'

export function registerApprovalRoutes(app: Hono<{ Variables: Vars }>): void {
  // The queue. Default view is what needs a person right now.
  app.get('/api/approvals', requireAuth, (c) => {
    const status = c.req.query('status')
    const action = c.req.query('action')
    if (status && !(APPROVAL_STATUSES as readonly string[]).includes(status)) {
      return c.json({ error: `Unbekannter Status: ${status}` }, 400)
    }
    if (action && !isApprovalAction(action)) {
      return c.json({ error: `Unbekannte Aktion: ${action}` }, 400)
    }
    const approvals = listApprovals({
      status: (status as ApprovalStatus) ?? undefined,
      action: (action as ApprovalAction) ?? undefined,
      entity_id: c.req.query('entity_id') ? Number(c.req.query('entity_id')) : undefined,
    })
    return c.json({
      approvals,
      pending: listApprovals({ status: 'offen' }).length,
      actions: APPROVAL_ACTIONS.map((a) => ({ id: a, label: ACTION_LABELS[a] })),
    })
  })

  app.get('/api/approvals/:id', requireAuth, (c) => {
    const approval = getApproval(Number(c.req.param('id')))
    if (!approval) return c.json({ error: 'not found' }, 404)
    return c.json({ approval })
  })

  // Raising a request from a human session is allowed too — it is how the UI
  // can hand a colleague ("the boss signs the invoices") something to decide.
  app.post('/api/approvals', requireAuth, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const { approval, existed } = requestApproval({
        action: b.action as ApprovalAction,
        entity_id: Number(b.entity_id),
        requested_by: c.get('user').username,
        reason: (b.reason as string) ?? null,
      })
      if (!existed) {
        audit({
          actor: c.get('user').username, action: 'approval.request', entity: 'approval',
          entityId: approval.id, detail: { action: approval.action, entity_id: approval.entity_id },
        })
      }
      return c.json({ approval, existed }, existed ? 200 : 201)
    } catch (e) {
      const err = e as ApprovalError
      return c.json({ error: err.message }, errorStatus(err.status))
    }
  })

  // Take back an own open request. Allowed from a token too — withdrawing is
  // the requester giving up authority, never gaining any.
  app.post('/api/approvals/:id/withdraw', requireAuth, (c) => {
    try {
      const approval = withdrawApproval(Number(c.req.param('id')), c.get('user').username)
      audit({
        actor: c.get('user').username, action: 'approval.withdraw', entity: 'approval',
        entityId: approval.id, detail: { approved_action: approval.action },
      })
      return c.json({ approval })
    } catch (e) {
      const err = e as ApprovalError
      return c.json({ error: err.message }, errorStatus(err.status))
    }
  })

  app.post('/api/approvals/:id/approve', requireAuth, async (c) => {
    if (!decisionsAllowed(c)) return c.json({ error: TOKEN_REFUSAL }, 403)
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    return decide(c, Number(c.req.param('id')), true, (b.note as string) ?? null)
  })

  app.post('/api/approvals/:id/reject', requireAuth, async (c) => {
    if (!decisionsAllowed(c)) return c.json({ error: TOKEN_REFUSAL }, 403)
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    return decide(c, Number(c.req.param('id')), false, (b.note as string) ?? null)
  })

  function decide(c: AppContext, id: number, approve: boolean, note: string | null) {
    const by = c.get('user').username
    try {
      const approval = decideApproval(id, { approve, by, note })
      // The decision is the accountable act, not the finalise that follows it:
      // the trail has to show which human said yes to which paper.
      audit({
        actor: by,
        action: approve ? 'approval.grant' : 'approval.reject',
        entity: 'approval',
        entityId: approval.id,
        detail: {
          approved_action: approval.action,
          entity: approval.entity,
          entity_id: approval.entity_id,
          requested_by: approval.requested_by,
          fingerprint: approval.fingerprint,
          note,
        },
      })
      return c.json({ approval })
    } catch (e) {
      const err = e as ApprovalError
      return c.json({ error: err.message }, errorStatus(err.status))
    }
  }
}
