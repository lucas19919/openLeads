import type { Group } from '../registry.js'
import { patchFrom } from '../registry.js'
import { print, printJson, table, details, euro, date, truncate } from '../output.js'
import type { Expense, ExpenseSummary, Subscription, RecurringInvoice, CatalogItem, Doc } from '../types.js'

// Ausgaben, Abos, Serienrechnungen, Leistungskatalog — the ledger side.
// `recurring run-due` is the one a nightly job wants: it only ever produces
// drafts, so an unattended run cannot issue an invoice by itself.

export const expenses: Group = {
  summary: 'Ausgaben und Belege',
  commands: {
    list: {
      summary: 'Ausgaben auflisten (mit Summen)',
      usage: '[--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--category <kat>] [--q <suche>]',
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        category: { type: 'string' },
        q: { type: 'string' },
      },
      async run(ctx) {
        const res = await ctx.client.get<{ expenses: Expense[]; summary: ExpenseSummary }>('/expenses', {
          from: ctx.str('from'),
          to: ctx.str('to'),
          category: ctx.str('category'),
          q: ctx.str('q'),
        })
        if (ctx.json) return printJson(res)
        table(res.expenses, [
          { header: 'ID', value: (e) => String(e.id), right: true },
          { header: 'Datum', value: (e) => date(e.expense_date) },
          { header: 'Lieferant', value: (e) => e.vendor ?? '—', max: 26 },
          { header: 'Kategorie', value: (e) => e.category, max: 20 },
          { header: 'Brutto', value: (e) => euro(e.gross_cents), right: true },
          { header: 'Vorsteuer', value: (e) => euro(e.vat_cents), right: true },
          { header: 'Beleg', value: (e) => (e.has_receipt ? 'ja' : '—') },
        ], 'Keine Ausgaben im Zeitraum.')
        print()
        details([
          ['Anzahl', String(res.summary.count)],
          ['Brutto', euro(res.summary.gross_cents)],
          ['Netto', euro(res.summary.net_cents)],
          ['Vorsteuer', euro(res.summary.vat_cents)],
        ])
      },
    },

    create: {
      summary: 'Ausgabe erfassen',
      usage: '--gross <betrag> [--vendor <name>] [--category <kat>] [--date <YYYY-MM-DD>]',
      options: {
        gross: { type: 'string' },
        vendor: { type: 'string' },
        category: { type: 'string' },
        description: { type: 'string' },
        date: { type: 'string' },
        'paid-on': { type: 'string' },
        'vat-rate': { type: 'string' },
        'payment-method': { type: 'string' },
        note: { type: 'string' },
      },
      async run(ctx) {
        const gross = ctx.cents('gross')
        if (gross === undefined) throw new Error('--gross fehlt (z. B. --gross 23,80).')
        const body: Record<string, unknown> = {
          gross_cents: gross,
          ...patchFrom(ctx, {
            vendor: 'string',
            category: 'string',
            description: 'string',
            'paid-on': 'string',
            'payment-method': 'string',
            note: 'string',
            'vat-rate': 'number',
          }),
        }
        if (ctx.str('date')) body.expense_date = ctx.str('date')
        const { expense } = await ctx.client.post<{ expense: Expense }>('/expenses', body)
        if (ctx.json) return printJson(expense)
        print(`Ausgabe ${expense.id} erfasst: ${euro(expense.gross_cents)} (${expense.category}).`)
      },
    },

    receipt: {
      summary: 'Beleg (PDF/Scan) an eine Ausgabe hängen',
      usage: '<id> <datei>',
      async run(ctx) {
        const { expense } = await ctx.client.postFile<{ expense: Expense }>(
          `/expenses/${ctx.id()}/receipt`,
          ctx.arg(1, '<datei>'),
        )
        if (ctx.json) return printJson(expense)
        print(`Beleg an Ausgabe ${expense.id} gespeichert.`)
      },
    },
  },
}

export const subs: Group = {
  summary: 'Abonnements (eigene SaaS-/Hosting-Kosten)',
  commands: {
    list: {
      summary: 'Abos auflisten, mit Monats- und Jahressumme',
      usage: '[--active]',
      options: { active: { type: 'boolean' } },
      async run(ctx) {
        const res = await ctx.client.get<{
          subscriptions: Subscription[]
          summary: { count: number; active_count: number; monthly_cents: number; yearly_cents: number }
        }>('/subscriptions', { active: ctx.bool('active') ? '1' : undefined })
        if (ctx.json) return printJson(res)
        table(res.subscriptions, [
          { header: 'ID', value: (s) => String(s.id), right: true },
          { header: 'Anbieter', value: (s) => s.vendor, max: 26 },
          { header: 'Kategorie', value: (s) => s.category, max: 20 },
          { header: 'Turnus', value: (s) => s.cadence },
          { header: 'Nächste', value: (s) => date(s.next_renewal) },
          { header: 'Betrag', value: (s) => euro(s.amount_cents), right: true },
          { header: '/Monat', value: (s) => euro(s.monthly_cents), right: true },
        ], 'Keine Abos erfasst.')
        print()
        details([
          ['Aktiv', `${res.summary.active_count} von ${res.summary.count}`],
          ['Pro Monat', euro(res.summary.monthly_cents)],
          ['Pro Jahr', euro(res.summary.yearly_cents)],
        ])
      },
    },

    create: {
      summary: 'Abo erfassen',
      usage: '--vendor <name> --amount <betrag> [--cadence <turnus>] [--next <YYYY-MM-DD>]',
      options: {
        vendor: { type: 'string' },
        amount: { type: 'string' },
        cadence: { type: 'string' },
        category: { type: 'string' },
        description: { type: 'string' },
        next: { type: 'string' },
        'payment-method': { type: 'string' },
        note: { type: 'string' },
      },
      async run(ctx) {
        const amount = ctx.cents('amount')
        if (amount === undefined) throw new Error('--amount fehlt.')
        const body: Record<string, unknown> = {
          amount_cents: amount,
          ...patchFrom(ctx, {
            vendor: 'string',
            cadence: 'string',
            category: 'string',
            description: 'string',
            'payment-method': 'string',
            note: 'string',
          }),
        }
        if (ctx.str('next')) body.next_renewal = ctx.str('next')
        const { subscription } = await ctx.client.post<{ subscription: Subscription }>('/subscriptions', body)
        if (ctx.json) return printJson(subscription)
        print(`Abo ${subscription.id} erfasst: ${subscription.vendor} (${euro(subscription.amount_cents)}).`)
      },
    },
  },
}

