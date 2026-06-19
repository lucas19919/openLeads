import './env'
import {
  TRADES,
  TOWNS,
  MIN_SCORE,
  REGION,
  DRY_RUN_FIXTURES,
  CRM_API_URL,
  CRM_SERVICE_TOKEN,
  fetchScraperConfig,
} from './config'
import { processCandidate, runPair } from './pipeline'

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}
const hasFlag = (n: string) => process.argv.includes(`--${n}`)

/** Human-readable elapsed time, e.g. "840 ms", "12.3 s", "1m 05s". */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
}

// Days since the Unix epoch — advances by one each calendar day so daily runs
// walk the full trade×town grid deterministically instead of randomly.
function daySeed(): number {
  return Math.floor(Date.now() / 86_400_000)
}

function pickPairs(
  trades: string[],
  towns: string[],
  max: number,
  offset = daySeed(),
): [string, string][] {
  const all: [string, string][] = []
  for (const t of trades) for (const c of towns) all.push([t, c])
  if (all.length === 0) return []
  // Rotate the start by `offset` so repeated daily runs cover new ground in
  // order rather than at random; DB dedupe still handles any overlap.
  const start = ((offset % all.length) + all.length) % all.length
  return all.slice(start).concat(all.slice(0, start)).slice(0, max)
}

async function dryRun(): Promise<void> {
  console.log('DRY RUN — Fixtures bewerten und an die CRM-API senden (kein Sonnet, kein Web-Fetch)\n')
  const start = Date.now()
  let posted = 0
  let deduped = 0
  let skipped = 0
  for (const fixture of DRY_RUN_FIXTURES) {
    const r = await processCandidate(fixture)
    if (!r) {
      skipped++
      console.log(`- ${fixture.company}: unter Schwelle, übersprungen`)
    } else if (r.deduped) {
      deduped++
      console.log(`- ${fixture.company}: bereits vorhanden (Domain-Dedupe)`)
    } else {
      posted++
      console.log(`+ ${fixture.company}: angelegt — Score ${r.score} (${r.priority})`)
    }
  }
  console.log(
    `\nFertig in ${fmtDuration(Date.now() - start)}. ` +
      `Neu: ${posted}, Dedupe: ${deduped}, übersprungen: ${skipped}`,
  )
}

/** Confirm the CRM API is reachable before spending on AI discovery. */
async function crmReachable(): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(`${CRM_API_URL}/api/health`, { signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function liveRun(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY fehlt — in crm/scraper/.env eintragen (oder --dry-run nutzen).')
    process.exit(1)
  }
  // Verify the lead sink is up BEFORE paying for discovery — otherwise we'd run
  // Sonnet + Websuche, fetch and score every site, then fail to post all of it.
  if (!(await crmReachable())) {
    console.error(
      `CRM-API nicht erreichbar unter ${CRM_API_URL} — Lauf abgebrochen, bevor Kosten entstehen. ` +
        `(CRM_API_URL prüfen bzw. die API starten.)`,
    )
    process.exit(1)
  }
  // CLI args win; otherwise use the CRM-configured values; otherwise env/defaults.
  const remote = await fetchScraperConfig()
  if (remote) console.log('Konfiguration aus dem CRM geladen.')
  const trades = argValue('trade')?.split(',').map((s) => s.trim()) ?? remote?.trades ?? TRADES
  const towns = argValue('town')?.split(',').map((s) => s.trim()) ?? remote?.towns ?? TOWNS
  const region = argValue('region') ?? REGION
  const maxPairs = Number(argValue('max-pairs') ?? remote?.max_pairs ?? 3)
  const perPair = Number(argValue('limit') ?? remote?.per_pair ?? 8)
  const minScore = Number(argValue('min-score') ?? remote?.min_score ?? MIN_SCORE)

  const pairs = pickPairs(trades, towns, maxPairs)
  console.log(
    `Scrape: ${pairs.length} Kombination(en) (Gewerk × Ort) in „${region}", Mindest-Score ${minScore}\n`,
  )

  const runStart = Date.now()
  const total = { posted: 0, deduped: 0, skipped: 0 }
  for (const [trade, town] of pairs) {
    console.log(`> ${trade} in ${town}`)
    const pairStart = Date.now()
    const res = await runPair(trade, town, perPair, minScore, region)
    total.posted += res.posted
    total.deduped += res.deduped
    total.skipped += res.skipped
    console.log(
      `  (${fmtDuration(Date.now() - pairStart)} — neu ${res.posted}, dup ${res.deduped}, ` +
        `übersprungen ${res.skipped})`,
    )
  }
  console.log(
    `\nFertig in ${fmtDuration(Date.now() - runStart)}. ` +
      `Neu: ${total.posted}, Dedupe: ${total.deduped}, übersprungen: ${total.skipped}`,
  )
}

async function main(): Promise<void> {
  if (!CRM_SERVICE_TOKEN) {
    console.error('CRM_SERVICE_TOKEN fehlt — in crm/scraper/.env eintragen.')
    process.exit(1)
  }
  if (hasFlag('dry-run')) await dryRun()
  else await liveRun()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
