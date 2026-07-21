/**
 * Capture OpenLeads UI screenshots for documentation.
 *
 * Prerequisites: API on :8787, web on :5173, and a seeded login.
 *
 *   OPENLEADS_USER=admin OPENLEADS_PASS='…' node docs/scripts/capture-screenshots.mjs
 *
 * Optional: OPENLEADS_URL (default http://localhost:5173)
 *
 * Needs the `playwright` package and a Chromium browser install:
 *   npm install -D playwright && npx playwright install chromium
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

async function shot(page, name, fullPage = false) {
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file, fullPage })
  console.log('  wrote', path.relative(process.cwd(), file))
}

async function clickNav(page, label) {
  const item = page.locator('.nav-item', { hasText: label }).first()
  await item.click()
  await page.waitForTimeout(700)
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
  })

  console.log('Logging in…')
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('input[name="username"], input[type="text"], form', { timeout: 15000 })

  // Login form fields
  const userInput = page.locator('input[name="username"], input[autocomplete="username"], form input[type="text"]').first()
  const passInput = page.locator('input[name="password"], input[type="password"]').first()
  await userInput.fill(USER)
  await passInput.fill(PASS)
  await page.locator('button[type="submit"], form button').first().click()
  await page.waitForSelector('.side, .brand', { timeout: 15000 })
  await page.waitForTimeout(900)

  console.log('Capturing modules…')
  await shot(page, 'overview')

  await clickNav(page, 'Leads')
  await page.waitForTimeout(500)
  await shot(page, 'leads')

  // Prefer board view if toggle exists
  const boardBtn = page.locator('button, .seg button, .toolbar button', { hasText: /Board|Kanban|Karte/i }).first()
  if (await boardBtn.count()) {
    await boardBtn.click().catch(() => {})
    await page.waitForTimeout(500)
    await shot(page, 'leads-board')
  }

  await clickNav(page, 'Kunden')
  await page.waitForTimeout(500)
  await shot(page, 'customers')

  await clickNav(page, 'Rechnungen')
  await page.waitForTimeout(500)
  await shot(page, 'invoices')

  await clickNav(page, 'Verträge')
  await page.waitForTimeout(500)
  await shot(page, 'contracts')

  await clickNav(page, 'Ausgaben')
  await page.waitForTimeout(500)
  await shot(page, 'expenses')

  await clickNav(page, 'Chat')
  await page.waitForTimeout(500)
  await shot(page, 'chat')

  // Settings if admin
  const settings = page.locator('.nav-item', { hasText: 'Einstellungen' }).first()
  if (await settings.count()) {
    await settings.click()
    await page.waitForTimeout(700)
    await shot(page, 'settings')
  }

  // Login screen (logout first)
  const logout = page.locator('button', { hasText: /Abmelden|Logout|Ausloggen/i }).first()
  if (await logout.count()) {
    await logout.click()
    await page.waitForTimeout(600)
    await shot(page, 'login')
  }

  await browser.close()
  console.log('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
