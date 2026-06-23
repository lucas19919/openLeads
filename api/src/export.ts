import { db, EXPENSE_CATEGORIES, type SettingsRow } from './db'
import { getDocument, getSettings, type FullDocument } from './documents'
import { listExpenses, categoryAccount, type Expense } from './expenses'

// Exports for the Steuerberater. Two flavours:
//  1. A clean, GoBD-minded invoice journal CSV (human + spreadsheet friendly).
//  2. A DATEV-style Buchungsstapel CSV with the essential booking columns
//     (Umsatz, S/H, Konto, Gegenkonto, BU-Schlüssel, Belegdatum, Belegfeld 1,
//     Buchungstext) — the columns a tax advisor maps for import. This is a
//     pragmatic booking template, not the full 116-column EXTF envelope.
//
// German conventions throughout: semicolon-separated, comma decimals, DD.MM.YYYY.

function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? '' : String(v)
  // Neutralise spreadsheet formula injection: a cell a tool like Excel would
  // interpret as a formula (=, +, -, @, or a leading tab/CR) gets a leading
  // apostrophe so it is rendered as literal text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  // Quote when the cell contains the delimiter, quotes or a newline.
  if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(';')
}

/** cents → "1234,56" (German decimal comma). */
export function deAmount(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',')
}

/** "YYYY-MM-DD" → "DD.MM.YYYY". */
export function deDate(iso: string | null): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return d && m && y ? `${d}.${m}.${y}` : iso
}

/** All finalised invoices in an optional [from,to] issue-date window. */
export function finalisedInvoices(from?: string, to?: string): FullDocument[] {
  const clauses = ["kind = 'rechnung'", 'number IS NOT NULL']
  const params: string[] = []
  if (from) {
    clauses.push('issue_date >= ?')
    params.push(from)
  }
  if (to) {
    clauses.push('issue_date <= ?')
    params.push(to)
  }
  const rows = db
    .prepare(`SELECT id FROM documents WHERE ${clauses.join(' AND ')} ORDER BY issue_date, number`)
    .all(...params) as unknown as { id: number }[]
  return rows.map((r) => getDocument(r.id)).filter((d): d is FullDocument => d !== null)
}

/** GoBD-minded invoice journal. One row per invoice with the tax-relevant fields. */
export function invoicesCsv(invoices: FullDocument[]): string {
  const header = [
    'Rechnungsnummer', 'Rechnungsdatum', 'Faelligkeit', 'Kunde', 'Ort', 'Status',
    'Netto', 'USt-Satz', 'USt-Betrag', 'Brutto', 'Kleinunternehmer',
  ]
  const lines = [csvRow(header)]
  for (const d of invoices) {
    lines.push(
      csvRow([
        d.number, deDate(d.issue_date), deDate(d.due_date), d.client_name, d.client_city, d.status,
        deAmount(d.totals.net_cents), d.small_business ? '0' : `${d.vat_rate}%`,
        deAmount(d.totals.vat_cents), deAmount(d.totals.gross_cents), d.small_business ? 'ja' : 'nein',
      ]),
    )
  }
  return lines.join('\r\n') + '\r\n'
}

/**
 * DATEV-style Buchungsstapel. One revenue booking per invoice:
 *   Umsatz = gross, S/H = 'S' (Debitor an Erlöse), Konto = Debitor,
 *   Gegenkonto = Erlöskonto, BU-Schlüssel from the VAT rate, Belegdatum,
 *   Belegfeld1 = invoice number, Buchungstext = customer.
 */
