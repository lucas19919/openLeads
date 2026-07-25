import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'

// The pure parts: how argv turns into a command, how German number input turns
// into cents, and how flags/env/profile combine into a connection. The HTTP
// paths are covered by running the CLI against a live API, not from here.

const CONFIG_FILE = join(tmpdir(), `openleads-cli-${process.pid}.json`)
process.env.OPENLEADS_CONFIG = CONFIG_FILE

const { findCommandToken } = await import('./dispatch.js')
const { Ctx } = await import('./registry.js')
const { parseItem } = await import('./commands/docs.js')
const { resolveConnection } = await import('./config.js')
const { Client, CliError } = await import('./client.js')

after(() => {
  try {
    rmSync(CONFIG_FILE)
  } catch {
    /* ignore */
  }
})

function ctx(values: Record<string, unknown>, args: string[] = []) {
  return new Ctx(new Client('http://localhost', undefined), args, values as never, true, false, {
    url: 'http://localhost',
    profile: 'test',
    source: 'none',
  })
}

// --- argv → command ---------------------------------------------------------

test('the command is the first token that is not a flag', () => {
  assert.equal(findCommandToken(['leads', 'list'], 0), 0)
  assert.equal(findCommandToken(['--json', 'leads', 'list'], 0), 1)
  assert.equal(findCommandToken(['-q', '--json', 'dashboard'], 0), 2)
})

test('a global flag consumes its value instead of it being read as a command', () => {
  // Regression: `--url http://x leads list` must not treat the URL as the command.
  assert.equal(findCommandToken(['--url', 'http://x', 'leads'], 0), 2)
  assert.equal(findCommandToken(['--token', 'ol_abc', 'whoami'], 0), 2)
  // The =form carries its own value, so the next token is still the command.
  assert.equal(findCommandToken(['--url=http://x', 'leads'], 0), 1)
})

test('a boolean global flag does not swallow the command', () => {
  assert.equal(findCommandToken(['--json', 'backup'], 0), 1)
  assert.equal(findCommandToken(['--yes', 'restore', 'file.db'], 0), 1)
})

test('searching resumes after the group token', () => {
  const argv = ['leads', 'list', '--stage', 'neu']
  const head = findCommandToken(argv, 0)
  assert.equal(head, 0)
  assert.equal(findCommandToken(argv, head + 1), 1)
})

test('a group with no command, and an argv with no command at all', () => {
  assert.equal(findCommandToken(['leads'], 1), -1)
  assert.equal(findCommandToken(['--json'], 0), -1)
  assert.equal(findCommandToken([], 0), -1)
})

test('nothing after -- is treated as a command', () => {
  assert.equal(findCommandToken(['--', 'leads'], 0), -1)
})

// --- values -----------------------------------------------------------------

test('amounts accept both German and plain decimal input', () => {
  assert.equal(ctx({ amount: '1190,00' }).cents('amount'), 119000)
  assert.equal(ctx({ amount: '1190.00' }).cents('amount'), 119000)
  assert.equal(ctx({ amount: '1.190,50' }).cents('amount'), 119050)
  assert.equal(ctx({ amount: '23,8' }).cents('amount'), 2380)
  assert.equal(ctx({ amount: '5' }).cents('amount'), 500)
  assert.equal(ctx({}).cents('amount'), undefined)
})

test('a dot is grouping only when it looks like grouping', () => {
  // Regression: "1190.00" is 1190,00 € — not 119.000,00 €.
  assert.equal(ctx({ amount: '1190.00' }).cents('amount'), 119000)
  assert.equal(ctx({ amount: '2500.5' }).cents('amount'), 250050)
  // Three digits after the dot and no comma: German thousands grouping.
  assert.equal(ctx({ amount: '1.190' }).cents('amount'), 119000)
  assert.equal(ctx({ amount: '1.000.000' }).cents('amount'), 100000000)
  // A comma settles it: dots group, comma decides the decimals.
  assert.equal(ctx({ amount: '1.000.000,25' }).cents('amount'), 100000025)
})