export const recurring: Group = {
  summary: 'Serienrechnungen (Hosting-/Wartungsverträge)',
  commands: {
    list: {
      summary: 'Serien auflisten',
      usage: '[--customer <id>] [--active]',
      options: { customer: { type: 'string' }, active: { type: 'boolean' } },
      async run(ctx) {
        const { recurring } = await ctx.client.get<{ recurring: RecurringInvoice[] }>('/recurring', {
          customer_id: ctx.num('customer'),
          active: ctx.bool('active') ? '1' : undefined,
        })
        if (ctx.json) return printJson(recurring)
        table(recurring, [
          { header: 'ID', value: (r) => String(r.id), right: true },
          { header: 'Kunde', value: (r) => r.client_name ?? '—', max: 28 },
          { header: 'Titel', value: (r) => truncate(r.title ?? '', 26) },
          { header: 'Turnus', value: (r) => r.cadence },
          { header: 'Nächster Lauf', value: (r) => date(r.next_run) },
          { header: 'Zuletzt', value: (r) => date(r.last_run) },
          { header: 'Aktiv', value: (r) => (r.active ? 'ja' : 'nein') },
        ], 'Keine Serienrechnungen angelegt.')
      },
    },

    run: {
      summary: 'Eine Serie jetzt ausführen — erzeugt einen Rechnungsentwurf',
      usage: '<id>',
      async run(ctx) {
        const { document: d } = await ctx.client.post<{ document: Doc }>(`/recurring/${ctx.id()}/run`)
        if (ctx.json) return printJson(d)
        print(`Rechnungsentwurf ${d.id} erzeugt (${euro(d.totals.gross_cents)} brutto).`)
      },
    },

    'run-due': {
      summary: 'Alle fälligen Serien ausführen (nur Entwürfe, nichts wird versendet)',
      async run(ctx) {
        const res = await ctx.client.post<{ generated: number }>('/recurring/run-due')
        if (ctx.json) return printJson(res)
        print(res.generated ? `${res.generated} Rechnungsentwurf/-entwürfe erzeugt.` : 'Nichts fällig.')
      },
    },
  },
}

export const catalog: Group = {
  summary: 'Leistungskatalog',
  commands: {
    list: {
      summary: 'Katalogpositionen auflisten',
      usage: '[--active]',
      options: { active: { type: 'boolean' } },
      async run(ctx) {
        const { items } = await ctx.client.get<{ items: CatalogItem[] }>('/catalog', {
          active: ctx.bool('active') ? '1' : undefined,
        })
        if (ctx.json) return printJson(items)
        table(items, [
          { header: 'ID', value: (i) => String(i.id), right: true },
          { header: 'Leistung', value: (i) => i.name, max: 40 },
          { header: 'Kategorie', value: (i) => i.category ?? '—', max: 20 },
          { header: 'Einheit', value: (i) => i.unit ?? '—' },
          { header: 'Preis', value: (i) => euro(i.unit_price_cents), right: true },
        ], 'Katalog ist leer.')
      },
    },

    create: {
      summary: 'Katalogposition anlegen',
      usage: '--name <name> --price <betrag> [--unit <einheit>] [--category <kat>]',
      options: {
        name: { type: 'string' },
        price: { type: 'string' },
        unit: { type: 'string' },
        category: { type: 'string' },
        description: { type: 'string' },
        sku: { type: 'string' },
      },
      async run(ctx) {
        const price = ctx.cents('price')
        if (!ctx.str('name') || price === undefined) throw new Error('--name und --price sind nötig.')
        const { item } = await ctx.client.post<{ item: CatalogItem }>('/catalog', {
          unit_price_cents: price,
          ...patchFrom(ctx, {
            name: 'string',
            unit: 'string',
            category: 'string',
            description: 'string',
            sku: 'string',
          }),
        })
        if (ctx.json) return printJson(item)
        print(`Katalogposition ${item.id} angelegt: ${item.name} (${euro(item.unit_price_cents)}).`)
      },
    },
  },
}
