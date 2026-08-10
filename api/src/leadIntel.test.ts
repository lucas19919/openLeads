import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import type { LeadRow } from './db'

const DB_FILE = join(tmpdir(), `openleads-leadintel-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { analyzeLead } = await import('./ai/leadIntel')

// analyzeLead → chatJSON → chatComplete → global fetch. Stub fetch with an
// OpenAI-shaped completion whose content is our canned analysis, so the DB
// write-back runs deterministically without a live model.
function stubModel(analysis: Record<string, unknown>) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(analysis) }, finish_reason: 'stop' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
}

function makeLead(overrides: { score?: number; priority?: string } = {}): LeadRow {
  const info = db
    .prepare(
      `INSERT INTO leads (company, score, priority, stage, source)
       VALUES ('Test GmbH', ?, ?, 'neu', 'manual')`,
    )
    .run(overrides.score ?? 0, overrides.priority ?? 'mittel')
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as LeadRow
}

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

test('analyzeLead writes the model fit confidence into the lead score', async () => {
  stubModel({ summary: 'Guter Fit', qualification: 'hot', fit_score: 82, next_action: 'Anrufen', talking_points: ['a'], risk_flags: [] })
  const lead = makeLead({ score: 0, priority: 'mittel' })

  const row = await analyzeLead(lead, 'tester')
  assert.equal(row.fit_score, 82) // cached in lead_ai

  const updated = db.prepare('SELECT score, priority FROM leads WHERE id = ?').get(lead.id) as {
    score: number
    priority: string
  }
  assert.equal(updated.score, 82) // fit confidence became the lead score
  assert.equal(updated.priority, 'hoch') // hot → hoch (existing mapping still applies)
})

test('analyzeLead rounds a fractional fit score before storing it', async () => {
  stubModel({ summary: 'ok', qualification: 'warm', fit_score: 66.7, next_action: 'Mail', talking_points: [], risk_flags: [] })
  const lead = makeLead({ score: 10 })

  await analyzeLead(lead, 'tester')
  const updated = db.prepare('SELECT score FROM leads WHERE id = ?').get(lead.id) as { score: number }
  assert.equal(updated.score, 67)
})

test('analyzeLead leaves the score untouched when the model returns no numeric fit', async () => {
  stubModel({ summary: 'unklar', qualification: 'cold', fit_score: null, next_action: 'Recherche', talking_points: [], risk_flags: [] })
  const lead = makeLead({ score: 37, priority: 'niedrig' })

  await analyzeLead(lead, 'tester')
  const updated = db.prepare('SELECT score FROM leads WHERE id = ?').get(lead.id) as { score: number }
  assert.equal(updated.score, 37) // non-finite fit → score preserved
})

// The priority a human sets by dragging a card on the board is a decision, not
// a cached model opinion — re-analysing a lead must not quietly reverse it.
test('analyzeLead does not overwrite a priority a human set', async () => {
  stubModel({ summary: 'heiß', qualification: 'hot', fit_score: 90, next_action: 'Anrufen', talking_points: [], risk_flags: [] })
  const lead = makeLead({ score: 0, priority: 'niedrig' })

  await analyzeLead(lead, 'tester')
  const updated = db.prepare('SELECT score, priority FROM leads WHERE id = ?').get(lead.id) as {
    score: number
    priority: string
  }
  assert.equal(updated.priority, 'niedrig', 'the operator outranks the model')
  assert.equal(updated.score, 90, 'the fit score is the model’s own metric and still updates')
})

test('analyzeLead may revise a priority it set itself', async () => {
  stubModel({ summary: 'lau', qualification: 'cold', fit_score: 20, next_action: 'Später', talking_points: [], risk_flags: [] })
  const lead = makeLead({ score: 0, priority: 'mittel' })
  await analyzeLead(lead, 'tester')
  assert.equal(
    (db.prepare('SELECT priority FROM leads WHERE id = ?').get(lead.id) as { priority: string }).priority,
    'niedrig',
  )

  // Same lead, new evidence: the model owns this value, so it may raise it.
  stubModel({ summary: 'doch heiß', qualification: 'hot', fit_score: 88, next_action: 'Anrufen', talking_points: [], risk_flags: [] })
  const again = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id) as unknown as LeadRow
  await analyzeLead(again, 'tester')
  assert.equal(
    (db.prepare('SELECT priority FROM leads WHERE id = ?').get(lead.id) as { priority: string }).priority,
    'hoch',
  )
})
