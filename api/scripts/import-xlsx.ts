// Import an existing lead .xlsx into the CRM via the API (dedupes by domain).
//
//   Usage: npm run import -- <path-to.xlsx>
//
// The API must be running. Most people will use the "Import" button in the web
// app instead — this CLI is for server-side bulk loads. Uses the same parser as
// the upload endpoint (auto-detects the header row, maps German/English columns).
import '../src/env'
import ExcelJS from 'exceljs'
import { parseWorksheet } from '../src/import'

const API = process.env.CRM_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`
const TOKEN = process.env.SERVICE_TOKEN ?? ''

async function main() {
  const path = process.argv[2]
  if (!path) {
    console.error('Usage: npm run import -- <path-to.xlsx>')
    process.exit(1)
  }
  if (!TOKEN) {
    console.error('SERVICE_TOKEN missing in crm/api/.env')
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
  let skipped = 0
  for (const lead of leads) {
    const res = await fetch(`${API}/api/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(lead),
    })
    if (!res.ok) {
      skipped++
      continue
    }
    const body = (await res.json().catch(() => null)) as { deduped?: boolean } | null
    if (!body) skipped++
    else if (body.deduped) deduped++
    else posted++
  }

  console.log(`Import fertig. Neu: ${posted}, Dedupe: ${deduped}, übersprungen: ${skipped}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
