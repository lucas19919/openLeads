// Usage: npm run restore -- <path-to-backup.db>
//
// Replaces the live SQLite database with a backup produced by `npm run backup`
// or the "Backup herunterladen (.db)" button — both are self-contained
// `VACUUM INTO` snapshots (a single file, no WAL sidecar).
//
// ⚠  STOP THE API FIRST so nothing holds the database open mid-swap. In Docker:
//      docker compose stop api
//      docker compose run --rm -v "$PWD/openleads-backup-XXXX.db":/in/backup.db \
//        api npm run restore -- /in/backup.db
//      docker compose up -d api
//
// Before swapping, the current database is snapshotted to
// <data-dir>/pre-restore-<ts>.db, so a mistaken restore is itself reversible.
import '../src/env'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

// Resolve the live DB path exactly as src/db.ts does.
const DB_PATH = process.env.DB_PATH
  ? resolve(process.cwd(), process.env.DB_PATH)
  : resolve(process.cwd(), 'data', 'leads.db')

const arg = process.argv[2]
if (!arg) {
  console.error('Usage: npm run restore -- <path-to-backup.db>')
  process.exit(1)
}
const src = resolve(process.cwd(), arg)
if (!existsSync(src)) {
  console.error(`Backup file not found: ${src}`)
  process.exit(1)
}

// --- 1. validate the backup is an intact OpenLeads database -----------------
// A truncated download or the wrong file would otherwise be swapped in blindly.
// node:sqlite opens lazily and only rejects a non-database on the first query,
// so the whole probe — open, integrity check, schema check — is guarded together.
const REQUIRED_TABLES = ['users', 'leads', 'documents', 'document_items', 'settings']
{
  let probe: DatabaseSync | undefined
  try {
    probe = new DatabaseSync(src, { readOnly: true })
    const check = probe.prepare('PRAGMA quick_check').get() as Record<string, unknown>
    const result = String(Object.values(check)[0] ?? '').toLowerCase()
    if (result !== 'ok') throw new Error(`failed its integrity check (${result})`)
    const tables = new Set(
      (probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    )
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t))
    if (missing.length) throw new Error(`missing OpenLeads tables (${missing.join(', ')})`)
  } catch (e) {
    console.error(`Invalid backup file: ${(e as Error).message}`)
    process.exit(1)
  } finally {
    probe?.close()
  }
}

// --- 2. refuse if a writer is active, then snapshot the current DB ----------
function ts(): string {
  return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
}
if (existsSync(DB_PATH)) {
  const cur = new DatabaseSync(DB_PATH)
  cur.exec('PRAGMA busy_timeout = 0')
  // BEGIN IMMEDIATE grabs the write lock now; SQLITE_BUSY means the API (or
  // another process) is mid-write. It can't prove the API is fully stopped —
  // stopping it first is still on you — but it catches an in-flight write.
  let inUse: string | null = null
  try {
    cur.exec('BEGIN IMMEDIATE')
    cur.exec('ROLLBACK')
  } catch (e) {
    inUse = (e as Error).message
  }
  if (inUse) {
    cur.close()
    console.error(`The live database is in use (${inUse}).\nStop the API first:  docker compose stop api`)
    process.exit(1)
  }
  const safety = join(dirname(DB_PATH), `pre-restore-${ts()}.db`)
  cur.exec(`VACUUM INTO '${safety.replace(/'/g, "''")}'`)
  cur.close()
  console.log(`Saved current database → ${safety}`)
}

// --- 3. swap in the backup --------------------------------------------------
copyFileSync(src, DB_PATH)
// A stale WAL/SHM beside the new file would replay old frames over it on the
// next open → corruption. The snapshot is a single file, so dropping them is safe.
rmSync(`${DB_PATH}-wal`, { force: true })
rmSync(`${DB_PATH}-shm`, { force: true })

console.log(`Restored ${src} → ${DB_PATH}`)
console.log('Start the API again:  docker compose up -d api')
