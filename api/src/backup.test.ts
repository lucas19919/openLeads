import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// Isolate to a throwaway DB. DB_PATH is read when db.ts is first evaluated, so set
// it before the dynamic import (same pattern as the other suites).
const DB_FILE = join(tmpdir(), `openleads-backup-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { snapshot, restoreFromBuffer } = await import('./backup')

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

const leadCount = () => (db.prepare('SELECT COUNT(*) AS c FROM leads').get() as { c: number }).c

test('snapshot → mutate → restore brings the data back to the snapshot point', () => {
  db.exec('DELETE FROM leads')
  db.prepare("INSERT INTO leads (company, stage) VALUES ('Alpha GmbH', 'neu')").run()
  assert.equal(leadCount(), 1)

  const backup = snapshot() // capture with exactly one lead

  // Mutate after the snapshot: remove the original, add two others.
  db.exec('DELETE FROM leads')
  db.prepare("INSERT INTO leads (company, stage) VALUES ('Beta', 'neu')").run()
  db.prepare("INSERT INTO leads (company, stage) VALUES ('Gamma', 'neu')").run()
  assert.equal(leadCount(), 2)

  const result = restoreFromBuffer(backup)
  assert.ok(result.tables > 0)
  assert.equal(leadCount(), 1)
  assert.equal(
    (db.prepare('SELECT company FROM leads').get() as { company: string }).company,
    'Alpha GmbH',
  )
})

test('foreign keys are re-enabled after a restore', () => {
  const fk = db.prepare('PRAGMA foreign_keys').get() as Record<string, number>
  assert.equal(Object.values(fk)[0], 1)
})

test('a non-database upload is rejected and leaves the data intact', () => {
  db.exec('DELETE FROM leads')
  db.prepare("INSERT INTO leads (company, stage) VALUES ('Keep', 'neu')").run()
  assert.throws(() => restoreFromBuffer(Buffer.from('this is not a sqlite file')), /SQLite|Sicherung/)
  assert.equal(leadCount(), 1) // untouched
})

test('a valid SQLite file that is not an OpenLeads backup is rejected', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const otherPath = join(tmpdir(), `not-openleads-${process.pid}.db`)
  const other = new DatabaseSync(otherPath)
  other.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY)')
  other.close()
  const { readFileSync } = await import('node:fs')
  const buf = readFileSync(otherPath)
  assert.throws(() => restoreFromBuffer(buf), /Tabellen fehlen|OpenLeads/)
  rmSync(otherPath, { force: true })
})
