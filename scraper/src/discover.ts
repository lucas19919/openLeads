import './env'
import Anthropic from '@anthropic-ai/sdk'
import { MODEL, REGION, WEB_SEARCH_MAX_USES, DIRECTORY_BLOCKLIST, type Candidate } from './config'

const client = new Anthropic() // reads ANTHROPIC_API_KEY

// Anthropic-hosted web search tool (GA, supports dynamic filtering on Sonnet 4.6).
// max_uses caps searches per call so a discovery run can't spend unbounded.
const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES }

/** Use Sonnet + web search to find real local business homepages for a trade/town. */
export async function discoverCandidates(
  trade: string,
  town: string,
  limit: number,
  region: string = REGION,
): Promise<Candidate[]> {
  const regionHint = region ? ` (${region})` : ''
  const prompt =
    `Finde bis zu ${limit} lokale Handwerksbetriebe im Bereich "${trade}" in oder um ${town}` +
    `${regionHint}, die eine EIGENE Firmen-Website haben. ` +
    `Keine Verzeichnisse/Portale, kein Facebook/Instagram/Google-Profil. ` +
    `Nutze die Websuche; bevorzuge kleine, inhabergeführte Betriebe.\n\n` +
    `Gib AUSSCHLIESSLICH am Ende ein JSON-Array in einem \`\`\`json Codeblock zurück, ` +
    `mit Objekten der Form {"company": "...", "website": "https://...", "city": "${town}"}. ` +
    `Nur echte Firmen-Homepages, keine Erklärungen nach dem JSON.`

  // The server-side web-search loop can return stop_reason "pause_turn"; re-send to resume.
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }]
  let resp: Anthropic.Message | undefined
  for (let i = 0; i < 6; i++) {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      tools: [WEB_SEARCH] as never,
      messages,
    })
    if (resp.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: resp.content })
      continue
    }
    break
  }
  if (!resp) return []

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  return parseCandidates(text, trade, town)
}

function extractJsonArray(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) return fence[1].trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start !== -1 && end > start) return text.slice(start, end + 1)
  return null
}

function parseCandidates(text: string, trade: string, town: string): Candidate[] {
  const json = extractJsonArray(text)
  if (!json) return []
  let arr: unknown
  try {
    arr = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []

  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const raw of arr) {
    const it = raw as Record<string, unknown>
    if (typeof it?.website !== 'string' || typeof it?.company !== 'string') continue
    let host: string
    try {
      host = new URL(it.website).hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      continue
    }
    if (DIRECTORY_BLOCKLIST.some((b) => host.includes(b))) continue
    if (seen.has(host)) continue
    seen.add(host)
    out.push({
      company: it.company.trim(),
      website: it.website.trim(),
      city: (typeof it.city === 'string' && it.city.trim()) || town,
      trade,
    })
  }
  return out
}
