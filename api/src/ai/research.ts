import { fetchHtml, normalizeUrl, decode, pickEmail, pickPhone, meta, companyFromDomain } from './weblookup'
import { recordFact, type FactField, type EvidenceKind } from '../facts'
import { db, type LeadRow } from '../db'
import { audit } from '../audit'

// The agent's eyes.
//
// Every German business website is required by §5 DDG (ex §5 TMG) to carry an
// Impressum listing the Firma, Rechtsform, a postal address, contact details,
// the Geschäftsführung, the Handelsregister entry and the USt-IdNr. That makes
// it something no amount of LLM guessing can match: a structured, free, legally
// compelled primary source at a predictable URL. This module reads it.
//
// Everything here returns *observations* — "the Impressum at <url> read X" —
// never verdicts. Grading and write-through are the ledger's job (facts.ts),
// and judgement is the model's. Keeping the three apart is what stops the
// agent inventing a Firmenname and filing it as truth.

/** Pages we are willing to pull per research run — the external-fetch budget. */
const MAX_PAGES = 3

export interface Observation {
  field: FactField
  value: string
  evidence: EvidenceKind
  detail: string
  source_url: string
  method: string
}

export interface ResearchResult {
  url: string
  reachable: boolean
  final_url: string | null
  impressum_url: string | null
  pages_fetched: number
  observations: Observation[]
  /** Human-readable notes about what could not be determined. */
  notes: string[]
}

/** Split HTML into visible lines, preserving block structure. */
function htmlToLines(html: string): string[] {
  const withBreaks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|address|section|td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return withBreaks
    .split('\n')
    .map((l) => decode(l).replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
}

// Longest-first: "GmbH & Co. KG" must win over the "GmbH" inside it.
const LEGAL_FORMS = [
  'UG (haftungsbeschränkt) & Co. KG',
  'GmbH & Co. KG',
  'AG & Co. KG',
  'UG (haftungsbeschränkt)',
  'gGmbH',
  'GmbH',
  'PartG mbB',
  'PartG',
  'e.K.',
  'e.Kfm.',
  'e.Kfr.',
  'e.V.',
  'OHG',
  'KG',
  'GbR',
  'AG',
]

function findLegalForm(line: string): string | null {
  for (const form of LEGAL_FORMS) {
    // Escape regex metacharacters in the literal, then require a word boundary
    // at the start so "Handelsagentur" cannot match "AG".
    const esc = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|\\s)${esc}(\\s|$|,|\\.)`, 'i').test(line)) return form
  }
  return null
}

/** Find the Impressum (or failing that, a Kontakt page) linked from a page. */
export function findLegalPageUrl(html: string, baseUrl: string): string | null {
  const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)]
  let kontakt: string | null = null
  for (const m of anchors) {
    const href = m[1]
    const text = decode(m[2].replace(/<[^>]+>/g, ' '))
    const hay = `${href} ${text}`.toLowerCase()
    if (/impressum|imprint/.test(hay)) {
      const abs = absolutize(href, baseUrl)
      if (abs) return abs
    }
    if (!kontakt && /kontakt|contact/.test(hay)) kontakt = absolutize(href, baseUrl)
  }
  return kontakt
}

function absolutize(href: string, baseUrl: string): string | null {
  try {
    const u = new URL(href, baseUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return normalizeUrl(u.href) ? u.href : null
  } catch {
    return null
  }
}

/**
 * Parse a German Impressum. Everything it yields is `primary` evidence: these
 * are legally mandated self-declarations, not inferences.
 */
export function parseImpressum(html: string, sourceUrl: string): Observation[] {
  const lines = htmlToLines(html)
  const text = lines.join('\n')
  const out: Observation[] = []
  const push = (field: FactField, value: string, detail: string, evidence: EvidenceKind = 'primary') => {
    if (value && value.trim()) {
      out.push({ field, value: value.trim(), evidence, detail, source_url: sourceUrl, method: 'impressum.parse' })
    }
  }

  // Firma + Rechtsform: the first short line carrying a legal-form token.
  for (const line of lines) {
    if (line.length > 90) continue
    const form = findLegalForm(line)
    if (!form) continue
    const company = line.replace(/^(Firma|Anbieter|Betreiber|Herausgeber)\s*:?\s*/i, '').trim()
    push('company', company, `Impressum nennt als Anbieter „${company}"`)
    push('legal_form', form, `Rechtsform „${form}" aus der Firmierung „${company}"`)
    break
  }

  // USt-IdNr. — DE followed by exactly nine digits.
  const vat = /\b(DE)[\s.-]?([0-9]{9})\b/i.exec(text)
  if (vat) push('vat_id', `DE${vat[2]}`, `Impressum führt die USt-IdNr. DE${vat[2]}`)

  // Handelsregister: HRB 12345, ideally with its Amtsgericht.
  const reg = /\b(HRB|HRA|GnR|PR|VR)[\s.-]?([0-9]{1,7})\b/i.exec(text)
  if (reg) {
    const court = /Amtsgericht\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]{2,28})/.exec(text)
    const value = court ? `${reg[1].toUpperCase()} ${reg[2]} (Amtsgericht ${court[1]})` : `${reg[1].toUpperCase()} ${reg[2]}`
    push('register', value, `Registereintrag laut Impressum: ${value}`)
  }

  // Geschäftsführung / Inhaber.
  const owner = /(?:Vertreten durch|Geschäftsführer(?:in)?|Geschäftsführung|Inhaber(?:in)?|Vorstand)\s*:?\s*\n?\s*([^\n|]{3,60})/i.exec(text)
  if (owner) {
    // "Vertreten durch" is usually its own heading, so the capture often starts
    // with the *next* label ("Geschäftsführer: Heinrich Müller"). Peel it off.
    const name = owner[1]
      .replace(/^(?:Geschäftsführer(?:in)?|Geschäftsführung|Inhaber(?:in)?|Vorstand|Vertreten durch)\s*:?\s*/i, '')
      .replace(/\s*(?:E-?Mail|Telefon|Tel\.|Fax).*$/i, '')
      .replace(/[,;]\s*$/, '')
      .trim()
    if (name.length >= 3) push('owner', name, `Impressum nennt als vertretungsberechtigt: ${name}`)
  }

  // Straße + Hausnummer.
  const street =
    /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]{2,40}?(?:straße|strasse|str\.|weg|allee|platz|gasse|ring|damm|ufer|chaussee))\s+(\d+\s*[a-zA-Z]?)\b/i.exec(
      text,
    )
  if (street) push('address', `${street[1].trim()} ${street[2].trim()}`, `Anschrift im Impressum: ${street[1].trim()} ${street[2].trim()}`)

  // PLZ + Ort.
  const place = /\b(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]{1,30}(?:[ -][A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]{1,30})?)\b/.exec(text)
  if (place) {
    push('zip', place[1], `PLZ ${place[1]} im Impressum`)
    push('city', place[2].trim(), `Ort „${place[2].trim()}" im Impressum`)
  }

  const email = pickEmail(text)
  if (email) push('email', email, `E-Mail im Impressum: ${email}`)
  const phone = pickPhone(text)
  if (phone) push('phone', phone, `Telefonnummer im Impressum: ${phone}`)

  return out
}

