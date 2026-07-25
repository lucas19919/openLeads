import type { Group } from '../registry.js'
import { patchFrom } from '../registry.js'
import { print, printJson, table, details, date, truncate } from '../output.js'
import { saveText, reportSaved } from '../files.js'
import type { Lead, LeadEvent } from '../types.js'

// The pipeline. `list` is the workhorse — it is what a scheduled "review all
// leads" job calls first — so its filters mirror the ones the board uses, and
// the CSV export honours exactly the same ones.

export const leads: Group = {
  summary: 'Lead-Pipeline: suchen, anlegen, bewegen, importieren, exportieren',
  commands: {
    list: {
      summary: 'Leads auflisten (gefiltert wie im Board)',
      usage: '[--stage <stage>] [--q <suche>] [--limit <n>]',
      options: {
        stage: { type: 'string' },
        q: { type: 'string' },
        limit: { type: 'string' },
      },
      async run(ctx) {
        const { leads } = await ctx.client.get<{ leads: Lead[] }>('/leads', {
          stage: ctx.str('stage'),
          q: ctx.str('q'),
        })
        const limit = ctx.num('limit')
        const rows = limit ? leads.slice(0, limit) : leads
        if (ctx.json) return printJson(rows)
        table(rows, [
          { header: 'ID', value: (l) => String(l.id), right: true },
          { header: 'Firma', value: (l) => l.company ?? '—', max: 34 },
          { header: 'Gewerk', value: (l) => l.trade ?? '—', max: 18 },
          { header: 'Ort', value: (l) => l.city ?? '—', max: 18 },
          { header: 'Stage', value: (l) => l.stage },
          { header: 'Prio', value: (l) => l.priority },
          { header: 'Score', value: (l) => String(l.score), right: true },
        ], 'Keine Leads gefunden.')
      },
    },

    get: {
      summary: 'Einen Lead mit seiner Historie zeigen',
      usage: '<id>',
      async run(ctx) {
        const res = await ctx.client.get<{ lead: Lead; events: LeadEvent[] }>(`/leads/${ctx.id()}`)
        if (ctx.json) return printJson(res)
        const l = res.lead
        details([
          ['ID', String(l.id)],
          ['Firma', l.company ?? '—'],
          ['Gewerk', l.trade ?? '—'],
          ['Ort', l.city ?? '—'],
          ['Website', l.website ?? '—'],
          ['Telefon', l.phone ?? '—'],
          ['E-Mail', l.email ?? '—'],
          ['Stage', l.stage],
          ['Priorität', l.priority],
          ['Score', String(l.score)],
          ['Tags', l.tags ?? '—'],
          ['Zuständig', l.assigned_to ?? '—'],
          ['Begründung', l.why_lead ?? '—'],
          ['Notizen', l.notes ?? '—'],
        ])
        if (res.events.length) {
          print()
          print('Historie:')
          table(res.events, [
            { header: 'Wann', value: (e) => date(e.at) },
            { header: 'Wer', value: (e) => e.actor ?? '—' },
            { header: 'Typ', value: (e) => e.type },
            {
              header: 'Detail',
              value: (e) =>
                e.type === 'stage' ? `${e.from_stage ?? '—'} → ${e.to_stage ?? '—'}` : truncate(e.body ?? '', 60),
            },
          ])
        }
      },
    },

    create: {
      summary: 'Lead anlegen (Dedupe über die Domain)',
      usage: '--website <url> [--company <name>] [--trade <gewerk>] …',
      options: {
        website: { type: 'string' },
        company: { type: 'string' },
        trade: { type: 'string' },
        city: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        priority: { type: 'string' },
        stage: { type: 'string' },
        why: { type: 'string' },
        tags: { type: 'string' },
      },
      async run(ctx) {
        const body = patchFrom(ctx, {
          website: 'string',
          company: 'string',
          trade: 'string',
          city: 'string',
          phone: 'string',
          email: 'string',
          priority: 'string',
          stage: 'string',
          tags: 'string',
        })
        if (ctx.str('why')) body.why_lead = ctx.str('why')
        if (!body.website && !body.company) {
          throw new Error('Mindestens --website oder --company angeben.')
        }
        const res = await ctx.client.post<{ id: number; deduped?: boolean }>('/leads', body)
        if (ctx.json) return printJson(res)
        print(res.deduped ? `Bereits vorhanden (Lead ${res.id}) — nichts angelegt.` : `Lead ${res.id} angelegt.`)
      },
    },

    update: {
      summary: 'Lead ändern — Stage, Priorität, Zuständigkeit, Notizen …',
      usage: '<id> [--stage <stage>] [--priority <p>] [--assigned-to <user>] …',
      options: {
        stage: { type: 'string' },
        priority: { type: 'string' },
        score: { type: 'string' },
        company: { type: 'string' },
        trade: { type: 'string' },
        city: { type: 'string' },
        website: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        tags: { type: 'string' },
        notes: { type: 'string' },
        'assigned-to': { type: 'string' },
      },
      async run(ctx) {
        const patch = patchFrom(ctx, {
          stage: 'string',
          priority: 'string',
          score: 'number',
          company: 'string',
          trade: 'string',
          city: 'string',
          website: 'string',
          phone: 'string',
          email: 'string',
          tags: 'string',
          notes: 'string',
          'assigned-to': 'string',
        })
        if (Object.keys(patch).length === 0) throw new Error('Nichts zu ändern — mindestens ein Feld angeben.')
        const { lead } = await ctx.client.patch<{ lead: Lead }>(`/leads/${ctx.id()}`, patch)
        if (ctx.json) return printJson(lead)
        print(`Lead ${lead.id} aktualisiert (Stage: ${lead.stage}, Priorität: ${lead.priority}).`)
      },
    },

    // Stage moves are frequent enough in scripts to deserve their own verb.
    move: {
      summary: 'Lead in eine andere Pipeline-Spalte schieben',
      usage: '<id> <stage>',
      async run(ctx) {
        const stage = ctx.arg(1, '<stage>')
        const { lead } = await ctx.client.patch<{ lead: Lead }>(`/leads/${ctx.id()}`, { stage })
        if (ctx.json) return printJson(lead)
        print(`Lead ${lead.id} → ${lead.stage}`)
      },
    },

    note: {
      summary: 'Notiz setzen (wird als Ereignis protokolliert)',
      usage: '<id> <text>',
      async run(ctx) {
        const text = ctx.args.slice(1).join(' ')
        if (!text) throw new Error('Kein Text angegeben.')
        const { lead } = await ctx.client.patch<{ lead: Lead }>(`/leads/${ctx.id()}`, { notes: text })
        if (ctx.json) return printJson(lead)
        print(`Notiz an Lead ${lead.id} gespeichert.`)
      },
    },

    import: {
      summary: 'Leads aus einer .xlsx-Datei importieren',
      usage: '<datei.xlsx>',
      async run(ctx) {
        const res = await ctx.client.postFile<{ imported: number; deduped: number; total: number }>(
          '/leads/import',
          ctx.arg(0, '<datei.xlsx>'),
        )
        if (ctx.json) return printJson(res)
        print(`${res.imported} importiert, ${res.deduped} Dubletten übersprungen (${res.total} Zeilen).`)
      },
    },

    export: {
      summary: 'Pipeline als CSV exportieren',
      usage: '[--stage <stage>] [--q <suche>] [-o <datei|->]',
      options: { stage: { type: 'string' }, q: { type: 'string' }, out: { type: 'string', short: 'o' } },
      async run(ctx) {
        const csv = await ctx.client.getText('/export/leads.csv', {
          stage: ctx.str('stage'),
          q: ctx.str('q'),
        })
        reportSaved(saveText(csv, ctx.str('out'), 'leads.csv'))
      },
    },
  },
}
