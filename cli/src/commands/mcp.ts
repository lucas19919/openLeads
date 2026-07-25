import type { Command } from '../registry.js'
import { CliError, EXIT } from '../client.js'
import { serve, log } from '../mcp/protocol.js'
import { buildTools } from '../mcp/tools.js'

// `openleads mcp` — the docking point. An agent host (Claude Desktop/Code, or
// any other MCP client) spawns this process and gets OpenLeads as a set of
// tools alongside whatever else it already has: mail, calendar, cloud storage.
//
// It speaks the same REST API as every other command, with the same token, so
// there is one auth story and one audit trail no matter who is driving.

const INSTRUCTIONS = [
  'OpenLeads ist eine selbstgehostete Vertriebs- und Rechnungsverwaltung für Webagenturen',
  '(Leads, Kunden, Angebote/Rechnungen, Verträge, Ausgaben).',
  '',
  'Für einen Tagesüberblick zuerst `morning_digest` oder `pipeline_overview` aufrufen.',
  'Beträge sind durchgängig in Cent; Daten im Format YYYY-MM-DD; die Oberfläche ist deutsch.',
  '',
  'Schreibende Werkzeuge erzeugen nur Zustände, die ein Mensch rückgängig machen kann —',
  'Entwürfe, Notizen, Stage-Wechsel. Rechnungen ausstellen, stornieren und E-Mails versenden',
  'ist bewusst nicht verfügbar, sofern der Betreiber es nicht ausdrücklich freigeschaltet hat.',
].join('\n')

export const mcp: Command = {
  summary: 'MCP-Server über stdio starten (für Agenten-Hosts)',
  usage: '[--read-only] [--allow-irreversible] [--max-rows <n>]',
  help:
    'Der Server spricht MCP über stdin/stdout und wird vom Host gestartet, nicht von Hand.\n' +
    'Beispiel für die Host-Konfiguration:\n' +
    '\n' +
    '  "openleads": {\n' +
    '    "command": "openleads",\n' +
    '    "args": ["mcp"],\n' +
    '    "env": { "OPENLEADS_URL": "https://openleads.example.de", "OPENLEADS_TOKEN": "ol_…" }\n' +
    '  }\n' +
    '\n' +
    '--allow-irreversible schaltet Ausstellen, Storno, Vertragsabschluss, E-Mail-Versand und den\n' +
    'Copiloten frei. Ohne die Option bleiben sie aus — voreingestellt kann ein Agent nur Dinge tun,\n' +
    'die sich rückgängig machen lassen. Alternativ per Umgebungsvariable\n' +
    'OPENLEADS_MCP_ALLOW_IRREVERSIBLE=1.',
  options: {
    'read-only': { type: 'boolean' },
    'allow-irreversible': { type: 'boolean' },
    'max-rows': { type: 'string' },
  },
  async run(ctx) {
    if (!ctx.connection.token) {
      throw new CliError(
        'Kein API-Token. OPENLEADS_TOKEN setzen oder vorher "openleads login --token …" ausführen.',
        EXIT.AUTH,
      )
    }

    const allowIrreversible =
      ctx.bool('allow-irreversible') || process.env.OPENLEADS_MCP_ALLOW_IRREVERSIBLE === '1'
    const readOnly = ctx.bool('read-only')

    const tools = buildTools(ctx.client, {
      allowIrreversible,
      readOnly,
      maxRows: ctx.num('max-rows') ?? 50,
    })

    // Fail loudly at startup rather than on the first tool call: a host that
    // shows "connected" while every call 401s is the worst of both worlds.
    try {
      const { user } = await ctx.client.get<{ user: { username: string; role: string } }>('/me')
      log(
        `verbunden mit ${ctx.connection.url} als ${user.username} (${user.role}) · ` +
          `${tools.length} Werkzeuge · ${readOnly ? 'nur lesend' : allowIrreversible ? 'inkl. nicht umkehrbarer Aktionen' : 'ohne nicht umkehrbare Aktionen'}`,
      )
    } catch (e) {
      throw new CliError(`Verbindung fehlgeschlagen: ${(e as Error).message}`, EXIT.AUTH)
    }

    await serve({ name: 'openleads', version: process.env.npm_package_version ?? '0.1.0', instructions: INSTRUCTIONS }, tools)
    log('Host hat die Verbindung geschlossen.')
  },
}
