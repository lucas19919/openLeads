import type { Hono } from 'hono'
import { db } from '../db'
import { getSettings } from '../documents'
import { encryptSecret, settingsKeyConfigured } from '../secrets'
import { audit } from '../audit'
import { requireAdmin, type Vars } from './middleware'

// The business profile + connection config. Admin-only in both directions:
// members work the pipeline and invoicing but must not read the SMTP/AI
// connection details or rewrite the numbering counters.

const SETTINGS_FIELDS = new Set([
  'business_name', 'owner', 'address', 'zip', 'city', 'email', 'phone',
  'website', 'tax_id', 'iban', 'bic', 'bank', 'small_business', 'vat_rate',
  'payment_terms', 'rechnung_prefix', 'rechnung_next', 'angebot_prefix',
  'angebot_next',
  'datev_revenue_account', 'datev_debitor_account', 'datev_bank_account',
  // Operator-editable connection config (plain). Override the matching .env var.
  'ai_base_url', 'ai_model', 'ai_label',
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_secure', 'smtp_from',
  // Verträge / AGB
  'agb_text', 'contract_prefix', 'contract_next', 'agb_attach_documents',
])

// Write-only secrets: the client sends the plaintext under the key on the left,
// we encrypt it into the column on the right. The plaintext is never stored or
// returned — only "is a secret set?" booleans go back to the browser.
const SECRET_FIELDS: Record<string, string> = {
  ai_api_key: 'ai_api_key_enc',
  smtp_pass: 'smtp_pass_enc',
}

// The settings object the client may see: the encrypted columns are stripped and
// replaced by booleans. Defence in depth — the values are ciphertext anyway, but
// they have no business leaving the server.
export function publicSettings() {
  const s = getSettings() as unknown as Record<string, unknown>
  const ai_api_key_set = !!s.ai_api_key_enc
  const smtp_pass_set = !!s.smtp_pass_enc
  delete s.ai_api_key_enc
  delete s.smtp_pass_enc
  return {
    ...s,
    ai_api_key_set,
    smtp_pass_set,
    settings_key_configured: settingsKeyConfigured(),
  }
}

export function registerSettingsRoutes(app: Hono<{ Variables: Vars }>): void {
  app.get('/api/settings', requireAdmin, (c) => c.json({ settings: publicSettings() }))

  app.put('/api/settings', requireAdmin, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const sets: string[] = []
    const params: Record<string, string | number | null> = {}
    const changed: string[] = []
    for (const key of Object.keys(b)) {
      if (SETTINGS_FIELDS.has(key)) {
        const v = b[key]
        // node:sqlite binds only string|number|null — coerce booleans, skip
        // non-scalar values rather than letting .run() throw a raw 500.
        if (v !== undefined && v !== null && typeof v !== 'boolean' && typeof v !== 'string' && typeof v !== 'number') continue
        sets.push(`${key} = @${key}`)
        params[key] =
          typeof v === 'boolean' ? (v ? 1 : 0) : ((v as string | number | null) ?? null)
        changed.push(key)
      } else if (key in SECRET_FIELDS) {
        // Empty/blank clears the stored secret; any value is encrypted at rest.
        const col = SECRET_FIELDS[key]
        const raw = b[key]
        let enc: string | null = null
        if (typeof raw === 'string' && raw.trim() !== '') {
          try {
            enc = encryptSecret(raw)
          } catch (e) {
            return c.json({ error: (e as Error).message }, 400)
          }
        }
        sets.push(`${col} = @${col}`)
        params[col] = enc
        changed.push(key) // log the field name, never the value
      }
    }
    if (sets.length) {
      db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`).run(params)
      audit({ actor: c.get('user').username, action: 'settings.update', entity: 'settings', entityId: 1, detail: { fields: changed } })
    }
    return c.json({ settings: publicSettings() })
  })
}
