import PDFDocument from 'pdfkit'
import { fileURLToPath } from 'node:url'
import type { FullDocument } from './documents'
import type { SettingsRow } from './db'
import type { DunningComputation } from './dunning'
import { levelLabel } from './dunning'

// Reuse the invoice letterhead/footer look. Fonts shipped under api/assets so
// €, German umlauts and § render even under PDF/A (no standard-14 fonts).
const FONT_REGULAR = fileURLToPath(new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url))
const FONT_BOLD = fileURLToPath(new URL('../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url))

// German money/date formatting. Money is integer cents.
function euro(cents: number): string {
  const s = (cents / 100).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${s} €`
}

function date(iso: string | null): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return d && m && y ? `${d}.${m}.${y}` : iso
}

/** ISO date `days` days from `from` (default today). */
function addDays(from: string, days: number): string {
  const t = Date.parse(from)
  if (Number.isNaN(t)) return from
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

const ACCENT = '#1f7a8c' // OpenLeads teal-blue
const MUTED = '#6b7785'
const TEXT = '#1c2733'
const LINE = '#e2e6ea'

/**
 * Render a Mahnung (dunning notice) to a PDF Buffer, mirroring the invoice
 * design. Level 0 is a friendly Zahlungserinnerung; level >= 1 references Verzug
 * and lists Verzugszinsen + Mahnpauschale.
 */
export function renderMahnungPdf(
  doc: FullDocument,
  s: SettingsRow,
  comp: DunningComputation,
  level: number,
): Promise<Buffer> {
  const label = levelLabel(level)

  const pdf = new PDFDocument({
    size: 'A4',
    margin: 50,
    info: {
      Title: `${label} ${doc.number ?? ''}`.trim(),
      Author: s.business_name ?? 'OpenLeads',
      Creator: 'OpenLeads',
    },
  })
  pdf.registerFont('Body', FONT_REGULAR)
  pdf.registerFont('Bold', FONT_BOLD)
  pdf.font('Body')

  const chunks: Buffer[] = []
  pdf.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)))
  })

  const left = pdf.page.margins.left
  const right = pdf.page.width - pdf.page.margins.right
  const width = right - left

  // --- letterhead (sender, top-right) ---
  pdf.fontSize(16).fillColor(ACCENT).font('Bold')
  pdf.text(s.business_name || 'OpenLeads', left, 50, { width, align: 'right' })
  pdf.font('Body').fontSize(9).fillColor(MUTED)
  const senderLines = [
    s.owner,
    s.address ?? '',
    [s.zip, s.city].filter(Boolean).join(' '),
    s.email,
    s.phone,
    s.tax_id ? `Steuernr./USt-IdNr.: ${s.tax_id}` : null,
  ].filter(Boolean) as string[]
  pdf.text(senderLines.join('\n'), left, 72, { width, align: 'right' })

  // --- recipient block (left) ---
  let y = 150
  pdf.fontSize(8).fillColor(MUTED).font('Body')
  pdf.text(
    [s.business_name, s.address, [s.zip, s.city].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(' · '),
    left,
    y,
    { width: width * 0.6 },
  )
  y += 16
  pdf.fontSize(11).fillColor(TEXT).font('Body')
  const recipient = [
    doc.client_name,
    doc.client_address,
    [doc.client_zip, doc.client_city].filter(Boolean).join(' '),
  ].filter(Boolean) as string[]
  pdf.text(recipient.length ? recipient.join('\n') : '—', left, y, { width: width * 0.6 })

  // --- meta block (right): invoice number + dates ---
  const metaTop = 150
  const today = new Date().toISOString().slice(0, 10)
  const metaRows: [string, string][] = [
    ['Rechnungs-Nr.', doc.number ?? '(Entwurf)'],
    ['Rechnungsdatum', date(doc.issue_date)],
  ]
  if (doc.due_date) metaRows.push(['Fällig war', date(doc.due_date)])
  metaRows.push(['Datum', date(today)])
  pdf.fontSize(9)
  let my = metaTop
  for (const [k, v] of metaRows) {
    pdf.fillColor(MUTED).font('Body').text(k, right - 200, my, { width: 100, align: 'left' })
    pdf.fillColor(TEXT).font('Bold').text(v, right - 100, my, { width: 100, align: 'right' })
    my += 15
  }

  // --- title (Mahnstufe) ---
  y = 250
  pdf.fontSize(18).fillColor(TEXT).font('Bold')
  pdf.text(label, left, y)
  y = pdf.y + 10

  // --- salutation ---
  pdf.fontSize(11).fillColor(TEXT).font('Body')
  pdf.text('Sehr geehrte Damen und Herren,', left, y, { width })
  y = pdf.y + 10

  // --- body ---
  const invNo = doc.number ?? '(ohne Nummer)'
  const issued = date(doc.issue_date)
  const due = date(doc.due_date)
  let body: string
  if (level <= 0) {
    body =
      `sicherlich ist es Ihrer Aufmerksamkeit entgangen: unsere Rechnung ${invNo}` +
      `${issued ? ` vom ${issued}` : ''} über ${euro(comp.gross_cents)} ist bis heute ` +
      `noch nicht beglichen` +
      `${due ? ` – sie war bereits am ${due} fällig` : ''}. ` +
      `Wir bitten Sie höflich, den offenen Betrag zeitnah auszugleichen. ` +
      `Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben als gegenstandslos.`
  } else {
    body =
      `trotz Fälligkeit unserer Rechnung ${invNo}${issued ? ` vom ${issued}` : ''} über ` +
      `${euro(comp.gross_cents)} konnten wir bislang keinen Zahlungseingang feststellen. ` +
      `${due ? `Die Rechnung war am ${due} fällig; ` : ''}` +
      `Sie befinden sich seit ${comp.days_overdue} Tagen in Verzug. ` +
      `Wir fordern Sie hiermit auf, die nachstehende Gesamtforderung – einschließlich der ` +
      `gesetzlichen Verzugszinsen und der Mahnpauschale nach § 288 BGB – umgehend zu begleichen.`
  }
  pdf.fontSize(10).fillColor(TEXT).font('Body').text(body, left, y, { width })
  y = pdf.y + 16

  // --- breakdown table (right-aligned, like the invoice totals) ---
  const tLabel = right - 280
  const tVal = right - 90
  function line(lbl: string, value: string, opts: { bold?: boolean } = {}) {
    pdf.font(opts.bold ? 'Bold' : 'Body').fontSize(opts.bold ? 11 : 9)
    pdf.fillColor(opts.bold ? TEXT : MUTED).text(lbl, tLabel, y, { width: 180, align: 'right' })
    pdf.fillColor(TEXT).text(value, tVal, y, { width: 90, align: 'right' })
    y += opts.bold ? 18 : 14
  }

  pdf.rect(left, y - 4, width, 0.5).fill(LINE)
  y += 6
  line('Rechnungsbetrag', euro(comp.gross_cents))
  if (comp.interest_cents > 0) {
    line(
      `Verzugszinsen (${comp.interest_rate_percent}% p.a., ${comp.days_overdue} Tage)`,
      euro(comp.interest_cents),
    )
  }
  if (comp.pauschale_cents > 0) {
    line('Mahnpauschale (§ 288 Abs. 5 BGB)', euro(comp.pauschale_cents))
  }
  pdf.rect(tLabel, y - 2, right - tLabel, 0.5).fill(LINE)
  y += 6
  line('Gesamtforderung', euro(comp.total_claim_cents), { bold: true })
  y += 12

  // --- payment instruction + new deadline ---
  const payBy = date(addDays(today, 7))
  const payLines: string[] = [
    level <= 0
      ? `Bitte überweisen Sie den offenen Betrag bis zum ${payBy} auf folgendes Konto:`
      : `Bitte überweisen Sie die Gesamtforderung bis spätestens ${payBy} auf folgendes Konto:`,
  ]
  const bankLine = [
    s.bank ? s.bank : null,
    s.iban ? `IBAN: ${s.iban}` : null,
    s.bic ? `BIC: ${s.bic}` : null,
  ].filter(Boolean)
  if (bankLine.length) payLines.push(bankLine.join('   '))
  if (doc.number) payLines.push(`Verwendungszweck: ${doc.number}`)
  pdf.font('Body').fontSize(10).fillColor(TEXT).text(payLines.join('\n'), left, y, { width })
  y = pdf.y + 14

  // --- closing ---
  pdf.font('Body').fontSize(10).fillColor(MUTED)
  pdf.text('Mit freundlichen Grüßen', left, y, { width })
  y = pdf.y + 4
  if (s.business_name || s.owner) {
    pdf.text(s.owner || s.business_name || '', left, y, { width })
  }

  // --- footer (like the invoice) ---
  const footY = pdf.page.height - 70
  pdf.rect(left, footY - 8, width, 0.5).fill(LINE)
  pdf.font('Body').fontSize(8).fillColor(MUTED)
  const footerParts = [
    s.business_name,
    s.iban ? `IBAN ${s.iban}` : null,
    s.tax_id ? `St.-Nr. ${s.tax_id}` : null,
    s.website,
  ].filter(Boolean) as string[]
  pdf.text(footerParts.join('  ·  '), left, footY, { width, align: 'center' })

  pdf.end()
  return done
}

/** A filesystem-safe filename, e.g. "Mahnung_RE-2026-0001_Stufe1.pdf". */
export function mahnungPdfFilename(doc: FullDocument, level: number): string {
  const id = (doc.number ?? `Entwurf-${doc.id}`).replace(/[^\w-]/g, '_')
  return `Mahnung_${id}_Stufe${level}.pdf`
}
