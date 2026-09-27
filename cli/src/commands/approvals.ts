import type { Group } from '../registry.js'
import { print, printJson, table, details, euro, date, truncate } from '../output.js'
import type { Approval } from '../types.js'

// Freigaben — the human's yes in front of the one-way doors.
//
// The CLI authenticates with an API token, which makes every call here a
// headless one. That is exactly why `approve` and `reject` are missing: the
// server only accepts a decision from an interactive login, so that an agent (or
// a script holding the same token) can never wave through its own request. What
// the CLI can do is ask, watch and withdraw.

const STATUS_HINT: Record<string, string> = {
  offen: 'wartet auf einen Menschen',
  genehmigt: 'genehmigt — einmal verwendbar',
  abgelehnt: 'abgelehnt',
  verbraucht: 'bereits verwendet',
  zurueckgezogen: 'zurückgezogen',
  abgelaufen: 'abgelaufen',
}

function show(a: Approval): void {
  details([
    ['Freigabe', String(a.id)],
    ['Aktion', a.summary.label ?? a.action],
    ['Betrifft', `${a.entity} ${a.entity_id} — ${a.summary.title}`],
    ['Empfänger', a.summary.recipient ?? '—'],
    ['Betrag', euro(a.summary.gross_cents)],
    ['Status', `${a.status} (${STATUS_HINT[a.status] ?? ''})`.trim()],
    ['Beantragt von', `${a.requested_by} am ${date(a.requested_at)}`],
    ['Begründung', a.reason ?? '—'],
    ['Gültig bis', date(a.expires_at)],
    ['Entschieden', a.decided_by ? `${a.decided_by} am ${date(a.decided_at)}` : '—'],
    ['Anmerkung', a.decision_note ?? '—'],
  ])
  if (a.summary.lines?.length) {
    print()
    for (const line of a.summary.lines) print(`  ${line}`)
  }
  if (a.summary.warnings?.length) {
    print()
    for (const w of a.summary.warnings) print(`  ! ${w}`)
  }
  if (a.content_unchanged === false) {
    print()
    print('  ! Der Inhalt hat sich seit der Anfrage geändert — diese Freigabe greift nicht mehr.')
  }
}

export const approvals: Group = {
  summary: 'Freigaben für Festschreiben und Versenden: beantragen und verfolgen',
  commands: {
    list: {
      summary: 'Freigaben auflisten (Standard: alle)',
      usage: '[--status offen|genehmigt|abgelehnt|verbraucht|abgelaufen] [--entity <id>]',
      options: { status: { type: 'string' }, entity: { type: 'string' } },
      async run(ctx) {
        const { approvals: rows } = await ctx.client.get<{ approvals: Approval[] }>('/approvals', {
          status: ctx.str('status'),
          entity_id: ctx.num('entity'),
        })
        if (ctx.json) return printJson(rows)
        table(
          rows,
          [
            { header: 'ID', value: (a) => String(a.id), right: true },
            { header: 'Aktion', value: (a) => a.action },
            { header: 'Betrifft', value: (a) => `${a.entity} ${a.entity_id}` },
            { header: 'Titel', value: (a) => truncate(a.summary.title ?? '', 34) },
            { header: 'Betrag', value: (a) => euro(a.summary.gross_cents), right: true },
            { header: 'Status', value: (a) => a.status },
            { header: 'Antragsteller', value: (a) => truncate(a.requested_by, 18) },
          ],
          'Keine Freigaben.',
        )
        const open = rows.filter((a) => a.status === 'offen').length
        if (open) {
          print()
          print(`${open} offen — entschieden wird im Kunden Manager unter „Freigaben" (nur angemeldet).`)
        }
      },
    },

    show: {
      summary: 'Eine Freigabe im Detail, mit Positionen und Warnhinweisen',
      usage: '<id>',
      async run(ctx) {
        const { approval } = await ctx.client.get<{ approval: Approval }>(`/approvals/${ctx.id()}`)
        if (ctx.json) return printJson(approval)
        show(approval)
      },
    },

    request: {
      summary: 'Freigabe beantragen (Festschreiben oder Versenden)',
      usage: '<id> --action document.finalize|document.send|contract.finalize|contract.send [--reason <text>]',
      options: { action: { type: 'string' }, reason: { type: 'string' } },
      help:
        'Beantragt die Erlaubnis, eine nicht umkehrbare Aktion auszuführen. <id> ist die ID des\n' +
        'Dokuments bzw. Vertrags. Der Antrag bewirkt selbst nichts: ein Mensch sieht ihn in der\n' +
        'Oberfläche mit Empfänger, Positionen und Summe und entscheidet. Danach:\n' +
        '  openleads docs finalize <id> --approval <freigabe-id> --yes',
      async run(ctx) {
        const action = ctx.str('action')
        if (!action) throw new Error('--action fehlt (z. B. --action document.finalize).')
        const res = await ctx.client.post<{ approval: Approval; existed: boolean }>('/approvals', {
          action,
          entity_id: ctx.id(),
          reason: ctx.str('reason') ?? null,
        })
        if (ctx.json) return printJson(res)
        show(res.approval)
        print()
        print(
          res.existed
            ? 'Ein gleichlautender Antrag lief bereits — kein zweiter angelegt.'
            : 'Beantragt. Es ist noch nichts passiert; ein Mensch entscheidet in der Oberfläche.',
        )
      },
    },

    withdraw: {
      summary: 'Eigenen offenen Antrag zurückziehen',
      usage: '<id>',
      async run(ctx) {
        const { approval } = await ctx.client.post<{ approval: Approval }>(
          `/approvals/${ctx.id()}/withdraw`,
        )
        if (ctx.json) return printJson(approval)
        print(`Antrag ${approval.id} zurückgezogen.`)
      },
    },
  },
}
