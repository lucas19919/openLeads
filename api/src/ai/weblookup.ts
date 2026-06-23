// Lightweight website reader for the copilot's lead tools. Lets the agent turn a
// bare URL into usable lead facts (Firma, Kontakt) instead of pestering the user
// for details the site already shows. Self-contained (the scraper's fetchSite is a
// separate workspace) and deliberately conservative: http/https only, a hard
// timeout, a byte cap, and a guard against pointing the fetch at our own network.

const USER_AGENT =
  'OpenLeads/1.0 (+https://openleads.local; Lead-Recherche im Auftrag des Betreibers)'
const FETCH_TIMEOUT_MS = 8000
const MAX_HTML_BYTES = 750_000

export interface WebsiteFacts {
  final_url: string
  company_guess: string | null
  title: string | null
  description: string | null
  email: string | null
  phone: string | null
}

/** Pretty company name from a hostname: print-factory24.de -> "Print Factory 24". */
export function companyFromDomain(input: string | null | undefined): string | null {
  if (!input) return null
  let host = String(input).trim().toLowerCase()
  try {
    if (/^https?:\/\//.test(host)) host = new URL(host).hostname
  } catch {
    /* treat as bare hostname */
  }
  host = host.replace(/^www\./, '')
  const label = host.split('.')[0]
  if (!label) return null
  const words = label
    .replace(/[-_]+/g, ' ')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  return words.join(' ') || null
}

/** Reject obviously-internal targets so the fetch can't be turned on our own LAN. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  return false
}

function normalizeUrl(raw: string): URL | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (isPrivateHost(u.hostname)) return null
    return u
  } catch {
    return null
  }
}

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;|&mdash;/gi, '–')
    .trim()
}

function meta(html: string, attr: 'name' | 'property', key: string): string | null {
  const re = new RegExp(
    `<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']+)["']`,
    'i',
  )
  const m = re.exec(html) ?? new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]*${attr}=["']${key}["']`,
    'i',
  ).exec(html)
  return m ? decode(m[1]) : null
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const PHONE_RE = /(?:\+49|0)[\d\s/().-]{6,}\d/g

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
}

function pickEmail(text: string): string | null {
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase()
    if (/\.(png|jpe?g|gif|svg|webp|ico)$/.test(e)) continue
    if (/@(sentry|wixpress|example)\b/.test(e)) continue
    if (/(^|[._-])(no-?reply|donotreply|mailer-daemon|postmaster)@/.test(e)) continue
    return m[0]
  }
  return null
}

function pickPhone(text: string): string | null {
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length < 7 || digits.length > 15) continue
    const ctx = text.slice(Math.max(0, m.index - 12), m.index).toLowerCase()
    if (/fax|telefax/.test(ctx)) continue
    return m[0].replace(/\s+/g, ' ').trim()
  }
  return null
}

/** Strip boilerplate suffixes a homepage title tacks on after the brand. */
function cleanTitle(title: string | null): string | null {
  if (!title) return null
  const head = title.split(/\s+[|–—·-]\s+/)[0]?.trim()
  return head || title
}

/**
 * Fetch a public website and pull out lead-relevant facts. Returns `null` on any
 * failure (unreachable, non-HTML, private/invalid URL) so the caller can fall back
 * gracefully — the agent should still be able to create a lead from the bare URL.
 */
export async function lookupWebsite(rawUrl: string): Promise<WebsiteFacts | null> {
  const u = normalizeUrl(rawUrl)
  if (!u) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(u.href, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
    })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('html') && !ct.includes('text')) return null
    const buf = new Uint8Array(await res.arrayBuffer()).subarray(0, MAX_HTML_BYTES)
    const html = new TextDecoder('utf-8').decode(buf)
    const titleRaw = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') || null
    const text = stripTags(html)
    const finalUrl = res.url || u.href
    return {
      final_url: finalUrl,
      company_guess:
        meta(html, 'property', 'og:site_name') ||
        cleanTitle(titleRaw) ||
        companyFromDomain(finalUrl),
      title: titleRaw,
      description: meta(html, 'name', 'description') || meta(html, 'property', 'og:description'),
      email: pickEmail(text),
      phone: pickPhone(text),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
