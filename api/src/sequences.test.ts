import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-sequences-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const {
  addDays,
  sanitizeSteps,
  createSequence,
  getSequence,
  setSequenceStatus,
  advanceAfterSend,
} = await import('./sequences')
import type { OutreachRow } from './db'

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

const leadId = Number(
  db.prepare("INSERT INTO leads (company, domain) VALUES ('Test GmbH', 'test.de')").run().lastInsertRowid,
)

// A stand-in for a freshly-sent step draft, so we can drive advanceAfterSend
// without a mail server or the model.
function sentDraft(seqId: number, step: number): OutreachRow {
  const id = Number(
    db
      .prepare(
        "INSERT INTO outreach (lead_id, channel, body, status, sequence_id, seq_step) VALUES (?, 'email', 'x', 'gesendet', ?, ?)",
      )
      .run(leadId, seqId, step).lastInsertRowid,
  )
  return db.prepare('SELECT * FROM outreach WHERE id = ?').get(id) as unknown as OutreachRow
}

test('addDays adds whole UTC days, crossing a month', () => {
  assert.equal(addDays('2026-01-30', 4), '2026-02-03')
  assert.equal(addDays('2026-06-20', 0), '2026-06-20')
})

test('sanitizeSteps normalises and rejects empty / oversized lists', () => {
  const steps = sanitizeSteps([
    { delay_days: 0, channel: 'email' },
    { delay_days: '4', channel: 'nonsense', instruction: 'Nachfass' },
  ])
  assert.equal(steps.length, 2)
  assert.equal(steps[1].delay_days, 4)
  assert.equal(steps[1].channel, 'email') // unknown channel falls back to email
  assert.equal(steps[1].instruction, 'Nachfass')
  assert.throws(() => sanitizeSteps([]))
  assert.throws(() => sanitizeSteps('nope'))
})

test('sending a step advances to the next and schedules it by delay', () => {
  const seq = createSequence(leadId, [
    { delay_days: 0, channel: 'email' },
    { delay_days: 4, channel: 'email' },
  ])
  assert.equal(seq.step_index, 0)
  assert.equal(seq.status, 'aktiv')

  advanceAfterSend(sentDraft(seq.id, 0), '2026-06-20')
  const afterFirst = getSequence(seq.id)!
  assert.equal(afterFirst.step_index, 1)
  assert.equal(afterFirst.next_run, '2026-06-24') // +4 days from the send
  assert.equal(afterFirst.status, 'aktiv')

  // Sending the final step finishes the sequence.
  advanceAfterSend(sentDraft(seq.id, 1), '2026-06-24')
  assert.equal(getSequence(seq.id)!.status, 'fertig')
})

test('a paused sequence is not advanced by a send', () => {
  const seq = createSequence(leadId, [
    { delay_days: 0, channel: 'email' },
    { delay_days: 4, channel: 'email' },
  ])
  setSequenceStatus(seq.id, 'pausiert')
  advanceAfterSend(sentDraft(seq.id, 0), '2026-06-20')
  const after = getSequence(seq.id)!
  assert.equal(after.step_index, 0) // unchanged while paused
  assert.equal(after.status, 'pausiert')
})

test('resuming a sequence with a past next_run re-arms it for today', () => {
  const seq = createSequence(leadId, [{ delay_days: 0, channel: 'email' }])
  db.prepare("UPDATE outreach_sequences SET next_run = '2020-01-01', status = 'pausiert' WHERE id = ?").run(seq.id)
  const resumed = setSequenceStatus(seq.id, 'aktiv')!
  assert.equal(resumed.status, 'aktiv')
  assert.equal(resumed.next_run, new Date().toISOString().slice(0, 10))
})
