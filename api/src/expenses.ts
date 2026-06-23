import { db, EXPENSE_CATEGORIES, type ExpenseRow } from './db'

// Ausgaben (operating expenses / Belege). The cost side of the books. Mirrors the
// shape of the payments/documents modules: integer cents throughout, a small set
// of pure helpers, and serialisers that never leak the receipt BLOB to callers
// that only want the metadata.

const CATEGORY_IDS = new Set(EXPENSE_CATEGORIES.map((c) => c.id))
const DEFAULT_CATEGORY = 'sonstiges'

/** Valid German VAT rates for an expense (0 = no Vorsteuer, e.g. §19 supplier). */
const VAT_RATES = new Set([0, 7, 19])

/**
 * Split a gross amount into net + VAT (Vorsteuer herausrechnen). Receipts print
 * the gross, so gross + rate is the canonical input and net/VAT are derived.
 *   net = round(gross / (1 + rate/100)),  vat = gross - net
 * rate 0 → net = gross, vat = 0.
 */
export function splitGross(grossCents: number, vatRate: number): { net_cents: number; vat_cents: number } {
  const gross = Math.round(grossCents)
  const rate = VAT_RATES.has(vatRate) ? vatRate : 0
  if (rate === 0) return { net_cents: gross, vat_cents: 0 }
  const net = Math.round(gross / (1 + rate / 100))
  return { net_cents: net, vat_cents: gross - net }
}

/** Coerce an arbitrary category id to a known one (defaults to 'sonstiges'). */
export function normalizeCategory(c: unknown): string {
  return typeof c === 'string' && CATEGORY_IDS.has(c as never) ? c : DEFAULT_CATEGORY
}

/** SKR03 expense account (Aufwandskonto) for a category, used in the DATEV export. */
export function categoryAccount(category: string): string {
  return EXPENSE_CATEGORIES.find((c) => c.id === category)?.skr03 ?? '4980'
}

// The client-facing shape: everything except the raw receipt bytes, plus a
// `has_receipt` flag so the list can show a paperclip without shipping the file.
export interface Expense {
  id: number
  vendor: string | null
  category: string
  description: string | null
  expense_date: string
  paid_on: string | null
  gross_cents: number
  vat_rate: number
  net_cents: number
  vat_cents: number
  payment_method: string | null
  note: string | null
  has_receipt: boolean
  receipt_name: string | null
  receipt_mime: string | null
  receipt_size: number | null
  created_by: string | null
  created_at: string
  updated_at: string
}

function toPublic(row: ExpenseRow): Expense {
  const { receipt_data, ...rest } = row
  return { ...rest, has_receipt: receipt_data != null }
}

export interface ExpenseInput {
  vendor?: string | null
  category?: string | null
  description?: string | null
  expense_date?: string | null
  paid_on?: string | null
  gross_cents?: number
  vat_rate?: number
  payment_method?: string | null
  note?: string | null
}

export interface ExpenseFilter {
  from?: string
  to?: string
  category?: string
  q?: string
}

