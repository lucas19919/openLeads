import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Triggering lead discovery from a workflow step. The scraper is a standalone
// service (its own env + Anthropic key, posts leads back via the service token),
// so we run it as a one-shot child process and parse its summary line. This
// works wherever the API can see the scraper sources (dev, single-host deploy);
// in a split container setup it degrades gracefully to a recorded error.

let scrapeRunning = false

export interface ScrapeResult {
  ok: boolean
  detail: string
  posted?: number
  deduped?: number
  skipped?: number
}

/** Run the scraper once. Never rejects — failures come back as { ok:false }. */
export function runScrape(timeoutMs = 5 * 60_000): Promise<ScrapeResult> {
  return new Promise((done) => {
    if (scrapeRunning) return done({ ok: false, detail: 'Scraper läuft bereits.' })

    const scraperDir = resolve(process.cwd(), '..', 'scraper')
    const entry = resolve(scraperDir, 'src', 'index.ts')
    if (!existsSync(entry)) {
      return done({ ok: false, detail: 'Scraper-Quellen nicht erreichbar (separater Dienst).' })
    }

    scrapeRunning = true
    let out = ''
    let err = ''
    // Spawn a fresh Node with tsx loaded (tsx is a dependency in the scraper dir).
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: scraperDir,
      env: process.env,
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)

    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      scrapeRunning = false
      done({ ok: false, detail: `Scraper-Start fehlgeschlagen: ${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      scrapeRunning = false
      // "Fertig. Neu: 3, Dedupe: 1, übersprungen: 2"
      const m = out.match(/Neu:\s*(\d+),\s*Dedupe:\s*(\d+),\s*übersprungen:\s*(\d+)/)
      if (m) {
        const posted = Number(m[1])
        const deduped = Number(m[2])
        const skipped = Number(m[3])
        return done({
          ok: true,
          detail: `${posted} neu · ${deduped} bekannt · ${skipped} übersprungen`,
          posted,
          deduped,
          skipped,
        })
      }
      if (code === 0) return done({ ok: true, detail: 'Scraper-Lauf abgeschlossen.' })
      const reason = (err || out).trim().split('\n').pop() || `Exit-Code ${code}`
      done({ ok: false, detail: `Scraper-Fehler: ${reason}` })
    })
  })
}