/**
 * Measure what the site actually is, rather than asking a model to imagine it.
 * These are the fields the lead analysis has always claimed to know
 * (`mobile_friendly`, `tech`, `staleness_signal`) — here they get observed.
 */
export function probeTech(html: string, finalUrl: string): Observation[] {
  const out: Observation[] = []
  const push = (field: FactField, value: string, detail: string) =>
    out.push({ field, value, evidence: 'primary', detail, source_url: finalUrl, method: 'tech.probe' })

  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html)
  push(
    'mobile_friendly',
    hasViewport ? 'ja' : 'nein',
    hasViewport ? 'Seite setzt ein viewport-Meta-Tag (responsive ausgelegt)' : 'Kein viewport-Meta-Tag — Seite ist nicht für Mobilgeräte ausgelegt',
  )

  // Platform fingerprints, most specific first.
  const generator = meta(html, 'name', 'generator')
  const fingerprints: [RegExp, string][] = [
    [/wp-content|wp-includes|wp-json/i, 'WordPress'],
    [/jimdo/i, 'Jimdo'],
    [/wixstatic|wix\.com|_wixCssImports/i, 'Wix'],
    [/squarespace/i, 'Squarespace'],
    [/typo3/i, 'TYPO3'],
    [/joomla/i, 'Joomla'],
    [/cdn\.shopify\.com/i, 'Shopify'],
    [/webflow/i, 'Webflow'],
    [/contao/i, 'Contao'],
    [/drupal/i, 'Drupal'],
    [/ionos|1and1|1&1/i, 'IONOS Baukasten'],
  ]
  const hit = fingerprints.find(([re]) => re.test(html))
  const tech = generator?.trim() || hit?.[1] || null
  if (tech) {
    push('tech', tech, generator ? `generator-Meta-Tag meldet „${generator.trim()}"` : `Quelltext-Signatur weist auf ${hit![1]} hin`)
  }

  // Staleness signals — each one independently observable in the markup.
  const signals: string[] = []
  const year = new Date().getFullYear()
  const copy = [...html.matchAll(/(?:©|&copy;|Copyright)[^0-9]{0,12}(?:\d{4}\s*[–—-]\s*)?(\d{4})/gi)]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 1995 && y <= year)
  const newest = copy.length ? Math.max(...copy) : null
  if (newest !== null && newest < year - 2) signals.push(`Copyright-Hinweis endet ${newest}`)
  if (!hasViewport) signals.push('kein viewport-Meta-Tag')
  if (finalUrl.startsWith('http://')) signals.push('kein HTTPS')
  const jq = /jquery[.-](1\.\d+(?:\.\d+)?)/i.exec(html)
  if (jq) signals.push(`jQuery ${jq[1]} (veraltete Generation)`)
  if (/\.swf\b/i.test(html)) signals.push('Flash-Inhalte (.swf)')
  if (/<font\b|bgcolor=/i.test(html)) signals.push('Pre-CSS-Markup (<font> / bgcolor)')

  if (signals.length) {
    push('staleness_signal', signals.join('; '), `Beobachtet am Quelltext: ${signals.join('; ')}`)
  }

  return out
}

