import type { ParseArgsConfig } from 'node:util'
import { Client, CliError, EXIT } from './client.js'
import type { Resolved } from './config.js'

// The command model. A command declares its own flags; `main` merges them with
// the global ones, parses once, and hands the result over as a Ctx. Keeping the
// declaration next to the implementation is what lets `--help` be generated
// rather than written twice and drift.

export type OptionSpec = NonNullable<ParseArgsConfig['options']>
export type OptionValue = string | boolean | (string | boolean)[] | undefined

export interface Command {
  summary: string
  /** Argument sketch shown in help, e.g. "<id> [--stage <stage>]". */
  usage?: string
  options?: OptionSpec
  /** Longer prose under the usage line in `--help`. */
  help?: string
  run(ctx: Ctx): Promise<void>
}

export interface Group {
  summary: string
  commands: Record<string, Command>
}

export class Ctx {
  constructor(
    readonly client: Client,
    readonly args: string[],
    private readonly values: Record<string, OptionValue>,
    readonly json: boolean,
    readonly quiet: boolean,
    readonly connection: Resolved,
  ) {}

  /** A string flag, or undefined when it was not given. */
  str(name: string): string | undefined {
    const v = this.values[name]
    if (Array.isArray(v)) return typeof v[v.length - 1] === 'string' ? (v[v.length - 1] as string) : undefined
    return typeof v === 'string' ? v : undefined
  }

  /** Every occurrence of a repeatable string flag (e.g. --item). */
  list(name: string): string[] {
    const v = this.values[name]
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
    return typeof v === 'string' ? [v] : []
  }

  bool(name: string): boolean {
    const v = this.values[name]
    if (Array.isArray(v)) return v.some((x) => x === true)
    return v === true
  }

  num(name: string): number | undefined {
    const raw = this.str(name)
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new CliError(`--${name} muss eine Zahl sein (war: ${raw})`, EXIT.USAGE)
    return n
  }

  /** A euro amount as cents. See {@link toCents} for the accepted forms. */
  cents(name: string): number | undefined {
    const raw = this.str(name)
    if (raw === undefined) return undefined
    const value = toCents(raw)
    if (value === null) throw new CliError(`--${name} muss ein Betrag sein (war: ${raw})`, EXIT.USAGE)
    return value
  }

  /** A required positional, by index. */
  arg(index: number, label: string): string {
    const v = this.args[index]
    if (v === undefined) throw new CliError(`Fehlendes Argument: ${label}`, EXIT.USAGE)
    return v
  }

  /** A required positional that must be a numeric id. */
  id(index = 0, label = '<id>'): number {
    const raw = this.arg(index, label)
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) throw new CliError(`${label} muss eine id sein (war: ${raw})`, EXIT.USAGE)
    return n
  }

  /** Gate for anything that cannot be undone. */
  confirm(what: string): void {
    if (!this.bool('yes')) {
      throw new CliError(`${what} — zum Bestätigen --yes anhängen.`, EXIT.USAGE)
    }
  }
}

/**
 * A euro amount as cents, or null if it is not a number at all.
 *
 * Both notations have to work: a German keyboard produces "1.190,50" and a
 * script produces "1190.50". A comma is therefore always the decimal separator
 * (dots then group thousands); without one, dots are only read as grouping when
 * they actually look like it — `1.190` is 1190 €, `1190.50` is 1190,50 €.
 */
export function toCents(raw: string): number | null {
  const value = raw.trim()
  let normalized: string
  if (value.includes(',')) {
    normalized = value.replace(/\./g, '').replace(',', '.')
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(value)) {
    normalized = value.replace(/\./g, '')
  } else {
    normalized = value
  }
  const n = Number(normalized)
  if (normalized === '' || !Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/** Build a patch object from only the flags the caller actually passed. */
export function patchFrom(
  ctx: Ctx,
  fields: Record<string, 'string' | 'number' | 'cents' | 'boolean'>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [name, kind] of Object.entries(fields)) {
    const key = name.replace(/-/g, '_')
    if (kind === 'boolean') {
      if (ctx.bool(name)) patch[key] = true
      continue
    }
    const value = kind === 'cents' ? ctx.cents(name) : kind === 'number' ? ctx.num(name) : ctx.str(name)
    if (value !== undefined) patch[key] = value
  }
  return patch
}
