// Import an existing lead .xlsx straight into the database (dedupes by domain).
//
//   Usage: npm run import -- <path-to.xlsx>
//
// Most people will use the "Import" button in the web app instead — this CLI is
// for server-side bulk loads. Uses the same parser and insert logic as the
// upload endpoint (auto-detects the header row, maps German/English columns),
// writing directly via insertLead(), so no running API or token is needed.
import '../src/env'
import ExcelJS from 'exceljs'
import { parseWorksheet } from '../src/import'
import { insertLead } from '../src/leads'

async function main() {
  const path = process.argv[2]
  if (!path) {
    console.error('Usage: npm run import -- <path-to.xlsx>')
    process.exit(1)
  }

  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.readFile(path)
  } catch (e) {
    console.error(`Datei konnte nicht gelesen werden (${path}): ${(e as Error).message}`)
    process.exit(1)
  }
  const ws = wb.worksheets[0]
  if (!ws) {
    console.error('No worksheet found.')
    process.exit(1)
  }

  const { leads, headerRow, mapped } = parseWorksheet(ws)
  if (leads.length === 0) {
    console.error('No lead rows recognised (need columns like Firma/Website/Telefon).')
    process.exit(1)
  }
  console.log(`Header row ${headerRow}, ${leads.length} leads, columns: ${mapped.join(', ')}`)

  let posted = 0
  let deduped = 0
  for (const lead of leads) {
    if (insertLead({ ...lead, source: 'import' }, 'cli-import').deduped) deduped++
    else posted++
  }

  console.log(`Import fertig. Neu: ${posted}, Dedupe: ${deduped}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
