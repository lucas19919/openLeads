import { MIN_SCORE, priorityFromScore, type Candidate } from './config'
import { fetchHtml, enrichContact, extractContact } from './fetchSite'
import { scoreSite, buildWhy } from './score'
import { postLead } from './post'
import { discoverCandidates } from './discover'

export interface CandidateResult {
  id?: number
  deduped?: boolean
  score: number
  priority: string
}

/** Fetch (or use supplied HTML), score, enrich, and post a single candidate. */
export async function processCandidate(
  cand: Candidate,
  minScore: number = MIN_SCORE,
): Promise<CandidateResult | null> {
  let html: string
  let finalUrl: string
  if (cand.html !== undefined) {
    html = cand.html
    finalUrl = cand.website
  } else {
    const fetched = await fetchHtml(cand.website)
    if (!fetched) return null
    html = fetched.html
    finalUrl = fetched.finalUrl
  }

  const s = scoreSite(html, finalUrl)
  if (s.score < minScore) return null

  const contact =
    cand.html !== undefined ? extractContact(html) : await enrichContact(finalUrl, html)
  const priority = priorityFromScore(s.score)

  const result = await postLead({
    company: cand.company,
    trade: cand.trade,
    city: cand.city,
    website: finalUrl,
    phone: contact.phone,
    email: contact.email,
    contact_name: contact.name,
    mobile_friendly: s.mobileFriendly,
    tech: s.tech,
    staleness_signal: s.signals.join(', '),
    score: s.score,
    priority,
    why_lead: buildWhy(s),
    source: 'scraper',
  })

  return { ...result, score: s.score, priority }
}

export interface PairSummary {
  posted: number
  deduped: number
  skipped: number
}

/** Discover candidates for one trade/town and run each through the pipeline. */
export async function runPair(
  trade: string,
  town: string,
  limit: number,
  minScore: number = MIN_SCORE,
  region?: string,
): Promise<PairSummary> {
  const summary: PairSummary = { posted: 0, deduped: 0, skipped: 0 }
  let candidates: Candidate[]
  try {
    candidates = await discoverCandidates(trade, town, limit, region)
  } catch (e) {
    console.log(`  ! Discovery fehlgeschlagen: ${(e as Error).message}`)
    return summary
  }
  if (candidates.length === 0) {
    console.log('  (keine Kandidaten gefunden)')
    return summary
  }

  for (const cand of candidates) {
    let result: CandidateResult | null = null
    try {
      result = await processCandidate(cand, minScore)
    } catch (e) {
      console.log(`  ! ${cand.company}: ${(e as Error).message}`)
      continue
    }
    if (!result) {
      summary.skipped++
      console.log(`  - ${cand.company}: kein Lead (modern oder nicht erreichbar)`)
    } else if (result.deduped) {
      summary.deduped++
      console.log(`  - ${cand.company}: bereits im System`)
    } else {
      summary.posted++
      console.log(`  + ${cand.company} — Score ${result.score} (${result.priority})`)
    }
  }
  return summary
}
