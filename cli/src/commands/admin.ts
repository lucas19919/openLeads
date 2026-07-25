import type { Command, Group } from '../registry.js'
import { CliError, EXIT } from '../client.js'
import { print, printJson, table, details, date } from '../output.js'
import { saveFile, reportSaved } from '../files.js'
import { readConfig, saveProfile, removeProfile, configPath, resolveConnection } from '../config.js'
import type { ApiToken, SessionUser, Config } from '../types.js'

// Connection management, tokens and the data-safety pair (backup/restore).
//
// There is deliberately no password login here: the CLI only ever holds an API
// token, minted in Settings and revocable there. That keeps the account
// password out of shell history, cron files and MCP host configs.

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

export const login: Command = {
  summary: 'Token und URL in einem Profil hinterlegen',
  usage: '--token <ol_…|-> [--url <url>] [--profile <name>]',
  help:
    'Token in den Einstellungen unter „API-Tokens" erzeugen. "--token -" liest ihn von stdin,\n' +
    'damit er nicht in der Shell-History landet:\n' +
    '  echo "$OL_TOKEN" | openleads login --token - --url https://openleads.example.de',
  async run(ctx) {
    let token = ctx.str('token')
    if (token === '-') token = await readStdin()
    if (!token) throw new CliError('--token fehlt.', EXIT.USAGE)

    // Verify before saving: a token that does not work should never be written
    // to disk, and the user finds out now rather than at 9am tomorrow.
    const probe = resolveConnection({ url: ctx.str('url'), token, profile: ctx.str('profile') })
    const { Client } = await import('../client.js')
    const client = new Client(probe.url, token)
    const { user } = await client.get<{ user: SessionUser }>('/me')

    saveProfile(probe.profile, { url: probe.url, token })
    if (ctx.json) return printJson({ profile: probe.profile, url: probe.url, user })
    print(`Angemeldet als ${user.username} (${user.role}) auf ${probe.url}.`)
    print(`Profil „${probe.profile}" gespeichert in ${configPath()}.`)
  },
}

export const logout: Command = {
  summary: 'Token aus einem Profil entfernen (widerruft ihn nicht serverseitig)',
  usage: '[--profile <name>] [--all]',
  options: { all: { type: 'boolean' } },
  async run(ctx) {
    const cfg = readConfig()
    const name = ctx.str('profile') ?? cfg.current
    if (ctx.bool('all')) {
      if (!removeProfile(name)) throw new CliError(`Profil „${name}" gibt es nicht.`, EXIT.NOT_FOUND)
      print(`Profil „${name}" entfernt.`)
      return
    }
    const profile = cfg.profiles[name]
    if (!profile) throw new CliError(`Profil „${name}" gibt es nicht.`, EXIT.NOT_FOUND)
    saveProfile(name, { url: profile.url, token: undefined }, false)
    print(`Token aus Profil „${name}" entfernt. Endgültig widerrufen: openleads tokens revoke <id>`)
  },
}

export const whoami: Command = {
  summary: 'Wer bin ich, gegen welche Instanz, mit welchem Token?',
  async run(ctx) {
    const { user } = await ctx.client.get<{ user: SessionUser }>('/me')
    if (ctx.json) return printJson({ user, url: ctx.connection.url, profile: ctx.connection.profile, token_source: ctx.connection.source })
    details([
      ['Benutzer', `${user.username} (${user.role})`],
      ['Instanz', ctx.connection.url],
      ['Profil', ctx.connection.profile],
      ['Token aus', { flag: '--token', env: 'OPENLEADS_TOKEN', profile: 'Profildatei', none: '—' }[ctx.connection.source]],
    ])
  },
}

export const health: Command = {
  summary: 'Erreichbarkeit der Instanz prüfen (ohne Token)',
  async run(ctx) {
    const res = await ctx.client.get<{ ok: boolean }>('/health')
    if (ctx.json) return printJson({ ...res, url: ctx.connection.url })
    print(res.ok ? `OK — ${ctx.connection.url}` : `Antwort ohne ok-Flag von ${ctx.connection.url}`)
    if (!res.ok) process.exitCode = EXIT.ERROR
  },
}

export const profiles: Command = {
  summary: 'Hinterlegte Profile auflisten',
  async run(ctx) {
    const cfg = readConfig()
    const rows = Object.entries(cfg.profiles).map(([name, p]) => ({
      name,
      url: p.url,
      token: p.token ? 'hinterlegt' : '—',
      current: name === cfg.current,
    }))
    if (ctx.json) return printJson({ path: configPath(), current: cfg.current, profiles: rows })
    table(rows, [
      { header: '', value: (r) => (r.current ? '*' : ' ') },
      { header: 'Profil', value: (r) => r.name },
      { header: 'URL', value: (r) => r.url },
      { header: 'Token', value: (r) => r.token },
    ], `Keine Profile in ${configPath()}.`)
  },
}

