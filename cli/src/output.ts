// Rendering. Two audiences: a person at a terminal (aligned columns, German
// money and dates) and a program reading stdout (--json, and the default
// whenever stdout is a pipe). Getting that default right is what lets the same
// command work in a shell and in a workflow without a flag.

export interface RenderOptions {
  json: boolean
  quiet: boolean
}

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const dim = (s: string) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s: string) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s)

export function print(line = ''): void {
  process.stdout.write(line + '\n')
}

export function warn(line: string): void {
  process.stderr.write(line + '\n')
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

/** Cents → "1.234,56 €", the format the rest of OpenLeads uses. */
export function euro(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return (
    (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
    ' €'
  )
}

/** ISO date (or datetime) → DD.MM.YYYY. */
export function date(value: string | null | undefined): string {
  if (!value) return '—'
  const [y, m, d] = value.slice(0, 10).split('-')
  return d && m && y ? `${d}.${m}.${y}` : value
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, Math.max(1, max - 1)) + '…'
}

export interface Column<T> {
  header: string
  /** Cell text. Return '' for blank; never undefined. */
  value: (row: T) => string
  /** Right-align (amounts, counts). */
  right?: boolean
  /** Hard cap on width; longer cells are ellipsised. */
  max?: number
}

/**
 * Print an aligned table. Widths come from the content, so a two-row list is
 * compact and a fifty-row list still lines up.
 */
export function table<T>(rows: T[], columns: Column<T>[], emptyNote = 'Keine Einträge.'): void {
  if (rows.length === 0) {
    print(dim(emptyNote))
    return
  }
  const cells = rows.map((r) =>
    columns.map((c) => {
      const v = c.value(r) ?? ''
      return c.max ? truncate(v, c.max) : v
    }),
  )
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...cells.map((row) => visibleLength(row[i]))),
  )
  print(bold(columns.map((c, i) => pad(c.header, widths[i], c.right)).join('  ').trimEnd()))
  for (const row of cells) {
    print(row.map((cell, i) => pad(cell, widths[i], columns[i].right)).join('  ').trimEnd())
  }
}

/** key: value block for a single record. */
export function details(entries: [string, string][]): void {
  const width = Math.max(...entries.map(([k]) => k.length))
  for (const [k, v] of entries) print(`${dim(pad(k + ':', width + 1))} ${v}`)
}

function pad(value: string, width: number, right = false): string {
  const gap = ' '.repeat(Math.max(0, width - visibleLength(value)))
  return right ? gap + value : value + gap
}

// Ellipsis and umlauts are one column each; ANSI escapes are zero. Nothing here
// emits wide CJK, so a simple strip is enough.
function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, '').length
}
