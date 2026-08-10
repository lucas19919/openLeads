import type { Group } from '../registry.js'
import { patchFrom, toCents } from '../registry.js'
import { print, printJson, table, details, euro, date, truncate } from '../output.js'
import { saveFile, reportSaved } from '../files.js'
import type { Doc, PaymentSummary, ValidationResult } from '../types.js'

// Angebote und Rechnungen. Everything that issues a number, sends mail or
// corrects an issued invoice demands --yes: once a Rechnung is finalised it is
// immutable and its number is consumed (GoBD, §14 UStG). The CLI should make
// that boundary visible rather than let a script cross it by accident.

/** "R-2026-0007 · Muster GmbH" — how a document reads in a one-line message. */
function label(d: Doc): string {
  return `${d.number ?? `Entwurf ${d.id}`}${d.client_name ? ` · ${d.client_name}` : ''}`
}

export function parseItem(spec: string): { description: string; quantity: number; unit: string | null; unit_price_cents: number } {
  // "Beschreibung:menge:einzelpreis[:einheit]" — colon-separated so it survives
  // a shell without quoting gymnastics.
  const parts = spec.split(':')
  if (parts.length < 3) {
    throw new Error(`--item erwartet "Beschreibung:Menge:Einzelpreis[:Einheit]" (war: ${spec})`)
  }
  const [description, qty, price, unit] = parts
  const quantity = Number(qty.replace(',', '.'))
  const cents = toCents(price)
  if (!Number.isFinite(quantity) || cents === null) {
    throw new Error(`Menge und Einzelpreis müssen Zahlen sein (war: ${spec})`)
  }
  return { description, quantity, unit: unit || null, unit_price_cents: cents }
}

