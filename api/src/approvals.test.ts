import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'

// Isolate to a throwaway DB. DB_PATH is read when db.ts is first evaluated, so
// set it before the dynamic import (same pattern as the other suites).
const DB_FILE = join(tmpdir(), `openleads-approvals-${process.pid}.db`)
process.env.DB_PATH = DB_FILE
process.env.TRUST_PROXY = '1'

const { db } = await import('./db')
const { registerMachineRoutes } = await import('./routes/machine')
const { registerApprovalRoutes } = await import('./routes/approvals')
const { registerDocumentRoutes } = await import('./routes/documents')
const { createDraftDocument, getDocument, finalizeDraft } = await import('./documents')
const { listApprovals, getApproval, decideApproval, requestApproval, consumeApproval } =
  await import('./approvals')
const { createSession, createApiToken } = await import('./auth')
type Vars = import('./routes/middleware').Vars

after(() => {
  try {
    db.close()
  } catch {
    /* ignore */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_FILE + suffix)
    } catch {
      /* ignore */
    }
  }
})

// Both halves of the gate in one app, so they can be played against each other:
// the machine asks over /api/machine/*, a human decides over /api/approvals/*.
// The human side runs with real credentials — an actual session cookie and an
// actual API token — because "who is asking" is the thing under test here, and a
// stubbed identity would prove nothing about it.
const app = new Hono<{ Variables: Vars }>()
registerMachineRoutes(app)
registerApprovalRoutes(app)
registerDocumentRoutes(app)

db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('chefin', 'x', 'admin')").run()
const USER_ID = Number(
  (db.prepare("SELECT id FROM users WHERE username = 'chefin'").get() as { id: number }).id,
)
const SESSION = createSession(USER_ID) // the browser: a person at a screen
const PERSONAL_TOKEN = createApiToken(USER_ID, 'mcp', 'write').token // headless

const HUMAN: Record<string, string> = { cookie: `sid=${SESSION}`, 'content-type': 'application/json' }
const AS_TOKEN: Record<string, string> = {
  authorization: `Bearer ${PERSONAL_TOKEN}`,
  'content-type': 'application/json',
}

const TOKEN = 'machine-secret-for-approval-tests'
const AUTH: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
const JSON_AUTH: Record<string, string> = { ...AUTH, 'content-type': 'application/json' }

let client = 0
beforeEach(() => {
  process.env.CRM_MACHINE_TOKEN = TOKEN
  delete process.env.CRM_MACHINE_PRINCIPAL
  delete process.env.CRM_APPROVAL_TTL_MINUTES
  const ip = `10.1.0.${++client}`
  AUTH['x-forwarded-for'] = ip
  JSON_AUTH['x-forwarded-for'] = ip
})

/** A priced Rechnung draft, straight through the domain (not the routes). */
function draft(name = 'Bäckerei Huber', cents = 119000): number {
  return createDraftDocument({
    kind: 'rechnung',
    client_name: name,
    client_email: 'kunde@example.de',
    title: 'Website-Relaunch',
    items: [{ description: 'Relaunch', quantity: 1, unit: 'Pauschal', unit_price_cents: cents }],
  }).id
}

/** Ask as the machine. */
async function ask(action: string, entityId: number, reason = 'Kunde hat zugesagt') {
  return app.request('/api/machine/approvals', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ action, entity_id: entityId, reason }),
  })
}

/** Decide as a logged-in human. */
async function grant(id: number, approve = true) {
  return app.request(`/api/approvals/${id}/${approve ? 'approve' : 'reject'}`, {
    method: 'POST',
    headers: HUMAN,
    body: '{}',
  })
}

async function finalize(docId: number, approvalId?: number) {
  return app.request(`/api/machine/documents/${docId}/finalize`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify(approvalId === undefined ? {} : { approval_id: approvalId }),
  })
}

// --- the drafting half: free, and visibly reversible -------------------------

