#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { Client, CliError, EXIT } from './client.js'
import { resolveConnection } from './config.js'
import { Ctx, type Command, type Group } from './registry.js'
import { GLOBAL_OPTIONS, findCommandToken } from './dispatch.js'
import { print, warn } from './output.js'

import { leads } from './commands/leads.js'
import { docs } from './commands/docs.js'
import { approvals } from './commands/approvals.js'
import { customers } from './commands/customers.js'
import { contracts } from './commands/contracts.js'
import { expenses, subs, recurring, catalog } from './commands/finance.js'
import { dashboard, digest, report, exportGroup, ai } from './commands/insights.js'
import {
  login,
  logout,
  whoami,
  health,
  profiles,
  config,
  tokens,
  backup,
  restore,
} from './commands/admin.js'
import { mcp } from './commands/mcp.js'

// The entry point: resolve the connection, find the command, parse its flags,
// run it, and map any failure onto an exit code a shell script can branch on.

const COMMANDS: Record<string, Command> = {
  login,
  logout,
  whoami,
  health,
  profiles,
  config,
  dashboard,
  digest,
  backup,
  restore,
  mcp,
}

const GROUPS: Record<string, Group> = {
  leads,
  docs,
  approvals,
  customers,
  contracts,
  expenses,
  subs,
  recurring,
  catalog,
  report,
  export: exportGroup,
  ai,
  tokens,
}

/** Aliases people reach for anyway. */
const GROUP_ALIASES: Record<string, string> = {
  invoices: 'docs',
  rechnungen: 'docs',
  freigaben: 'approvals',
  kunden: 'customers',
  vertraege: 'contracts',
  ausgaben: 'expenses',
}

function version(): string {
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - value.length))
}

function topHelp(): void {
  print('openleads — Kommandozeile und MCP-Server für den Isar Kunden Manager\n')
  print('Aufruf:')
  print('  openleads <befehl> [optionen]')
  print('  openleads <gruppe> <befehl> [optionen]\n')
  const width = Math.max(...[...Object.keys(COMMANDS), ...Object.keys(GROUPS)].map((n) => n.length)) + 2
  print('Befehle:')
  for (const [name, cmd] of Object.entries(COMMANDS)) print(`  ${pad(name, width)}${cmd.summary}`)
  print('\nGruppen:')
  for (const [name, group] of Object.entries(GROUPS)) print(`  ${pad(name, width)}${group.summary}`)
  print('\nGlobale Optionen:')
  print('  --url <url>        Instanz (Standard: Profil, sonst http://127.0.0.1:8787)')
  print('  --token <token>    API-Token; überschreibt Umgebung und Profil')
  print('  --profile <name>   Profil aus ~/.openleads/config.json')
  print('  --json             Maschinenlesbare Ausgabe (automatisch beim Pipen)')
  print('  --quiet, -q        Nur das Nötigste')
  print('  --yes, -y          Nicht umkehrbare Aktionen bestätigen')
  print('  --help, -h         Hilfe zu Befehl oder Gruppe')
  print('  --version, -V      Version\n')
  print('Umgebung:')
  print('  OPENLEADS_URL, OPENLEADS_TOKEN, OPENLEADS_PROFILE, OPENLEADS_CONFIG\n')
  print('Beispiele:')
  print('  openleads leads list --stage neu')
  print('  openleads docs list --overdue --json')
  print('  openleads backup -o ./sicherungen/')
  print('  openleads mcp            # MCP-Server über stdio, für Agenten-Hosts')
}

function groupHelp(name: string, group: Group): void {
  print(`openleads ${name} — ${group.summary}\n`)
  const width = Math.max(...Object.keys(group.commands).map((n) => n.length)) + 2
  print('Befehle:')
  for (const [cmd, def] of Object.entries(group.commands)) print(`  ${pad(cmd, width)}${def.summary}`)
  print(`\n"openleads ${name} <befehl> --help" zeigt die Optionen eines Befehls.`)
}