export const docs: Group = {
  summary: 'Angebote und Rechnungen: anlegen, prüfen, ausstellen, bezahlen',
  commands: {
    list: {
      summary: 'Dokumente auflisten',
      usage: '[--kind angebot|rechnung] [--status <status>] [--customer <id>] [--open] [--overdue]',
      options: {
        kind: { type: 'string' },
        status: { type: 'string' },
        customer: { type: 'string' },
        open: { type: 'boolean' },
        overdue: { type: 'boolean' },
      },
      async run(ctx) {
        const { documents } = await ctx.client.get<{ documents: Doc[] }>('/documents', {
          kind: ctx.str('kind'),
          customer_id: ctx.num('customer'),
        })
        const today = new Date().toISOString().slice(0, 10)
        let rows = documents
        if (ctx.str('status')) rows = rows.filter((d) => d.status === ctx.str('status'))
        // "offen" = ausgestellt und noch nicht vollständig bezahlt.
        if (ctx.bool('open') || ctx.bool('overdue')) {
          rows = rows.filter((d) => d.number && d.totals.gross_cents > d.paid_cents && d.status !== 'storniert')
        }
        if (ctx.bool('overdue')) rows = rows.filter((d) => d.due_date != null && d.due_date < today)
        if (ctx.json) return printJson(rows)
        table(rows, [
          { header: 'ID', value: (d) => String(d.id), right: true },
          { header: 'Nummer', value: (d) => d.number ?? '(Entwurf)' },
          { header: 'Art', value: (d) => d.kind },
          { header: 'Kunde', value: (d) => d.client_name ?? '—', max: 28 },
          { header: 'Status', value: (d) => d.status },
          { header: 'Fällig', value: (d) => date(d.due_date) },
          { header: 'Brutto', value: (d) => euro(d.totals.gross_cents), right: true },
          { header: 'Offen', value: (d) => euro(Math.max(0, d.totals.gross_cents - d.paid_cents)), right: true },
        ], 'Keine Dokumente gefunden.')
      },
    },

    get: {
      summary: 'Ein Dokument mit Positionen zeigen',
      usage: '<id>',
      async run(ctx) {
        const { document: d } = await ctx.client.get<{ document: Doc }>(`/documents/${ctx.id()}`)
        if (ctx.json) return printJson(d)
        details([
          ['ID', String(d.id)],
          ['Art', d.kind],
          ['Nummer', d.number ?? '(Entwurf)'],
          ['Titel', d.title ?? '—'],
          ['Kunde', d.client_name ?? '—'],
          ['E-Mail', d.client_email ?? '—'],
          ['Status', d.status],
          ['Ausgestellt', date(d.issue_date)],
          ['Fällig', date(d.due_date)],
          ['Netto', euro(d.totals.net_cents)],
          ['USt', euro(d.totals.vat_cents)],
          ['Brutto', euro(d.totals.gross_cents)],
          ['Bezahlt', euro(d.paid_cents)],
          ['Offen', euro(Math.max(0, d.totals.gross_cents - d.paid_cents))],
        ])
        if (d.items.length) {
          print()
          table(d.items, [
            { header: 'Position', value: (i) => truncate(i.description ?? '—', 44) },
            { header: 'Menge', value: (i) => String(i.quantity), right: true },
            { header: 'Einheit', value: (i) => i.unit ?? '' },
            { header: 'Einzel', value: (i) => euro(i.unit_price_cents), right: true },
            { header: 'Summe', value: (i) => euro(Math.round(i.quantity * i.unit_price_cents)), right: true },
          ])
        }
      },
    },

    create: {
      summary: 'Entwurf anlegen (Angebot oder Rechnung)',
      usage: '--kind <angebot|rechnung> [--customer <id>] [--item "Text:Menge:Preis[:Einheit]"]…',
      help:
        'Positionen werden mit --item wiederholt angegeben. Ohne --customer/--lead müssen die\n' +
        'Empfängerfelder (--client-name usw.) gesetzt werden. Erzeugt immer nur einen Entwurf.',
      options: {
        kind: { type: 'string' },
        customer: { type: 'string' },
        lead: { type: 'string' },
        title: { type: 'string' },
        intro: { type: 'string' },
        notes: { type: 'string' },
        'client-name': { type: 'string' },
        'client-email': { type: 'string' },
        item: { type: 'string', multiple: true },
      },
      async run(ctx) {
        const kind = ctx.str('kind') ?? 'rechnung'
        const body: Record<string, unknown> = {
          kind,
          ...patchFrom(ctx, {
            title: 'string',
            intro: 'string',
            notes: 'string',
            'client-name': 'string',
            'client-email': 'string',
          }),
        }
        if (ctx.num('customer') !== undefined) body.customer_id = ctx.num('customer')
        if (ctx.num('lead') !== undefined) body.lead_id = ctx.num('lead')
        const items = ctx.list('item').map(parseItem)
        if (items.length) body.items = items
        const { document: d } = await ctx.client.post<{ document: Doc }>('/documents', body)
        if (ctx.json) return printJson(d)
        print(`${d.kind} ${d.id} als Entwurf angelegt (${euro(d.totals.gross_cents)} brutto).`)
      },
    },

    update: {
      summary: 'Entwurf ändern (ausgestellte Dokumente sind unveränderlich)',
      usage: '<id> [--title <t>] [--status <s>] [--item …]',
      options: {
        title: { type: 'string' },
        intro: { type: 'string' },
        notes: { type: 'string' },
        status: { type: 'string' },
        'client-name': { type: 'string' },
        'client-email': { type: 'string' },
        item: { type: 'string', multiple: true },
      },
      async run(ctx) {
        const patch: Record<string, unknown> = patchFrom(ctx, {
          title: 'string',
          intro: 'string',
          notes: 'string',
          status: 'string',
          'client-name': 'string',
          'client-email': 'string',
        })
        const items = ctx.list('item')
        if (items.length) patch.items = items.map(parseItem)
        if (Object.keys(patch).length === 0) throw new Error('Nichts zu ändern.')
        const { document: d } = await ctx.client.patch<{ document: Doc }>(`/documents/${ctx.id()}`, patch)
        if (ctx.json) return printJson(d)
        print(`Dokument ${d.id} aktualisiert (${euro(d.totals.gross_cents)} brutto).`)
      },
    },

    validate: {
      summary: 'Rechnung gegen EN 16931 (ZUGFeRD/Factur-X) prüfen',
      usage: '<id>',
      async run(ctx) {
        const { validation } = await ctx.client.get<{ validation: ValidationResult }>(
          `/documents/${ctx.id()}/validate`,
        )
        if (ctx.json) return printJson(validation)
        print(validation.valid ? `Gültig (Profil ${validation.profile}).` : `Ungültig (Profil ${validation.profile}).`)
        for (const e of validation.errors) print(`  Fehler   ${e.rule}: ${e.message}`)
        for (const w of validation.warnings) print(`  Hinweis  ${w.rule}: ${w.message}`)
        if (!validation.valid) process.exitCode = 5
      },
    },

    finalize: {
      summary: 'Entwurf festschreiben — vergibt die Nummer, danach unveränderlich',
      usage: '<id> --approval <freigabe-id> --yes',
      options: { approval: { type: 'string' } },
      help:
        'Die CLI spricht mit einem API-Token, also als Automat. Festschreiben verlangt darum eine\n' +
        'Freigabe, die ein angemeldeter Mensch in OpenLeads erteilt hat:\n' +
        '  openleads approvals request <id> --action document.finalize --reason "..."\n' +
        '  (ein Mensch entscheidet in der Oberfläche unter „Freigaben")\n' +
        '  openleads docs finalize <id> --approval <freigabe-id> --yes',
      async run(ctx) {
        ctx.confirm('Festschreiben vergibt eine fortlaufende Nummer und ist nicht umkehrbar')
        const { document: d } = await ctx.client.post<{ document: Doc }>(
          `/documents/${ctx.id()}/finalize`,
          { approval_id: ctx.num('approval') },
        )
        if (ctx.json) return printJson(d)
        print(`Festgeschrieben: ${label(d)} — fällig ${date(d.due_date)}.`)
      },
    },

    pdf: {
      summary: 'PDF herunterladen (ausgestellte Rechnungen sind ZUGFeRD/Factur-X)',
      usage: '<id> [-o <datei|verzeichnis|->]',
      options: { out: { type: 'string', short: 'o' } },
      async run(ctx) {
        const file = await ctx.client.getFile(`/documents/${ctx.id()}/pdf`)
        reportSaved(saveFile(file, ctx.str('out')), file.data.length)
      },
    },

    send: {
      summary: 'Festgeschriebenes Dokument per E-Mail an den Kunden schicken',
      usage: '<id> --approval <freigabe-id> --yes',
      options: { approval: { type: 'string' } },
      help:
        'Wie beim Festschreiben: eine Mail an den Kunden lässt sich nicht zurückholen, und ein\n' +
        'Token-Aufruf braucht dafür die Freigabe eines Menschen —\n' +
        '  openleads approvals request <id> --action document.send',
      async run(ctx) {
        ctx.confirm('Das verschickt eine E-Mail an den Kunden')
        const res = await ctx.client.post<{ ok: true; to: string }>(`/documents/${ctx.id()}/send`, {
          approval_id: ctx.num('approval'),
        })
        if (ctx.json) return printJson(res)
        print(`Versendet an ${res.to}.`)
      },
    },

    pay: {
      summary: 'Zahlung auf eine Rechnung buchen',
      usage: '<id> --amount <betrag> [--on <YYYY-MM-DD>] [--method <art>]',
      options: {
        amount: { type: 'string' },
        on: { type: 'string' },
        method: { type: 'string' },
        note: { type: 'string' },
      },
      async run(ctx) {
        const amount = ctx.cents('amount')
        if (amount === undefined) throw new Error('--amount fehlt (z. B. --amount 1190,00).')
        const res = await ctx.client.post<{ document: Doc }>(`/documents/${ctx.id()}/payments`, {
          amount_cents: amount,
          paid_on: ctx.str('on') ?? null,
          method: ctx.str('method') ?? null,
          note: ctx.str('note') ?? null,
        })
        if (ctx.json) return printJson(res.document)
        const d = res.document
        print(
          `${euro(amount)} gebucht auf ${label(d)} — bezahlt ${euro(d.paid_cents)} von ${euro(d.totals.gross_cents)} (Status: ${d.status}).`,
        )
      },
    },

    payments: {
      summary: 'Zahlungen einer Rechnung auflisten',
      usage: '<id>',
      async run(ctx) {
        const res = await ctx.client.get<PaymentSummary>(`/documents/${ctx.id()}/payments`)
        if (ctx.json) return printJson(res)
        table(res.payments, [
          { header: 'ID', value: (p) => String(p.id), right: true },
          { header: 'Datum', value: (p) => date(p.paid_on) },
          { header: 'Betrag', value: (p) => euro(p.amount_cents), right: true },
          { header: 'Art', value: (p) => p.method ?? '—' },
          { header: 'Notiz', value: (p) => truncate(p.note ?? '', 40) },
        ], 'Keine Zahlungen erfasst.')
        print()
        details([
          ['Brutto', euro(res.gross_cents)],
          ['Bezahlt', euro(res.paid_cents)],
          ['Offen', euro(res.outstanding_cents)],
        ])
      },
    },

    convert: {
      summary: 'Angebot in einen Rechnungsentwurf überführen',
      usage: '<id>',
      async run(ctx) {
        const { document: d } = await ctx.client.post<{ document: Doc }>(`/documents/${ctx.id()}/convert`)
        if (ctx.json) return printJson(d)
        print(`Rechnungsentwurf ${d.id} aus Angebot erzeugt (${euro(d.totals.gross_cents)} brutto).`)
      },
    },

    storno: {
      summary: 'Stornorechnung zu einer ausgestellten Rechnung anlegen (Entwurf)',
      usage: '<id> --yes',
      async run(ctx) {
        ctx.confirm('Eine Stornorechnung korrigiert eine ausgestellte Rechnung')
        const { document: d } = await ctx.client.post<{ document: Doc }>(`/documents/${ctx.id()}/storno`)
        if (ctx.json) return printJson(d)
        print(
          `Storno-Entwurf ${d.id} angelegt. Wirksam wird er erst beim Festschreiben — dafür erst ` +
            `"approvals request ${d.id} --action document.finalize", dann "docs finalize ${d.id} --approval <id> --yes".`,
        )
      },
    },
  },
}
