import { CRM_API_URL, CRM_SERVICE_TOKEN } from './config'

export interface LeadPayload {
  company: string
  trade?: string
  city: string
  website: string
  phone?: string
  email?: string
  mobile_friendly: boolean
  tech: string | null
  staleness_signal: string
  score: number
  priority: string
  why_lead: string
  source: 'scraper'
}

export interface PostResult {
  id?: number
  deduped?: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function postLead(lead: LeadPayload): Promise<PostResult> {
  const url = `${CRM_API_URL}/api/leads`
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CRM_SERVICE_TOKEN}`,
    },
    body: JSON.stringify(lead),
  }
  let lastErr = 'unbekannter Fehler'
  // Retry transient failures (network blip, 429, 5xx) so a single lead isn't lost.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1))
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (e) {
      lastErr = (e as Error).message
      continue
    }
    if (res.ok) return res.json() as Promise<PostResult>
    const body = await res.text().catch(() => '')
    if (res.status === 429 || res.status >= 500) {
      lastErr = `${res.status} ${body}`
      continue
    }
    // 4xx (e.g. bad payload, 401) won't fix itself — fail fast.
    throw new Error(`POST /api/leads failed: ${res.status} ${body}`)
  }
  throw new Error(`POST /api/leads failed after retries: ${lastErr}`)
}
