import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { snapshot, snapshotFilename, restoreFromBuffer } from '../backup'
import { buildDashboard } from '../dashboard'
import { buildEuer } from '../report'
import { audit } from '../audit'
import { requireAuth, requireAdmin, type Vars } from './middleware'

const RESTORE_MAX_BYTES = 200 * 1024 * 1024 // 200 MB

export function registerAdminRoutes(app: Hono<{ Variables: Vars }>): void {
  // A full DB snapshot contains every tenant's data — admin-only.
  app.get('/api/admin/backup', requireAdmin, (c) => {
    const buf = snapshot()
    audit({ actor: c.get('user').username, action: 'admin.backup', detail: { bytes: buf.length } })
    c.header('Content-Type', 'application/octet-stream')
    c.header('Content-Disposition', `attachment; filename="${snapshotFilename()}"`)
    return c.body(buf as unknown as ArrayBuffer)
  })

  // Restore a previously downloaded snapshot — the upload counterpart to the backup
  // download. Validates the file, then replaces the live data in one transaction
  // (rolls back on any failure). Admin-only and audited; destructive by design.
  app.post(
    '/api/admin/restore',
    requireAdmin,
    bodyLimit({ maxSize: RESTORE_MAX_BYTES + 1024 * 1024 }),
    async (c) => {
      const form = await c.req.parseBody()
      const file = form['file']
      if (!(file instanceof File)) return c.json({ error: 'Keine Datei hochgeladen.' }, 400)
      if (file.size > RESTORE_MAX_BYTES) return c.json({ error: 'Datei zu groß (max. 200 MB).' }, 413)
      let result
      try {
        result = restoreFromBuffer(Buffer.from(await file.arrayBuffer()))
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400)
      }
      audit({ actor: c.get('user').username, action: 'admin.restore', detail: { ...result, bytes: file.size } })
      return c.json({ ok: true, ...result })
    },
  )

  // --- dashboard (read-only KPIs) + EÜR period report ----------------------

  app.get('/api/dashboard', requireAuth, (c) => c.json({ dashboard: buildDashboard() }))

  app.get('/api/report/euer', requireAuth, (c) => {
    const from = c.req.query('from') || undefined
    const to = c.req.query('to') || undefined
    return c.json({ report: buildEuer(from, to) })
  })
}
