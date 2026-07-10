import type { Hono } from 'hono'
import { getSettings } from '../documents'
import {
  finalisedInvoices,
  invoicesCsv,
  datevCsv,
  expensesInRange,
  expensesCsv,
  expensesDatevCsv,
  exportFilename,
} from '../export'
import { audit } from '../audit'
import { requireAuth, type Vars } from './middleware'
import { csvResponse } from './helpers'

// Exports for the Steuerberater (GoBD invoice journal + DATEV bookings).
// The lead CSV export lives with the lead routes (it shares their filters).

export function registerExportRoutes(app: Hono<{ Variables: Vars }>): void {
  app.get('/api/export/invoices.csv', requireAuth, (c) => {
    const from = c.req.query('from')
    const to = c.req.query('to')
    const invoices = finalisedInvoices(from, to)
    audit({ actor: c.get('user').username, action: 'export.invoices', detail: { from, to, count: invoices.length } })
    return csvResponse(c, invoicesCsv(invoices), exportFilename('rechnungen', from, to))
  })

  app.get('/api/export/datev.csv', requireAuth, (c) => {
    const from = c.req.query('from')
    const to = c.req.query('to')
    const invoices = finalisedInvoices(from, to)
    audit({ actor: c.get('user').username, action: 'export.datev', detail: { from, to, count: invoices.length } })
    return csvResponse(c, datevCsv(invoices, getSettings()), exportFilename('datev', from, to))
  })

  app.get('/api/export/expenses.csv', requireAuth, (c) => {
    const from = c.req.query('from')
    const to = c.req.query('to')
    const expenses = expensesInRange(from, to)
    audit({ actor: c.get('user').username, action: 'export.expenses', detail: { from, to, count: expenses.length } })
    return csvResponse(c, expensesCsv(expenses), exportFilename('ausgaben', from, to))
  })

  app.get('/api/export/expenses-datev.csv', requireAuth, (c) => {
    const from = c.req.query('from')
    const to = c.req.query('to')
    const expenses = expensesInRange(from, to)
    audit({ actor: c.get('user').username, action: 'export.expenses_datev', detail: { from, to, count: expenses.length } })
    return csvResponse(c, expensesDatevCsv(expenses, getSettings()), exportFilename('ausgaben-datev', from, to))
  })
}
