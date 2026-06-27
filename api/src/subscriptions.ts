import { db, EXPENSE_CATEGORIES, RECURRING_CADENCES, type SubscriptionRow } from './db'
import { splitGross } from './expenses'

// Abonnements: recurring outgoing costs the business pays (SaaS, hosting,
// insurance, memberships). The forward-looking, cost-side counterpart to the
// recurring-invoice module. Same conventions as expenses: integer cents, a small
// set of pure helpers, category ids shared with EXPENSE_CATEGORIES so a booked
// charge lands in the same SKR03 bucket.

const CATEGORY_IDS = new Set(EXPENSE_CATEGORIES.map((c) => c.id))
const DEFAULT_CATEGORY = 'software'
const CADENCES = new Set<string>(RECURRING_CADENCES)
const VAT_RATES = new Set([0, 7, 19])

// How many of one cadence fit in a year — used to normalise to a monthly /
// yearly run-rate so different subscriptions are comparable.
const PER_YEAR: Record<string, number> = { monatlich: 12, quartalsweise: 4, jährlich: 1 }

function normalizeCategory(c: unknown): string {
  return typeof c === 'string' && CATEGORY_IDS.has(c as never) ? c : DEFAULT_CATEGORY
}
function normalizeCadence(c: unknown): string {
  return typeof c === 'string' && CADENCES.has(c) ? c : 'monatlich'
}

export interface Subscription extends SubscriptionRow {
  /** Gross normalised to a monthly run-rate (rounded cents). */
  monthly_cents: number
  /** Gross normalised to a yearly run-rate (rounded cents). */
  yearly_cents: number
}

/** Yearly gross run-rate for a subscription (amount × periods per year). */
export function yearlyCents(amountCents: number, cadence: string): number {
  return Math.round(amountCents) * (PER_YEAR[cadence] ?? 12)
}

function toPublic(row: SubscriptionRow): Subscription {
  const yearly = yearlyCents(row.amount_cents, row.cadence)
  return { ...row, yearly_cents: yearly, monthly_cents: Math.round(yearly / 12) }
}

export interface SubscriptionInput {
  vendor?: string | null
  description?: string | null
  category?: string | null
  amount_cents?: number
  vat_rate?: number
  cadence?: string | null
  next_renewal?: string | null
  payment_method?: string | null
  active?: number | boolean
  note?: string | null
}

export function listSubscriptions(activeOnly = false): Subscription[] {
  const where = activeOnly ? 'WHERE active = 1' : ''
  const rows = db
    .prepare(
      `SELECT * FROM subscriptions ${where}
        ORDER BY active DESC, next_renewal IS NULL, next_renewal ASC, id DESC`,
    )
    .all() as unknown as SubscriptionRow[]
  return rows.map(toPublic)
}

export function getSubscription(id: number): Subscription | null {
  const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as unknown as
    | SubscriptionRow
    | undefined
  return row ? toPublic(row) : null
}

export function createSubscription(input: SubscriptionInput, actor: string | null): Subscription {
  const amount = Math.round(Number(input.amount_cents ?? 0))
  const rate = Number(input.vat_rate ?? 19)
  const vatRate = VAT_RATES.has(rate) ? rate : 0
  const info = db
    .prepare(
      `INSERT INTO subscriptions
        (vendor, description, category, amount_cents, vat_rate, cadence,
         next_renewal, payment_method, active, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      (input.vendor ?? '').trim() || 'Unbenannt',
      input.description ?? null,
      normalizeCategory(input.category),
      amount,
      vatRate,
      normalizeCadence(input.cadence),
      input.next_renewal ? String(input.next_renewal).slice(0, 10) : null,
      input.payment_method ?? null,
      input.active === undefined ? 1 : input.active ? 1 : 0,
      input.note ?? null,
      actor,
    )
  return getSubscription(Number(info.lastInsertRowid))!
}

const EDITABLE = new Set([
  'vendor', 'description', 'category', 'amount_cents', 'vat_rate',
  'cadence', 'next_renewal', 'payment_method', 'active', 'note',
])

export function updateSubscription(id: number, patch: SubscriptionInput): Subscription | null {
  const cur = db.prepare('SELECT id FROM subscriptions WHERE id = ?').get(id)
  if (!cur) return null

  const sets: string[] = []
  const params: Record<string, string | number | null> = { id }
  for (const key of Object.keys(patch)) {
    if (!EDITABLE.has(key)) continue
    let v = (patch as Record<string, unknown>)[key]
    if (key === 'category') v = normalizeCategory(v)
    if (key === 'cadence') v = normalizeCadence(v)
    if (key === 'amount_cents') v = Math.round(Number(v))
    if (key === 'vat_rate') v = VAT_RATES.has(Number(v)) ? Number(v) : 0
    if (key === 'active') v = v ? 1 : 0
    if (key === 'next_renewal') v = v ? String(v).slice(0, 10) : null
    if (key === 'vendor') v = (typeof v === 'string' && v.trim()) || 'Unbenannt'
    sets.push(`${key} = @${key}`)
    params[key] = (v as string | number | null) ?? null
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  return getSubscription(id)
}

export function deleteSubscription(id: number): boolean {
  return db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id).changes > 0
}

export interface SubscriptionSummary {
  count: number
  active_count: number
  /** Monthly run-rate of all ACTIVE subscriptions (gross cents). */
  monthly_cents: number
  /** Yearly run-rate of all ACTIVE subscriptions (gross cents). */
  yearly_cents: number
  by_category: { category: string; count: number; monthly_cents: number }[]
  /** Active subscriptions renewing within the next `withinDays` window. */
  upcoming: { id: number; vendor: string; next_renewal: string; amount_cents: number }[]
}

/** Run-rate totals + per-category breakdown + upcoming renewals. */
export function subscriptionSummary(
  withinDays = 30,
  today: string = new Date().toISOString().slice(0, 10),
): SubscriptionSummary {
  const subs = listSubscriptions()
  const active = subs.filter((s) => s.active)
  const monthly = active.reduce((s, x) => s + x.monthly_cents, 0)

  const catMap = new Map<string, { count: number; monthly_cents: number }>()
  for (const s of active) {
    const e = catMap.get(s.category) ?? { count: 0, monthly_cents: 0 }
    e.count++
    e.monthly_cents += s.monthly_cents
    catMap.set(s.category, e)
  }
  const by_category = [...catMap.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.monthly_cents - a.monthly_cents)

  const horizon = new Date(Date.parse(today) + withinDays * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const upcoming = active
    .filter((s) => s.next_renewal && s.next_renewal <= horizon)
    .sort((a, b) => (a.next_renewal! < b.next_renewal! ? -1 : 1))
    .map((s) => ({ id: s.id, vendor: s.vendor, next_renewal: s.next_renewal!, amount_cents: s.amount_cents }))

  return {
    count: subs.length,
    active_count: active.length,
    monthly_cents: monthly,
    yearly_cents: monthly * 12,
    by_category,
    upcoming,
  }
}

// Re-exported so a future "book this charge as an expense" flow can reuse the
// same gross→net split the expenses module uses.
export { splitGross }