/**
 * Research a company from its website: homepage → Impressum → observations.
 * Fetches at most `MAX_PAGES` pages. Never throws on a bad site — an
 * unreachable host is a result, not an error.
 */
export async function researchCompany(rawUrl: string): Promise<ResearchResult> {
  const result: ResearchResult = {
    url: rawUrl,
    reachable: false,
    final_url: null,
    impressum_url: null,
    pages_fetched: 0,
    observations: [],
    notes: [],
  }
  if (!normalizeUrl(rawUrl)) {
    result.notes.push('Keine gültige öffentliche http(s)-Adresse.')
    return result
  }

  const home = await fetchHtml(rawUrl)
  if (!home) {
    result.notes.push('Website nicht erreichbar oder liefert kein HTML.')
    return result
  }
  result.pages_fetched++
  result.reachable = true
  result.final_url = home.final_url

  // The technical read is on the homepage — that is the page a prospect sees.
  result.observations.push(...probeTech(home.html, home.final_url))

  // Homepage naming is a weaker source than the Impressum: og:site_name is
  // marketing copy, so it is only ever a suggestion.
  const siteName = meta(home.html, 'property', 'og:site_name')
  if (siteName) {
    result.observations.push({
      field: 'company',
      value: siteName,
      evidence: 'supporting',
      detail: `og:site_name der Startseite lautet „${siteName}"`,
      source_url: home.final_url,
      method: 'website.meta',
    })
  }

  const legalUrl = findLegalPageUrl(home.html, home.final_url)
  const candidates = [legalUrl, new URL('/impressum', home.final_url).href].filter(
    (u, i, a): u is string => !!u && a.indexOf(u) === i,
  )

  for (const candidate of candidates) {
    if (result.pages_fetched >= MAX_PAGES) break
    const page = await fetchHtml(candidate)
    result.pages_fetched++
    if (!page) continue
    const observed = parseImpressum(page.html, page.final_url)
    if (observed.length) {
      result.impressum_url = page.final_url
      result.observations.push(...observed)
      break
    }
  }

  if (!result.impressum_url) {
    result.notes.push(
      'Kein auswertbares Impressum gefunden — Firmendaten stammen nur aus der Startseite und sind entsprechend schwächer belegt.',
    )
  }
  return result
}

export interface ResearchLeadSummary {
  lead_id: number
  researched_url: string
  reachable: boolean
  impressum_url: string | null
  pages_fetched: number
  /** Fields written straight through to the lead. */
  applied: { field: string; value: string }[]
  /** Fields held back for a human — with the reason. */
  suggested: { field: string; value: string; reason: string }[]
  notes: string[]
}

/**
 * Research a lead's website and file every observation in the ledger. The
 * ledger decides what may be written; this only reports what happened, in a
 * shape small enough for a local model to reason about in one turn.
 */
export async function researchLead(leadId: number, actor: string): Promise<ResearchLeadSummary> {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as unknown as LeadRow | undefined
  if (!lead) throw new Error('Lead nicht gefunden')
  const target = lead.website || lead.domain
  if (!target) throw new Error('Lead hat keine Website — nichts zu recherchieren.')

  const res = await researchCompany(target)
  const applied: ResearchLeadSummary['applied'] = []
  const suggested: ResearchLeadSummary['suggested'] = []

  for (const o of res.observations) {
    try {
      const r = recordFact({
        lead_id: leadId,
        field: o.field,
        value: o.value,
        evidence: o.evidence,
        detail: o.detail,
        source_url: o.source_url,
        method: o.method,
        actor,
      })
      if (r.applied) applied.push({ field: o.field, value: o.value })
      else if (r.status === 'offen') suggested.push({ field: o.field, value: o.value, reason: r.reason })
    } catch (e) {
      res.notes.push(`${o.field}: ${(e as Error).message}`)
    }
  }

  db.prepare(`INSERT INTO lead_events (lead_id, actor, type, body) VALUES (?, ?, 'research', ?)`).run(
    leadId,
    actor,
    res.reachable
      ? `Website recherchiert (${res.pages_fetched} Seite(n)${res.impressum_url ? ', Impressum ausgewertet' : ', kein Impressum gefunden'}): ${applied.length} übernommen, ${suggested.length} zur Prüfung.`
      : 'Website nicht erreichbar.',
  )
  audit({
    actor,
    action: 'ai.research_lead',
    entity: 'lead',
    entityId: leadId,
    detail: { url: target, pages: res.pages_fetched, applied: applied.length, suggested: suggested.length },
  })

  return {
    lead_id: leadId,
    researched_url: res.final_url ?? target,
    reachable: res.reachable,
    impressum_url: res.impressum_url,
    pages_fetched: res.pages_fetched,
    applied,
    suggested,
    notes: res.notes,
  }
}
