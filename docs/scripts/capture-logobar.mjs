/**
 * Render the OpenLeads wordmark (same as the top-left .brand) as a full-width
 * README banner.
 *
 *   node docs/scripts/capture-logobar.mjs
 *
 * Needs playwright + Chromium (and the Spectral font files from web/).
 */
import { chromium } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const OUT = path.resolve(__dirname, '../images/logobar.png')

// Match web/src/styles.css .brand + tokens
const INK = '#211e1a'
const ACCENT = '#1f7a8c'
const CHROME = '#fbf9f4'

// Wide banner so GitHub README shows it full content-width
const WIDTH = 1600
const HEIGHT = 220

async function main() {
  await mkdir(path.dirname(OUT), { recursive: true })

  const fontNormal = pathToFileURL(
    path.join(ROOT, 'web/node_modules/@fontsource/spectral/files/spectral-latin-600-normal.woff2'),
  ).href
  const fontItalic = pathToFileURL(
    path.join(ROOT, 'web/node_modules/@fontsource/spectral/files/spectral-latin-600-italic.woff2'),
  ).href

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @font-face {
    font-family: 'Spectral';
    font-style: normal;
    font-weight: 600;
    src: url('${fontNormal}') format('woff2');
  }
  @font-face {
    font-family: 'Spectral';
    font-style: italic;
    font-weight: 600;
    src: url('${fontItalic}') format('woff2');
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    background: ${CHROME};
    overflow: hidden;
  }
  .bar {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${CHROME};
  }
  /* Same recipe as .brand in styles.css, scaled up for a README banner */
  .brand {
    font-family: 'Spectral', Georgia, serif;
    font-weight: 600;
    font-size: 72px;
    letter-spacing: -0.015em;
    color: ${INK};
    white-space: nowrap;
    line-height: 1;
  }
  .brand i {
    font-style: italic;
    color: ${ACCENT};
  }
</style>
</head>
<body>
  <div class="bar">
    <div class="brand">Open<i>Leads</i></div>
  </div>
</body>
</html>`

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  })
  await page.setContent(html, { waitUntil: 'networkidle' })
  // Wait for webfonts
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await page.waitForTimeout(200)
  await page.screenshot({ path: OUT, type: 'png' })
  await browser.close()
  console.log('wrote', path.relative(ROOT, OUT), `(${WIDTH}×${HEIGHT} @2x)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