test('a non-numeric amount is a usage error, not a silent NaN', () => {
  assert.throws(() => ctx({ amount: 'viel' }).cents('amount'), (e: unknown) => {
    assert.ok(e instanceof CliError)
    assert.equal((e as InstanceType<typeof CliError>).code, 2)
    return true
  })
})

test('ids must be positive integers', () => {
  assert.equal(ctx({}, ['42']).id(), 42)
  assert.throws(() => ctx({}, ['abc']).id(), CliError)
  assert.throws(() => ctx({}, ['-1']).id(), CliError)
  assert.throws(() => ctx({}, ['1.5']).id(), CliError)
  assert.throws(() => ctx({}, []).id(), CliError)
})

test('repeatable flags come back as a list whether given once or many times', () => {
  assert.deepEqual(ctx({ item: ['a', 'b'] }).list('item'), ['a', 'b'])
  assert.deepEqual(ctx({ item: 'a' }).list('item'), ['a'])
  assert.deepEqual(ctx({}).list('item'), [])
})

test('irreversible actions refuse without --yes', () => {
  assert.throws(() => ctx({}).confirm('Das ist endgültig'), (e: unknown) => {
    assert.match((e as Error).message, /--yes/)
    return true
  })
  assert.doesNotThrow(() => ctx({ yes: true }).confirm('Das ist endgültig'))
})

// --- line items -------------------------------------------------------------

test('a line item parses into description, quantity, unit and net cents', () => {
  assert.deepEqual(parseItem('Website-Relaunch:1:2500,00'), {
    description: 'Website-Relaunch',
    quantity: 1,
    unit: null,
    unit_price_cents: 250000,
  })
  assert.deepEqual(parseItem('Pflege:12:49,00:Monat'), {
    description: 'Pflege',
    quantity: 12,
    unit: 'Monat',
    unit_price_cents: 4900,
  })
})

test('a malformed line item is rejected with the expected shape in the message', () => {
  assert.throws(() => parseItem('nur-text'), /Beschreibung:Menge:Einzelpreis/)
  assert.throws(() => parseItem('Text:viele:100'), /Zahlen/)
})

// --- connection resolution --------------------------------------------------

test('flags beat environment, environment beats the profile file', () => {
  writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      current: 'prod',
      profiles: { prod: { url: 'https://profile.example', token: 'ol_profile' } },
    }),
  )
  delete process.env.OPENLEADS_URL
  delete process.env.OPENLEADS_TOKEN

  const fromProfile = resolveConnection({})
  assert.equal(fromProfile.url, 'https://profile.example')
  assert.equal(fromProfile.token, 'ol_profile')
  assert.equal(fromProfile.source, 'profile')

  process.env.OPENLEADS_URL = 'https://env.example'
  process.env.OPENLEADS_TOKEN = 'ol_env'
  const fromEnv = resolveConnection({})
  assert.equal(fromEnv.url, 'https://env.example')
  assert.equal(fromEnv.token, 'ol_env')
  assert.equal(fromEnv.source, 'env')

  const fromFlags = resolveConnection({ url: 'https://flag.example', token: 'ol_flag' })
  assert.equal(fromFlags.url, 'https://flag.example')
  assert.equal(fromFlags.token, 'ol_flag')
  assert.equal(fromFlags.source, 'flag')

  delete process.env.OPENLEADS_URL
  delete process.env.OPENLEADS_TOKEN
})

test('a trailing slash on the URL is trimmed so paths do not double up', () => {
  assert.equal(resolveConnection({ url: 'https://example.de/' }).url, 'https://example.de')
  assert.equal(resolveConnection({ url: 'https://example.de///' }).url, 'https://example.de')
})

test('an unknown profile falls back to the default URL rather than failing', () => {
  const resolved = resolveConnection({ profile: 'gibt-es-nicht' })
  assert.equal(resolved.url, 'http://127.0.0.1:8787')
  assert.equal(resolved.token, undefined)
  assert.equal(resolved.source, 'none')
})