function commandHelp(fullName: string, cmd: Command): void {
  print(`openleads ${fullName} — ${cmd.summary}\n`)
  print(`Aufruf:\n  openleads ${fullName}${cmd.usage ? ' ' + cmd.usage : ''}\n`)
  if (cmd.help) print(cmd.help + '\n')
  const options = Object.keys(cmd.options ?? {})
  if (options.length) {
    print('Optionen:')
    const width = Math.max(...options.map((o) => o.length)) + 4
    for (const [name, spec] of Object.entries(cmd.options ?? {})) {
      const flag = `--${name}${spec.type === 'string' ? ' <wert>' : ''}`
      print(`  ${pad(flag, width + 8)}${spec.multiple ? '(mehrfach angebbar)' : ''}`.trimEnd())
    }
    print('')
  }
  print('Dazu gelten die globalen Optionen (openleads --help).')
}

async function main(argv: string[]): Promise<number> {
  // Tolerant pre-parse, only to answer "did they ask for help or the version?"
  // before we know which command's flags are legal.
  const preflight = parseArgs({ args: argv, options: GLOBAL_OPTIONS, strict: false, allowPositionals: true })
  const wantsHelp = preflight.values.help === true

  const headIndex = findCommandToken(argv, 0)
  if (headIndex === -1) {
    if (preflight.values.version === true) {
      print(version())
      return EXIT.OK
    }
    topHelp()
    return wantsHelp ? EXIT.OK : EXIT.USAGE
  }

  const head = GROUP_ALIASES[argv[headIndex]] ?? argv[headIndex]
  // Tokens that name the command, removed before the real parse so a command's
  // own flags (and their values) reach parseArgs intact.
  const nameIndices = [headIndex]
  let command: Command | undefined
  let fullName = head

  if (head in GROUPS) {
    const group = GROUPS[head]
    const subIndex = findCommandToken(argv, headIndex + 1)
    if (subIndex === -1) {
      groupHelp(head, group)
      return wantsHelp ? EXIT.OK : EXIT.USAGE
    }
    nameIndices.push(subIndex)
    command = group.commands[argv[subIndex]]
    fullName = `${head} ${argv[subIndex]}`
    if (!command) {
      warn(`Unbekannter Befehl: ${fullName}`)
      groupHelp(head, group)
      return EXIT.USAGE
    }
  } else if (head in COMMANDS) {
    command = COMMANDS[head]
  } else {
    warn(`Unbekannter Befehl: ${argv[headIndex]}`)
    topHelp()
    return EXIT.USAGE
  }

  if (wantsHelp) {
    commandHelp(fullName, command)
    return EXIT.OK
  }

  const parsed = parseArgs({
    args: argv.filter((_, i) => !nameIndices.includes(i)),
    options: { ...GLOBAL_OPTIONS, ...(command.options ?? {}) },
    strict: true,
    allowPositionals: true,
  })

  const connection = resolveConnection({
    url: parsed.values.url as string | undefined,
    token: parsed.values.token as string | undefined,
    profile: parsed.values.profile as string | undefined,
  })
  const client = new Client(connection.url, connection.token)

  // Machine output by default when stdout is a pipe: the same command then works
  // unchanged in a shell and inside a workflow.
  const json = parsed.values.json === true || (!process.stdout.isTTY && !process.env.OPENLEADS_NO_AUTO_JSON)

  const ctx = new Ctx(
    client,
    parsed.positionals,
    parsed.values,
    json,
    parsed.values.quiet === true,
    connection,
  )

  await command.run(ctx)
  return process.exitCode == null ? EXIT.OK : Number(process.exitCode)
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((e: unknown) => {
    const err = e as Error & { code?: number }
    warn(`Fehler: ${err.message}`)
    // parseArgs rejects unknown/misused flags — that is a usage problem, not a
    // runtime one, and scripts want to tell those apart.
    const parseArgsFailure = typeof (e as { code?: string }).code === 'string'
    process.exitCode = e instanceof CliError ? e.code : parseArgsFailure ? EXIT.USAGE : EXIT.ERROR
  })
