import type { Group } from '../registry.js'
import { patchFrom } from '../registry.js'
import { print, printJson, table, details, euro, date } from '../output.js'
import type { Customer } from '../types.js'

interface CustomerOverview {
  customer: Customer
  kpis: {
    invoices_count: number
    invoiced_gross_cents: number
    paid_cents: number
    open_cents: number
    quotes_count: number
    contracts_active: number
    contracts_total: number
    series_active: number
  }
  documents: { id: number; kind: string; number: string | null; status: string; issue_date: string | null; gross_cents: number; open_cents: number }[]
}

export const customers: Group = {
  summary: 'Kundenstamm: nachschlagen, anlegen, Gesamtbild je Kunde',
  commands: {
    list: {
      summary: 'Kunden auflisten',
      usage: '[--active] [--q <suche>]',
      options: { active: { type: 'boolean' }, q: { type: 'string' } },
      async run(ctx) {
        const { customers } = await ctx.client.get<{ customers: Customer[] }>('/customers', {
          active: ctx.bool('active') ? '1' : undefined,
        })
        // Free-text filtering happens here: the endpoint has no q parameter, and
        // a client-side filter over a Kundenstamm is cheap.
        const q = ctx.str('q')?.toLowerCase()
        const rows = q
          ? customers.filter((c) =>
              [c.name, c.contact_name, c.city, c.email].some((f) => f?.toLowerCase().includes(q)),
            )
          : customers
        if (ctx.json) return printJson(rows)
        table(rows, [
          { header: 'ID', value: (c) => String(c.id), right: true },
          { header: 'Name', value: (c) => c.name, max: 34 },
          { header: 'Ansprechpartner', value: (c) => c.contact_name ?? '—', max: 24 },
          { header: 'Ort', value: (c) => c.city ?? '—', max: 18 },
          { header: 'E-Mail', value: (c) => c.email ?? '—', max: 30 },
          { header: 'Aktiv', value: (c) => (c.active ? 'ja' : 'nein') },
        ], 'Keine Kunden gefunden.')
      },
    },

    get: {
      summary: 'Einen Kunden zeigen',
      usage: '<id>',
      async run(ctx) {
        const { customer: c } = await ctx.client.get<{ customer: Customer }>(`/customers/${ctx.id()}`)
        if (ctx.json) return printJson(c)
        details([
          ['ID', String(c.id)],
          ['Name', c.name],
          ['Ansprechpartner', c.contact_name ?? '—'],
          ['Ort', c.city ?? '—'],
          ['E-Mail', c.email ?? '—'],
          ['Telefon', c.phone ?? '—'],
          ['Typ', c.client_type],
          ['Aktiv', c.active ? 'ja' : 'nein'],
        ])
      },
    },

    overview: {
      summary: 'Gesamtbild: Umsatz, offene Posten, Verträge, Serien',
      usage: '<id>',
      async run(ctx) {
        const { overview } = await ctx.client.get<{ overview: CustomerOverview }>(
          `/customers/${ctx.id()}/overview`,
        )
        if (ctx.json) return printJson(overview)
        const k = overview.kpis
        details([
          ['Kunde', overview.customer.name],
          ['Rechnungen', `${k.invoices_count} · ${euro(k.invoiced_gross_cents)} brutto`],
          ['Bezahlt', euro(k.paid_cents)],
          ['Offen', euro(k.open_cents)],
          ['Angebote', String(k.quotes_count)],
          ['Verträge', `${k.contracts_active} aktiv von ${k.contracts_total}`],
          ['Serien', `${k.series_active} aktiv`],
        ])
        if (overview.documents.length) {
          print()
          table(overview.documents, [
            { header: 'ID', value: (d) => String(d.id), right: true },
            { header: 'Nummer', value: (d) => d.number ?? '(Entwurf)' },
            { header: 'Art', value: (d) => d.kind },
            { header: 'Status', value: (d) => d.status },
            { header: 'Datum', value: (d) => date(d.issue_date) },
            { header: 'Brutto', value: (d) => euro(d.gross_cents), right: true },
            { header: 'Offen', value: (d) => euro(d.open_cents), right: true },
          ])
        }
      },
    },

    create: {
      summary: 'Kunden anlegen',
      usage: '--name <name> [--email <mail>] [--city <ort>] …',
      options: {
        name: { type: 'string' },
        'contact-name': { type: 'string' },
        address: { type: 'string' },
        zip: { type: 'string' },
        city: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        'vat-id': { type: 'string' },
        'client-type': { type: 'string' },
        lead: { type: 'string' },
        notes: { type: 'string' },
      },
      async run(ctx) {
        const body = patchFrom(ctx, {
          name: 'string',
          'contact-name': 'string',
          address: 'string',
          zip: 'string',
          city: 'string',
          email: 'string',
          phone: 'string',
          'vat-id': 'string',
          'client-type': 'string',
          notes: 'string',
        })
        if (!body.name) throw new Error('--name fehlt.')
        if (ctx.num('lead') !== undefined) body.lead_id = ctx.num('lead')
        const { customer } = await ctx.client.post<{ customer: Customer }>('/customers', body)
        if (ctx.json) return printJson(customer)
        print(`Kunde ${customer.id} angelegt: ${customer.name}`)
      },
    },

    update: {
      summary: 'Kunden ändern',
      usage: '<id> [--email <mail>] [--city <ort>] …',
      options: {
        name: { type: 'string' },
        'contact-name': { type: 'string' },
        address: { type: 'string' },
        zip: { type: 'string' },
        city: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        'vat-id': { type: 'string' },
        notes: { type: 'string' },
      },
      async run(ctx) {
        const patch = patchFrom(ctx, {
          name: 'string',
          'contact-name': 'string',
          address: 'string',
          zip: 'string',
          city: 'string',
          email: 'string',
          phone: 'string',
          'vat-id': 'string',
          notes: 'string',
        })
        if (Object.keys(patch).length === 0) throw new Error('Nichts zu ändern.')
        const { customer } = await ctx.client.patch<{ customer: Customer }>(`/customers/${ctx.id()}`, patch)
        if (ctx.json) return printJson(customer)
        print(`Kunde ${customer.id} aktualisiert.`)
      },
    },
  },
}
