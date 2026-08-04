import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-research-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { parseImpressum, probeTech, findLegalPageUrl, researchCompany } = await import('./ai/research')
const { listFacts } = await import('./facts')

type Obs = ReturnType<typeof parseImpressum>[number]
const valueOf = (obs: Obs[], field: string): string | undefined => obs.find((o) => o.field === field)?.value

// A realistic Impressum: the shape a German Handwerksbetrieb's page actually
// takes, down to the Telefax line that must not be mistaken for the Telefon.
const IMPRESSUM = `
<!doctype html><html><body>
<h1>Impressum</h1>
<p>Angaben gem&auml;&szlig; &sect; 5 DDG</p>
<p>Dachdeckerei M&uuml;ller GmbH<br>
Lange Stra&szlig;e 42<br>
49074 Osnabr&uuml;ck</p>
<h2>Kontakt</h2>
<p>Telefon: 0541 1234567<br>
Telefax: 0541 1234568<br>
E-Mail: info@dachdeckerei-mueller.de</p>
<h2>Vertreten durch</h2>
<p>Gesch&auml;ftsf&uuml;hrer: Heinrich M&uuml;ller</p>
<h2>Registereintrag</h2>
<p>Eintragung im Handelsregister.<br>
Registergericht: Amtsgericht Osnabr&uuml;ck<br>
Registernummer: HRB 21045</p>
<h2>Umsatzsteuer-ID</h2>
<p>Umsatzsteuer-Identifikationsnummer gem&auml;&szlig; &sect; 27 a UStG:<br>
DE 812345678</p>
</body></html>
`

after(() => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(DB_FILE, { force: true })
  rmSync(`${DB_FILE}-wal`, { force: true })
  rmSync(`${DB_FILE}-shm`, { force: true })
})

test('das Impressum liefert die Pflichtangaben', () => {
  const obs = parseImpressum(IMPRESSUM, 'https://mueller.de/impressum')

  assert.equal(valueOf(obs, 'company'), 'Dachdeckerei Müller GmbH')
  assert.equal(valueOf(obs, 'legal_form'), 'GmbH')
  assert.equal(valueOf(obs, 'owner'), 'Heinrich Müller')
  assert.equal(valueOf(obs, 'address'), 'Lange Straße 42')
  assert.equal(valueOf(obs, 'zip'), '49074')
  assert.equal(valueOf(obs, 'city'), 'Osnabrück')
  assert.equal(valueOf(obs, 'vat_id'), 'DE812345678')
  assert.equal(valueOf(obs, 'register'), 'HRB 21045 (Amtsgericht Osnabrück)')
  assert.equal(valueOf(obs, 'email'), 'info@dachdeckerei-mueller.de')
})

test('die Telefaxnummer wird nicht als Telefonnummer genommen', () => {
  const obs = parseImpressum(IMPRESSUM, 'https://mueller.de/impressum')
  assert.equal(valueOf(obs, 'phone'), '0541 1234567')
})

test('Impressum-Angaben gelten als direkter Beleg', () => {
  const obs = parseImpressum(IMPRESSUM, 'https://mueller.de/impressum')
  assert.ok(obs.length > 0)
  assert.ok(
    obs.every((o) => o.evidence === 'primary' && o.detail.length > 0 && o.source_url === 'https://mueller.de/impressum'),
    'jede Beobachtung trägt Quelle und Beleg',
  )
})

test('die längere Rechtsform gewinnt gegen die darin enthaltene', () => {
  const obs = parseImpressum('<p>Bau &amp; Technik GmbH &amp; Co. KG</p><p>12345 Musterstadt</p>', 'https://x.de/impressum')
  assert.equal(valueOf(obs, 'legal_form'), 'GmbH & Co. KG')
  assert.equal(valueOf(obs, 'company'), 'Bau & Technik GmbH & Co. KG')
})

test('„AG" wird nicht mitten in einem Wort erkannt', () => {
  const obs = parseImpressum('<p>Handelsagentur Schmidt</p>', 'https://x.de/impressum')
  assert.equal(valueOf(obs, 'legal_form'), undefined)
})

test('ein leeres Impressum liefert nichts statt zu raten', () => {
  const obs = parseImpressum('<p>Diese Seite ist im Aufbau.</p>', 'https://x.de/impressum')
  assert.deepEqual(obs, [])
})

test('der Impressum-Link wird gefunden, Kontakt nur als Rückfallebene', () => {
  const html = '<a href="/kontakt">Kontakt</a><a href="/rechtliches/impressum">Impressum</a>'
  assert.equal(findLegalPageUrl(html, 'https://x.de/'), 'https://x.de/rechtliches/impressum')
  assert.equal(findLegalPageUrl('<a href="/kontakt">Kontakt</a>', 'https://x.de/'), 'https://x.de/kontakt')
  assert.equal(findLegalPageUrl('<a href="/leistungen">Leistungen</a>', 'https://x.de/'), null)
})

test('interne Ziele werden auch über einen Link nicht angefasst', () => {
  assert.equal(findLegalPageUrl('<a href="http://192.168.0.5/impressum">Impressum</a>', 'https://x.de/'), null)
  assert.equal(findLegalPageUrl('<a href="javascript:void(0)">Impressum</a>', 'https://x.de/'), null)
})

