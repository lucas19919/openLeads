import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-scrape-${process.pid}.db`)
process.env.DB_PATH = DB_FILE
// Neutralize any inherited values so childEnv() is exercised from a known base.
delete process.env.SCRAPER_MODEL
delete process.env.AI_MODEL

const { db } = await import('./db')
const { childEnv } = await import('./scrape')

after(() => {
  try {
    db.close()
  } catch {
    /* ignore */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_FILE + suffix)
    } catch {
      /* ignore */
    }
  }
})

test('childEnv does NOT forward a non-Claude (local Ollama) model to the Anthropic scraper', () => {
  // The operator's general AI is a local model — sending it to the Anthropic SDK
  // would 404. childEnv must leave SCRAPER_MODEL unset so the scraper uses its
  // own Claude default.
  process.env.AI_MODEL = 'llama3.1:8b'
  assert.equal(childEnv().SCRAPER_MODEL, undefined)
})

test('childEnv forwards a Claude model to the scraper', () => {
  process.env.AI_MODEL = 'claude-opus-4-8'
  assert.equal(childEnv().SCRAPER_MODEL, 'claude-opus-4-8')
})

test('childEnv wires the CRM callback URL and service token for the child', () => {
  process.env.AI_MODEL = 'claude-sonnet-4-6'
  process.env.SERVICE_TOKEN = 'svc-test-token'
  const env = childEnv()
  assert.match(env.CRM_API_URL ?? '', /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(env.CRM_SERVICE_TOKEN, 'svc-test-token')
})
