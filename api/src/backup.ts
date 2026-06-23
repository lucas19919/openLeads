import { db } from './db'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * A consistent point-in-time snapshot of the whole database as a single file.
 * `VACUUM INTO` works even with WAL active and without locking writers out — the
 * operator owns their data and can pull a backup any time. Returns the bytes.
 */
export function snapshot(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'ol-bak-'))
  const file = join(dir, 'openleads-snapshot.db')
  // VACUUM INTO does not accept a bound parameter; the path is process-internal.
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  try {
    return readFileSync(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function snapshotFilename(): string {
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  return `openleads-backup-${ts}.db`
}

/** Write a snapshot to disk (used by the cron-friendly backup script). */
export function snapshotToFile(path: string): { path: string; bytes: number } {
  const buf = snapshot()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buf)
  return { path, bytes: buf.length }
}

// Tables every valid OpenLeads snapshot must contain — a guard against swapping in
// a truncated download or an unrelated SQLite file.
const REQUIRED_TABLES = ['users', 'leads', 'documents', 'document_items', 'settings']
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface RestoreResult {
  tables: number
  rows: number
}

/** Column names of a table in the given schema ('main' | 'restore'). */
function columnsOf(schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map(
    (r) => r.name,
  )
}

/**
 * Validate and import a backup snapshot into the LIVE database, replacing its
 * contents. Unlike the CLI `restore` script (which swaps the file and needs the
 * API stopped), this runs while the server holds the DB open: it ATTACHes the
 * uploaded snapshot and copies it table-by-table inside ONE transaction with
 * foreign keys deferred, so a failure rolls back and leaves the current data
 * untouched — no restart required.
 *
 * Tables are matched by name, columns by intersection, so a backup taken under an
 * older schema (fewer columns) still restores cleanly (new columns keep their
 * defaults). Throws a German Error if the upload isn't an intact OpenLeads DB.
 */
export function restoreFromBuffer(buf: Buffer): RestoreResult {
  const dir = mkdtempSync(join(tmpdir(), 'ol-restore-'))
  const file = join(dir, 'upload.db')
  writeFileSync(file, buf)
  try {
    // 1. Validate the upload: opens as SQLite, passes integrity, has our tables.
    let backupTables: string[]
    let probe: DatabaseSync | undefined
    try {
      probe = new DatabaseSync(file, { readOnly: true })
      const check = probe.prepare('PRAGMA quick_check').get() as Record<string, unknown>
      const result = String(Object.values(check)[0] ?? '').toLowerCase()
      if (result !== 'ok') throw new Error(`Integritätsprüfung der Sicherung fehlgeschlagen (${result}).`)
      backupTables = (
        probe
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      )
        .map((r) => r.name)
        .filter((n) => SAFE_NAME.test(n))
      const missing = REQUIRED_TABLES.filter((t) => !backupTables.includes(t))
      if (missing.length) {
        throw new Error(`Keine gültige OpenLeads-Sicherung — Tabellen fehlen (${missing.join(', ')}).`)
      }
    } catch (e) {
      throw new Error(
        (e as Error).message.startsWith('Keine') || (e as Error).message.startsWith('Integrit')
          ? (e as Error).message
          : 'Datei ist keine gültige SQLite-Sicherung.',
      )
    } finally {
      probe?.close()
    }

    // 2. Copy into the live DB. Only tables present in BOTH schemas are touched.
    const liveTables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    )
    const toCopy = backupTables.filter((t) => liveTables.has(t))

    db.exec(`ATTACH '${file.replace(/'/g, "''")}' AS restore`)
    let rows = 0
    try {
      // foreign_keys can't be toggled inside a transaction; defer it around the swap
      // so wipe+reload order can't trip constraints, then restore the setting.
      db.exec('PRAGMA foreign_keys = OFF')
      db.exec('BEGIN')
      try {
        for (const t of toCopy) db.exec(`DELETE FROM main.${t}`)
        for (const t of toCopy) {
          const shared = columnsOf('main', t).filter((c) => columnsOf('restore', t).includes(c))
          if (!shared.length) continue
          const cols = shared.map((c) => `"${c}"`).join(', ')
          db.exec(`INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM restore.${t}`)
          rows += (db.prepare(`SELECT COUNT(*) AS c FROM main.${t}`).get() as { c: number }).c
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('DETACH restore')
    }
    return { tables: toCopy.length, rows }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
