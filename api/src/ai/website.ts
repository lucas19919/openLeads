import { chatJSON } from './provider'
import { ICP_SUGGESTER_SYSTEM } from './prompts'

// "Analyse meine Website": read the operator's own homepage and let the model
// propose a lead-search raster (trades / region / towns). The suggestion is just
// that — the UI fills the form with it and the operator reviews + saves. Nothing
// is applied automatically (in-the-loop principle).

export interface ScraperSuggestion {
  trades: string[]
  region: string
  towns: string[]
  rationale: string
}

// Block private / loopback / link-local hosts. The operator points this at their
// own public site; refusing internal targets keeps the server-side fetch from
// being turned into an SSRF probe of the host's network.
const PRIVATE_HOST =
  /^(?:localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?)$|\.local$/i

function publicHttpUrl(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (PRIVATE_HOST.test(u.hostname)) return null
  return u
}

async function fetchSiteText(url: URL): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'OpenLeadsBot/1.0 (+ICP-Analyse)', Accept: 'text/html,*/*' },
    })
    if (!res.ok) throw new Error(`Website nicht erreichbar (HTTP ${res.status}).`)
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('html') && !ct.includes('text')) throw new Error('Die URL liefert keine HTML-Seite.')
    if (Number(res.headers.get('content-length') ?? 0) > 5_000_000) throw new Error('Seite zu groß.')
    const html = await res.text()
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000)
  } finally {
    clearTimeout(timer)
  }
}

const cleanList = (v: unknown, n: number): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))].slice(0, n)
    : []

export async function suggestScraperRaster(rawUrl: string): Promise<ScraperSuggestion> {
  const url = publicHttpUrl(rawUrl)
  if (!url) throw new Error('Bitte eine gültige, öffentliche Website-URL angeben.')
  const text = await fetchSiteText(url)
  if (text.length < 80) throw new Error('Auf der Seite war zu wenig Text für eine Analyse.')
  const s = await chatJSON<ScraperSuggestion>(
    ICP_SUGGESTER_SYSTEM,
    `Eigene Website (${url.hostname}):\n\n${text}`,
    { temperature: 0.3, maxTokens: 600 },
  )
  return {
    trades: cleanList(s.trades, 12),
    region: typeof s.region === 'string' ? s.region.trim() : '',
    towns: cleanList(s.towns, 12),
    rationale: typeof s.rationale === 'string' ? s.rationale.trim() : '',
  }
}