test('an agent writes, edits and deletes drafts on its own', async () => {
  const created = await app.request('/api/machine/documents', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({
      kind: 'angebot',
      client_name: 'Metzgerei Sturm',
      items: [{ description: 'Website', quantity: 1, unit_price_cents: 250000 }],
    }),
  })
  assert.equal(created.status, 201)
  const { document } = (await created.json()) as { document: { id: number; number: string | null; totals: { gross_cents: number } } }
  assert.equal(document.number, null, 'a fresh draft never carries a number')

  const patched = await app.request(`/api/machine/documents/${document.id}`, {
    method: 'PATCH',
    headers: JSON_AUTH,
    body: JSON.stringify({ items: [{ description: 'Website', quantity: 1, unit_price_cents: 300000 }] }),
  })
  assert.equal(patched.status, 200)
  assert.equal(getDocument(document.id)!.totals.net_cents, 300000)

  const gone = await app.request(`/api/machine/documents/${document.id}`, {
    method: 'DELETE',
    headers: AUTH,
  })
  assert.equal(gone.status, 200)
  assert.equal(getDocument(document.id), null)
})

test('bookkeeping statuses are not an agent\'s to claim', async () => {
  const id = draft()
  const res = await app.request(`/api/machine/documents/${id}`, {
    method: 'PATCH',
    headers: JSON_AUTH,
    body: JSON.stringify({ status: 'bezahlt' }),
  })
  assert.equal(res.status, 403)
  assert.equal(getDocument(id)!.status, 'entwurf')
})

test('a festgeschriebenes document is closed to the machine surface', async () => {
  const id = draft()
  finalizeDraft(id)
  const patch = await app.request(`/api/machine/documents/${id}`, {
    method: 'PATCH',
    headers: JSON_AUTH,
    body: JSON.stringify({ title: 'Anders' }),
  })
  assert.equal(patch.status, 409)
  const del = await app.request(`/api/machine/documents/${id}`, { method: 'DELETE', headers: AUTH })
  assert.equal(del.status, 409)
})

// --- the gate ---------------------------------------------------------------

test('Festschreiben without a Freigabe is refused, and says how to get one', async () => {
  const id = draft()
  const res = await finalize(id)
  assert.equal(res.status, 403)
  const { error } = (await res.json()) as { error: string }
  assert.match(error, /Freigabe/)
  assert.match(error, /approvals/, 'the refusal names the way forward')
  assert.equal(getDocument(id)!.number, null, 'nothing was issued')
})

test('an open request is not a permission', async () => {
  const id = draft()
  const asked = await ask('document.finalize', id)
  assert.equal(asked.status, 201)
  const { approval } = (await asked.json()) as { approval: { id: number; status: string } }
  assert.equal(approval.status, 'offen')

  const res = await finalize(id, approval.id)
  assert.equal(res.status, 403)
  assert.match(((await res.json()) as { error: string }).error, /noch nicht entschieden/)
  assert.equal(getDocument(id)!.number, null)
})

test('granted → the number is issued once, and the Freigabe is spent', async () => {
  const id = draft()
  const { approval } = (await (await ask('document.finalize', id)).json()) as { approval: { id: number } }
  assert.equal((await grant(approval.id)).status, 200)

  const ok = await finalize(id, approval.id)
  assert.equal(ok.status, 200)
  const body = (await ok.json()) as { document: { number: string | null }; approval_id: number }
  assert.match(body.document.number ?? '', /^RE?-\d{4}-\d{4}$/)
  assert.equal(body.approval_id, approval.id)
  assert.equal(getApproval(approval.id)!.status, 'verbraucht')

  // Replaying the same yes gets nowhere.
  const replay = await finalize(id, approval.id)
  assert.equal(replay.status, 409)
  assert.match(((await replay.json()) as { error: string }).error, /einmal/)
})

test('a rejected request stays rejected', async () => {
  const id = draft()
  const { approval } = (await (await ask('document.finalize', id)).json()) as { approval: { id: number } }
  assert.equal((await grant(approval.id, false)).status, 200)
  const res = await finalize(id, approval.id)
  assert.equal(res.status, 403)
  assert.equal(getDocument(id)!.number, null)

  // And it cannot be flipped to yes afterwards.
  assert.equal((await grant(approval.id)).status, 409)
})

