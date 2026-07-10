import { db } from './db'

// One-time defaults for a fresh isarwebsites instance. The business sells
// websites (plus hosting, Pflege and lokales Online-Marketing) to small local
// businesses, so a new install starts with a ready-to-use Leistungskatalog
// instead of an empty picker. Everything here is a starting point the operator
// edits in the UI — prices are net cents, 19 % USt.
//
// Idempotent: runs once per database (settings.defaults_seeded), and never
// touches a catalog the operator has already filled.

interface SeedItem {
  name: string
  description: string
  unit: string
  unit_price_cents: number
  category: string
  sort: number
}

const CATALOG_SEED: SeedItem[] = [
  {
    name: 'Website Starter – One-Pager',
    description:
      'Konzeption, Design und Umsetzung einer One-Page-Website: mobil-optimiert, ' +
      'schnell, mit Impressum & Datenschutz (DSGVO)',
    unit: 'pauschal',
    unit_price_cents: 89_900,
    category: 'Website',
    sort: 10,
  },
  {
    name: 'Website Business – bis 5 Unterseiten',
    description:
      'Vollständige Firmen-Website mit bis zu 5 Unterseiten: Design, Umsetzung, ' +
      'Texte-Einbau, Kontaktformular, mobil-optimiert, DSGVO-konform',
    unit: 'pauschal',
    unit_price_cents: 179_000,
    category: 'Website',
    sort: 20,
  },
  {
    name: 'Website Premium – individuell',
    description:
      'Individuelle Website nach Anforderung (Umfang laut Angebot): Konzeption, ' +
      'Design, Umsetzung, Einweisung',
    unit: 'pauschal',
    unit_price_cents: 349_000,
    category: 'Website',
    sort: 30,
  },
  {
    name: 'Website-Relaunch / Redesign',
    description:
      'Modernisierung einer bestehenden, veralteten Website: neues Design, ' +
      'Übernahme der Inhalte, mobil-optimiert',
    unit: 'pauschal',
    unit_price_cents: 129_000,
    category: 'Website',
    sort: 40,
  },
  {
    name: 'Hosting & Domain',
    description: 'Webhosting inkl. Domain, SSL-Zertifikat und E-Mail-Postfächern',
    unit: 'Monat',
    unit_price_cents: 1_900,
    category: 'Hosting & Pflege',
    sort: 50,
  },
  {
    name: 'Website-Pflege & Wartung',
    description:
      'Laufende Pflege: Updates, Backups, Sicherheit, kleine Inhaltsänderungen ' +
      '(bis 1 Std./Monat)',
    unit: 'Monat',
    unit_price_cents: 4_900,
    category: 'Hosting & Pflege',
    sort: 60,
  },
  {
    name: 'SEO-Grundoptimierung',
    description:
      'Lokale Suchmaschinen-Grundoptimierung: Meta-Daten, Seitenstruktur, ' +
      'Ladezeit, lokale Keywords',
    unit: 'pauschal',
    unit_price_cents: 34_900,
    category: 'Marketing',
    sort: 70,
  },
  {
    name: 'Google Business Profil einrichten',
    description:
      'Einrichtung/Optimierung des Google Business Profils: Daten, Fotos, ' +
      'Kategorien, Verknüpfung mit der Website',
    unit: 'pauschal',
    unit_price_cents: 14_900,
    category: 'Marketing',
    sort: 80,
  },
  {
    name: 'Texterstellung',
    description: 'Professioneller Website-Text je Seite (recherchiert, SEO-tauglich)',
    unit: 'Seite',
    unit_price_cents: 8_900,
    category: 'Inhalte',
    sort: 90,
  },
  {
    name: 'Logo & Basis-Branding',
    description: 'Logo-Gestaltung inkl. Farb- und Schriftdefinition für die Website',
    unit: 'pauschal',
    unit_price_cents: 24_900,
    category: 'Design',
    sort: 100,
  },
  {
    name: 'Zusatzarbeiten Webentwicklung',
    description: 'Individuelle Anpassungen und Erweiterungen nach Aufwand',
    unit: 'Std',
    unit_price_cents: 8_500,
    category: 'Extras',
    sort: 110,
  },
]

/** Apply the one-time isarwebsites defaults to a fresh database. */
export function seedDefaults(): void {
  const s = db
    .prepare('SELECT defaults_seeded, business_name FROM settings WHERE id = 1')
    .get() as unknown as { defaults_seeded: number; business_name: string | null } | undefined
  if (!s) return

  // A fresh profile starts under the isarwebsites name; never overwrite one the
  // operator has set.
  if (!s.business_name) {
    db.prepare("UPDATE settings SET business_name = 'isarwebsites' WHERE id = 1").run()
  }

  if (s.defaults_seeded) return
  const count = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM catalog_items').get() as { n: number }).n,
  )
  if (count === 0) {
    const ins = db.prepare(
      `INSERT INTO catalog_items (name, description, unit, unit_price_cents, vat_rate, category, sort)
       VALUES (@name, @description, @unit, @unit_price_cents, 19, @category, @sort)`,
    )
    for (const item of CATALOG_SEED) ins.run({ ...item })
    console.log(`seed: Leistungskatalog mit ${CATALOG_SEED.length} isarwebsites-Positionen vorbefüllt`)
  }
  db.prepare('UPDATE settings SET defaults_seeded = 1 WHERE id = 1').run()
}