export const config: Command = {
  summary: 'Konfigurationswerte des laufenden Aufrufs zeigen (Stages, Kategorien …)',
  async run(ctx) {
    const cfg = await ctx.client.get<Config>('/config')
    if (ctx.json) return printJson(cfg)
    details([
      ['Stages', cfg.stages.join(', ')],
      ['Prioritäten', cfg.priorities.join(', ')],
      ['Dokumentarten', cfg.docKinds.join(', ')],
      ['Turnus', cfg.cadences.join(', ')],
      ['Zahlarten', cfg.paymentMethods.join(', ')],
      ['Vertragsarten', cfg.contractTypes.map((t) => t.id).join(', ')],
      ['Vertragsstatus', cfg.contractStatuses.join(', ')],
      ['Ausgabenkategorien', cfg.expenseCategories.map((e) => e.id).join(', ')],
    ])
  },
}

export const tokens: Group = {
  summary: 'API-Tokens verwalten',
  commands: {
    list: {
      summary: 'Eigene Tokens auflisten',
      async run(ctx) {
        const { tokens } = await ctx.client.get<{ tokens: ApiToken[] }>('/tokens')
        if (ctx.json) return printJson(tokens)
        table(tokens, [
          { header: 'ID', value: (t) => String(t.id), right: true },
          { header: 'Name', value: (t) => t.name, max: 30 },
          { header: 'Präfix', value: (t) => `${t.prefix}…` },
          { header: 'Rechte', value: (t) => (t.scope === 'read' ? 'nur lesen' : 'lesen & schreiben') },
          { header: 'Zuletzt', value: (t) => (t.last_used_at ? date(t.last_used_at) : 'nie') },
          { header: 'Läuft ab', value: (t) => (t.expires_at ? date(t.expires_at) : '—') },
        ], 'Keine Tokens angelegt.')
      },
    },

    create: {
      summary: 'Token erzeugen — der Wert wird genau einmal ausgegeben',
      usage: '--name <name> [--scope read|write] [--expires-days <n>]',
      options: { name: { type: 'string' }, scope: { type: 'string' }, 'expires-days': { type: 'string' } },
      async run(ctx) {
        const name = ctx.str('name')
        if (!name) throw new CliError('--name fehlt.', EXIT.USAGE)
        const res = await ctx.client.post<{ token: string; id: number; prefix: string }>('/tokens', {
          name,
          scope: ctx.str('scope') ?? 'write',
          expires_days: ctx.num('expires-days') ?? null,
        })
        if (ctx.json) return printJson(res)
        // The secret goes to stdout alone, so `openleads tokens create … --json`
        // or a plain capture both work without stripping prose.
        print(res.token)
      },
    },

    revoke: {
      summary: 'Token widerrufen — wirkt sofort',
      usage: '<id> --yes',
      async run(ctx) {
        ctx.confirm('Laufende Automationen mit diesem Token brechen ab')
        await ctx.client.delete(`/tokens/${ctx.id()}`)
        print(`Token ${ctx.id()} widerrufen.`)
      },
    },
  },
}

export const backup: Command = {
  summary: 'Vollständige SQLite-Momentaufnahme herunterladen',
  usage: '[-o <datei|verzeichnis|->]',
  help: 'Admin-Recht nötig. Ohne -o landet die Datei unter ihrem Servernamen im aktuellen Verzeichnis.',
  options: { out: { type: 'string', short: 'o' } },
  async run(ctx) {
    const file = await ctx.client.getFile('/admin/backup')
    const path = saveFile(file, ctx.str('out'))
    if (ctx.json) return printJson({ path, bytes: file.data.length, filename: file.filename })
    reportSaved(path, file.data.length)
  },
}

export const restore: Command = {
  summary: 'Sicherung einspielen — überschreibt ALLE aktuellen Daten',
  usage: '<datei.db> --yes',
  async run(ctx) {
    ctx.confirm('Die Wiederherstellung überschreibt alle aktuellen Daten und ist nicht umkehrbar')
    const res = await ctx.client.postFile<{ ok: true; rows: number; tables: number }>(
      '/admin/restore',
      ctx.arg(0, '<datei.db>'),
    )
    if (ctx.json) return printJson(res)
    print(`Wiederhergestellt: ${res.rows} Datensätze in ${res.tables} Tabellen.`)
  },
}