test('editing the paper after the yes revokes it', async () => {
  const id = draft()
  const { approval } = (await (await ask('document.finalize', id)).json()) as { approval: { id: number } }
  await grant(approval.id)

  // The agent "improves" the invoice after the human looked at it.
  await app.request(`/api/machine/documents/${id}`, {
    method: 'PATCH',
    headers: JSON_AUTH,
    body: JSON.stringify({ items: [{ description: 'Relaunch', quantity: 1, unit_price_cents: 999000 }] }),
  })

  const res = await finalize(id, approval.id)
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /geändert/)
  assert.equal(getDocument(id)!.number, null)
})

test('a Freigabe is bound to its document and its action', async () => {
  const a = draft('Kunde A')
  const b = draft('Kunde B')
  const { approval } = (await (await ask('document.finalize', a)).json()) as { approval: { id: number } }
  await grant(approval.id)

  const wrongDoc = await finalize(b, approval.id)
  assert.equal(wrongDoc.status, 403)
  assert.match(((await wrongDoc.json()) as { error: string }).error, /nicht für/)
  assert.equal(getDocument(b)!.number, null)

  // Same row, different door: sending is not what was granted.
  assert.throws(
    () => consumeApproval({ id: approval.id, action: 'document.send', entityId: a, actor: 'machine:mcp' }),
    /gilt für "document.finalize"/,
  )
})

test('an expired Freigabe is dead, even if it was granted', async () => {
  const id = draft()
  const { approval } = requestApproval({
    action: 'document.finalize',
    entity_id: id,
    requested_by: 'machine:mcp',
  })
  decideApproval(approval.id, { approve: true, by: 'chefin' })
  // Backdate the window rather than sleeping through it.
  db.prepare("UPDATE approvals SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(approval.id)

  const res = await finalize(id, approval.id)
  assert.equal(res.status, 403)
  assert.equal(getApproval(approval.id)!.status, 'abgelaufen')
  assert.equal(getDocument(id)!.number, null)
})

// --- who may decide ----------------------------------------------------------

test('a token may ask and watch, but never grant', async () => {
  const id = draft()
  const { approval } = (await (await ask('document.finalize', id)).json()) as { approval: { id: number } }

  const asToken = await app.request(`/api/approvals/${approval.id}/approve`, {
    method: 'POST',
    headers: AS_TOKEN,
    body: '{}',
  })
  assert.equal(asToken.status, 403)
  assert.match(((await asToken.json()) as { error: string }).error, /angemeldeten Menschen/)
  assert.equal(getApproval(approval.id)!.status, 'offen')

  // The machine surface has no decision route at all.
  const noRoute = await app.request(`/api/machine/approvals/${approval.id}/approve`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: '{}',
  })
  assert.ok(noRoute.status === 404 || noRoute.status === 405)
})

test('the human queue shows what the yes would actually do', async () => {
  const id = draft('Schreinerei Vogl', 250000)
  await ask('document.finalize', id, 'Auftrag abgeschlossen')

  const res = await app.request('/api/approvals?status=offen', { headers: HUMAN })
  assert.equal(res.status, 200)
  const { approvals } = (await res.json()) as {
    approvals: {
      entity_id: number
      reason: string | null
      summary: { recipient: string | null; gross_cents: number; lines: string[]; warnings: string[] }
    }[]
  }
  const mine = approvals.find((a) => a.entity_id === id)!
  assert.equal(mine.summary.recipient, 'Schreinerei Vogl')
  // Gross as the settings actually compute it (a fresh install is §19
  // Kleinunternehmer, so no VAT line) — the human is shown the real total.
  assert.equal(mine.summary.gross_cents, getDocument(id)!.totals.gross_cents)
  assert.equal(mine.summary.gross_cents, 250000)
  assert.ok(mine.summary.lines.length === 1, 'the positions are on the card, not just an id')
  assert.ok(mine.summary.warnings.some((w) => /Nummer/.test(w)), 'it says what will be consumed')
  assert.equal(mine.reason, 'Auftrag abgeschlossen')
})