export function datevCsv(invoices: FullDocument[], s: SettingsRow): string {
  const debitor = s.datev_debitor_account || '10000'
  const revenue = s.datev_revenue_account || (s.small_business ? '8200' : '8400')
  const header = [
    'Umsatz', 'Soll/Haben-Kennzeichen', 'Konto', 'Gegenkonto (ohne BU-Schluessel)',
    'BU-Schluessel', 'Belegdatum', 'Belegfeld 1', 'Buchungstext', 'Steuersatz',
  ]
  const lines = [csvRow(header)]
  for (const d of invoices) {
    // BU-Schlüssel: simplified SKR03 mapping — empty for §19/0%, '3' for 19%, '2' for 7%.
    const bu = d.small_business || d.totals.vat_cents === 0 ? '' : d.vat_rate === 19 ? '3' : d.vat_rate === 7 ? '2' : ''
    lines.push(
      csvRow([
        deAmount(d.totals.gross_cents), 'S', debitor, revenue, bu,
        deDate(d.issue_date), d.number, d.client_name ?? '',
        d.small_business ? '0' : String(d.vat_rate),
      ]),
    )
  }
  return lines.join('\r\n') + '\r\n'
}

// --- expenses (Ausgaben) ----------------------------------------------------

const CATEGORY_LABEL = new Map<string, string>(EXPENSE_CATEGORIES.map((c) => [c.id, c.label]))

/** All expenses in an optional [from,to] Belegdatum window (newest first). */
export function expensesInRange(from?: string, to?: string): Expense[] {
  return listExpenses({ from, to })
}

/** Human + spreadsheet friendly expense journal. One row per expense. */
export function expensesCsv(expenses: Expense[]): string {
  const header = [
    'Belegdatum', 'Lieferant', 'Kategorie', 'Beschreibung', 'Netto', 'USt-Satz',
    'Vorsteuer', 'Brutto', 'Zahlungsart', 'Bezahlt am', 'Beleg',
  ]
  const lines = [csvRow(header)]
  for (const e of expenses) {
    lines.push(
      csvRow([
        deDate(e.expense_date), e.vendor, CATEGORY_LABEL.get(e.category) ?? e.category,
        e.description, deAmount(e.net_cents), e.vat_rate ? `${e.vat_rate}%` : '0%',
        deAmount(e.vat_cents), deAmount(e.gross_cents), e.payment_method,
        deDate(e.paid_on), e.has_receipt ? 'ja' : 'nein',
      ]),
    )
  }
  return lines.join('\r\n') + '\r\n'
}

/**
 * DATEV-style Buchungsstapel for expenses. One booking per expense:
 *   Umsatz = gross, S/H = 'S' (Aufwand im Soll), Konto = category's SKR03
 *   Aufwandskonto, Gegenkonto = Bank, BU-Schlüssel from the Vorsteuer rate
 *   (SKR03: 19% → '9', 7% → '8', 0 % → leer), Belegdatum, Belegfeld1 = the
 *   expense id, Buchungstext = Lieferant. Pragmatic template, not the full EXTF.
 */
export function expensesDatevCsv(expenses: Expense[], s: SettingsRow): string {
  const bank = s.datev_bank_account || '1200'
  const header = [
    'Umsatz', 'Soll/Haben-Kennzeichen', 'Konto', 'Gegenkonto (ohne BU-Schluessel)',
    'BU-Schluessel', 'Belegdatum', 'Belegfeld 1', 'Buchungstext', 'Steuersatz',
  ]
  const lines = [csvRow(header)]
  for (const e of expenses) {
    // SKR03 Vorsteuer BU-Schlüssel: 19% = '9', 7% = '8', sonst leer.
    const bu = e.vat_cents === 0 ? '' : e.vat_rate === 19 ? '9' : e.vat_rate === 7 ? '8' : ''
    lines.push(
      csvRow([
        deAmount(e.gross_cents), 'S', categoryAccount(e.category), bank, bu,
        deDate(e.expense_date), `A-${e.id}`, e.vendor ?? CATEGORY_LABEL.get(e.category) ?? '',
        String(e.vat_rate),
      ]),
    )
  }
  return lines.join('\r\n') + '\r\n'
}

export function exportFilename(
  kind: 'rechnungen' | 'datev' | 'ausgaben' | 'ausgaben-datev',
  from?: string,
  to?: string,
): string {
  const span = [from, to].filter(Boolean).join('_bis_') || new Date().toISOString().slice(0, 10)
  return `${kind}_${span}.csv`
}

export { getSettings }
