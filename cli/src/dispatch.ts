import type { OptionSpec } from './registry.js'

// Argument-vector plumbing, kept out of main.ts so it can be tested without
// running the CLI. Small surface, but it is the part that decides what counts
// as a command name — and getting that wrong silently eats a flag's value.

export const GLOBAL_OPTIONS: OptionSpec = {
  url: { type: 'string' },
  token: { type: 'string' },
  profile: { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
}

const GLOBAL_FLAGS_WITH_VALUE = new Set(
  Object.entries(GLOBAL_OPTIONS)
    .filter(([, spec]) => spec.type === 'string')
    .map(([name]) => name),
)

/**
 * Index of the next token that names a command, starting at `from`, or -1.
 *
 * Global flags may precede the command (`openleads --url X leads list`), so a
 * value-taking global flag consumes its argument here instead of having it
 * mistaken for a command name. Only *global* flags are known at this point;
 * a command's own flags always follow the command, so that is enough — and the
 * command tokens are removed by index afterwards, which keeps a command flag's
 * value (`backup -o backups/`) out of the command lookup entirely.
 */
export function findCommandToken(argv: string[], from: number): number {
  for (let i = from; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') return -1
    if (arg.startsWith('-')) {
      const name = arg.replace(/^--?/, '').split('=')[0]
      if (GLOBAL_FLAGS_WITH_VALUE.has(name) && !arg.includes('=') && argv[i + 1] !== undefined) i++
      continue
    }
    return i
  }
  return -1
}
