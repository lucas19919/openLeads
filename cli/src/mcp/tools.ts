import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Client } from '../client.js'
import { AI_TIMEOUT_MS } from '../client.js'
import type { ToolDefinition } from './protocol.js'
import type {
  Contract,
  Customer,
  Dashboard,
  Digest,
  Doc,
  EuerReport,
  Expense,
  ExpenseSummary,
  Lead,
  LeadEvent,
  RecurringInvoice,
  Subscription,
  CatalogItem,
  Approval,
} from '../types.js'

// The tool surface an agent host sees. Two tiers:
//
//   safe        — reads, and writes that a human can undo from the UI
//                 (drafts, notes, stage moves, new records)
//   irreversible— issues a number, sends mail to a customer, or overwrites the
//                 database; off unless the operator turns them on explicitly
//
// The split is deliberate. An agent that mis-reads a calendar entry should be
// able to make a mess someone can tidy up, not one that consumes an invoice
// number under GoBD or e-mails the wrong client.
//
// Invoicing sits astride that line, so it is split down the middle. Writing the
// paper — drafting an Angebot or a Rechnung, fixing a position, converting an
// accepted quote, preparing a Storno, throwing a draft away — is safe: no number
// is spent, nothing has left the building. Festschreiben and Versenden are not,
// and they are not simply "irreversible tier" either: even with that tier on,
// they need an `approval_id` — a Freigabe a human granted in the Kunden Manager for
// exactly that document in exactly that state (`request_approval` →
// `list_approvals` → finalise). The tier switch decides whether the agent may
// *spend* a human's yes; it never substitutes for one.

export interface ToolOptions {
  /** Register the irreversible tier (finalise, send, restore, copilot). */
  allowIrreversible: boolean
  /** Register nothing that writes at all. */
  readOnly: boolean
  /** Cap on rows returned per list call, so one query can't flood the context. */
  maxRows: number
}

type Args = Record<string, unknown>

const str = (a: Args, k: string): string | undefined => {
  const v = a[k]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}
