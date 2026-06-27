import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getSettings } from './documents'
import { decryptSecret, resolveAIConfig } from './secrets'

// Triggering a lead-discovery run from the UI. The scraper is a standalone
// service (its own env + Anthropic key; posts leads back via the service token),
// so we run it as a one-shot child process and parse its summary line. This
// works wherever the API can see the scraper sources (dev, single-host deploy);
// in a split-container setup it degrades gracefully to a recorded error.
//
// Runs are fire-and-poll: startScrape() kicks the child off and returns at once;
// the UI polls /api/scraper/status for the live state + final result. A dry run
// (--dry-run) uses offline fixtures — no Anthropic key, no cost — for testing.

export interface ScrapeResult {
  ok: boolean
  detail: string
  posted?: number
  deduped?: number
  skipped?: number
  dry: boolean
}

export interface ScrapeRunState {
  running: boolean
  dry: boolean
  started_at: string | null
  finished_at: string | null
  last: ScrapeResult | null
}

const state: ScrapeRunState = {
  running: false,
  dry: false,
  started_at: null,
  finished_at: null,
  last: null,
}

export function scrapeRunState(): ScrapeRunState {
  return state
}

function scraperEntry(): string | null {
  const entry = resolve(process.cwd(), '..', 'scraper', 'src', 'index.ts')
  return existsSync(entry) ? entry : null
}

/** Whether the scraper sources are reachable from here (i.e. a run is possible). */
export function scraperReachable(): boolean {
  return scraperEntry() !== null
}

/** Whether the API has a service token the spawned scraper can authenticate with. */
export function serviceTokenConfigured(): boolean {
  return !!process.env.SERVICE_TOKEN
}

/**
 * The environment the scraper child runs with. We wire the CRM connection from
 * the API's own config (the scraper and API are the same trust domain when run
 * this way), and let the operator-set discovery model + key override the
 * scraper's .env — so a GUI run needs no scraper/.env at all.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // CRM connection: the scraper posts back to THIS API with its own token.
  if (process.env.SERVICE_TOKEN) env.CRM_SERVICE_TOKEN = process.env.SERVICE_TOKEN
  env.CRM_API_URL = `http://127.0.0.1:${process.env.PORT ?? 8787}`
  // Discovery model: always the operator's default configured AI model — there
  // is no separate scraper model knob. The scraper's own API key still applies.
  const s = getSettings()
  env.SCRAPER_MODEL = resolveAIConfig().model
  const key = decryptSecret(s.scraper_ai_api_key_enc)
  if (key) env.ANTHROPIC_API_KEY = key
  return env
}

/**
 * Start a scraper run in the background. Returns immediately; watch
 * scrapeRunState() for progress. Never throws. `dry` runs offline fixtures.
 */
export function startScrape(opts: { dry?: boolean } = {}): { started: boolean; detail?: string } {
  if (state.running) return { started: false, detail: 'Scraper läuft bereits.' }
  const entry = scraperEntry()
  if (!entry) return { started: false, detail: 'Scraper-Quellen nicht erreichbar (separater Dienst).' }
  if (!serviceTokenConfigured()) {
    return { started: false, detail: 'SERVICE_TOKEN ist in der API nicht gesetzt — in api/.env eintragen.' }
  }
  state.running = true
  state.dry = !!opts.dry
  state.started_at = new Date().toISOString()
  state.finished_at = null
  state.last = null
  runChild(entry, !!opts.dry)
    .then((r) => {
      state.last = r
    })
    .finally(() => {
      state.running = false
      state.finished_at = new Date().toISOString()
    })
  return { started: true }
}

function runChild(entry: string, dry: boolean, timeoutMs = 6 * 60_000): Promise<ScrapeResult> {
  return new Promise((done) => {
    const scraperDir = resolve(process.cwd(), '..', 'scraper')
    // Spawn a fresh Node with tsx loaded (tsx is a dependency in the scraper dir).
    const args = ['--import', 'tsx', entry]
    if (dry) args.push('--dry-run')
    let out = ''
    let err = ''
    const child = spawn(process.execPath, args, { cwd: scraperDir, env: childEnv() })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ ok: false, detail: `Scraper-Start fehlgeschlagen: ${e.message}`, dry })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // "Fertig … Neu: 3, Dedupe: 1, übersprungen: 2"
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
          dry,
        })
      }
      if (code === 0) return done({ ok: true, detail: 'Lauf abgeschlossen.', dry })
      const reason = (err || out).trim().split('\n').filter(Boolean).pop() || `Exit-Code ${code}`
      done({ ok: false, detail: `Scraper-Fehler: ${reason}`, dry })
    })
  })
}