// --- asking for the impossible ----------------------------------------------

test('impossible requests are refused at the asking stage', async () => {
  const id = draft()
  finalizeDraft(id)
  const again = await ask('document.finalize', id)
  assert.equal(again.status, 400)
  assert.match(((await again.json()) as { error: string }).error, /bereits festgeschrieben/)

  const missing = await ask('document.finalize', 999999)
  assert.equal(missing.status, 404)

  const draftId = draft()
  const sendDraft = await ask('document.send', draftId)
  assert.equal(sendDraft.status, 400)
  assert.match(((await sendDraft.json()) as { error: string }).error, /festgeschriebene/)
})

test('the machine cannot ask for what it could not carry out', async () => {
  const res = await ask('contract.finalize', 1)
  assert.equal(res.status, 403)
  assert.match(((await res.json()) as { error: string }).error, /nicht ausführbar/)
})

test('asking twice for the same unchanged paper reuses the request', async () => {
  const id = draft()
  const first = (await (await ask('document.finalize', id)).json()) as { approval: { id: number } }
  const second = await ask('document.finalize', id)
  assert.equal(second.status, 200)
  const body = (await second.json()) as { approval: { id: number }; existed: boolean }
  assert.equal(body.existed, true)
  assert.equal(body.approval.id, first.approval.id)
  assert.equal(listApprovals({ entity_id: id, status: 'offen' }).length, 1)
})

test('an agent can take its own request back', async () => {
  const id = draft()
  const { approval } = (await (await ask('document.finalize', id)).json()) as { approval: { id: number } }
  const res = await app.request(`/api/machine/approvals/${approval.id}/withdraw`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: '{}',
  })
  assert.equal(res.status, 200)
  assert.equal(getApproval(approval.id)!.status, 'zurueckgezogen')
  // A withdrawn request is no basis for anything.
  assert.equal((await finalize(id, approval.id)).status, 403)
})

// --- the same gate on the human API ------------------------------------------
// The CLI and the MCP server talk to /api/documents with a personal API token,
// so the rule has to hold there too: a click is its own approval, a token is not.

test('a personal API token needs a Freigabe on the human API as well', async () => {
  const id = draft('Elektro Bauer')
  const res = await app.request(`/api/documents/${id}/finalize`, {
    method: 'POST',
    headers: AS_TOKEN,
    body: '{}',
  })
  assert.equal(res.status, 403)
  assert.match(((await res.json()) as { error: string }).error, /Freigabe/)
  assert.equal(getDocument(id)!.number, null)
})

test('a logged-in human festschreibt directly — the click is the approval', async () => {
  const id = draft('Dachdecker Klein')
  const res = await app.request(`/api/documents/${id}/finalize`, { method: 'POST', headers: HUMAN })
  assert.equal(res.status, 200)
  assert.ok(getDocument(id)!.number, 'the person at the screen needs no paperwork')
})

test('the decision is in the audit trail, with who and what', async () => {
  const id = draft('Fliesen Kern')
  const { approval } = (await (await ask('document.finalize', id)).json()) as { approval: { id: number } }
  await grant(approval.id)
  await finalize(id, approval.id)

  const rows = db
    .prepare("SELECT actor, action, detail FROM audit_log WHERE entity_id = ? ORDER BY id")
    .all(approval.id) as unknown as { actor: string; action: string; detail: string }[]
  const granted = rows.find((r) => r.action === 'approval.grant')
  assert.ok(granted, 'the yes itself is logged')
  assert.equal(granted!.actor, 'chefin')
  assert.match(granted!.detail, /document\.finalize/)

  const issue = db
    .prepare("SELECT actor, detail FROM audit_log WHERE action = 'document.finalize' AND entity_id = ?")
    .get(id) as unknown as { actor: string; detail: string }
  assert.equal(issue.actor, 'machine:mcp')
  assert.match(issue.detail, new RegExp(`"approval_id":${approval.id}`), 'the issuance points back at the yes')
})
