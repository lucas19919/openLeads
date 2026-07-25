import type { Command, Group } from '../registry.js'
import { print, printJson, table, details, euro, date, truncate } from '../output.js'
import { saveText, reportSaved } from '../files.js'
import { AI_TIMEOUT_MS } from '../client.js'
import type { Dashboard, Digest, EuerReport } from '../types.js'

// Read-only views: the numbers a morning routine reports on, and the CSVs the
// Steuerberater wants. Nothing here writes, so a read-only token covers all of it.

export const dashboard: Command = {
  summary: 'KPIs: Pipeline, offene Posten, Ausgaben, Verträge',
  async run(ctx) {
    const { dashboard: d } = await ctx.client.get<{ dashboard: Dashboard }>('/dashboard')
    if (ctx.json) return printJson(d)
    details([
      ['Leads gesamt', String(d.leads.total)],
      ['davon offen', String(d.leads.open)],
      ['gewonnen / verloren', `${d.leads.won} / ${d.leads.lost}`],
      ['Conversion', `${d.leads.conversion_pct} %`],
      ['Rechnungen ausgestellt', String(d.invoices.issued)],
      ['Entwürfe', String(d.invoices.drafts)],
      ['Umsatz (brutto)', euro(d.invoices.gross_total_cents)],
      ['davon bezahlt', euro(d.invoices.paid_total_cents)],
      ['offen', euro(d.invoices.open_total_cents)],
      ['überfällig', `${d.invoices.overdue_count} · ${euro(d.invoices.overdue_total_cents)}`],
      ['Ausgaben (brutto)', euro(d.expenses.gross_total_cents)],
      ['Ergebnis (netto)', euro(d.result.net_cents)],
      ['Verträge aktiv', `${d.contracts.active} · ${euro(d.contracts.active_value_cents)}`],
    ])
    if (d.leads.by_stage.length) {
      print()
      print('Pipeline:')
      table(d.leads.by_stage, [
        { header: 'Stage', value: (s) => s.stage },
        { header: 'Leads', value: (s) => String(s.n), right: true },
      ])
    }
    if (d.contracts.expiring_soon.length) {
      print()
      print('Verträge, die bald auslaufen:')
      table(d.contracts.expiring_soon, [
        { header: 'ID', value: (c) => String(c.id), right: true },
        { header: 'Nummer', value: (c) => c.number ?? '—' },
        { header: 'Kunde', value: (c) => c.client_name ?? '—', max: 28 },
        { header: 'Ende', value: (c) => date(c.end_date) },
      ])
    }
  },
}

export const digest: Command = {
  summary: 'Morgen-Briefing: was heute Aufmerksamkeit braucht',
  help: 'Nutzt das konfigurierte Modell, wenn eines erreichbar ist — sonst die reinen Fakten.',
  async run(ctx) {
    const { digest: g } = await ctx.client.get<{ digest: Digest }>('/ai/digest')
    if (ctx.json) return printJson(g)
    print(g.headline)
    if (g.priorities.length) {
      print()
      for (const [i, p] of g.priorities.entries()) {
        print(`${i + 1}. ${p.title}`)
        print(`   Warum:  ${p.why}`)
        print(`   Schritt: ${p.action}`)
      }
    }
    const f = g.facts
    print()
    details([
      ['Neue Leads', String(f.new_leads)],
      ['Heiße Leads', String(f.hot_leads.length)],
      ['Liegengeblieben', String(f.stale_leads.length)],
      ['Überfällig', `${f.overdue.count} · ${euro(f.overdue.total_claim_cents)} (max. ${f.overdue.worst_days} Tage)`],
    ])
    if (!g.ai) print('\n(ohne Modell erstellt — nur Fakten)')
  },
}

export const report: Group = {
  summary: 'Auswertungen für die Buchhaltung',
  commands: {
    euer: {
      summary: 'EÜR-Übersicht für einen Zeitraum',
      usage: '[--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>]',
      options: { from: { type: 'string' }, to: { type: 'string' } },
      async run(ctx) {
        const { report: r } = await ctx.client.get<{ report: EuerReport }>('/report/euer', {
          from: ctx.str('from'),
          to: ctx.str('to'),
        })
        if (ctx.json) return printJson(r)
        details([
          ['Zeitraum', `${r.from ? date(r.from) : 'Anfang'} – ${r.to ? date(r.to) : 'heute'}`],
          ['Einnahmen (netto)', `${euro(r.revenue.net_cents)} · ${r.revenue.count} Rechnung(en)`],
          ['Ausgaben (netto)', `${euro(r.expenses.net_cents)} · ${r.expenses.count} Beleg(e)`],
          ['Ergebnis (netto)', euro(r.result_net_cents)],
          ...(r.small_business
            ? []
            : ([
                ['USt vereinnahmt', euro(r.vat.collected_cents)],
                ['Vorsteuer', euro(r.vat.input_cents)],
                ['USt-Zahllast', euro(r.vat.payable_cents)],
              ] as [string, string][])),
        ])
        if (r.expenses.by_category.length) {
          print()
          table(r.expenses.by_category, [
            { header: 'Kategorie', value: (c) => truncate(c.label, 32) },
            { header: 'SKR03', value: (c) => c.skr03 },
            { header: 'Anzahl', value: (c) => String(c.count), right: true },
            { header: 'Netto', value: (c) => euro(c.net_cents), right: true },
          ])
        }
        // Kein Steuerrat — dieselbe Einordnung wie in der Oberfläche.
        if (!ctx.quiet) print('\nKeine steuerliche Beratung — mit der Steuerberatung abgleichen.')
      },
    },
  },
}

