import type { Group } from '../registry.js'
import { patchFrom } from '../registry.js'
import { print, printJson, table, details, euro, date, truncate } from '../output.js'
import { saveFile, reportSaved } from '../files.js'
import type { Contract } from '../types.js'

// Verträge. Finalising freezes the AGB text in force at that moment and assigns
// a number — same one-way door as an invoice, same --yes gate.

export const contracts: Group = {
  summary: 'Verträge: auflisten, anlegen, festschreiben, PDF holen',
  commands: {
    list: {
      summary: 'Verträge auflisten',
      usage: '[--customer <id>] [--status <status>] [--expiring <tage>]',
      options: { customer: { type: 'string' }, status: { type: 'string' }, expiring: { type: 'string' } },
      async run(ctx) {
        const { contracts } = await ctx.client.get<{ contracts: Contract[] }>('/contracts', {
          customer_id: ctx.num('customer'),
        })
        let rows = contracts
        if (ctx.str('status')) rows = rows.filter((c) => c.status === ctx.str('status'))
        const days = ctx.num('expiring')
        if (days !== undefined) {
          // The renewal question a scheduled job asks: what runs out soon?
          const cutoff = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
          const today = new Date().toISOString().slice(0, 10)
          rows = rows.filter((c) => c.end_date != null && c.end_date >= today && c.end_date <= cutoff)
        }
        if (ctx.json) return printJson(rows)
        table(rows, [
          { header: 'ID', value: (c) => String(c.id), right: true },
          { header: 'Nummer', value: (c) => c.number ?? '(Entwurf)' },
          { header: 'Typ', value: (c) => c.type, max: 20 },
          { header: 'Kunde', value: (c) => c.client_name ?? '—', max: 26 },
          { header: 'Status', value: (c) => c.status },
          { header: 'Ende', value: (c) => date(c.end_date) },
          { header: 'Wert', value: (c) => euro(c.totals.gross_cents), right: true },
        ], 'Keine Verträge gefunden.')
      },
    },

    get: {
      summary: 'Einen Vertrag zeigen',
      usage: '<id>',
      async run(ctx) {
        const { contract: c } = await ctx.client.get<{ contract: Contract }>(`/contracts/${ctx.id()}`)
        if (ctx.json) return printJson(c)
        details([
          ['ID', String(c.id)],
          ['Nummer', c.number ?? '(Entwurf)'],
          ['Typ', c.type],
          ['Titel', c.title ?? '—'],
          ['Kunde', c.client_name ?? '—'],
          ['Status', c.status],
          ['Laufzeit', `${date(c.start_date)} – ${date(c.end_date)}`],
          ['Wert (netto)', euro(c.totals.net_cents)],
          ['Wert (brutto)', euro(c.totals.gross_cents)],
          ['Gegengezeichnet', c.signed_at ? date(c.signed_at) : '—'],
        ])
      },
    },

    create: {
      summary: 'Vertragsentwurf anlegen',
      usage: '--type <typ> --client-name <name> [--value <betrag>] …',
      options: {
        type: { type: 'string' },
        customer: { type: 'string' },
        lead: { type: 'string' },
        title: { type: 'string' },
        'client-name': { type: 'string' },
        'client-email': { type: 'string' },
        body: { type: 'string' },
        value: { type: 'string' },
        'start-date': { type: 'string' },
        'end-date': { type: 'string' },
        'notice-period': { type: 'string' },
        'payment-terms': { type: 'string' },
        notes: { type: 'string' },
      },
      async run(ctx) {
        const payload = patchFrom(ctx, {
          type: 'string',
          title: 'string',
          'client-name': 'string',
          'client-email': 'string',
          body: 'string',
          'start-date': 'string',
          'end-date': 'string',
          'notice-period': 'string',
          'payment-terms': 'string',
          notes: 'string',
        })
        if (!payload.type) throw new Error('--type fehlt (z. B. wartungsvertrag).')
        if (ctx.cents('value') !== undefined) payload.value_cents = ctx.cents('value')
        if (ctx.num('customer') !== undefined) payload.customer_id = ctx.num('customer')
        if (ctx.num('lead') !== undefined) payload.lead_id = ctx.num('lead')
        const { contract } = await ctx.client.post<{ contract: Contract }>('/contracts', payload)
        if (ctx.json) return printJson(contract)
        print(`Vertragsentwurf ${contract.id} angelegt (${contract.type}).`)
      },
    },

    finalize: {
      summary: 'Vertrag festschreiben — Nummer vergeben, AGB einfrieren',
      usage: '<id> --approval <freigabe-id> --yes',
      options: { approval: { type: 'string' } },
      help:
        'Nicht umkehrbar, also für Token-Aufrufe nur mit der Freigabe eines Menschen:\n' +
        '  openleads approvals request <id> --action contract.finalize',
      async run(ctx) {
        ctx.confirm('Festschreiben vergibt eine Nummer und friert die AGB ein')
        const { contract } = await ctx.client.post<{ contract: Contract }>(`/contracts/${ctx.id()}/finalize`, {
          approval_id: ctx.num('approval'),
        })
        if (ctx.json) return printJson(contract)
        print(`Festgeschrieben: ${contract.number ?? contract.id}`)
      },
    },

    sign: {
      summary: 'Gegenzeichnung erfassen (Status → aktiv)',
      usage: '<id> [--by <name>] [--at <YYYY-MM-DD>] [--note <text>]',
      options: { by: { type: 'string' }, at: { type: 'string' }, note: { type: 'string' } },
      async run(ctx) {
        const { contract } = await ctx.client.post<{ contract: Contract }>(`/contracts/${ctx.id()}/sign`, {
          signed_by: ctx.str('by') ?? null,
          signed_at: ctx.str('at') ?? null,
          note: ctx.str('note') ?? null,
        })
        if (ctx.json) return printJson(contract)
        print(`Vertrag ${contract.id} gegengezeichnet (Status: ${contract.status}).`)
      },
    },

    pdf: {
      summary: 'Vertrags-PDF herunterladen (AGB im Volltext angehängt)',
      usage: '<id> [-o <datei|verzeichnis|->]',
      options: { out: { type: 'string', short: 'o' } },
      async run(ctx) {
        const file = await ctx.client.getFile(`/contracts/${ctx.id()}/pdf`)
        reportSaved(saveFile(file, ctx.str('out')), file.data.length)
      },
    },

    send: {
      summary: 'Festgeschriebenen Vertrag per E-Mail zur Unterschrift schicken',
      usage: '<id> --approval <freigabe-id> --yes',
      options: { approval: { type: 'string' } },
      async run(ctx) {
        ctx.confirm('Das verschickt eine E-Mail an den Kunden')
        const res = await ctx.client.post<{ ok: true; to: string }>(`/contracts/${ctx.id()}/send`, {
          approval_id: ctx.num('approval'),
        })
        if (ctx.json) return printJson(res)
        print(`Versendet an ${res.to}.`)
      },
    },

    expiring: {
      summary: 'Verträge, die in den nächsten N Tagen auslaufen (Standard 60)',
      usage: '[--days <n>]',
      options: { days: { type: 'string' } },
      async run(ctx) {
        const days = ctx.num('days') ?? 60
        const { contracts } = await ctx.client.get<{ contracts: Contract[] }>('/contracts')
        const today = new Date().toISOString().slice(0, 10)
        const cutoff = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
        const rows = contracts.filter(
          (c) => c.status === 'aktiv' && c.end_date != null && c.end_date >= today && c.end_date <= cutoff,
        )
        if (ctx.json) return printJson(rows)
        table(rows, [
          { header: 'ID', value: (c) => String(c.id), right: true },
          { header: 'Nummer', value: (c) => c.number ?? '—' },
          { header: 'Kunde', value: (c) => c.client_name ?? '—', max: 28 },
          { header: 'Titel', value: (c) => truncate(c.title ?? '', 28) },
          { header: 'Ende', value: (c) => date(c.end_date) },
          { header: 'Wert', value: (c) => euro(c.totals.gross_cents), right: true },
        ], `Kein Vertrag läuft in den nächsten ${days} Tagen aus.`)
      },
    },
  },
}
