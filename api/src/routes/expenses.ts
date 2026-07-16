import type { Hono } from 'hono'
import {
  listExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
  setReceipt,
  deleteReceipt,
  getReceipt,
  expenseSummary,
} from '../expenses'
import { audit } from '../audit'
import { requireAuth, type Vars } from './middleware'
import { readUpload, inlineFile } from './helpers'

export function registerExpenseRoutes(app: Hono<{ Variables: Vars }>): void {
  // List expenses, optionally filtered by Belegdatum range, category or free text,
  // plus the matching summary (so the view gets totals for the current filter).
  app.get('/api/expenses', requireAuth, (c) => {
    const filter = {
      from: c.req.query('from') || undefined,
      to: c.req.query('to') || undefined,
      category: c.req.query('category') || undefined,
      q: c.req.query('q') || undefined,
    }
    return c.json({ expenses: listExpenses(filter), summary: expenseSummary(filter) })
  })

  app.post('/api/expenses', requireAuth, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const gross = Math.round(Number(b.gross_cents))
    if (!Number.isFinite(gross) || gross <= 0) {
      return c.json({ error: 'Bruttobetrag (Cent) muss positiv sein.' }, 400)
    }
    const exp = createExpense(
      {
        vendor: (b.vendor as string) ?? null,
        category: (b.category as string) ?? null,
        description: (b.description as string) ?? null,
        expense_date: (b.expense_date as string) ?? null,
        paid_on: (b.paid_on as string) ?? null,
        gross_cents: gross,
        vat_rate: Number(b.vat_rate ?? 19),
        payment_method: (b.payment_method as string) ?? null,
        note: (b.note as string) ?? null,
      },
      c.get('user').username,
    )
    audit({ actor: c.get('user').username, action: 'expense.create', entity: 'expense', entityId: exp.id, detail: { gross_cents: exp.gross_cents, category: exp.category, vendor: exp.vendor } })
    return c.json({ expense: exp }, 201)
  })

  app.patch('/api/expenses/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if ('gross_cents' in b) {
      const gross = Math.round(Number(b.gross_cents))
      if (!Number.isFinite(gross) || gross <= 0) {
        return c.json({ error: 'Bruttobetrag (Cent) muss positiv sein.' }, 400)
      }
      b.gross_cents = gross
    }
    const exp = updateExpense(id, b)
    if (!exp) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'expense.update', entity: 'expense', entityId: id, detail: { fields: Object.keys(b) } })
    return c.json({ expense: exp })
  })

  app.delete('/api/expenses/:id', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    if (!deleteExpense(id)) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'expense.delete', entity: 'expense', entityId: id })
    return c.json({ ok: true })
  })

  // Attach / replace the receipt scan. multipart/form-data field name: "file".
  app.post('/api/expenses/:id/receipt', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    if (!getExpense(id)) return c.json({ error: 'not found' }, 404)
    const up = await readUpload(c, `beleg-${id}`)
    if (!up.ok) return c.json({ error: up.error }, up.status)
    const exp = setReceipt(id, up.file)
    audit({ actor: c.get('user').username, action: 'expense.receipt.upload', entity: 'expense', entityId: id, detail: { name: up.file.name, bytes: up.file.data.byteLength } })
    return c.json({ expense: exp })
  })

  // Download / view the receipt scan inline.
  app.get('/api/expenses/:id/receipt', requireAuth, (c) => {
    const receipt = getReceipt(Number(c.req.param('id')))
    if (!receipt) return c.json({ error: 'not found' }, 404)
    return inlineFile(c, receipt)
  })

  app.delete('/api/expenses/:id/receipt', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const exp = deleteReceipt(id)
    if (!exp) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'expense.receipt.delete', entity: 'expense', entityId: id })
    return c.json({ expense: exp })
  })
}
