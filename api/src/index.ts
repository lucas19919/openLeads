import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { bodyLimit } from 'hono/body-limit'

import { seedDefaults } from './seed'
import { processDueRecurring } from './recurring'
import type { Vars } from './routes/middleware'
import { requireAuth } from './routes/middleware'
import { registerAuthRoutes } from './routes/auth'
import { registerLeadRoutes } from './routes/leads'
import { registerSettingsRoutes } from './routes/settings'
import { registerDocumentRoutes } from './routes/documents'
import { registerContractRoutes } from './routes/contracts'
import { registerCatalogRoutes } from './routes/catalog'
import { registerCustomerRoutes } from './routes/customers'
import { registerExpenseRoutes } from './routes/expenses'
import { registerSubscriptionRoutes } from './routes/subscriptions'
import { registerRecurringRoutes } from './routes/recurring'
import { registerUserRoutes } from './routes/users'
import { registerExportRoutes } from './routes/exports'
import { registerAdminRoutes } from './routes/admin'
import { registerAiRoutes } from './ai/router'
import { registerDsgvoRoutes } from './dsgvo'

// Composition root: global middleware, route registration, static serving in
// production, the recurring-invoice scheduler, and the listener. The actual
// endpoints live in ./routes/*, the domain logic one level below that.

const app = new Hono<{ Variables: Vars }>()

const isProd = process.env.NODE_ENV === 'production'
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'

// --- security baseline ------------------------------------------------------

// Standard hardening headers on every response; a strict-but-workable CSP for
// the SPA the API serves in production (self-hosted, no third-party assets).
app.use(
  secureHeaders({
    contentSecurityPolicy: isProd
      ? {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
        }
      : undefined,
  }),
)

app.use('/api/*', cors({ origin: WEB_ORIGIN, credentials: true }))

// CSRF guard: mutating requests must come from our own origin (the Vite dev
// origin, or same-origin in production). Cookie-authenticated form posts from a
// foreign site are rejected regardless of SameSite behaviour.
app.use(
  '/api/*',
  csrf({
    origin: (origin, c) => origin === WEB_ORIGIN || origin === new URL(c.req.url).origin,
  }),
)

// Request-size caps: JSON bodies stay small; the upload endpoints allow the
// 10 MB receipt/signed-document files (validated again per route); the backup
// restore sets its own 200 MB limit where it is registered.
const JSON_LIMIT = bodyLimit({ maxSize: 2 * 1024 * 1024 })
const UPLOAD_LIMIT = bodyLimit({ maxSize: 12 * 1024 * 1024 })
const UPLOAD_PATH = /\/(import|receipt|signed-document)$/
app.use('/api/*', (c, next) => {
  if (c.req.path === '/api/admin/restore') return next()
  return (UPLOAD_PATH.test(c.req.path) ? UPLOAD_LIMIT : JSON_LIMIT)(c, next)
})

// --- routes ------------------------------------------------------------------

registerAuthRoutes(app)
registerLeadRoutes(app)
registerSettingsRoutes(app)
registerDocumentRoutes(app)
registerContractRoutes(app)
registerCatalogRoutes(app)
registerCustomerRoutes(app)
registerExpenseRoutes(app)
registerSubscriptionRoutes(app)
registerRecurringRoutes(app)
registerUserRoutes(app)
registerExportRoutes(app)
registerAdminRoutes(app)
registerAiRoutes(app, requireAuth)
registerDsgvoRoutes(app, requireAuth)

app.get('/api/health', (c) => c.json({ ok: true }))

// --- serve the built web app (production only) ------------------------------
// In dev the web app runs on Vite and proxies /api here, so this is skipped.
if (isProd) {
  // @hono/node-server serveStatic resolves `root` relative to the cwd.
  const webDist = process.env.WEB_DIST ?? '../web/dist'
  app.use('/*', serveStatic({ root: webDist }))
  // SPA fallback: any non-API, non-asset route returns index.html.
  let indexHtml = ''
  try {
    indexHtml = readFileSync(resolve(process.cwd(), webDist, 'index.html'), 'utf8')
  } catch {
    console.warn(`web build not found at ${webDist} — run "npm run build" in web/`)
  }
  app.get('*', (c) => (indexHtml ? c.html(indexHtml) : c.text('web app not built', 503)))
}

// --- one-time defaults + recurring-invoice scheduler -------------------------

seedDefaults()

// Generate drafts for due Serienrechnungen on an interval. Drafts only (no
// number, no send), so this never acts on its own beyond preparing work for a
// human. Set RECURRING_DISABLE=1 to turn it off.
if (process.env.RECURRING_DISABLE !== '1') {
  const runDue = () => {
    try {
      const { generated } = processDueRecurring()
      if (generated) console.log(`recurring: ${generated} Rechnungsentwurf/-entwürfe erzeugt`)
    } catch (e) {
      console.warn('recurring scheduler error:', (e as Error).message)
    }
  }
  setTimeout(runDue, 15_000).unref() // shortly after boot
  setInterval(runDue, 6 * 60 * 60 * 1000).unref() // every 6h
}

// --- boot ---------------------------------------------------------------------

const port = Number(process.env.PORT ?? 8787)
// In Docker, bind 0.0.0.0 (HOST=0.0.0.0) so the published port is reachable.
// The host only exposes it on 127.0.0.1 via the compose `ports` mapping.
const host = process.env.HOST ?? '127.0.0.1'
serve({ fetch: app.fetch, port, hostname: host }, ({ port }) => {
  console.log(`openleads api listening on http://${host}:${port}`)
})