test('eine veraltete Seite wird an ihrem Quelltext erkannt', () => {
  const obs = probeTech(
    '<html><head><meta name="generator" content="WordPress 4.9"></head>' +
      '<body><script src="/js/jquery-1.7.2.min.js"></script>' +
      '<font color="red">Willkommen</font><p>&copy; 2015 Muster</p></body></html>',
    'http://alt.example.de/',
  )
  assert.equal(valueOf(obs, 'mobile_friendly'), 'nein')
  assert.equal(valueOf(obs, 'tech'), 'WordPress 4.9')

  const stale = valueOf(obs, 'staleness_signal') ?? ''
  assert.match(stale, /Copyright-Hinweis endet 2015/)
  assert.match(stale, /kein viewport/)
  assert.match(stale, /kein HTTPS/)
  assert.match(stale, /jQuery 1\.7\.2/)
  assert.match(stale, /Pre-CSS/)
})

test('eine gepflegte Seite meldet keine Veraltungs-Signale', () => {
  const obs = probeTech(
    `<html><head><meta name="viewport" content="width=device-width"></head><body><p>&copy; ${new Date().getFullYear()} Muster</p></body></html>`,
    'https://neu.example.de/',
  )
  assert.equal(valueOf(obs, 'mobile_friendly'), 'ja')
  assert.equal(valueOf(obs, 'staleness_signal'), undefined)
})

test('die Plattform wird auch ohne generator-Tag erkannt', () => {
  const obs = probeTech('<html><body><link href="/wp-content/themes/x/style.css"></body></html>', 'https://x.de/')
  assert.equal(valueOf(obs, 'tech'), 'WordPress')
})

// --- end to end, with the network stubbed ---------------------------------

function stubSite(pages: Record<string, string>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = pages[url]
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }) as typeof fetch
}

test('researchCompany geht von der Startseite zum Impressum', async () => {
  stubSite({
    'https://mueller.de/': '<html><head><meta property="og:site_name" content="Dachdeckerei Müller"></head><body><a href="/impressum">Impressum</a></body></html>',
    'https://mueller.de/impressum': IMPRESSUM,
  })
  const res = await researchCompany('mueller.de')

  assert.equal(res.reachable, true)
  assert.equal(res.impressum_url, 'https://mueller.de/impressum')
  assert.equal(res.pages_fetched, 2)
  assert.equal(valueOf(res.observations, 'vat_id'), 'DE812345678')

  // og:site_name is marketing copy, so it may only ever be a suggestion —
  // the Impressum's own wording is the primary claim on the Firma.
  const companyObs = res.observations.filter((o) => o.field === 'company')
  assert.equal(companyObs.find((o) => o.evidence === 'supporting')?.value, 'Dachdeckerei Müller')
  assert.equal(companyObs.find((o) => o.evidence === 'primary')?.value, 'Dachdeckerei Müller GmbH')
})

test('ohne Impressum bleibt es bei der schwächeren Startseiten-Auskunft', async () => {
  stubSite({ 'https://leer.de/': '<html><head><meta property="og:site_name" content="Leer"></head><body>Hallo</body></html>' })
  const res = await researchCompany('leer.de')

  assert.equal(res.reachable, true)
  assert.equal(res.impressum_url, null)
  assert.ok(res.notes.some((n) => /Impressum/.test(n)))
  assert.equal(res.observations.find((o) => o.field === 'company')?.evidence, 'supporting')
})

test('eine unerreichbare Seite ist ein Ergebnis, kein Fehler', async () => {
  stubSite({})
  const res = await researchCompany('tot.example')
  assert.equal(res.reachable, false)
  assert.equal(res.observations.length, 0)
  assert.ok(res.notes.length > 0)
})

test('interne Adressen werden gar nicht erst abgerufen', async () => {
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return new Response('', { status: 200 })
  }) as typeof fetch

  const res = await researchCompany('http://192.168.1.10/')
  assert.equal(called, false, 'kein Request ins eigene Netz')
  assert.equal(res.reachable, false)
})

test('recherchierte Werte kommen mit Herkunft im Ledger an', async () => {
  stubSite({
    'https://mueller.de/': '<html><body><a href="/impressum">Impressum</a></body></html>',
    'https://mueller.de/impressum': IMPRESSUM,
  })
  const { researchLead } = await import('./ai/research')
  const info = db
    .prepare("INSERT INTO leads (domain, website, city, stage, source) VALUES ('mueller.de', 'https://mueller.de/', 'Hannover', 'neu', 'manual')")
    .run()
  const id = Number(info.lastInsertRowid)

  const summary = await researchLead(id, 'ai')
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as { company: string; city: string }

  assert.equal(lead.company, 'Dachdeckerei Müller GmbH', 'leeres Feld wird belegt gefüllt')
  assert.equal(lead.city, 'Hannover', 'der von Hand gesetzte Ort bleibt stehen')
  assert.ok(summary.suggested.some((s) => s.field === 'city'), 'der abweichende Ort wird vorgelegt')

  const facts = listFacts(id)
  assert.ok(facts.every((f) => f.source_url?.includes('mueller.de')))
  assert.ok(facts.some((f) => f.field === 'vat_id' && f.value === 'DE812345678'))
})