const num = (a: Args, k: string): number | undefined => {
  const v = a[k]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
const bool = (a: Args, k: string): boolean => a[k] === true || a[k] === 'true'

function requireNum(a: Args, k: string): number {
  const v = num(a, k)
  if (v === undefined) throw new Error(`Pflichtfeld fehlt oder ist keine Zahl: ${k}`)
  return v
}
function requireStr(a: Args, k: string): string {
  const v = str(a, k)
  if (v === undefined) throw new Error(`Pflichtfeld fehlt: ${k}`)
  return v
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const S = {
  string: (description: string) => ({ type: 'string', description }),
  number: (description: string) => ({ type: 'number', description }),
  boolean: (description: string) => ({ type: 'boolean', description }),
  enum: (values: readonly string[], description: string) => ({ type: 'string', enum: [...values], description }),
}

function def(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: (args: Args) => Promise<unknown>,
): ToolDefinition {
  return { name, description, inputSchema, handler }
}

/** Trim a list to the configured cap and say so, rather than silently cutting. */
function capped<T>(rows: T[], max: number): { count: number; truncated?: string; items: T[] } {
  if (rows.length <= max) return { count: rows.length, items: rows }
  return {
    count: rows.length,
    truncated: `Nur die ersten ${max} von ${rows.length} Einträgen — Filter enger fassen.`,
    items: rows.slice(0, max),
  }
}

/** A compact invoice projection: everything a summary needs, no line items. */
function invoiceBrief(d: Doc) {
  return {
    id: d.id,
    kind: d.kind,
    number: d.number,
    status: d.status,
    client_name: d.client_name,
    issue_date: d.issue_date,
    due_date: d.due_date,
    gross_cents: d.totals.gross_cents,
    paid_cents: d.paid_cents,
    open_cents: Math.max(0, d.totals.gross_cents - d.paid_cents),
  }
}

const today = () => new Date().toISOString().slice(0, 10)

export function buildTools(client: Client, options: ToolOptions): ToolDefinition[] {
  const { maxRows } = options

  // --- reads ---------------------------------------------------------------

  const read: ToolDefinition[] = [
    def(
      'list_leads',
      'Leads aus der Vertriebspipeline auflisten, optional nach Stage oder Freitext gefiltert. ' +
        'Der Einstieg für jede Pipeline-Durchsicht.',
      obj({
        stage: S.string('Pipeline-Stage, z. B. neu, kontaktiert, angebot, gewonnen, verloren'),
        query: S.string('Freitext über Firma, Ort, Gewerk, Website'),
        limit: S.number('Höchstzahl Treffer'),
      }),
      async (a) => {
        const { leads } = await client.get<{ leads: Lead[] }>('/leads', {
          stage: str(a, 'stage'),
          q: str(a, 'query'),
        })
        const rows = leads.map((l) => ({
          id: l.id,
          company: l.company,
          trade: l.trade,
          city: l.city,
          stage: l.stage,
          priority: l.priority,
          score: l.score,
          email: l.email,
          phone: l.phone,
          updated_at: l.updated_at,
        }))
        return capped(rows, Math.min(num(a, 'limit') ?? maxRows, maxRows))
      },
    ),

    def(
      'get_lead',
      'Einen Lead mit allen Feldern und seiner Ereignishistorie holen.',
      obj({ id: S.number('Lead-ID') }, ['id']),
      async (a) => client.get<{ lead: Lead; events: LeadEvent[] }>(`/leads/${requireNum(a, 'id')}`),
    ),

    def(
      'pipeline_overview',
      'Kennzahlen des Betriebs: Pipeline nach Stage, ausgestellte und offene Rechnungsbeträge, ' +
        'überfällige Posten, Ausgaben, aktive Verträge, Umsatz je Monat.',
      obj({}),
      async () => (await client.get<{ dashboard: Dashboard }>('/dashboard')).dashboard,
    ),

    def(
      'morning_digest',
      'Priorisierte Tagesübersicht: neue und heiße Leads, liegengebliebene Leads, überfällige ' +
        'Rechnungen — plus, wenn ein Modell erreichbar ist, konkrete nächste Schritte.',
      obj({}),
      async () => (await client.get<{ digest: Digest }>('/ai/digest')).digest,
    ),

    def(
      'list_invoices',
      'Rechnungen und Angebote auflisten. `only_open` zeigt ausgestellte, noch nicht vollständig ' +
        'bezahlte Rechnungen; `only_overdue` zusätzlich nur die mit überschrittenem Fälligkeitsdatum.',
      obj({
        kind: S.enum(['angebot', 'rechnung'], 'Dokumentart'),
        status: S.string('Statusfilter, z. B. entwurf, versendet, bezahlt, storniert'),
        customer_id: S.number('nur Dokumente dieses Kunden'),
        only_open: S.boolean('nur ausgestellte, nicht vollständig bezahlte'),
        only_overdue: S.boolean('nur überfällige'),
        limit: S.number('Höchstzahl Treffer'),
      }),
      async (a) => {
        const { documents } = await client.get<{ documents: Doc[] }>('/documents', {
          kind: str(a, 'kind'),
          customer_id: num(a, 'customer_id'),
        })
        let rows = documents
        const status = str(a, 'status')
        if (status) rows = rows.filter((d) => d.status === status)
        if (bool(a, 'only_open') || bool(a, 'only_overdue')) {
          rows = rows.filter(
            (d) => d.number && d.status !== 'storniert' && d.totals.gross_cents > d.paid_cents,
          )
        }
        if (bool(a, 'only_overdue')) {
          const t = today()
          rows = rows.filter((d) => d.due_date != null && d.due_date < t)
        }
        return capped(rows.map(invoiceBrief), Math.min(num(a, 'limit') ?? maxRows, maxRows))
      },
    ),

    def(
      'get_invoice',
      'Ein Dokument mit Positionen, Summen und Zahlungsstand holen.',
      obj({ id: S.number('Dokument-ID') }, ['id']),
      async (a) => (await client.get<{ document: Doc }>(`/documents/${requireNum(a, 'id')}`)).document,
    ),

    def(
      'list_customers',
      'Kundenstamm auflisten, optional nach Freitext gefiltert.',
      obj({
        query: S.string('Freitext über Name, Ansprechpartner, Ort, E-Mail'),
        active_only: S.boolean('nur aktive Kunden'),
      }),
      async (a) => {
        const { customers } = await client.get<{ customers: Customer[] }>('/customers', {
          active: bool(a, 'active_only') ? '1' : undefined,
        })
        const q = str(a, 'query')?.toLowerCase()
        const rows = q
          ? customers.filter((c) => [c.name, c.contact_name, c.city, c.email].some((f) => f?.toLowerCase().includes(q)))
          : customers
        return capped(rows, maxRows)
      },
    ),

    def(
      'customer_overview',
      'Gesamtbild eines Kunden: Rechnungen, offene Posten, Verträge, Serienrechnungen.',
      obj({ id: S.number('Kunden-ID') }, ['id']),
      async (a) => (await client.get<{ overview: unknown }>(`/customers/${requireNum(a, 'id')}/overview`)).overview,
    ),

    def(
      'list_contracts',
      'Verträge auflisten. `expiring_within_days` grenzt auf Verträge ein, die demnächst auslaufen — ' +
        'die übliche Frage vor einer Verlängerung.',
      obj({
        status: S.string('Statusfilter: entwurf, versendet, aktiv, beendet, abgelehnt'),
        customer_id: S.number('nur Verträge dieses Kunden'),
        expiring_within_days: S.number('nur Verträge mit Ende in den nächsten N Tagen'),
      }),
      async (a) => {
        const { contracts } = await client.get<{ contracts: Contract[] }>('/contracts', {
          customer_id: num(a, 'customer_id'),
        })
        let rows = contracts
        const status = str(a, 'status')
        if (status) rows = rows.filter((c) => c.status === status)
        const days = num(a, 'expiring_within_days')
        if (days !== undefined) {
          const t = today()
          const cutoff = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
          rows = rows.filter((c) => c.end_date != null && c.end_date >= t && c.end_date <= cutoff)
        }
        return capped(
          rows.map((c) => ({
            id: c.id,
            number: c.number,
            type: c.type,
            title: c.title,
            client_name: c.client_name,
            status: c.status,
            start_date: c.start_date,
            end_date: c.end_date,
            gross_cents: c.totals.gross_cents,
          })),
          maxRows,
        )
      },
    ),

    def(
      'list_expenses',
      'Ausgaben mit Summen für einen Zeitraum auflisten.',
      obj({
        from: S.string('Belegdatum ab, YYYY-MM-DD'),
        to: S.string('Belegdatum bis, YYYY-MM-DD'),
        category: S.string('Kategoriefilter'),
        query: S.string('Freitext'),
      }),
      async (a) => {
        const res = await client.get<{ expenses: Expense[]; summary: ExpenseSummary }>('/expenses', {
          from: str(a, 'from'),
          to: str(a, 'to'),
          category: str(a, 'category'),
          q: str(a, 'query'),
        })
        return { summary: res.summary, ...capped(res.expenses, maxRows) }
      },
    ),

    def(
      'list_subscriptions',
      'Eigene Abonnements (SaaS, Hosting) mit Monats- und Jahressumme sowie den nächsten Verlängerungen.',
      obj({ active_only: S.boolean('nur aktive Abos') }),
      async (a) => {
        const res = await client.get<{ subscriptions: Subscription[]; summary: unknown }>('/subscriptions', {
          active: bool(a, 'active_only') ? '1' : undefined,
        })
        return { summary: res.summary, ...capped(res.subscriptions, maxRows) }
      },
    ),

    def(
      'list_recurring',
      'Serienrechnungen (Hosting-/Wartungsverträge) mit ihrem nächsten Lauf auflisten.',
      obj({ active_only: S.boolean('nur aktive Serien'), customer_id: S.number('nur dieser Kunde') }),
      async (a) => {
        const { recurring } = await client.get<{ recurring: RecurringInvoice[] }>('/recurring', {
          active: bool(a, 'active_only') ? '1' : undefined,
          customer_id: num(a, 'customer_id'),
        })
        return capped(
          recurring.map((r) => ({
            id: r.id,
            client_name: r.client_name,
            title: r.title,
            cadence: r.cadence,
            next_run: r.next_run,
            last_run: r.last_run,
            active: !!r.active,
          })),
          maxRows,
        )
      },
    ),

    def(
      'list_catalog',
      'Leistungskatalog auflisten — die Positionen, aus denen Angebote und Rechnungen gebaut werden.',
      obj({ active_only: S.boolean('nur aktive Positionen') }),
      async (a) => {
        const { items } = await client.get<{ items: CatalogItem[] }>('/catalog', {
          active: bool(a, 'active_only') ? '1' : undefined,
        })
        return capped(items, maxRows)
      },
    ),

    def(
      'euer_report',
      'Einnahmen-Überschuss-Übersicht für einen Zeitraum: Einnahmen, Ausgaben nach Kategorie, ' +
        'Ergebnis und USt-Position. Keine steuerliche Beratung.',
      obj({ from: S.string('ab YYYY-MM-DD'), to: S.string('bis YYYY-MM-DD') }),
      async (a) =>
        (await client.get<{ report: EuerReport }>('/report/euer', { from: str(a, 'from'), to: str(a, 'to') })).report,
    ),

    def(
      'export_csv',
      'Einen CSV-Export in eine lokale Datei schreiben und den Pfad zurückgeben — gedacht zum ' +
        'Weiterreichen an ein anderes Werkzeug (Ablage, Cloud, Steuerberatung).',
      obj(
        {
          kind: S.enum(
            ['leads', 'invoices', 'datev', 'expenses', 'expenses-datev'],
            'Welcher Export',
          ),
          path: S.string('Zielpfad der zu schreibenden Datei'),
          from: S.string('ab YYYY-MM-DD (nur Journale)'),
          to: S.string('bis YYYY-MM-DD (nur Journale)'),
        },
        ['kind', 'path'],
      ),
      async (a) => {
        const kind = requireStr(a, 'kind')
        const paths: Record<string, string> = {
          leads: '/export/leads.csv',
          invoices: '/export/invoices.csv',
          datev: '/export/datev.csv',
          expenses: '/export/expenses.csv',
          'expenses-datev': '/export/expenses-datev.csv',
        }
        const endpoint = paths[kind]
        if (!endpoint) throw new Error(`Unbekannter Export: ${kind}`)
        const csv = await client.getText(endpoint, { from: str(a, 'from'), to: str(a, 'to') })
        const target = resolve(requireStr(a, 'path'))
        writeFileSync(target, csv, 'utf8')
        return { path: target, bytes: Buffer.byteLength(csv, 'utf8'), kind }
      },
    ),

    def(
      'create_backup',
      'Vollständige Datenbank-Momentaufnahme in eine lokale Datei schreiben und den Pfad ' +
        'zurückgeben — zum Ablegen oder Hochladen durch ein anderes Werkzeug. Erfordert ein ' +
        'Admin-Konto. Liest nur; überschreibt nichts im Bestand des Kunden Managers.',
      obj({ path: S.string('Zielpfad der .db-Datei') }, ['path']),
      async (a) => {
        const file = await client.getFile('/admin/backup')
        const target = resolve(requireStr(a, 'path'))
        writeFileSync(target, file.data)
        return { path: target, bytes: file.data.length, server_filename: file.filename }
      },
    ),

    def(
      'research_company',
      'Eine Firma anhand ihrer Website recherchieren: liest Startseite UND Impressum und liefert ' +
        'belegte Beobachtungen — Firma, Rechtsform, Geschäftsführung, Anschrift, USt-IdNr., ' +
        'Handelsregister, E-Mail, Telefon — dazu den technischen Zustand der Seite (mobilfähig, ' +
        'eingesetzte Technik, Veraltungs-Signale). Schreibt nichts. Das deutsche Impressum ist ' +
        'gesetzlich vorgeschrieben und damit die verlässlichste Quelle für Firmendaten.',
      obj({ url: S.string('Website-URL, mit oder ohne https://') }, ['url']),
      async (a) =>
        (
          await client.post<{ research: unknown }>(
            '/ai/research',
            { url: requireStr(a, 'url') },
            { timeoutMs: AI_TIMEOUT_MS },
          )
        ).research,
    ),

    def(
      'list_lead_facts',
      'Herkunft der Daten eines Leads: jede Beobachtung mit Quelle, Beleg, Stärke und Status ' +
        '(uebernommen = steht im Lead, offen = wartet auf menschliche Prüfung, verworfen, ' +
        'widersprochen). Nutze dies, bevor du einem gespeicherten Wert vertraust.',
      obj(
        {
          id: S.number('Lead-ID'),
          status: S.enum(['offen', 'uebernommen', 'verworfen', 'widersprochen'], 'nur diesen Status zeigen'),
        },
        ['id'],
      ),
      async (a) => {
        const { facts } = await client.get<{ facts: unknown[] }>(`/leads/${requireNum(a, 'id')}/facts`, {
          status: str(a, 'status'),
        })
        return capped(facts, maxRows)
      },
    ),

    def(
      'review_facts',
      'Alle Beobachtungen quer über die Pipeline, die auf eine menschliche Entscheidung warten — ' +
        'die Prüfliste. Enthält Vorschläge mit schwächerem Beleg und Widersprüche zu von Hand ' +
        'gesetzten Werten.',
      obj({ limit: S.number('Höchstzahl Einträge') }),
      async (a) => {
        const { facts } = await client.get<{ facts: unknown[] }>('/facts/pending', {
          limit: num(a, 'limit') !== undefined ? String(num(a, 'limit')) : undefined,
        })
        return capped(facts, maxRows)
      },
    ),
  ]

  // --- writes a human can undo ---------------------------------------------

  const safeWrites: ToolDefinition[] = [
    def(
      'create_lead',
      'Neuen Lead anlegen. Dubletten werden über die Domain erkannt — ein bereits bekannter ' +
        'Betrieb wird nicht doppelt angelegt, sondern seine ID zurückgegeben.',
      obj(
        {
          website: S.string('Website-URL des Betriebs'),
          company: S.string('Firmenname; fehlt er, wird er aus der Domain abgeleitet'),
          trade: S.string('Gewerk/Branche'),
          city: S.string('Ort'),
          phone: S.string('Telefon'),
          email: S.string('E-Mail'),
          priority: S.string('Priorität'),
          stage: S.string('Pipeline-Stage (Standard: neu)'),
          why_lead: S.string('kurze Begründung, warum das ein Lead ist'),
          tags: S.string('Tags, kommagetrennt'),
        },
        ['website'],
      ),
      async (a) => {
        const body: Args = {}
        for (const k of ['website', 'company', 'trade', 'city', 'phone', 'email', 'priority', 'stage', 'why_lead', 'tags']) {
          const v = str(a, k)
          if (v !== undefined) body[k] = v
        }
        if (!body.website && !body.company) throw new Error('Mindestens website oder company angeben.')
        return client.post<{ id: number; deduped?: boolean }>('/leads', body)
      },
    ),

    def(
      'update_lead',
      'Lead ändern: Stage, Priorität, Score, Kontaktdaten, Tags, Zuständigkeit. Ein Stage-Wechsel ' +
        'wird in der Historie protokolliert.',
      obj(
        {
          id: S.number('Lead-ID'),
          stage: S.string('neue Pipeline-Stage'),
          priority: S.string('neue Priorität'),
          score: S.number('Score 0–100'),
          company: S.string('Firmenname'),
          city: S.string('Ort'),
          email: S.string('E-Mail'),
          phone: S.string('Telefon'),
          tags: S.string('Tags, kommagetrennt'),
          assigned_to: S.string('zuständige Person'),
        },
        ['id'],
      ),
      async (a) => {
        const patch: Args = {}
        for (const k of ['stage', 'priority', 'company', 'city', 'email', 'phone', 'tags', 'assigned_to']) {
          const v = str(a, k)
          if (v !== undefined) patch[k] = v
        }
        const score = num(a, 'score')
        if (score !== undefined) patch.score = score
        if (Object.keys(patch).length === 0) throw new Error('Kein Feld zum Ändern angegeben.')
        return (await client.patch<{ lead: Lead }>(`/leads/${requireNum(a, 'id')}`, patch)).lead
      },
    ),

    def(
      'add_lead_note',
      'Notiz an einem Lead setzen; sie erscheint als Ereignis in seiner Historie.',
      obj({ id: S.number('Lead-ID'), note: S.string('Notiztext') }, ['id', 'note']),
      async (a) =>
        (await client.patch<{ lead: Lead }>(`/leads/${requireNum(a, 'id')}`, { notes: requireStr(a, 'note') })).lead,
    ),

    def(
      'analyze_lead',
      'Lead vom Modell bewerten lassen: Qualifizierung, Fit-Score, nächster Schritt. Schreibt nur ' +
        'die Bewertung, ändert die Stammdaten nicht.',
      obj({ id: S.number('Lead-ID') }, ['id']),
      async (a) =>
        (
          await client.post<{ analysis: unknown }>(`/ai/leads/${requireNum(a, 'id')}/analyze`, undefined, {
            timeoutMs: AI_TIMEOUT_MS,
          })
        ).analysis,
    ),

    def(
      'draft_outreach',
      'Erstansprache für einen Lead entwerfen. Reiner Entwurf — versendet wird nichts; das ' +
        'bestätigt ein Mensch in der Oberfläche.',
      obj({ id: S.number('Lead-ID') }, ['id']),
      async (a) =>
        (
          await client.post<{ outreach: unknown }>(`/ai/leads/${requireNum(a, 'id')}/outreach`, undefined, {
            timeoutMs: AI_TIMEOUT_MS,
          })
        ).outreach,
    ),

    def(
      'create_customer',
      'Kunden im Stamm anlegen — die Basis für Rechnungen, Verträge und Serienrechnungen.',
      obj(
        {
          name: S.string('Firmen-/Kundenname'),
          contact_name: S.string('Ansprechpartner'),
          address: S.string('Straße und Hausnummer'),
          zip: S.string('PLZ'),
          city: S.string('Ort'),
          email: S.string('E-Mail'),
          phone: S.string('Telefon'),
          vat_id: S.string('USt-IdNr.'),
          lead_id: S.number('zugehöriger Lead'),
        },
        ['name'],
      ),
      async (a) => {
        const body: Args = {}
        for (const k of ['name', 'contact_name', 'address', 'zip', 'city', 'email', 'phone', 'vat_id']) {
          const v = str(a, k)
          if (v !== undefined) body[k] = v
        }
        const leadId = num(a, 'lead_id')
        if (leadId !== undefined) body.lead_id = leadId
        return (await client.post<{ customer: Customer }>('/customers', body)).customer
      },
    ),

    def(
      'create_invoice_draft',
      'Entwurf für ein Angebot oder eine Rechnung anlegen. Entwürfe tragen keine Nummer, sind ' +
        'jederzeit änderbar und löschbar — hier darfst du frei arbeiten. Das Festschreiben ist ein ' +
        'eigener Schritt und braucht die Freigabe eines Menschen (`request_approval`).',
      obj(
        {
          kind: S.enum(['angebot', 'rechnung'], 'Dokumentart'),
          customer_id: S.number('Kunde aus dem Stamm (füllt die Empfängerdaten)'),
          lead_id: S.number('zugehöriger Lead'),
          client_name: S.string('Empfänger, falls kein Kunde verknüpft ist'),
          client_email: S.string('E-Mail des Empfängers'),
          title: S.string('Titel des Dokuments'),
          intro: S.string('Einleitungstext'),
          notes: S.string('Schlussbemerkung'),
          items: {
            type: 'array',
            description: 'Positionen',
            items: obj(
              {
                description: S.string('Leistungsbeschreibung'),
                quantity: S.number('Menge'),
                unit: S.string('Einheit, z. B. Std., Stk., Monat'),
                unit_price_cents: S.number('Einzelpreis netto in Cent'),
              },
              ['description', 'quantity', 'unit_price_cents'],
            ),
          },
        },
        ['kind'],
      ),
      async (a) => {
        const body: Args = { kind: requireStr(a, 'kind') }
        for (const k of ['client_name', 'client_email', 'title', 'intro', 'notes']) {
          const v = str(a, k)
          if (v !== undefined) body[k] = v
        }
        const customerId = num(a, 'customer_id')
        if (customerId !== undefined) body.customer_id = customerId
        const leadId = num(a, 'lead_id')
        if (leadId !== undefined) body.lead_id = leadId
        if (Array.isArray(a.items)) body.items = a.items
        return (await client.post<{ document: Doc }>('/documents', body)).document
      },
    ),

    def(
      'update_invoice_draft',
      'Entwurf ändern: Empfänger, Titel, Texte, Fälligkeit, Kundenverknüpfung — und mit `items` die ' +
        'Positionen, die dabei VOLLSTÄNDIG ersetzt werden (immer die ganze Liste schicken). ' +
        'Festgeschriebene Dokumente sind unveränderlich (GoBD) und werden abgelehnt. Korrigiere ' +
        'hier, bevor du eine Freigabe beantragst — nach der Freigabe macht jede Änderung sie ungültig.',
      obj(
        {
          id: S.number('Dokument-ID'),
          client_name: S.string('Empfänger'),
          client_email: S.string('E-Mail des Empfängers'),
          client_address: S.string('Straße und Hausnummer'),
          client_zip: S.string('PLZ'),
          client_city: S.string('Ort'),
          title: S.string('Titel'),
          intro: S.string('Einleitungstext'),
          notes: S.string('Schlussbemerkung'),
          due_date: S.string('Fälligkeit YYYY-MM-DD'),
          customer_id: S.number('Kunde aus dem Stamm'),
          status: S.string('Status (nur bei Angeboten sinnvoll: angenommen, abgelehnt)'),
          items: {
            type: 'array',
            description: 'ERSETZT alle Positionen',
            items: obj(
              {
                description: S.string('Leistungsbeschreibung'),
                quantity: S.number('Menge'),
                unit: S.string('Einheit'),
                unit_price_cents: S.number('Einzelpreis netto in Cent'),
              },
              ['description', 'quantity', 'unit_price_cents'],
            ),
          },
        },
        ['id'],
      ),
      async (a) => {
        const { id, ...patch } = a
        if (Object.keys(patch).length === 0) throw new Error('Kein Feld zum Ändern angegeben.')
        return (await client.patch<{ document: Doc }>(`/documents/${requireNum(a, 'id')}`, patch)).document
      },
    ),

    def(
      'delete_invoice_draft',
      'Einen Entwurf löschen (z. B. doppelt angelegt). Festgeschriebene Dokumente bleiben — sie ' +
        'tragen eine Nummer und gehören zur lückenlosen Reihe; dafür gibt es den Storno.',
      obj({ id: S.number('Dokument-ID') }, ['id']),
      async (a) => client.delete<{ ok: true }>(`/documents/${requireNum(a, 'id')}`),
    ),

    def(
      'convert_quote_to_invoice',
      'Aus einem angenommenen Angebot einen Rechnungs-ENTWURF erzeugen: Empfänger und Positionen ' +
        'werden kopiert, das Angebot bleibt unverändert. Nichts wird ausgestellt.',
      obj({ id: S.number('Angebots-ID') }, ['id']),
      async (a) =>
        (await client.post<{ document: Doc }>(`/documents/${requireNum(a, 'id')}/convert`)).document,
    ),

    def(
      'validate_invoice',
      'Ein Dokument gegen die EN-16931-Regeln (Factur-X/ZUGFeRD, XRechnung) prüfen: fehlende ' +
        'Pflichtangaben, Rechenfehler, B2G-Hinweise. Ändert nichts. Der sinnvolle Schritt, bevor du ' +
        'einen Menschen um die Freigabe zum Festschreiben bittest.',
      obj({ id: S.number('Dokument-ID') }, ['id']),
      async (a) =>
        (await client.get<{ validation: unknown }>(`/documents/${requireNum(a, 'id')}/validate`)).validation,
    ),

    def(
      'create_storno_draft',
      'Zu einer festgeschriebenen Rechnung eine Stornorechnung als ENTWURF vorbereiten (Positionen ' +
        'negiert, Bezug auf die Originalnummer). Die Bücher ändern sich dadurch NICHT — die ' +
        'Original-Rechnung wird erst storniert, wenn der Storno festgeschrieben wird, und das ' +
        'braucht wieder eine Freigabe.',
      obj({ id: S.number('Dokument-ID der zu stornierenden Rechnung') }, ['id']),
      async (a) =>
        (await client.post<{ document: Doc }>(`/documents/${requireNum(a, 'id')}/storno`)).document,
    ),

    // --- Freigaben: asking is safe, deciding is not yours ---------------------

    def(
      'request_approval',
      'Eine menschliche Freigabe für eine NICHT UMKEHRBARE Aktion beantragen: Festschreiben oder ' +
        'Versenden eines Angebots, einer Rechnung oder eines Vertrags. Der Antrag erscheint in ' +
        'im Kunden Manager unter „Freigaben" mit Empfänger, Positionen und Summe; ein Mensch entscheidet ' +
        'dort. Der Antrag allein bewirkt nichts. Nach der Genehmigung gibst du die `approval_id` ' +
        'bei `finalize_invoice` bzw. `send_invoice` mit. Die Freigabe gilt genau einmal, nur für ' +
        'diesen Inhalt (jede spätere Änderung macht sie ungültig) und läuft ab.',
      obj(
        {
          action: S.enum(
            ['document.finalize', 'document.send', 'contract.finalize', 'contract.send'],
            'Wofür die Freigabe gilt',
          ),
          entity_id: S.number('ID des Dokuments bzw. Vertrags'),
          reason: S.string('Warum das jetzt passieren soll — ein Satz für den Menschen'),
        },
        ['action', 'entity_id'],
      ),
      async (a) =>
        client.post<{ approval: unknown; existed: boolean }>('/approvals', {
          action: requireStr(a, 'action'),
          entity_id: requireNum(a, 'entity_id'),
          reason: str(a, 'reason'),
        }),
    ),

    def(
      'list_approvals',
      'Freigabe-Anträge und ihr Stand: offen (wartet auf einen Menschen), genehmigt (nutzbar), ' +
        'abgelehnt, verbraucht (bereits verwendet), abgelaufen. Hiermit prüfst du, ob du ' +
        'weiterarbeiten darfst — warte auf „genehmigt", frage nicht mehrfach nach.',
      obj({
        status: S.enum(
          ['offen', 'genehmigt', 'abgelehnt', 'verbraucht', 'zurueckgezogen', 'abgelaufen'],
          'Statusfilter',
        ),
        entity_id: S.number('nur Anträge zu diesem Dokument/Vertrag'),
      }),
      async (a) => {
        const { approvals } = await client.get<{ approvals: Approval[] }>('/approvals', {
          status: str(a, 'status'),
          entity_id: num(a, 'entity_id'),
        })
        return capped(approvals, maxRows)
      },
    ),

    def(
      'withdraw_approval',
      'Einen eigenen offenen Antrag zurückziehen — etwa weil du den Entwurf noch korrigieren willst. ' +
        'Höflicher, als einen Menschen über ein Dokument entscheiden zu lassen, das sich gleich ändert.',
      obj({ id: S.number('Freigabe-ID') }, ['id']),
      async (a) =>
        (await client.post<{ approval: Approval }>(`/approvals/${requireNum(a, 'id')}/withdraw`)).approval,
    ),

    def(
      'create_expense',
      'Ausgabe erfassen (Betrag brutto in Cent). Der Beleg selbst wird in der Oberfläche angehängt.',
      obj(
        {
          gross_cents: S.number('Bruttobetrag in Cent'),
          vendor: S.string('Lieferant'),
          category: S.string('SKR03-Kategorie'),
          description: S.string('Beschreibung'),
          expense_date: S.string('Belegdatum YYYY-MM-DD'),
          vat_rate: S.number('USt-Satz in Prozent, Standard 19'),
        },
        ['gross_cents'],
      ),
      async (a) => {
        const body: Args = { gross_cents: requireNum(a, 'gross_cents') }
        for (const k of ['vendor', 'category', 'description', 'expense_date']) {
          const v = str(a, k)
          if (v !== undefined) body[k] = v
        }
        const vat = num(a, 'vat_rate')
        if (vat !== undefined) body.vat_rate = vat
        return (await client.post<{ expense: Expense }>('/expenses', body)).expense
      },
    ),

    def(
      'run_due_recurring',
      'Für alle fälligen Serienrechnungen einen Rechnungsentwurf erzeugen. Erzeugt ausschließlich ' +
        'Entwürfe — es wird nichts ausgestellt und nichts versendet.',
      obj({}),
      async () => client.post<{ generated: number }>('/recurring/run-due'),
    ),

    def(
      'research_lead',
      'Website eines bestehenden Leads auswerten und die Belege eintragen. Leere Felder werden mit ' +
        'direkt belegten Werten aus dem Impressum gefüllt; alles Schwächere landet als Vorschlag in ' +
        'der Prüfliste. Von Hand gesetzte Werte werden nie überschrieben — jede Änderung ist über ' +
        '`list_lead_facts` nachvollziehbar und umkehrbar.',
      obj({ id: S.number('Lead-ID') }, ['id']),
      async (a) =>
        (
          await client.post<{ research: unknown }>(`/ai/leads/${requireNum(a, 'id')}/research`, undefined, {
            timeoutMs: AI_TIMEOUT_MS,
          })
        ).research,
    ),

    def(
      'record_fact',
      'EINE belegte Beobachtung über einen Lead festhalten. `value` ist der Wert wortgetreu aus der ' +
        'Quelle, `detail` ein Satz darüber, was dort tatsächlich stand. `evidence`: "primary" = ' +
        'direkt belegt (Impressum, Signatur, Antwort des Betriebs), "supporting" = mittelbar ' +
        '(Suchtreffer, Erwähnung Dritter), "contradiction" = die Quelle widerspricht dem ' +
        'gespeicherten Wert. Nur direkt Belegtes füllt leere Felder; alles Übrige wird einem ' +
        'Menschen vorgelegt. Erfinde niemals einen Beleg — ein selbstbewusst falsches Feld richtet ' +
        'mehr Schaden an als ein leeres.',
      obj(
        {
          lead_id: S.number('Lead-ID'),
          field: S.enum(
            [
              'company', 'trade', 'city', 'website', 'email', 'phone', 'tech',
              'mobile_friendly', 'staleness_signal', 'legal_form', 'owner',
              'address', 'zip', 'vat_id', 'register',
            ],
            'Welches Feld die Beobachtung betrifft',
          ),
          value: S.string('Der Wert, wortgetreu aus der Quelle'),
          evidence: S.enum(['primary', 'supporting', 'contradiction'], 'Stärke des Belegs'),
          detail: S.string('Was die Quelle wörtlich hergab, in einem Satz'),
          source_url: S.string('URL der Quelle, falls vorhanden'),
        },
        ['lead_id', 'field', 'value', 'evidence', 'detail'],
      ),
      async (a) =>
        client.post<unknown>('/ai/facts', {
          lead_id: requireNum(a, 'lead_id'),
          field: requireStr(a, 'field'),
          value: requireStr(a, 'value'),
          evidence: requireStr(a, 'evidence'),
          detail: requireStr(a, 'detail'),
          source_url: str(a, 'source_url'),
        }),
    ),

    def(
      'resolve_fact',
      'Einen offenen Vorschlag aus der Prüfliste entscheiden: übernehmen (schreibt den Wert in den ' +
        'Lead) oder verwerfen. Nur einsetzen, wenn die Nutzerin die Entscheidung ausdrücklich ' +
        'getroffen hat — das Prüfen ist ihre Aufgabe, nicht deine.',
      obj({ id: S.number('Fakt-ID aus review_facts / list_lead_facts'), accept: S.boolean('true = übernehmen, false = verwerfen') }, [
        'id',
        'accept',
      ]),
      async (a) => client.patch<unknown>(`/facts/${requireNum(a, 'id')}`, { accept: bool(a, 'accept') }),
    ),
  ]

  // --- one-way doors, each behind a human's yes ----------------------------
  //
  // These four exist only to *spend* an approval a person already granted. There
  // is no argument that skips it: the server rejects the call without a valid,
  // unused, unexpired `approval_id` matching this exact document. Which is the
  // point — the tool tier is the operator's decision about the agent, the
  // Freigabe is a human's decision about this one piece of paper.

  const irreversible: ToolDefinition[] = [
    def(
      'finalize_invoice',
      'NICHT UMKEHRBAR: Entwurf festschreiben. Vergibt eine lückenlose Nummer; das Dokument ist ' +
        'danach unveränderlich (GoBD) und die Nummer verbraucht. Erfordert `approval_id` — die ID ' +
        'einer von einem Menschen GENEHMIGTEN Freigabe für genau dieses Dokument (siehe ' +
        '`request_approval`/`list_approvals`). Ohne sie schlägt der Aufruf fehl; frage dann nach ' +
        'der Freigabe, statt es erneut zu versuchen.',
      obj({ id: S.number('Dokument-ID'), approval_id: S.number('ID der genehmigten Freigabe') }, [
        'id',
        'approval_id',
      ]),
      async (a) =>
        (
          await client.post<{ document: Doc }>(`/documents/${requireNum(a, 'id')}/finalize`, {
            approval_id: requireNum(a, 'approval_id'),
          })
        ).document,
    ),

    def(
      'send_invoice',
      'NICHT UMKEHRBAR: verschickt eine E-Mail mit dem PDF an den Kunden. Erfordert `approval_id` ' +
        'einer genehmigten Freigabe (`action: "document.send"`) für genau dieses Dokument.',
      obj({ id: S.number('Dokument-ID'), approval_id: S.number('ID der genehmigten Freigabe') }, [
        'id',
        'approval_id',
      ]),
      async (a) =>
        client.post<{ ok: true; to: string }>(`/documents/${requireNum(a, 'id')}/send`, {
          approval_id: requireNum(a, 'approval_id'),
        }),
    ),

    def(
      'finalize_contract',
      'NICHT UMKEHRBAR: Vertrag festschreiben. Vergibt eine Nummer und friert die zu diesem ' +
        'Zeitpunkt geltenden AGB ein. Erfordert `approval_id` einer genehmigten Freigabe ' +
        '(`action: "contract.finalize"`).',
      obj({ id: S.number('Vertrags-ID'), approval_id: S.number('ID der genehmigten Freigabe') }, [
        'id',
        'approval_id',
      ]),
      async (a) =>
        (
          await client.post<{ contract: Contract }>(`/contracts/${requireNum(a, 'id')}/finalize`, {
            approval_id: requireNum(a, 'approval_id'),
          })
        ).contract,
    ),

    def(
      'send_contract',
      'NICHT UMKEHRBAR: verschickt den Vertrag als PDF per E-Mail an den Kunden. Erfordert ' +
        '`approval_id` einer genehmigten Freigabe (`action: "contract.send"`).',
      obj({ id: S.number('Vertrags-ID'), approval_id: S.number('ID der genehmigten Freigabe') }, [
        'id',
        'approval_id',
      ]),
      async (a) =>
        client.post<{ ok: true; to: string }>(`/contracts/${requireNum(a, 'id')}/send`, {
          approval_id: requireNum(a, 'approval_id'),
        }),
    ),

    def(
      'ask_copilot',
      'Den eingebauten Copiloten beauftragen. Er darf dieselben Werkzeuge nutzen wie die Oberfläche ' +
        '— einschließlich schreibender. Nur für Aufträge, die kein einzelnes Werkzeug abdeckt.',
      obj({ message: S.string('Auftrag in natürlicher Sprache'), thread_id: S.number('bestehender Thread') }, [
        'message',
      ]),
      async (a) =>
        client.post<{ thread_id: number; reply: string; steps: unknown[] }>(
          '/ai/chat',
          { message: requireStr(a, 'message'), thread_id: num(a, 'thread_id') },
          { timeoutMs: AI_TIMEOUT_MS },
        ),
    ),
  ]

  // The tiers, told to the host as MCP hints, so a host that gates by them
  // (werkbank: lesen, schreiben, or only with a Freigabe) gets them right.
  // Two "reads" leave a file on this machine; they are not read-only.
  const writesFiles = new Set(['export_csv', 'create_backup'])
  const hint = (tools: ToolDefinition[], readOnly: boolean, destructive: boolean) =>
    tools.map((t) => ({
      ...t,
      annotations: { readOnlyHint: readOnly && !writesFiles.has(t.name), destructiveHint: destructive },
    }))
  const reads = hint(read, true, false)
  if (options.readOnly) return reads.filter((t) => t.annotations.readOnlyHint)
  const writes = hint(safeWrites, false, false)
  return options.allowIrreversible ? [...reads, ...writes, ...hint(irreversible, false, true)] : [...reads, ...writes]
}
