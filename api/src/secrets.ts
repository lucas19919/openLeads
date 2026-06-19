import './env'
import {
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto'
import { db } from './db'

// --- Operator-editable connection config, with secrets encrypted at rest -----
//
// The AI provider and SMTP credentials can be set from the Settings UI instead
// of editing .env. Two kinds of value land in the `settings` table:
//
//   • plain config (base URL, model, host, port, From) — stored as-is, and
//   • secrets (AI_API_KEY, SMTP_PASS) — stored ENCRYPTED with AES-256-GCM.
//
// The encryption key (SETTINGS_KEY) lives only in the environment, never in the
// database. That is the whole point: a leaked `.db` file or a downloaded backup
// contains ciphertext that is useless without the env key. Bootstrap secrets
// that the app needs *before* it can read the DB — SESSION_SECRET, SERVICE_TOKEN
// — deliberately stay in .env and are NOT handled here.
//
// Resolution order for every field is: DB value → matching .env var → default.
// So existing .env-only deployments keep working unchanged.

const DEV_KEY = 'dev-insecure-settings-key-change-me'
const KEY_MATERIAL = process.env.SETTINGS_KEY ?? DEV_KEY

/** True when a real SETTINGS_KEY is configured (not the dev default). */
export function settingsKeyConfigured(): boolean {
  return KEY_MATERIAL !== DEV_KEY
}

let warnedDevKey = false

/**
 * Encrypt a plaintext secret for storage. Format (all base64):
 *   v1.<salt>.<iv>.<authTag>.<ciphertext>
 * A fresh random salt per value means the scrypt-derived key differs per
 * record, so identical secrets never produce identical ciphertext.
 *
 * Fails closed in production when SETTINGS_KEY is unset — we refuse to persist a
 * credential under a publicly known key. In development we warn once and use the
 * dev default so the feature is testable.
 */
export function encryptSecret(plain: string): string {
  if (!settingsKeyConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'SETTINGS_KEY ist nicht gesetzt — Zugangsdaten können im Produktivbetrieb nicht ' +
          'verschlüsselt gespeichert werden. Bitte SETTINGS_KEY in der Umgebung setzen.',
      )
    }
    if (!warnedDevKey) {
      console.warn('WARN: SETTINGS_KEY nicht gesetzt — Zugangsdaten werden mit unsicherem Entwicklungs-Default verschlüsselt.')
      warnedDevKey = true
    }
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(KEY_MATERIAL, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    'v1',
    salt.toString('base64'),
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64'),
  ].join('.')
}

/**
 * Decrypt a stored secret. Returns null for empty input, a malformed record, or
 * a wrong/rotated key — callers treat null as "no DB secret" and fall back to
 * the corresponding .env var, so a key mismatch degrades instead of crashing.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null
  const parts = stored.split('.')
  if (parts.length !== 5 || parts[0] !== 'v1') return null
  try {
    const [, saltB64, ivB64, tagB64, ctB64] = parts
    const key = scryptSync(KEY_MATERIAL, Buffer.from(saltB64, 'base64'), 32)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    const out = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()])
    return out.toString('utf8')
  } catch {
    return null
  }
}

// --- Config resolution (DB override → env fallback → default) ----------------

interface ConfigRow {
  ai_base_url: string | null
  ai_model: string | null
  ai_label: string | null
  ai_api_key_enc: string | null
  smtp_host: string | null
  smtp_port: number | null
  smtp_user: string | null
  smtp_pass_enc: string | null
  smtp_secure: number | null
  smtp_from: string | null
}

function configRow(): ConfigRow {
  return db
    .prepare(
      `SELECT ai_base_url, ai_model, ai_label, ai_api_key_enc,
              smtp_host, smtp_port, smtp_user, smtp_pass_enc, smtp_secure, smtp_from
         FROM settings WHERE id = 1`,
    )
    .get() as unknown as ConfigRow
}

/** First non-empty of DB value, env value, default. */
function pick(dbVal: string | null | undefined, envVal: string | undefined, def: string): string {
  const d = dbVal?.trim()
  if (d) return d
  const e = envVal?.trim()
  if (e) return e
  return def
}

export interface ResolvedAI {
  baseUrl: string
  model: string
  label: string
  apiKey: string
}

export function resolveAIConfig(): ResolvedAI {
  const r = configRow()
  return {
    baseUrl: pick(r.ai_base_url, process.env.AI_BASE_URL, 'http://localhost:11434/v1').replace(/\/$/, ''),
    model: pick(r.ai_model, process.env.AI_MODEL, 'llama3.1:8b'),
    label: pick(r.ai_label, process.env.AI_LABEL, ''),
    apiKey: decryptSecret(r.ai_api_key_enc) ?? process.env.AI_API_KEY ?? '',
  }
}

export interface ResolvedSMTP {
  host: string
  port: number
  user: string
  pass: string
  secure: boolean
  from: string
}

export function resolveSMTPConfig(): ResolvedSMTP {
  const r = configRow()
  const portStr = r.smtp_port != null ? String(r.smtp_port) : undefined
  return {
    host: pick(r.smtp_host, process.env.SMTP_HOST, ''),
    port: Number(pick(portStr, process.env.SMTP_PORT, '587')),
    user: pick(r.smtp_user, process.env.SMTP_USER, ''),
    pass: decryptSecret(r.smtp_pass_enc) ?? process.env.SMTP_PASS ?? '',
    secure: r.smtp_secure != null ? r.smtp_secure === 1 : process.env.SMTP_SECURE === 'true',
    from: pick(r.smtp_from, process.env.SMTP_FROM, ''),
  }
}
