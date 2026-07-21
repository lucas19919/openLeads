/**
 * Capture a wide logo-bar / banner strip for the README header.
 *
 *   OPENLEADS_USER=… OPENLEADS_PASS=… node docs/scripts/capture-logobar.mjs
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../images')
const BASE = process.env.OPENLEADS_URL || 'http://localhost:5173'
const USER = process.env.OPENLEADS_USER
const PASS = process.env.OPENLEADS_PASS

if (!USER || !PASS) {
  console.error('Set OPENLEADS_USER and OPENLEADS_PASS to a seeded login.')
  process.exit(1)
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  })

  await page.goto(BASE, { waitUntil: 'networkidle' })
  const userInput = page
    .locator('input[name="username"], input[autocomplete="username"], form input[type="text"]')
    .first()
  const passInput = page.locator('input[type="password"]').first()
  await userInput.fill(USER)
  await passInput.fill(PASS)
  await page.locator('button[type="submit"], form button').first().click()
  await page.waitForSelector('.brand', { timeout: 15000 })
  await page.waitForTimeout(1000)

  // Prefer Übersicht so the strip shows brand + live dashboard chrome
  const overview = page.locator('.nav-item', { hasText: 'Übersicht' }).first()
  if (await overview.count()) {
    await overview.click()
    await page.waitForTimeout(700)
  }

  // Logo bar: full width, brand + top content header + first KPI row
  const logobar = path.join(OUT, 'logobar.png')
  await page.screenshot({
    path: logobar,
    clip: { x: 0, y: 0, width: 1440, height: 300 },
  })
  console.log('wrote', path.relative(process.cwd(), logobar))

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
