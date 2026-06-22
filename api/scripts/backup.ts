import '../src/env'
import { snapshotToFile, snapshotFilename } from '../src/backup'
import { join, resolve } from 'node:path'

// Cron-friendly snapshot. Usage:
//   npm run backup                 -> ./backups/openleads-backup-<ts>.db
//   BACKUP_DIR=/var/backups npm run backup
// Schedule via crontab, e.g. nightly:  0 3 * * * cd /app/api && npm run backup
const dir = process.env.BACKUP_DIR ? resolve(process.env.BACKUP_DIR) : resolve(process.cwd(), 'backups')
const out = join(dir, snapshotFilename())
try {
  const { path, bytes } = snapshotToFile(out)
  console.log(`backup written: ${path} (${(bytes / 1024).toFixed(1)} KiB)`)
} catch (e) {
  // Runs unattended from cron — a clean one-line reason beats a raw stack trace.
  console.error(`backup failed: ${(e as Error).message}`)
  process.exit(1)
}