// CSV exports, one verb per artefact. Default is stdout so they compose with
// other tools; -o writes a file (and prints the path).
const CSV_EXPORTS: Record<string, { path: string; label: string; ranged: boolean }> = {
  invoices: { path: '/export/invoices.csv', label: 'Rechnungsjournal', ranged: true },
  datev: { path: '/export/datev.csv', label: 'DATEV-Buchungen', ranged: true },
  expenses: { path: '/export/expenses.csv', label: 'Ausgabenjournal', ranged: true },
  'expenses-datev': { path: '/export/expenses-datev.csv', label: 'DATEV-Ausgaben', ranged: true },
  leads: { path: '/export/leads.csv', label: 'Lead-Pipeline', ranged: false },
}

export const exportGroup: Group = {
  summary: 'CSV-Exporte für die Steuerberatung',
  commands: Object.fromEntries(
    Object.entries(CSV_EXPORTS).map(([name, def]) => [
      name,
      {
        summary: `${def.label} als CSV`,
        usage: def.ranged ? '[--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [-o <datei>]' : '[--stage <s>] [--q <suche>] [-o <datei>]',
        options: {
          from: { type: 'string' },
          to: { type: 'string' },
          stage: { type: 'string' },
          q: { type: 'string' },
          out: { type: 'string', short: 'o' },
        },
        async run(ctx) {
          const csv = await ctx.client.getText(def.path, {
            from: ctx.str('from'),
            to: ctx.str('to'),
            stage: ctx.str('stage'),
            q: ctx.str('q'),
          })
          reportSaved(saveText(csv, ctx.str('out'), `${name}.csv`))
        },
      } satisfies Command,
    ]),
  ),
}

export const ai: Group = {
  summary: 'Copilot und Lead-Intelligenz',
  commands: {
    ask: {
      summary: 'Den Copiloten etwas fragen (er darf dieselben Werkzeuge nutzen wie die Oberfläche)',
      usage: '<frage…> [--thread <id>]',
      options: { thread: { type: 'string' } },
      async run(ctx) {
        const message = ctx.args.join(' ')
        if (!message) throw new Error('Keine Frage angegeben.')
        const res = await ctx.client.post<{
          thread_id: number
          reply: string
          steps: { tool: string; args: unknown }[]
        }>('/ai/chat', { message, thread_id: ctx.num('thread') }, { timeoutMs: AI_TIMEOUT_MS })
        if (ctx.json) return printJson(res)
        print(res.reply)
        if (res.steps.length && !ctx.quiet) {
          print()
          print(`(Werkzeuge: ${res.steps.map((s) => s.tool).join(', ')} · Thread ${res.thread_id})`)
        }
      },
    },

    analyze: {
      summary: 'Lead bewerten lassen (Qualifizierung, Fit-Score, nächster Schritt)',
      usage: '<lead-id>',
      async run(ctx) {
        const { analysis } = await ctx.client.post<{
          analysis: { summary: string | null; qualification: string | null; fit_score: number | null; next_action: string | null }
        }>(`/ai/leads/${ctx.id()}/analyze`, undefined, { timeoutMs: AI_TIMEOUT_MS })
        if (ctx.json) return printJson(analysis)
        details([
          ['Einschätzung', analysis.summary ?? '—'],
          ['Qualifizierung', analysis.qualification ?? '—'],
          ['Fit-Score', analysis.fit_score != null ? String(analysis.fit_score) : '—'],
          ['Nächster Schritt', analysis.next_action ?? '—'],
        ])
      },
    },

    outreach: {
      summary: 'Erstansprache entwerfen — Entwurf, wird nicht versendet',
      usage: '<lead-id>',
      async run(ctx) {
        const { outreach } = await ctx.client.post<{
          outreach: { id: number; subject: string | null; body: string | null }
        }>(`/ai/leads/${ctx.id()}/outreach`, undefined, { timeoutMs: AI_TIMEOUT_MS })
        if (ctx.json) return printJson(outreach)
        print(`Betreff: ${outreach.subject ?? '—'}`)
        print()
        print(outreach.body ?? '')
        if (!ctx.quiet) print('\n(Entwurf — Versand bestätigt ein Mensch in der Oberfläche.)')
      },
    },

    status: {
      summary: 'Ist das Modell erreichbar, und läuft es lokal?',
      async run(ctx) {
        const s = await ctx.client.get<{
          ok: boolean
          model: string
          label: string
          base_url: string
          local_inference: boolean
          detail?: string
        }>('/ai/status')
        if (ctx.json) return printJson(s)
        details([
          ['Erreichbar', s.ok ? 'ja' : `nein${s.detail ? ` (${s.detail})` : ''}`],
          ['Modell', s.label || s.model],
          ['Endpunkt', s.base_url],
          ['Inferenz lokal', s.local_inference ? 'ja' : 'nein'],
        ])
        if (!s.ok) process.exitCode = 1
      },
    },
  },
}