/** WHERE clause + params shared by list and summary. */
function buildWhere(f: ExpenseFilter): { where: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (f.from) {
    clauses.push('expense_date >= ?')
    params.push(f.from)
  }
  if (f.to) {
    clauses.push('expense_date <= ?')
    params.push(f.to)
  }
  if (f.category && CATEGORY_IDS.has(f.category as never)) {
    clauses.push('category = ?')
    params.push(f.category)
  }
  if (f.q && f.q.trim()) {
    clauses.push('(vendor LIKE ? OR description LIKE ? OR note LIKE ?)')
    const like = `%${f.q.trim()}%`
    params.push(like, like, like)
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

// SELECT list that omits the BLOB — listing receipts' bytes would be wasteful.
const COLS_NO_BLOB =
  'id, vendor, category, description, expense_date, paid_on, gross_cents, vat_rate, ' +
  'net_cents, vat_cents, payment_method, note, receipt_name, receipt_mime, receipt_size, ' +
  'created_by, created_at, updated_at, (receipt_data IS NOT NULL) AS has_receipt'

type RowNoBlob = Omit<ExpenseRow, 'receipt_data'> & { has_receipt: number }

export function listExpenses(filter: ExpenseFilter = {}): Expense[] {
  const { where, params } = buildWhere(filter)
  const rows = db
    .prepare(`SELECT ${COLS_NO_BLOB} FROM expenses ${where} ORDER BY expense_date DESC, id DESC`)
    .all(...params) as unknown as RowNoBlob[]
  return rows.map((r) => ({ ...r, has_receipt: !!r.has_receipt }))
}

/** A single expense (metadata only, no receipt bytes), or null. */
export function getExpense(id: number): Expense | null {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as unknown as
    | ExpenseRow
    | undefined
  return row ? toPublic(row) : null
}

export function createExpense(input: ExpenseInput, actor: string | null): Expense {
  const gross = Math.round(Number(input.gross_cents ?? 0))
  const rate = Number(input.vat_rate ?? 19)
  const vatRate = VAT_RATES.has(rate) ? rate : 0
  const { net_cents, vat_cents } = splitGross(gross, vatRate)
  const expense_date = (input.expense_date || new Date().toISOString().slice(0, 10)).slice(0, 10)
  const info = db
    .prepare(
      `INSERT INTO expenses
        (vendor, category, description, expense_date, paid_on, gross_cents, vat_rate,
         net_cents, vat_cents, payment_method, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.vendor ?? null,
      normalizeCategory(input.category),
      input.description ?? null,
      expense_date,
      input.paid_on ?? null,
      gross,
      vatRate,
      net_cents,
      vat_cents,
      input.payment_method ?? null,
      input.note ?? null,
      actor,
    )
  return getExpense(Number(info.lastInsertRowid))!
}

const EDITABLE = new Set([
  'vendor', 'category', 'description', 'expense_date', 'paid_on',
  'gross_cents', 'vat_rate', 'payment_method', 'note',
])

export function updateExpense(id: number, patch: ExpenseInput): Expense | null {
  const cur = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as unknown as
    | ExpenseRow
    | undefined
  if (!cur) return null

  const sets: string[] = []
  const params: Record<string, string | number | null> = { id }
  for (const key of Object.keys(patch)) {
    if (!EDITABLE.has(key)) continue
    let v = (patch as Record<string, unknown>)[key]
    if (key === 'category') v = normalizeCategory(v)
    if (key === 'gross_cents') v = Math.round(Number(v))
    if (key === 'expense_date' && typeof v === 'string') v = v.slice(0, 10)
    sets.push(`${key} = @${key}`)
    params[key] = (v as string | number | null) ?? null
  }

  // Recompute the derived net/Vorsteuer whenever gross or rate change.
  if ('gross_cents' in patch || 'vat_rate' in patch) {
    const gross = Math.round(Number(patch.gross_cents ?? cur.gross_cents))
    const rawRate = Number(patch.vat_rate ?? cur.vat_rate)
    const vatRate = VAT_RATES.has(rawRate) ? rawRate : 0
    const { net_cents, vat_cents } = splitGross(gross, vatRate)
    sets.push('vat_rate = @vat_rate', 'net_cents = @net_cents', 'vat_cents = @vat_cents')
    params.vat_rate = vatRate
    params.net_cents = net_cents
    params.vat_cents = vat_cents
  }

  if (sets.length) {
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE expenses SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  return getExpense(id)
}

/** Delete an expense (and its receipt). Returns true if a row was removed. */
export function deleteExpense(id: number): boolean {
  return db.prepare('DELETE FROM expenses WHERE id = ?').run(id).changes > 0
}

export interface ReceiptInput {
  data: Uint8Array
  name: string
  mime: string
}

/** Attach (or replace) the receipt scan on an expense. Returns the updated row or null. */
export function setReceipt(id: number, receipt: ReceiptInput): Expense | null {
  const exists = db.prepare('SELECT id FROM expenses WHERE id = ?').get(id)
  if (!exists) return null
  db.prepare(
    `UPDATE expenses
       SET receipt_data = ?, receipt_name = ?, receipt_mime = ?, receipt_size = ?,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(receipt.data, receipt.name, receipt.mime, receipt.data.byteLength, id)
  return getExpense(id)
}

/** Remove the receipt from an expense, keeping the expense itself. */
export function deleteReceipt(id: number): Expense | null {
  const exists = db.prepare('SELECT id FROM expenses WHERE id = ?').get(id)
  if (!exists) return null
  db.prepare(
    `UPDATE expenses
       SET receipt_data = NULL, receipt_name = NULL, receipt_mime = NULL, receipt_size = NULL,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(id)
  return getExpense(id)
}

/** Fetch the receipt bytes + metadata for download, or null if none attached. */
export function getReceipt(
  id: number,
): { data: Uint8Array; name: string; mime: string } | null {
  const row = db
    .prepare('SELECT receipt_data, receipt_name, receipt_mime FROM expenses WHERE id = ?')
    .get(id) as unknown as
    | Pick<ExpenseRow, 'receipt_data' | 'receipt_name' | 'receipt_mime'>
    | undefined
  if (!row || !row.receipt_data) return null
  return {
    data: row.receipt_data,
    name: row.receipt_name || `beleg-${id}`,
    mime: row.receipt_mime || 'application/octet-stream',
  }
}

export interface ExpenseSummary {
  count: number
  gross_cents: number
  net_cents: number
  vat_cents: number // total Vorsteuer
  by_category: { category: string; count: number; gross_cents: number; net_cents: number }[]
}

/** Totals + per-category breakdown for the filtered set (dashboard / reports). */
export function expenseSummary(filter: ExpenseFilter = {}): ExpenseSummary {
  const { where, params } = buildWhere(filter)
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(gross_cents), 0) AS gross_cents,
              COALESCE(SUM(net_cents), 0) AS net_cents,
              COALESCE(SUM(vat_cents), 0) AS vat_cents
       FROM expenses ${where}`,
    )
    .get(...params) as unknown as Omit<ExpenseSummary, 'by_category'>
  const by_category = db
    .prepare(
      `SELECT category,
              COUNT(*) AS count,
              COALESCE(SUM(gross_cents), 0) AS gross_cents,
              COALESCE(SUM(net_cents), 0) AS net_cents
       FROM expenses ${where}
       GROUP BY category
       ORDER BY gross_cents DESC`,
    )
    .all(...params) as unknown as ExpenseSummary['by_category']
  return { ...totals, by_category }
}
