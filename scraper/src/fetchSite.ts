import {
  USER_AGENT,
  FETCH_TIMEOUT_MS,
  MAX_HTML_BYTES,
  POLITE_DELAY_MS,
  RESPECT_ROBOTS,
} from './config'

export interface Fetched {
  html: string
  finalUrl: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const politeDelay = () => (POLITE_DELAY_MS > 0 ? sleep(POLITE_DELAY_MS) : Promise.resolve())

// --- robots.txt -----------------------------------------------------------
// Minimal but correct-enough robots parser: collect Disallow rules from groups
// whose User-agent matches "*" or our bot token. Cached per origin.
const robotsCache = new Map<string, string[]>()

function parseRobots(txt: string): string[] {
  const uaToken = (USER_AGENT.split('/')[0] || 'bot').toLowerCase()
  const groups: { agents: string[]; disallow: string[] }[] = []
  let cur: { agents: string[]; disallow: string[] } | null = null
  let expectingAgents = false
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const i = line.indexOf(':')
    if (i === -1) continue
    const field = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    if (field === 'user-agent') {
      if (!cur || !expectingAgents) {
        cur = { agents: [], disallow: [] }
        groups.push(cur)
        expectingAgents = true
      }
      cur.agents.push(value.toLowerCase())
    } else if (field === 'disallow') {
      if (cur) {
        expectingAgents = false
        if (value) cur.disallow.push(value)
      }
    } else if (cur) {
      expectingAgents = false
    }
  }
  const out: string[] = []
  for (const g of groups) {
    if (g.agents.some((a) => a === '*' || (a !== '' && uaToken.includes(a)))) {
      out.push(...g.disallow)
    }
  }
  return out
}

async function disallowedPaths(origin: string): Promise<string[]> {
  const cached = robotsCache.get(origin)
  if (cached) return cached
  let rules: string[] = []
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT },
      })
      if (res.ok && (res.headers.get('content-type') ?? '').includes('text')) {
        rules = parseRobots(await res.text())
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    rules = [] // no robots / unreachable → treat as allowed
  }
  robotsCache.set(origin, rules)
  return rules
}

async function isAllowed(url: string): Promise<boolean> {
  if (!RESPECT_ROBOTS) return true
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const rules = await disallowedPaths(u.origin)
  return !rules.some((p) => u.pathname.startsWith(p))
}

// --- body decoding --------------------------------------------------------
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(await res.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

// Old German sites are the target population and frequently serve latin1 /
// windows-1252 without a proper charset header — decode honestly so umlauts and
// contact data don't turn to mojibake.
function decodeBody(bytes: Uint8Array, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase()
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase()
  }
  if (!charset || charset === 'utf8') charset = 'utf-8'
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

export async function fetchHtml(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Fetched | null> {
  if (!(await isAllowed(url))) return null
  await politeDelay()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
    })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('html') && !ct.includes('text')) return null
    const bytes = await readCapped(res, MAX_HTML_BYTES)
    return { html: decodeBody(bytes, ct), finalUrl: res.url || url }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// --- contact extraction ---------------------------------------------------
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const PHONE_RE = /(?:\+49|0)[\d\s/().-]{6,}\d/g

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&middot;|&nbsp;|&ndash;|&amp;/gi, ' ')
    .replace(/\s+/g, ' ')
}

export interface Contact {
  phone?: string
  email?: string
}

function isJunkEmail(e: string): boolean {
  const s = e.toLowerCase()
  if (/\.(png|jpe?g|gif|svg|webp|bmp|ico)$/.test(s)) return true
  if (/@(sentry|wixpress|example)\b/.test(s)) return true
  // bounce/system mailboxes that are never a real contact
  if (/(^|[._-])(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|hostmaster|abuse)@/.test(s))
    return true
  return false
}

/** Rank candidate addresses: real inboxes first, role/privacy boxes last. */
function emailRank(e: string): number {
  const local = e.toLowerCase().split('@')[0]
  if (/^(info|kontakt|contact|office|mail|buero|büro|kanzlei|praxis|hallo|hello)/.test(local)) return 0
  if (/^(datenschutz|privacy|dsb|impressum|webmaster)/.test(local)) return 2
  return 1
}

function pickEmail(text: string): string | undefined {
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = m[0]
    if (isJunkEmail(e)) continue
    const key = e.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(e)
  }
  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => emailRank(a) - emailRank(b))
  return candidates[0]
}

function pickPhone(text: string): string | undefined {
  PHONE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PHONE_RE.exec(text))) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length < 7 || digits.length > 15) continue
    // skip fax numbers when the preceding text labels them as such
    const ctx = text.slice(Math.max(0, m.index - 12), m.index).toLowerCase()
    if (/fax|telefax/.test(ctx)) continue
    return m[0].replace(/\s+/g, ' ').trim()
  }
  return undefined
}

/** Pull a phone + email out of page text. */
export function extractContact(html: string): Contact {
  const text = stripTags(html)
  const out: Contact = {}
  const email = pickEmail(text)
  if (email) out.email = email
  const phone = pickPhone(text)
  if (phone) out.phone = phone
  return out
}

/**
 * Find contact details for a site. Reuses the already-fetched homepage HTML when
 * provided (avoids re-fetching `/`), then falls back to impressum/kontakt pages
 * only for whatever is still missing.
 */
export async function enrichContact(baseUrl: string, homepageHtml?: string): Promise<Contact> {
  let origin: string
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return {}
  }
  const out: Contact = {}
  if (homepageHtml) {
    const c = extractContact(homepageHtml)
    out.email ??= c.email
    out.phone ??= c.phone
  }
  for (const path of ['/impressum', '/kontakt', '/impressum.html', '/kontakt.html', '/contact']) {
    if (out.phone && out.email) break
    const r = await fetchHtml(origin + path)
    if (!r) continue
    const c = extractContact(r.html)
    out.email ??= c.email
    out.phone ??= c.phone
  }
  return out
}
